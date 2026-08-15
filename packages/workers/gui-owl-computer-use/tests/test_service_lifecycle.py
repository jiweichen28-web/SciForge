"""PR2 lifecycle tests drive the real service/registry/router/channel ownership path."""
from __future__ import annotations

import os
import sys
import threading
from typing import Any

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cua import result as R  # noqa: E402
from cua.service import ComputerUseService  # noqa: E402
from driver.backends import legacy_pyautogui  # noqa: E402
from driver.router import BackendRouter  # noqa: E402


TRUSTED = {
    "requestId": "host-request",
    "runtimeId": "codex",
    "threadId": "thread-1",
    "actionId": "managed-mcp.computer_use.test",
    "invocationId": "invocation-1",
    "approval": "confirmation",
}


class FakeLegacyBackend:
    backend_id = "legacy-pyautogui"
    input_isolation = "host-approved"

    def __init__(self) -> None:
        self.open_calls = 0
        self.close_calls = 0
        self.perform_calls: list[dict[str, Any]] = []
        self.fail_close_count = 0

    def open(self, context):
        self.open_calls += 1
        return {"context": context}

    def observe(self, handle):
        provider = handle["context"].screenshot_provider
        return provider() if provider is not None else Image.new("RGB", (32, 24), "white")

    def perform(self, handle, action, width, height):
        self.perform_calls.append({"action": dict(action), "screen": [width, height]})

    def close(self, handle, reason):
        self.close_calls += 1
        if self.fail_close_count:
            self.fail_close_count -= 1
            raise RuntimeError("synthetic close failure")


def service_with(backend: FakeLegacyBackend) -> ComputerUseService:
    return ComputerUseService(router=BackendRouter([backend]))


def live_input(request_id: str, instruction: str = "type alpha") -> dict[str, Any]:
    return {
        "instruction": instruction,
        "execute": True,
        "approve": True,
        "requestId": request_id,
        "invocation": {**TRUSTED, "requestId": request_id},
    }


def run(service, value, executor):
    return service.run(value, executor, allow_execute=True, settle_s=0)


def assert_baseline(service: ComputerUseService) -> None:
    assert service.status() == {
        "backend": "legacy-pyautogui",
        "effectiveIsolation": "host-approved",
        "leaseScope": "process-global",
        "activeChannels": 0,
        "activeRequests": 0,
        "cleanupPending": 0,
        "sessions": 0,
        "requests": 0,
        "activeLeases": 0,
        "waiters": 0,
        "backendHandles": 0,
    }


def test_v1_instruction_is_forwarded_unchanged_and_approval_is_trusted():
    backend = FakeLegacyBackend()
    service = service_with(backend)
    seen: list[str] = []

    denied = run(
        service,
        {"instruction": "keep spacing", "execute": True, "approve": True},
        lambda request, channel: R.ok({}),
    )
    assert denied["error"]["code"] == "NEEDS_APPROVAL"
    assert backend.open_calls == 0

    mismatched = live_input("expected-id")
    mismatched["invocation"] = {**TRUSTED, "requestId": "different-id"}
    denied_mismatch = run(service, mismatched, lambda request, channel: R.ok({}))
    assert denied_mismatch["error"]["code"] == "NEEDS_APPROVAL"
    assert backend.open_calls == 0

    result = run(
        service,
        live_input("equivalent", "keep spacing"),
        lambda request, channel: seen.append(request["instruction"]) or R.ok({"status": "done"}),
    )
    assert result["ok"] is True
    assert seen == ["keep spacing"]
    assert_baseline(service)


def test_two_process_global_host_input_writes_cannot_overlap():
    backend = FakeLegacyBackend()
    service = service_with(backend)
    started = threading.Event()
    release = threading.Event()
    first_result: list[dict[str, Any]] = []

    def first_executor(request, channel):
        channel.perform({"action": "type", "text": "alpha"}, 32, 24)
        started.set()
        assert release.wait(5)
        return R.ok({"status": "done"})

    thread = threading.Thread(
        target=lambda: first_result.append(run(service, live_input("first"), first_executor))
    )
    thread.start()
    assert started.wait(5)
    second = run(
        service,
        live_input("second", "type beta"),
        lambda request, channel: R.ok({"status": "should-not-run"}),
    )
    assert second["error"]["code"] == "HOST_INPUT_BUSY"
    assert len(backend.perform_calls) == 1
    release.set()
    thread.join(5)
    assert first_result[0]["ok"] is True
    assert_baseline(service)


def test_duplicate_request_id_cannot_release_the_active_owner():
    backend = FakeLegacyBackend()
    service = service_with(backend)
    started = threading.Event()
    release = threading.Event()
    first_result: list[dict[str, Any]] = []

    def first_executor(request, channel):
        started.set()
        assert release.wait(5)
        return R.ok({"status": "done"})

    thread = threading.Thread(
        target=lambda: first_result.append(run(service, live_input("same-id"), first_executor))
    )
    thread.start()
    assert started.wait(5)

    duplicate = run(
        service,
        live_input("same-id", "duplicate"),
        lambda request, channel: R.ok({"status": "must-not-run"}),
    )
    assert duplicate["error"]["code"] == "REQUEST_ID_CONFLICT"
    assert service.status()["activeLeases"] == 1
    assert service.cancel({"requestId": "same-id"})["data"]["status"] == "accepted"

    release.set()
    thread.join(5)
    assert first_result[0]["ok"] is True
    assert_baseline(service)


def test_success_failure_timeout_and_cancel_all_return_to_baseline():
    backend = FakeLegacyBackend()
    service = service_with(backend)
    terminal_results = [
        R.ok({"status": "done"}),
        R.err("INTERNAL_ERROR", "synthetic failure"),
        R.err("TIMEOUT", "synthetic timeout"),
        R.err("CANCEL_PENDING", "synthetic cancel"),
    ]
    for index, expected in enumerate(terminal_results):
        result = run(
            service,
            live_input(f"terminal-{index}"),
            lambda request, channel, expected=expected: expected,
        )
        assert result["ok"] is expected["ok"]
        assert_baseline(service)


def test_cancel_reaches_active_channel_and_releases_ownership():
    backend = FakeLegacyBackend()
    service = service_with(backend)
    started = threading.Event()
    result: list[dict[str, Any]] = []

    def executor(request, channel):
        started.set()
        assert channel.cancellation.wait(5)
        return R.err("CANCEL_PENDING", "cancelled")

    thread = threading.Thread(
        target=lambda: result.append(run(service, live_input("cancel-me"), executor))
    )
    thread.start()
    assert started.wait(5)
    cancelled = service.cancel({"requestId": "cancel-me"})
    assert cancelled["data"]["status"] == "accepted"
    thread.join(5)
    assert result[0]["error"]["code"] == "CANCEL_PENDING"
    assert_baseline(service)


def test_stronger_isolation_fails_closed_without_legacy_fallback():
    backend = FakeLegacyBackend()
    service = service_with(backend)
    value = live_input("isolated") | {"requestedIsolation": "host-app-scoped"}
    result = run(service, value, lambda request, channel: R.ok({"status": "unexpected"}))
    assert result["error"]["code"] == "BACKEND_UNAVAILABLE"
    assert backend.open_calls == 0
    assert_baseline(service)


def test_failed_close_quarantines_ownership_until_reclaim_succeeds():
    backend = FakeLegacyBackend()
    backend.fail_close_count = 1
    service = service_with(backend)
    result = run(
        service,
        live_input("cleanup-retry"),
        lambda request, channel: R.ok({"status": "done"}),
    )
    assert result["error"]["code"] == "CLEANUP_INCOMPLETE"
    assert service.status()["activeChannels"] == 1
    assert service.status()["cleanupPending"] == 1
    assert service.status()["activeLeases"] == 1

    reclaimed = service.reclaim("cleanup-retry")
    assert reclaimed["data"]["reclaimed"] is True
    assert backend.close_calls == 2
    assert_baseline(service)


def test_next_run_reclaims_quarantined_cleanup_before_new_ownership():
    backend = FakeLegacyBackend()
    backend.fail_close_count = 1
    service = service_with(backend)
    first = run(
        service,
        live_input("cleanup-first"),
        lambda request, channel: R.ok({"status": "done"}),
    )
    assert first["error"]["code"] == "CLEANUP_INCOMPLETE"

    second = run(
        service,
        live_input("cleanup-second"),
        lambda request, channel: R.ok({"status": "done"}),
    )
    assert second["ok"] is True
    assert backend.close_calls == 3
    assert_baseline(service)


def test_real_legacy_backend_retains_failed_key_release_until_reclaim(monkeypatch):
    class FakePyAutoGUI:
        FAILSAFE = False
        PAUSE = 0.0

        def __init__(self) -> None:
            self.key_up_failures = 2

        def keyDown(self, key):
            return None

        def keyUp(self, key):
            if self.key_up_failures:
                self.key_up_failures -= 1
                raise RuntimeError("synthetic key release failure")

        def mouseUp(self, *, button):
            return None

    pyautogui = FakePyAutoGUI()
    monkeypatch.setattr(
        legacy_pyautogui,
        "_desktop_modules",
        lambda: (pyautogui, object(), object()),
    )
    backend = legacy_pyautogui.LegacyPyAutoGUIBackend()
    service = ComputerUseService(router=BackendRouter([backend]))

    result = run(
        service,
        live_input("real-backend-cleanup"),
        lambda request, channel: channel.perform(
            {"action": "hotkey", "keys": ["ctrl"]},
            32,
            24,
        ) or R.ok({"status": "unexpected"}),
    )
    assert result["error"]["code"] == "CLEANUP_INCOMPLETE"
    assert service.status()["activeLeases"] == 1

    reclaimed = service.reclaim("real-backend-cleanup")
    assert reclaimed["data"]["reclaimed"] is True
    assert pyautogui.key_up_failures == 0
    assert_baseline(service)


def test_repeated_runs_do_not_grow_registry_or_channel_maps():
    backend = FakeLegacyBackend()
    service = service_with(backend)
    for index in range(20):
        result = run(
            service,
            live_input(f"repeat-{index}"),
            lambda request, channel: R.ok({"status": "done"}),
        )
        assert result["ok"] is True
        assert_baseline(service)
