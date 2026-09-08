from unittest.mock import patch
import unittest

try:
    from odoo.exceptions import ValidationError
    from odoo.tests.common import TransactionCase
    from odoo.addons.print_gateway.models.gateway_config import PrintGatewayConfig
except ImportError:
    class ValidationError(Exception):
        pass
    TransactionCase = unittest.TestCase
    PrintGatewayConfig = None


class TestPrintGatewayURLTransport(TransactionCase):
    def _config(self, url):
        if not hasattr(self, 'env') or PrintGatewayConfig is None:
            self.skipTest("Odoo runtime environment not available")
        with patch.object(PrintGatewayConfig, '_validate_gateway_host'):
            return self.env['print_gateway.gateway_config'].create({
                'company_id': self.env.company.id,
                'gateway_url': url,
                'gateway_api_key': 'test-key',
            })

    def test_https_gateway_url_is_accepted(self):
        config = self._config('https://gateway.example.com')
        self.assertEqual(config.gateway_url, 'https://gateway.example.com')

    def test_http_gateway_url_is_accepted_for_explicit_deployment(self):
        config = self._config('http://gateway.example.com')
        self.assertEqual(config.gateway_url, 'http://gateway.example.com')

    def test_unsupported_gateway_url_scheme_is_rejected(self):
        with self.assertRaises(ValidationError):
            self._config('ftp://gateway.example.com')

    def test_gateway_url_without_host_is_rejected(self):
        with self.assertRaises(ValidationError):
            self._config('http://')

    def test_gateway_url_rejects_embedded_credentials_and_api_paths(self):
        with self.assertRaises(ValidationError):
            self._config('https://user:pass@gateway.example.com')
        with self.assertRaises(ValidationError):
            self._config('https://gateway.example.com/api')
