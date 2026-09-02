# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import ValidationError
import logging

_logger = logging.getLogger(__name__)


class PrintGatewayAgent(models.Model):
    """Mirror of a Gateway agent.

    The agent is the SOLE owner of branch context for its printers:

        Branch -> Agent -> Printer

    Moving an agent to another branch moves every printer it owns, because
    ``print_gateway.printer.branch_id`` is a stored *related* field on
    ``agent_id.branch_id``. There is no second place to update, and therefore
    no way to end up with an agent in Branch A owning a printer in Branch B.
    """

    _name = 'print_gateway.agent'
    _description = 'Print Gateway Agent'
    _order = 'name'

    gateway_agent_id = fields.Char(string='Gateway Agent ID', required=True, index=True)
    name = fields.Char(required=True)
    # ondelete='restrict', NOT 'cascade'. Deleting a branch must not silently
    # destroy the agents that served it — and, by extension (printer.agent_id),
    # their printers, taking the physical topology of a whole site with it.
    # Branch deletion is refused while agents exist; retire them first.
    branch_id = fields.Many2one(
        'print_gateway.branch', required=True, ondelete='restrict',
        help='Branch this agent serves. Every printer registered by this agent belongs to '
             'this branch (Branch -> Agent -> Printer).')
    status = fields.Selection([
        ('online', 'Online'),
        ('offline', 'Offline'),
        ('unknown', 'Unknown'),
        # TERMINAL, operator-asserted: the machine is decommissioned. A sync
        # must never move an agent out of this state.
        ('retired', 'Retired'),
    ], default='unknown')
    last_seen_at = fields.Datetime(readonly=True)
    hostname = fields.Char()
    os = fields.Char(string='OS')

    # A real one2many on the ownership column. This used to be a computed
    # search over a plain Char (`gateway_agent_id`), which could not express
    # ownership, could not cascade, and silently matched printers mirrored in
    # other branches.
    printer_ids = fields.One2many('print_gateway.printer', 'agent_id', string='Printers')
    printer_count = fields.Integer(compute='_compute_printer_count', string='Printers')

    # A Gateway agent id is globally unique in the Gateway and an agent lives in
    # exactly one branch, so uniqueness is global here too. The previous
    # per-branch uniqueness allowed the same runtime agent to be mirrored into
    # two branches at once — the duplicated-ownership bug this redesign removes.
    _sql_constraints = [
        ('gateway_agent_id_unique', 'unique(gateway_agent_id)',
         'This Gateway agent is already mirrored; an agent belongs to exactly one branch.'),
    ]

    @api.depends('printer_ids')
    def _compute_printer_count(self):
        for rec in self:
            rec.printer_count = len(rec.printer_ids)

    def action_sync_status(self):
        for agent in self:
            agent.branch_id.action_sync_from_gateway()
        return True

    # ------------------------------------------------------------------
    # Lifecycle and deletion
    # ------------------------------------------------------------------

    def action_retire(self):
        """Retire the agent and, with it, every printer it owns.

        TERMINAL. A printer is only reachable through its agent, so retiring
        the agent without retiring its printers would leave printers that look
        routable but can never receive a job.
        """
        for rec in self:
            if rec.status == 'retired':
                raise ValidationError(
                    _('Agent %s is already retired. Retirement is permanent.') % rec.display_name)
            rec.write({'status': 'retired'})
            live = rec.printer_ids.filtered(lambda p: p.status != 'retired')
            if live:
                live.write({'status': 'retired', 'enabled': False})
        return True

    def write(self, vals):
        if 'status' in vals and vals['status'] != 'retired':
            retired = self.filtered(lambda r: r.status == 'retired')
            if retired:
                raise ValidationError(_(
                    'Cannot change the status of retired agent(s): %s.\n\n'
                    'Retirement is permanent. Create a new agent and pair it instead.'
                ) % ', '.join(retired.mapped('display_name')))

        # ------------------------------------------------------------------
        # Branch move: validate every affected binding IN THE SAME TRANSACTION.
        #
        # Moving an agent moves all of its printers (their branch is derived).
        # Any binding that routes to one of those printers stays behind in the
        # OLD branch and instantly becomes a cross-branch binding — a routing
        # rule pointing at a printer that is no longer in its branch.
        #
        # `_check_branch_consistency` cannot catch this: it is an
        # @api.constrains on the BINDING, and a branch move touches no binding
        # field, so nothing re-triggers it. The inconsistency would be written
        # and only surface later, at print time, as a failed job.
        #
        # So the check happens here, before the move is committed. Because it
        # runs inside the same transaction as `super().write`, either the move
        # and its binding fix-ups both land, or neither does.
        # ------------------------------------------------------------------
        new_branch_id = vals.get('branch_id')
        movers = self.env['print_gateway.agent']
        if new_branch_id:
            movers = self.filtered(lambda a: a.branch_id.id != new_branch_id)

        affected = {}
        if movers:
            Binding = self.env['print_gateway.printer_binding']
            for agent in movers:
                printers = agent.printer_ids
                if not printers:
                    continue
                # Bindings that route to this agent's printers but do NOT live
                # in the destination branch. After the move they would be
                # cross-branch.
                stale = Binding.search([
                    ('printer_id', 'in', printers.ids),
                    ('branch_id', '!=', new_branch_id),
                ])
                if stale:
                    affected[agent] = stale

        result = super().write(vals)

        if affected:
            # Policy is explicit, never implicit. Default: REFUSE the move and
            # name every offending binding, so an operator repoints or removes
            # them deliberately. The alternative — disabling them — is opt-in
            # via context, and is always audited.
            disable = self.env.context.get('disable_cross_branch_bindings')
            for agent, bindings in affected.items():
                if not disable:
                    raise ValidationError(_(
                        'Cannot move agent %s to branch %s: %s routing binding(s) would become '
                        'cross-branch, pointing at printers that are no longer in their branch.\n\n'
                        '%s\n\n'
                        'Repoint or remove these bindings first. To move anyway and have them '
                        'disabled automatically (recorded in the chatter and the log), re-run with '
                        'the "Move and disable bindings" action.'
                    ) % (
                        agent.display_name,
                        self.env['print_gateway.branch'].browse(new_branch_id).display_name,
                        len(bindings),
                        '\n'.join(
                            '  - %s (branch %s, printer %s)' % (
                                b.display_name, b.branch_id.display_name, b.printer_id.display_name)
                            for b in bindings
                        ),
                    ))

                # Audited disable. The bindings are NOT deleted: an operator
                # must be able to see exactly what the move broke and re-point
                # it in the new branch.
                detail = ', '.join(
                    '%s (branch %s)' % (b.display_name, b.branch_id.display_name) for b in bindings)
                bindings.write({'enabled': False})
                _logger.warning(
                    "Agent %s moved to branch %s; disabled %s now-cross-branch binding(s): %s",
                    agent.display_name, new_branch_id, len(bindings), detail)
                note = _(
                    'Agent moved to branch <b>%s</b>. %s routing binding(s) became cross-branch '
                    'and were <b>disabled</b> (not deleted): %s'
                ) % (
                    self.env['print_gateway.branch'].browse(new_branch_id).display_name,
                    len(bindings), detail)
                if hasattr(agent, 'message_post'):
                    agent.message_post(body=note)
                for b in bindings:
                    b.notes = '%s\n[%s] disabled: printer moved to branch %s with agent %s' % (
                        b.notes or '', fields.Datetime.now(),
                        self.env['print_gateway.branch'].browse(new_branch_id).display_name,
                        agent.display_name)

        return result

    def action_move_to_branch_disabling_bindings(self, branch_id):
        """Move the agent, disabling (never deleting) bindings the move breaks.

        The audited escape hatch for the refusal in `write`. Everything still
        happens in one transaction.
        """
        return self.with_context(disable_cross_branch_bindings=True).write({'branch_id': branch_id})

    def unlink(self):
        """Refuse to delete an agent that owns printers or carries history."""
        Job = self.env['print_gateway.print_job']
        for rec in self:
            if rec.printer_ids:
                raise ValidationError(_(
                    'Agent %s still owns %s printer(s): %s.\n\n'
                    'A printer cannot exist without an agent, so deleting this agent would '
                    'destroy them. Retire the agent instead — it stops all routing and keeps '
                    'the printers and their job history intact.'
                ) % (rec.display_name, len(rec.printer_ids),
                     ', '.join(rec.printer_ids.mapped('display_name'))))
            job_count = Job.search_count([('agent_id', '=', rec.id)])
            if job_count:
                raise ValidationError(_(
                    'Agent %s has %s print job(s) in its history and cannot be deleted. '
                    'Retire it instead.'
                ) % (rec.display_name, job_count))
        return super().unlink()
