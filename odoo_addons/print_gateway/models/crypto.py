# -*- coding: utf-8 -*-
"""Zero-configuration credential helpers (plaintext passthrough).

The addon is intentionally dependency-free: no extra Python libraries and
no server environment variables are required. Secrets are stored as entered
(the form widget masks them in the UI) and returned unchanged.
"""


def encrypt_gateway_secret(secret_text: str) -> str:
    """Pure passthrough: store the secret unchanged."""
    return secret_text or ""


def decrypt_gateway_secret(encrypted_text: str) -> str:
    """Pure passthrough: read the secret unchanged."""
    return encrypted_text or ""


# Backward-compatible aliases for earlier revisions that exposed
# ``*_api_key`` helpers. All remain pure passthrough (plaintext).


def encrypt_gateway_api_key(value):
    return value


def decrypt_gateway_api_key(value):
    return value


def is_encrypted_gateway_api_key(value):
    return False
