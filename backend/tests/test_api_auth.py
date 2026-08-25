"""End-to-end tests of the authentication endpoints against a real database.

These run the actual FastAPI application over SQLite, so routing, form parsing,
password storage and the dependency that resolves the current user are all
exercised together.
"""
from __future__ import annotations


def register(client, email="birder@example.com", password="hunter2!"):
    return client.post("/auth/register", data={"email": email, "password": password})


def login(client, email="birder@example.com", password="hunter2!"):
    return client.post("/auth/login", data={"email": email, "password": password})


class TestRegister:
    def test_creates_an_account(self, app_client):
        response = register(app_client)
        assert response.status_code == 200
        assert response.json() == {"ok": True}

    def test_rejects_a_short_password(self, app_client):
        response = register(app_client, password="12345")
        assert response.status_code == 400

    def test_rejects_a_duplicate_email(self, app_client):
        assert register(app_client).status_code == 200
        assert register(app_client).status_code == 409

    def test_email_is_normalised(self, app_client):
        # Registering with a capitalised, padded address and logging in with the
        # plain one has to work, or users lock themselves out on a typo.
        assert register(app_client, email="  Birder@Example.COM  ").status_code == 200
        assert login(app_client, email="birder@example.com").status_code == 200

    def test_the_password_is_not_stored_in_clear(self, app_client):
        register(app_client, password="hunter2!")
        token = login(app_client).json()["access_token"]
        # Nothing in the API surface should ever echo the password back.
        me = app_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert "hunter2!" not in me.text


class TestLogin:
    def test_returns_a_bearer_token(self, app_client):
        register(app_client)
        response = login(app_client)
        assert response.status_code == 200
        body = response.json()
        assert body["token_type"] == "bearer"
        assert body["access_token"]

    def test_rejects_a_wrong_password(self, app_client):
        register(app_client)
        assert login(app_client, password="not-the-password").status_code == 401

    def test_rejects_an_unknown_account(self, app_client):
        assert login(app_client, email="nobody@example.com").status_code == 401

    def test_does_not_reveal_whether_the_account_exists(self, app_client):
        """Wrong password and unknown user must be indistinguishable."""
        register(app_client)
        wrong_password = login(app_client, password="not-the-password")
        unknown_user = login(app_client, email="nobody@example.com")
        assert wrong_password.status_code == unknown_user.status_code
        assert wrong_password.json() == unknown_user.json()


class TestMe:
    def test_returns_the_authenticated_user(self, app_client):
        register(app_client)
        token = login(app_client).json()["access_token"]

        response = app_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})

        assert response.status_code == 200
        body = response.json()
        assert body["email"] == "birder@example.com"
        assert body["id"]

    def test_requires_a_token(self, app_client):
        assert app_client.get("/auth/me").status_code == 401

    def test_rejects_a_malformed_token(self, app_client):
        response = app_client.get("/auth/me", headers={"Authorization": "Bearer nonsense"})
        assert response.status_code == 401

    def test_rejects_a_valid_token_for_a_deleted_user(self, app_client, main_module):
        """A token outliving its account must stop working immediately."""
        import auth as auth_module

        token = auth_module.create_access_token("a-user-that-never-existed")
        response = app_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401


class TestProtectedRoutes:
    def test_video_download_requires_authentication(self, app_client):
        assert app_client.get("/videos/whatever.mp4").status_code == 401

    def test_a_user_cannot_download_someone_elses_video(self, app_client):
        register(app_client)
        token = login(app_client).json()["access_token"]

        response = app_client.get(
            "/videos/not-mine.mp4", headers={"Authorization": f"Bearer {token}"}
        )

        # Authenticated but not the owner: forbidden, not "not found", and
        # certainly not the file.
        assert response.status_code == 403
