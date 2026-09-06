from odoo.tests.common import TransactionCase


class TestPrintGatewayPhysicalOutcome(TransactionCase):
    def _branch(self):
        company = self.env.company
        return self.env['print_gateway.branch'].create({
            'name': 'Physical Outcome Branch',
            'company_id': company.id,
            'gateway_url': 'https://gateway.example.com',
            'gateway_api_key': 'test-key',
        })

    def test_success_means_definitely_printed(self):
        branch = self._branch()
        job = self.env['print_gateway.print_job'].create({
            'branch_id': branch.id,
            'status': 'success',
            'payload': '{}',
        })
        self.assertEqual(job.physical_outcome, 'printed')

    def test_interrupted_print_is_unknown_not_failed_semantically(self):
        branch = self._branch()
        job = self.env['print_gateway.print_job'].create({
            'branch_id': branch.id,
            'status': 'failed',
            'error': 'AGENT_RESTART_DURING_PRINT: physical output is unknown',
            'payload': '{}',
        })
        self.assertEqual(job.physical_outcome, 'unknown')

    def test_ordinary_failure_is_definitely_not_printed(self):
        branch = self._branch()
        job = self.env['print_gateway.print_job'].create({
            'branch_id': branch.id,
            'status': 'failed',
            'error': 'CAPABILITY_MISMATCH',
            'payload': '{}',
        })
        self.assertEqual(job.physical_outcome, 'not_printed')

    def test_expiry_while_printing_is_unknown(self):
        branch = self._branch()
        job = self.env['print_gateway.print_job'].create({
            'branch_id': branch.id,
            'status': 'expired',
            'error': 'JOB_EXPIRED_DURING_PRINT: physical output is unknown',
            'payload': '{}',
        })
        self.assertEqual(job.physical_outcome, 'unknown')
