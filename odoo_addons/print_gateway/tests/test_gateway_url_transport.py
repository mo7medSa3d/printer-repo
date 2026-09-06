"""Gateway URL transport validation tests."""

from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase


class TestPrintGatewayURLTransport(TransactionCase):
    def _branch(self, url):
        return self.env['print_gateway.branch'].create({
            'name': 'Gateway URL Test Branch',
            'company_id': self.env.company.id,
            'gateway_url': url,
            'gateway_api_key': 'test-key',
            'enabled': True,
        })

    def test_http_gateway_url_is_accepted(self):
        branch = self._branch('http://127.0.0.1:3000')
        self.assertEqual(branch.gateway_url, 'http://127.0.0.1:3000')

    def test_https_gateway_url_is_accepted(self):
        branch = self._branch('https://gateway.example.com')
        self.assertEqual(branch.gateway_url, 'https://gateway.example.com')

    def test_unsupported_gateway_url_scheme_is_rejected(self):
        with self.assertRaises(ValidationError):
            self._branch('ftp://gateway.example.com')

    def test_gateway_url_without_host_is_rejected(self):
        with self.assertRaises(ValidationError):
            self._branch('http://')

    def test_gateway_url_without_scheme_is_rejected(self):
        with self.assertRaises(ValidationError):
            self._branch('127.0.0.1:3000')
