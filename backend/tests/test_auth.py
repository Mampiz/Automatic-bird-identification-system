"""Unit tests for password hashing and token handling."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from jose import jwt


@pytest.fixture(scope="module")
def auth(main_module):  # main_module first: it sets up sys.path and the stubs
    import auth as auth_module

    return auth_module


class TestPasswordHashing:
    def test_hash_verifies_against_the_original(self, auth):
        digest = auth.hash_password("correct horse battery staple")
        assert auth.verify_password("correct horse battery staple", digest) is True

    def test_hash_rejects_a_wrong_password(self, auth):
        digest = auth.hash_password("correct horse battery staple")
        assert auth.verify_password("wrong password", digest) is False

    def test_hash_is_salted(self, auth):
        # Two hashes of the same password must differ, or a leaked table tells an
        # attacker which users share a password.
        assert auth.hash_password("same") != auth.hash_password("same")

    def test_uses_argon2(self, auth):
        assert auth.hash_password("whatever").startswith("$argon2")


class TestAccessTokens:
    def test_round_trips_the_user_id(self, auth):
        token = auth.create_access_token("user-123")
        assert auth.decode_token(token) == "user-123"

    def test_carries_an_expiry(self, auth):
        token = auth.create_access_token("user-123")
        payload = jwt.decode(token, auth.JWT_SECRET, algorithms=[auth.JWT_ALG])
        assert "exp" in payload

    def test_rejects_a_token_signed_with_another_secret(self, auth):
        forged = jwt.encode(
            {"sub": "user-123", "exp": datetime.utcnow() + timedelta(minutes=5)},
            "a-different-secret",
            algorithm=auth.JWT_ALG,
        )
        with pytest.raises(HTTPException) as excinfo:
            auth.decode_token(forged)
        assert excinfo.value.status_code == 401

    def test_rejects_an_expired_token(self, auth):
        expired = jwt.encode(
            {"sub": "user-123", "exp": datetime.utcnow() - timedelta(minutes=1)},
            auth.JWT_SECRET,
            algorithm=auth.JWT_ALG,
        )
        with pytest.raises(HTTPException) as excinfo:
            auth.decode_token(expired)
        assert excinfo.value.status_code == 401

    def test_rejects_a_token_without_a_subject(self, auth):
        subjectless = jwt.encode(
            {"exp": datetime.utcnow() + timedelta(minutes=5)},
            auth.JWT_SECRET,
            algorithm=auth.JWT_ALG,
        )
        with pytest.raises(HTTPException) as excinfo:
            auth.decode_token(subjectless)
        assert excinfo.value.status_code == 401

    @pytest.mark.parametrize("token", ["", "not-a-token", "a.b.c"])
    def test_rejects_garbage(self, auth, token):
        with pytest.raises(HTTPException):
            auth.decode_token(token)


class TestInsecureSecretList:
    """The module refuses to start in production with a placeholder secret."""

    def test_the_development_default_is_on_the_blocklist(self, auth):
        assert auth.JWT_SECRET is not None
        assert "dev_insecure_change_me" in auth.INSECURE_JWT_SECRETS
        assert "changeme" in auth.INSECURE_JWT_SECRETS
