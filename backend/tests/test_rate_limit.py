"""Tests for the per-user frame rate limiter.

The live-camera mode posts a frame per user several times a second, so this is
the only thing between one browser tab and the inference queue.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException


@pytest.fixture(autouse=True)
def clean_state(main_module):
    """Each test starts with an empty bucket."""
    with main_module.frame_rate_lock:
        main_module.frame_rate_state.clear()
    yield
    with main_module.frame_rate_lock:
        main_module.frame_rate_state.clear()


def test_allows_requests_up_to_the_limit(main_module, monkeypatch):
    monkeypatch.setattr(main_module, "FRAME_RATE_LIMIT_COUNT", 3)

    for _ in range(3):
        main_module._check_frame_rate_limit("user-a")


def test_blocks_the_request_over_the_limit(main_module, monkeypatch):
    monkeypatch.setattr(main_module, "FRAME_RATE_LIMIT_COUNT", 3)

    for _ in range(3):
        main_module._check_frame_rate_limit("user-a")

    with pytest.raises(HTTPException) as excinfo:
        main_module._check_frame_rate_limit("user-a")
    assert excinfo.value.status_code == 429


def test_limits_are_per_user(main_module, monkeypatch):
    """One noisy tab must not throttle everybody else."""
    monkeypatch.setattr(main_module, "FRAME_RATE_LIMIT_COUNT", 2)

    main_module._check_frame_rate_limit("user-a")
    main_module._check_frame_rate_limit("user-a")
    with pytest.raises(HTTPException):
        main_module._check_frame_rate_limit("user-a")

    # user-b has its own budget.
    main_module._check_frame_rate_limit("user-b")


def test_the_window_slides(main_module, monkeypatch):
    """Old timestamps drop out, so a user is not blocked for ever."""
    monkeypatch.setattr(main_module, "FRAME_RATE_LIMIT_COUNT", 2)
    monkeypatch.setattr(main_module, "FRAME_RATE_LIMIT_WINDOW_SECONDS", 1.0)

    clock = {"now": 1000.0}
    monkeypatch.setattr(main_module.time, "monotonic", lambda: clock["now"])

    main_module._check_frame_rate_limit("user-a")
    main_module._check_frame_rate_limit("user-a")
    with pytest.raises(HTTPException):
        main_module._check_frame_rate_limit("user-a")

    # Move past the window: the earlier timestamps are no longer counted.
    clock["now"] += 1.5
    main_module._check_frame_rate_limit("user-a")


def test_the_bucket_does_not_grow_without_bound(main_module, monkeypatch):
    """Entries outside the window are evicted rather than accumulated."""
    monkeypatch.setattr(main_module, "FRAME_RATE_LIMIT_COUNT", 100)
    monkeypatch.setattr(main_module, "FRAME_RATE_LIMIT_WINDOW_SECONDS", 1.0)

    clock = {"now": 1000.0}
    monkeypatch.setattr(main_module.time, "monotonic", lambda: clock["now"])

    for _ in range(50):
        main_module._check_frame_rate_limit("user-a")
        clock["now"] += 0.1

    assert len(main_module.frame_rate_state["user-a"]) <= 11
