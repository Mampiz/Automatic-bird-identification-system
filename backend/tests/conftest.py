"""Test fixtures for the backend.

Two things have to happen before ``main`` can be imported at all:

* ``main`` loads the YOLO weights at import time (``model = YOLO(MODEL_PATH)``),
  so ``ultralytics`` and ``cv2`` are replaced with stubs. Unit tests should not
  need a 200 MB torch wheel, a GPU, or the checkpoints to run, and CI should not
  spend three minutes installing them to test a bounding-box conversion.
* ``db`` reads ``DATABASE_URL`` at import time and defaults to Postgres, so it is
  pointed at an in-memory SQLite database first.

Anything that genuinely needs inference belongs in an integration test that runs
with the real dependencies, not here.
"""
from __future__ import annotations

import os
import sys
import types
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent

# The application imports its own modules as top-level names ("from db import
# ..."), so the backend directory has to be importable as such.
sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("JWT_SECRET", "test-secret-not-used-anywhere-else")
os.environ.setdefault("ENV", "test")


def _stub_ultralytics() -> None:
    """Replace ultralytics with a module whose YOLO() returns a dummy model."""
    if "ultralytics" in sys.modules:
        return

    class _StubYOLO:
        def __init__(self, weights: str):
            self.weights = weights
            self.names = {0: "Parus major", 1: "Turdus merula"}

        def predict(self, *args, **kwargs):  # pragma: no cover - not exercised here
            return []

    module = types.ModuleType("ultralytics")
    module.YOLO = _StubYOLO
    sys.modules["ultralytics"] = module


def _stub_cv2() -> None:
    """Replace OpenCV with a stub exposing only the constants read at import."""
    if "cv2" in sys.modules:
        return

    module = types.ModuleType("cv2")
    module.FONT_HERSHEY_SIMPLEX = 0
    module.LINE_AA = 16
    module.CAP_PROP_FPS = 5
    module.CAP_PROP_FRAME_COUNT = 7
    module.CAP_PROP_FRAME_WIDTH = 3
    module.CAP_PROP_FRAME_HEIGHT = 4
    module.IMREAD_COLOR = 1

    def _unavailable(*_args, **_kwargs):
        raise RuntimeError("cv2 is stubbed in unit tests; this path needs an integration test")

    for name in ("VideoCapture", "VideoWriter", "imread", "imdecode", "imwrite", "rectangle", "putText"):
        setattr(module, name, _unavailable)

    sys.modules["cv2"] = module


_stub_ultralytics()
_stub_cv2()


@pytest.fixture(scope="session")
def main_module():
    """The application module, imported once with its heavy deps stubbed."""
    import main

    return main


@pytest.fixture
def app_client(monkeypatch, tmp_path):
    """A FastAPI test client backed by a throwaway SQLite database."""
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import db as db_module

    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'test.db'}",
        connect_args={"check_same_thread": False},
    )
    TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    import main as main_module_
    import models  # noqa: F401  (registers the tables on Base)

    db_module.Base.metadata.create_all(bind=engine)

    def _override_get_db():
        session = TestingSession()
        try:
            yield session
        finally:
            session.close()

    main_module_.app.dependency_overrides[db_module.get_db] = _override_get_db
    with TestClient(main_module_.app) as client:
        yield client
    main_module_.app.dependency_overrides.clear()
