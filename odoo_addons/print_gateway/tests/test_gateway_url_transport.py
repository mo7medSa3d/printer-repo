from unittest.mock import patch

# Hard imports: this module only runs under the Odoo test runner; a fallback
# previously degraded the whole file into silent skips with a green exit.
from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase
from odoo.addons.print_gateway.models.gateway_config import PrintGatewayConfig


class TestPrintGatewayURLTransport(TransactionCase):
    def _config(self, url):
        return self.env['print_gateway.gateway_config'].create({
            'company_id': self.env.company.id,
            'gateway_url': url,
            'gateway_api_key': 'test-key',
        })

    def test_https_gateway_url_is_accepted(self):
        config = self._config('https://gateway.example.com')
        self.assertEqual(config.gateway_url, 'https://gateway.example.com')

    def test_http_gateway_url_is_accepted_for_any_host(self):
        # Zero-configuration: plain HTTP works for LAN IPs, public hosts,
        # and loopback with no environment opt-in. Validated directly
        # without DB writes (gateway configs are UNIQUE per company).
        for url in (
            'http://gateway.example.com',
            'http://192.168.1.50:3000',
            'http://10.0.0.5:3000',
            'http://localhost:3000',
            'http://127.0.0.1:3000',
        ):
            with self.subTest(url=url):
                self.assertEqual(
                    PrintGatewayConfig._validate_gateway_url(url), url.rstrip('/')
                )

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
