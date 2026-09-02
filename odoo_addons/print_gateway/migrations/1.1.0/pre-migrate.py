# -*- coding: utf-8 -*-
"""Pre-migration: Printer branch ownership becomes derived through the Agent.

    BEFORE:  print_gateway.printer.branch_id  (independent m2o, required)
             print_gateway.printer.gateway_agent_id (plain Char, no ownership)

    AFTER:   print_gateway.printer.agent_id   (required m2o -> the owner)
             print_gateway.printer.branch_id  (stored *related* on agent_id.branch_id)

Runs BEFORE Odoo loads the new field definitions, so the ``agent_id`` column is
created and back-filled here from the legacy ``gateway_agent_id`` string. The
ORM then simply recomputes the stored related ``branch_id`` from the agent.

FAIL-LOUD policy — this migration never guesses and never moves hardware
between branches on its own. It raises when:

  * a printer's legacy ``gateway_agent_id`` matches no mirrored agent;
  * a printer's legacy ``branch_id`` disagrees with its agent's branch;
  * the same ``gateway_printer_id`` / ``gateway_agent_id`` is mirrored more
    than once (the old per-branch uniqueness allowed exactly that).

Every failure names the printer, its stored branch, its agent and the agent's
branch so the operator can resolve it deliberately.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return

    cr.execute("""
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'print_gateway_printer' AND column_name = 'branch_id'
    """)
    if not cr.fetchone():
        _logger.info("print_gateway: printer table not present/already migrated; nothing to do")
        return

    # 0. Duplicate mirrors -----------------------------------------------
    cr.execute("""
        SELECT gateway_agent_id, count(*) FROM print_gateway_agent
        WHERE gateway_agent_id IS NOT NULL
        GROUP BY gateway_agent_id HAVING count(*) > 1
    """)
    dup_agents = cr.fetchall()
    if dup_agents:
        raise Exception(
            "print_gateway migration aborted: the same Gateway agent is mirrored in several "
            "branches, which the new Branch -> Agent -> Printer model forbids: %s. "
            "Keep exactly one mirror per agent (delete the duplicates or re-point their printers) "
            "and upgrade again." % ", ".join("%s x%s" % (a, n) for a, n in dup_agents)
        )

    cr.execute("""
        SELECT gateway_printer_id, count(*) FROM print_gateway_printer
        WHERE gateway_printer_id IS NOT NULL
        GROUP BY gateway_printer_id HAVING count(*) > 1
    """)
    dup_printers = cr.fetchall()
    if dup_printers:
        raise Exception(
            "print_gateway migration aborted: the same Gateway printer is mirrored in several "
            "branches: %s. A printer belongs to exactly one agent (and therefore one branch). "
            "Delete the stale duplicate mirrors and upgrade again."
            % ", ".join("%s x%s" % (p, n) for p, n in dup_printers)
        )

    # 1. Create the ownership column -------------------------------------
    cr.execute("""
        ALTER TABLE print_gateway_printer
        ADD COLUMN IF NOT EXISTS agent_id integer
    """)

    # 2. Back-fill from the legacy gateway_agent_id string -----------------
    cr.execute("""
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'print_gateway_printer' AND column_name = 'gateway_agent_id'
    """)
    if cr.fetchone():
        cr.execute("""
            UPDATE print_gateway_printer p
            SET agent_id = a.id
            FROM print_gateway_agent a
            WHERE p.agent_id IS NULL
              AND p.gateway_agent_id IS NOT NULL
              AND a.gateway_agent_id = p.gateway_agent_id
        """)

    # 3. Unresolvable printers -> fail loudly ------------------------------
    cr.execute("""
        SELECT p.id, p.gateway_printer_id, p.gateway_agent_id, b.name
        FROM print_gateway_printer p
        LEFT JOIN print_gateway_branch b ON b.id = p.branch_id
        WHERE p.agent_id IS NULL
    """)
    orphans = cr.fetchall()
    if orphans:
        raise Exception(
            "print_gateway migration aborted: %s printer mirror(s) cannot be attached to an agent, "
            "so their branch cannot be derived:\n%s\n"
            "Run a Gateway sync first (so the agents exist in Odoo), set gateway_agent_id "
            "correctly, or delete the stale mirrors, then upgrade again."
            % (
                len(orphans),
                "\n".join(
                    "  printer id=%s gateway_printer_id=%s gateway_agent_id=%s branch=%s"
                    % (r[0], r[1], r[2], r[3])
                    for r in orphans
                ),
            )
        )

    # 4. Branch disagreement -> fail loudly, never reassign silently -------
    cr.execute("""
        SELECT p.id, p.gateway_printer_id, pb.name, a.gateway_agent_id, ab.name
        FROM print_gateway_printer p
        JOIN print_gateway_agent a ON a.id = p.agent_id
        LEFT JOIN print_gateway_branch pb ON pb.id = p.branch_id
        LEFT JOIN print_gateway_branch ab ON ab.id = a.branch_id
        WHERE p.branch_id IS DISTINCT FROM a.branch_id
    """)
    conflicts = cr.fetchall()
    if conflicts:
        raise Exception(
            "print_gateway migration aborted: %s printer mirror(s) disagree with their agent about "
            "the owning branch. Refusing to move printers between branches automatically:\n%s\n"
            "Fix each conflict explicitly (move the agent, or re-point the printer at an agent in "
            "the correct branch), then upgrade again."
            % (
                len(conflicts),
                "\n".join(
                    "  printer=%s printer.branch=%s agent=%s agent.branch=%s" % (r[1], r[2], r[3], r[4])
                    for r in conflicts
                ),
            )
        )

    # 5. Integrity established. branch_id is now redundant with
    #    agent_id.branch_id; Odoo recomputes it as a stored related field on
    #    module load, so the values above are simply confirmed, not changed.
    cr.execute("ALTER TABLE print_gateway_printer ALTER COLUMN agent_id SET NOT NULL")
    cr.execute("CREATE INDEX IF NOT EXISTS print_gateway_printer_agent_id_idx ON print_gateway_printer (agent_id)")

    # Drop the old per-branch uniqueness; global uniqueness replaces it.
    cr.execute("ALTER TABLE print_gateway_printer DROP CONSTRAINT IF EXISTS print_gateway_printer_gateway_printer_id_branch_unique")
    cr.execute("ALTER TABLE print_gateway_agent DROP CONSTRAINT IF EXISTS print_gateway_agent_gateway_agent_id_branch_unique")

    _logger.info(
        "print_gateway: printer ownership migrated to Branch -> Agent -> Printer "
        "(printer.branch_id is now derived from agent_id.branch_id)"
    )
