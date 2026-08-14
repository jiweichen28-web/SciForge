from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
import io
import os
import sys
import threading
import time
from typing import Any

import pytest
import requests
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cua.service import ComputerUseService
from cua.session_registry import SessionRegistry
from cua.config import Config
from cua.runner import run_task
from cua import owl_agent
from driver.backend import BackendOpenContext, BackendOperationError
from driver.backends.cdp_adapter import CdpAdapterBackend
from driver.channel import ChannelError, SessionInputChannel
from driver.router import BackendRouter


TARGETS = [
    {
        "targetId": "cdp:adapter:page-1",
        "kind": "browser-page",
        "ownership": "attached",
        "generation": "generation-1",
        "locator": {"cdpEndpoint": "http://127.0.0.1:9222", "cdpTargetId": "page-1"},
        "metadata": {"title": "Alpha", "url": "http://127.0.0.1/alpha"},
    },
    {
        "targetId": "cdp:adapter:page-2",
        "kind": "browser-page",
        "ownership": "attached",
        "generation": "generation-1",
        "locator": {"cdpEndpoint": "http://127.0.0.1:9222", "cdpTargetId": "page-2"},
        "metadata": {"title": "Beta", "url": "http://127.0.0.1/beta"},
    },
]


def trusted(request_id: str = "request-1") -> dict[str, str]:
    return {
        "requestId": request_id,
        "runtimeId": "codex",
        "threadId": "thread-1",
        "actionId": "managed-mcp.computer_use.test",
        "invocationId": f"invocation-{request_id}",
        "approval": "confirmation",
    }


class FakeCdpBackend(CdpAdapterBackend):
    def __init__(self, *, available: bool = True, fail_close: bool = False) -> None:
        self.available = available
        self.fail_close = fail_close
        self.opened: list[str] = []
        self.performed: list[dict[str, Any]] = []
        self.closed = 0
        self.cancelled = 0
        self._handle_sequence = 0
        self.active_handles: set[int] = set()

    def configured_url(self) -> str:
        return "http://127.0.0.1:4001" if self.available else ""

    def capabilities(self) -> dict[str, Any]:
        return {"backend": self.backend_id, "available": self.available,
                "effectiveIsolation": self.input_isolation,
                "activeHandleCount": len(self.active_handles),
                "supportedTargetKinds": ["browser-page"],
                "requiresHostFocus": False, "affectsUserInput": False,
                "usesHostClipboard": False, "activatesTargetForObservation": True}

    def discover_targets(self) -> list[dict[str, Any]]:
        if not self.available:
            raise BackendOperationError("adapter unavailable")
        return [dict(target) for target in TARGETS]

    def open(self, context):
        assert context.target is not None
        self.opened.append(str(context.target["targetId"]))
        self._handle_sequence += 1
        self.active_handles.add(self._handle_sequence)
        return {
            "id": self._handle_sequence,
            "target": context.target,
            "revision": "cdp:0",
            "verification": {},
        }

    def observe(self, handle):
        handle["revision"] = "cdp:1"
        return Image.new("RGB", (32, 24), "white")

    def perform(self, handle, action, width, height):
        assert (width, height) == (32, 24)
        self.performed.append(dict(action))
        handle["verification"] = {
            "status": "verified", "targetId": handle["target"]["targetId"],
        }

    def observation_metadata(self, handle):
        return {
            "targetId": handle["target"]["targetId"], "revision": handle["revision"],
            "semanticTree": [{"tag": "button", "name": "Submit", "center": [500, 500]}],
            "url": handle["target"]["metadata"]["url"],
        }

    def verification(self, handle):
        return dict(handle["verification"])

    def cancel(self, handle, reason):
        del handle, reason
        self.cancelled += 1

    def close(self, handle, reason):
        del reason
        if self.fail_close:
            raise BackendOperationError("adapter close failed", code="CLEANUP_INCOMPLETE")
        self.active_handles.discard(handle["id"])
        self.closed += 1


def service(backend: FakeCdpBackend) -> ComputerUseService:
    return ComputerUseService(SessionRegistry(), BackendRouter([backend]))


def bind(runtime: ComputerUseService, target_id: str = TARGETS[0]["targetId"]):
    return runtime.bind({
        "targetId": target_id,
        "requestedIsolation": "host-app-scoped",
        "requestId": "bind-1",
        "invocation": trusted("bind-1"),
    }, settle_s=0)


def release_sessions(runtime: ComputerUseService, session_ids, prefix: str) -> None:
    for index, session_id in enumerate(session_ids):
        assert runtime.release({
            "computerUseSessionId": session_id,
            "requestId": f"{prefix}-{index}",
            "invocation": trusted(f"{prefix}-{index}"),
        })["ok"] is True


def test_real_service_registry_router_and_channel_bind_run_release_target_scope():
    backend = FakeCdpBackend()
    runtime = service(backend)
    bound = bind(runtime)
    assert bound["ok"] is True
    session_id = bound["data"]["computerUseSessionId"]
    assert backend.opened == [TARGETS[0]["targetId"]]
    assert runtime.status()["activeLeases"] == 1

    def execute(_request, channel: SessionInputChannel):
        image = channel.observe()
        channel.perform({"action": "click", "coordinate": [500, 500]}, *image.size)
        return {"ok": True, "data": {
            "observation": channel.canonical_observation(),
            "verification": channel.last_verification,
        }}

    result = runtime.run({
        "instruction": "click Submit",
        "computerUseSessionId": session_id,
        "execute": True,
        "approve": True,
        "requestId": "run-1",
        "invocation": trusted("run-1"),
    }, execute, allow_execute=True, settle_s=0)
    assert result["ok"] is True
    assert result["data"]["observation"]["targetId"] == TARGETS[0]["targetId"]
    assert result["data"]["verification"]["status"] == "verified"
    assert backend.opened == [TARGETS[0]["targetId"]]
    assert backend.performed == [{"action": "click", "coordinate": [500, 500]}]
    assert runtime.status()["requests"] == 0
    assert runtime.status()["sessions"] == 1

    released = runtime.release({
        "computerUseSessionId": session_id,
        "requestId": "release-1",
        "invocation": trusted("release-1"),
    })
    assert released["ok"] is True
    assert runtime.status() == {
        "backend": "legacy-pyautogui", "effectiveIsolation": "host-approved",
        "leaseScope": "process-global", "activeChannels": 0,
        "activeRequests": 0, "cleanupPending": 0, "sessions": 0,
        "requests": 0, "activeLeases": 0, "waiters": 0, "backendHandles": 0,
    }
    assert backend.closed == 1


def test_cancelled_target_request_releases_request_but_keeps_target_lease():
    backend = FakeCdpBackend()
    runtime = service(backend)
    session_id = bind(runtime)["data"]["computerUseSessionId"]
    entered = threading.Event()

    def execute(_request, channel: SessionInputChannel):
        entered.set()
        channel.wait(10)
        raise AssertionError("cancel should interrupt wait")

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(runtime.run, {
            "instruction": "wait", "computerUseSessionId": session_id,
            "execute": True, "approve": True, "requestId": "run-cancel",
            "invocation": trusted("run-cancel"),
        }, execute, allow_execute=True, settle_s=0)
        assert entered.wait(2)
        busy_release = runtime.release({
            "computerUseSessionId": session_id, "requestId": "release-busy",
            "invocation": trusted("release-busy"),
        })
        cancelled = runtime.cancel({"requestId": "run-cancel"})
        result = future.result(timeout=2)

    assert busy_release["ok"] is False
    assert busy_release["error"]["code"] == "HOST_INPUT_BUSY"
    assert cancelled["ok"] is True
    assert cancelled["data"]["status"] == "accepted"
    assert result["ok"] is False
    assert result["error"]["code"] == "CANCEL_PENDING"
    assert backend.cancelled == 1
    assert runtime.status()["requests"] == 0
    assert runtime.status()["sessions"] == 1
    assert runtime.status()["activeLeases"] == 1
    assert runtime.release({
        "computerUseSessionId": session_id, "requestId": "release-cancel",
        "invocation": trusted("release-cancel"),
    })["ok"] is True
    assert runtime.status()["activeLeases"] == 0


def test_distinct_target_sessions_execute_concurrently_without_cross_target_recovery():
    backend = FakeCdpBackend()
    runtime = service(backend)
    first_session = bind(runtime, TARGETS[0]["targetId"])["data"]["computerUseSessionId"]
    second_session = bind(runtime, TARGETS[1]["targetId"])["data"]["computerUseSessionId"]
    entered = {"alpha": threading.Event(), "beta": threading.Event()}
    release = threading.Event()

    def execute(request, _channel):
        entered[request["instruction"]].set()
        assert release.wait(2), "concurrent executor was not released"
        return {"ok": True, "data": {"instruction": request["instruction"]}}

    def invoke(instruction: str, session_id: str):
        return runtime.run({
            "instruction": instruction,
            "computerUseSessionId": session_id,
            "execute": True,
            "approve": True,
            "requestId": f"run-{instruction}",
            "invocation": trusted(f"run-{instruction}"),
        }, execute, allow_execute=True, settle_s=0)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(invoke, "alpha", first_session)
        assert entered["alpha"].wait(1)
        second = pool.submit(invoke, "beta", second_session)
        both_entered = entered["beta"].wait(1)
        release.set()
        results = [first.result(timeout=2), second.result(timeout=2)]

    assert both_entered is True
    assert all(result["ok"] is True for result in results)
    assert runtime.status()["requests"] == 0
    assert runtime.status()["sessions"] == 2
    assert runtime.status()["activeLeases"] == 2
    for index, session_id in enumerate((first_session, second_session)):
        assert runtime.release({
            "computerUseSessionId": session_id,
            "requestId": f"release-{index}",
            "invocation": trusted(f"release-{index}"),
        })["ok"] is True
    assert runtime.status()["activeLeases"] == 0


def test_bounded_parallel_run_uses_two_real_sessions_and_returns_resource_baseline():
    backend = FakeCdpBackend()
    runtime = service(backend)
    session_ids = [
        bind(runtime, target["targetId"])["data"]["computerUseSessionId"]
        for target in TARGETS
    ]
    barrier = threading.Barrier(2)

    def execute(request, _channel):
        barrier.wait(timeout=2)
        time.sleep(0.05)
        return {"ok": True, "data": {"instruction": request["instruction"]}}

    result = runtime.run({
        "parallel": [
            {"instruction": "alpha", "computerUseSessionId": session_ids[0]},
            {"instruction": "beta", "computerUseSessionId": session_ids[1]},
        ],
        "execute": True,
        "approve": True,
        "requestId": "batch-1",
        "invocation": trusted("batch-1"),
    }, execute, allow_execute=True, settle_s=0)

    assert result["ok"] is True
    assert result["data"]["successCount"] == 2
    assert result["data"]["failureCount"] == 0
    assert result["data"]["concurrencyEvidence"]["maxConcurrentExecutions"] == 2, (
        result["data"]["concurrencyEvidence"], result["data"]["results"]
    )
    assert len({item["requestId"] for item in result["data"]["results"]}) == 2
    status = runtime.status()
    assert status["requests"] == status["activeRequests"] == 0
    assert status["sessions"] == status["activeLeases"] == 2
    assert status["activeChannels"] == status["backendHandles"] == 2

    release_sessions(runtime, session_ids, "release-batch")
    assert {key: runtime.status()[key] for key in (
        "sessions", "requests", "activeLeases", "activeChannels", "activeRequests",
        "cleanupPending", "waiters", "backendHandles",
    )} == {
        "sessions": 0, "requests": 0, "activeLeases": 0, "activeChannels": 0,
        "activeRequests": 0, "cleanupPending": 0, "waiters": 0, "backendHandles": 0,
    }


def test_parent_cancel_latches_before_parallel_children_register_and_cleans_all_maps(monkeypatch):
    backend = FakeCdpBackend()
    runtime = service(backend)
    session_ids = [
        bind(runtime, target["targetId"])["data"]["computerUseSessionId"]
        for target in TARGETS
    ]
    original_begin = runtime.registry.begin
    begin_entered = threading.Event()
    allow_begin = threading.Event()

    def delayed_begin(request_id, session_id=None):
        begin_entered.set()
        assert allow_begin.wait(2)
        return original_begin(request_id, session_id)

    monkeypatch.setattr(runtime.registry, "begin", delayed_begin)
    executed = []
    batch_result = []

    def execute(request, _channel):
        executed.append(request["instruction"])
        return {"ok": True}

    worker = threading.Thread(target=lambda: batch_result.append(runtime.run({
        "parallel": [
            {"instruction": "alpha", "computerUseSessionId": session_ids[0]},
            {"instruction": "beta", "computerUseSessionId": session_ids[1]},
        ],
        "execute": True, "approve": True, "requestId": "batch-cancel-early",
        "invocation": trusted("batch-cancel-early"),
    }, execute, allow_execute=True, settle_s=0)))
    worker.start()
    assert begin_entered.wait(1)
    cancelled = runtime.cancel({"requestId": "batch-cancel-early"})
    busy_release = runtime.release({
        "computerUseSessionId": session_ids[0],
        "requestId": "release-during-pending-batch",
        "invocation": trusted("release-during-pending-batch"),
    })
    allow_begin.set()
    worker.join(timeout=3)

    assert not worker.is_alive()
    assert cancelled["ok"] is True
    assert busy_release["error"]["code"] == "HOST_INPUT_BUSY"
    child_statuses = {item["status"] for item in cancelled["data"]["children"]}
    assert child_statuses <= {"pending-start", "already-terminal"}
    assert "pending-start" in child_statuses
    assert batch_result[0]["data"]["failureCount"] == 2
    assert executed == []
    assert runtime.status()["requests"] == 0
    assert runtime._batch_cancellations == {}
    assert runtime._batch_children == {}
    assert runtime._child_batches == {}
    release_sessions(runtime, session_ids, "release-early-cancel")
    assert runtime.status()["activeLeases"] == 0


def test_exact_child_cancel_does_not_cancel_parallel_survivor():
    backend = FakeCdpBackend()
    runtime = service(backend)
    session_ids = [
        bind(runtime, target["targetId"])["data"]["computerUseSessionId"]
        for target in TARGETS
    ]
    entered = {"alpha": threading.Event(), "beta": threading.Event()}
    release_beta = threading.Event()
    batch_result = []

    def execute(request, channel):
        instruction = request["instruction"]
        entered[instruction].set()
        if instruction == "alpha":
            channel.wait(5)
            raise AssertionError("alpha cancellation should interrupt wait")
        assert release_beta.wait(2)
        return {"ok": True, "data": {"instruction": instruction}}

    worker = threading.Thread(target=lambda: batch_result.append(runtime.run({
        "parallel": [
            {"instruction": "alpha", "computerUseSessionId": session_ids[0]},
            {"instruction": "beta", "computerUseSessionId": session_ids[1]},
        ],
        "execute": True, "approve": True, "requestId": "batch-child-cancel",
        "invocation": trusted("batch-child-cancel"),
    }, execute, allow_execute=True, settle_s=0)))
    worker.start()
    assert entered["alpha"].wait(1) and entered["beta"].wait(1)
    assert {key: runtime.status()[key] for key in (
        "sessions", "requests", "activeLeases", "activeChannels", "activeRequests",
        "cleanupPending", "waiters", "backendHandles",
    )} == {
        "sessions": 2, "requests": 3, "activeLeases": 2, "activeChannels": 2,
        "activeRequests": 3, "cleanupPending": 0, "waiters": 0, "backendHandles": 2,
    }
    with runtime._lock:
        alpha_request_id = next(
            request_id for request_id, channel in runtime._request_channels.items()
            if channel.handle["target"]["targetId"] == TARGETS[0]["targetId"]
        )
    cancelled = runtime.cancel({"requestId": alpha_request_id})
    release_beta.set()
    worker.join(timeout=3)

    assert not worker.is_alive()
    assert cancelled["data"]["status"] == "accepted"
    assert backend.cancelled == 1
    assert batch_result[0]["data"]["successCount"] == 1
    assert batch_result[0]["data"]["failureCount"] == 1
    by_target = {item["targetId"]: item["result"] for item in batch_result[0]["data"]["results"]}
    assert by_target[TARGETS[0]["targetId"]]["error"]["code"] == "CANCEL_PENDING"
    assert by_target[TARGETS[1]["targetId"]]["ok"] is True
    assert runtime.status()["requests"] == 0
    release_sessions(runtime, session_ids, "release-child-cancel")
    assert runtime.status()["activeLeases"] == 0


def test_parent_cancel_delivery_failure_is_diagnostic_and_still_reaches_other_child():
    class SelectiveCancelBackend(FakeCdpBackend):
        def __init__(self):
            super().__init__()
            self.cancel_targets = []

        def cancel(self, handle, reason):
            del reason
            target_id = handle["target"]["targetId"]
            self.cancel_targets.append(target_id)
            if target_id == TARGETS[0]["targetId"]:
                raise BackendOperationError("synthetic child cancellation delivery failure")

    backend = SelectiveCancelBackend()
    runtime = service(backend)
    session_ids = [
        bind(runtime, target["targetId"])["data"]["computerUseSessionId"]
        for target in TARGETS
    ]
    both_entered = threading.Barrier(3)
    batch_result = []

    def execute(_request, channel):
        both_entered.wait(timeout=2)
        channel.wait(5)
        raise AssertionError("parent cancellation should interrupt both children")

    worker = threading.Thread(target=lambda: batch_result.append(runtime.run({
        "parallel": [
            {"instruction": "alpha", "computerUseSessionId": session_ids[0]},
            {"instruction": "beta", "computerUseSessionId": session_ids[1]},
        ],
        "execute": True, "approve": True, "requestId": "batch-delivery-failure",
        "invocation": trusted("batch-delivery-failure"),
    }, execute, allow_execute=True, settle_s=0)))
    worker.start()
    both_entered.wait(timeout=2)
    cancelled = runtime.cancel({"requestId": "batch-delivery-failure"})
    worker.join(timeout=3)

    assert not worker.is_alive()
    assert cancelled["ok"] is False
    assert cancelled["error"]["code"] == "CANCEL_DELIVERY_FAILED"
    statuses = {item["status"] for item in cancelled["error"]["details"]["children"]}
    assert statuses == {"accepted", "delivery-failed"}
    assert set(backend.cancel_targets) == {target["targetId"] for target in TARGETS}
    assert batch_result[0]["data"]["failureCount"] == 2
    assert runtime.status()["requests"] == 0
    release_sessions(runtime, session_ids, "release-delivery-failure")
    assert runtime.status()["activeLeases"] == 0


def test_duplicate_parent_request_id_cannot_overwrite_active_batch_ownership():
    backend = FakeCdpBackend()
    runtime = service(backend)
    session_ids = [
        bind(runtime, target["targetId"])["data"]["computerUseSessionId"]
        for target in TARGETS
    ]
    entered = threading.Barrier(3)
    finish = threading.Event()
    first_result = []
    batch_input = {
        "parallel": [
            {"instruction": "alpha", "computerUseSessionId": session_ids[0]},
            {"instruction": "beta", "computerUseSessionId": session_ids[1]},
        ],
        "execute": True, "approve": True, "requestId": "batch-duplicate",
        "invocation": trusted("batch-duplicate"),
    }

    def execute(_request, _channel):
        entered.wait(timeout=2)
        assert finish.wait(2)
        return {"ok": True}

    worker = threading.Thread(target=lambda: first_result.append(runtime.run(
        batch_input, execute, allow_execute=True, settle_s=0,
    )))
    worker.start()
    entered.wait(timeout=2)
    duplicate = runtime.run(batch_input, execute, allow_execute=True, settle_s=0)
    finish.set()
    worker.join(timeout=3)

    assert duplicate["error"]["code"] == "REQUEST_ID_CONFLICT"
    assert first_result[0]["data"]["successCount"] == 2
    assert runtime.status()["requests"] == 0
    release_sessions(runtime, session_ids, "release-duplicate")


def test_target_loss_child_does_not_fail_parallel_survivor():
    backend = FakeCdpBackend()
    runtime = service(backend)
    session_ids = [
        bind(runtime, target["targetId"])["data"]["computerUseSessionId"]
        for target in TARGETS
    ]
    barrier = threading.Barrier(2)

    def execute(request, _channel):
        barrier.wait(timeout=2)
        if request["instruction"] == "lost":
            raise ChannelError("TARGET_LOST", "synthetic target closed")
        return {"ok": True, "data": {"status": "survived"}}

    result = runtime.run({
        "parallel": [
            {"instruction": "lost", "computerUseSessionId": session_ids[0]},
            {"instruction": "survivor", "computerUseSessionId": session_ids[1]},
        ],
        "execute": True, "approve": True, "requestId": "batch-target-loss",
        "invocation": trusted("batch-target-loss"),
    }, execute, allow_execute=True, settle_s=0)

    assert result["data"]["successCount"] == result["data"]["failureCount"] == 1
    by_target = {item["targetId"]: item["result"] for item in result["data"]["results"]}
    assert by_target[TARGETS[0]["targetId"]]["error"]["code"] == "TARGET_LOST"
    assert by_target[TARGETS[1]["targetId"]]["data"]["status"] == "survived"
    assert runtime.status()["requests"] == 0
    release_sessions(runtime, session_ids, "release-target-loss")
    assert runtime.status()["activeLeases"] == 0


def test_parallel_child_deadline_is_local_and_survivor_completes():
    backend = FakeCdpBackend()
    runtime = service(backend)
    session_ids = [
        bind(runtime, target["targetId"])["data"]["computerUseSessionId"]
        for target in TARGETS
    ]
    barrier = threading.Barrier(2)

    def execute(request, channel):
        barrier.wait(timeout=2)
        if request["instruction"] == "deadline":
            channel.wait(1)
            raise AssertionError("deadline should interrupt wait")
        return {"ok": True, "data": {"status": "survived"}}

    result = runtime.run({
        "parallel": [
            {"instruction": "deadline", "computerUseSessionId": session_ids[0], "deadlineMs": 20},
            {"instruction": "survivor", "computerUseSessionId": session_ids[1]},
        ],
        "execute": True, "approve": True, "requestId": "batch-local-deadline",
        "invocation": trusted("batch-local-deadline"),
    }, execute, allow_execute=True, settle_s=0)

    assert result["data"]["successCount"] == result["data"]["failureCount"] == 1
    by_target = {item["targetId"]: item["result"] for item in result["data"]["results"]}
    assert by_target[TARGETS[0]["targetId"]]["error"]["code"] == "TIMEOUT"
    assert by_target[TARGETS[1]["targetId"]]["data"]["status"] == "survived"
    release_sessions(runtime, session_ids, "release-local-deadline")
    assert runtime.status()["activeLeases"] == 0


def test_cancel_after_action_dispatch_preserves_may_have_taken_effect_diagnostics():
    class BlockingActionBackend(FakeCdpBackend):
        def __init__(self):
            super().__init__()
            self.action_started = threading.Event()
            self.finish_action = threading.Event()

        def perform(self, handle, action, width, height):
            self.action_started.set()
            assert self.finish_action.wait(2)
            super().perform(handle, action, width, height)

    backend = BlockingActionBackend()
    runtime = service(backend)
    session_id = bind(runtime)["data"]["computerUseSessionId"]
    result = []

    def execute(_request, channel):
        image = channel.observe()
        channel.perform({"action": "click", "coordinate": [500, 500]}, *image.size)
        return {"ok": True}

    worker = threading.Thread(target=lambda: result.append(runtime.run({
        "instruction": "race", "computerUseSessionId": session_id,
        "execute": True, "approve": True, "requestId": "run-cancel-race",
        "invocation": trusted("run-cancel-race"),
    }, execute, allow_execute=True, settle_s=0)))
    worker.start()
    assert backend.action_started.wait(1)
    cancelled = runtime.cancel({"requestId": "run-cancel-race"})
    backend.finish_action.set()
    worker.join(timeout=3)

    assert cancelled["data"]["status"] == "accepted"
    assert result[0]["error"]["code"] == "CANCEL_PENDING"
    assert result[0]["error"]["details"] == {
        "mayHaveTakenEffect": True,
        "verification": {
            "status": "verified", "targetId": TARGETS[0]["targetId"],
        },
    }
    assert backend.performed == [{"action": "click", "coordinate": [500, 500]}]
    assert runtime.status()["requests"] == 0
    release_sessions(runtime, [session_id], "release-cancel-race")


def test_repeated_parallel_success_and_failure_returns_all_resource_maps_to_baseline():
    backend = FakeCdpBackend()
    runtime = service(backend)
    resource_keys = (
        "sessions", "requests", "activeLeases", "activeChannels", "activeRequests",
        "cleanupPending", "waiters", "backendHandles",
    )

    for iteration in range(20):
        session_ids = [
            bind(runtime, target["targetId"])["data"]["computerUseSessionId"]
            for target in TARGETS
        ]
        barrier = threading.Barrier(2)

        def execute(request, _channel):
            barrier.wait(timeout=2)
            if iteration % 2 and request["instruction"] == "alpha":
                raise ChannelError("TARGET_LOST", "synthetic repeated target loss")
            return {"ok": True, "data": {"status": "done"}}

        result = runtime.run({
            "parallel": [
                {"instruction": "alpha", "computerUseSessionId": session_ids[0]},
                {"instruction": "beta", "computerUseSessionId": session_ids[1]},
            ],
            "execute": True, "approve": True,
            "requestId": f"batch-repeat-{iteration}",
            "invocation": trusted(f"batch-repeat-{iteration}"),
        }, execute, allow_execute=True, settle_s=0)
        assert result["data"]["successCount"] == (1 if iteration % 2 else 2)
        assert runtime.status()["requests"] == 0
        release_sessions(runtime, session_ids, f"release-repeat-{iteration}")
        assert {key: runtime.status()[key] for key in resource_keys} == {
            key: 0 for key in resource_keys
        }
        assert backend.active_handles == set()

    assert backend.closed == 40
    assert runtime._request_channels == {}
    assert runtime._sessions == {}
    assert runtime._cleanup_pending == set()


def test_failed_target_release_is_quarantined_until_reclaim_succeeds():
    backend = FakeCdpBackend(fail_close=True)
    runtime = service(backend)
    session_id = bind(runtime)["data"]["computerUseSessionId"]

    failed = runtime.release({
        "computerUseSessionId": session_id, "requestId": "release-fail",
        "invocation": trusted("release-fail"),
    })
    assert failed["ok"] is False
    assert failed["error"]["code"] == "CLEANUP_INCOMPLETE"
    assert runtime.status()["cleanupPending"] == 1
    assert runtime.status()["sessions"] == 1
    assert runtime.status()["activeLeases"] == 1

    backend.fail_close = False
    reclaimed = runtime.reclaim(session_id)
    assert reclaimed == {"ok": True, "data": {"resourceId": session_id, "reclaimed": True}}
    assert runtime.status()["cleanupPending"] == 0
    assert runtime.status()["sessions"] == 0
    assert runtime.status()["activeLeases"] == 0
    assert backend.closed == 1


def test_invalid_planner_response_fails_before_backend_dispatch_and_releases_request(
    monkeypatch, tmp_path,
):
    backend = FakeCdpBackend()
    runtime = service(backend)
    session_id = bind(runtime)["data"]["computerUseSessionId"]
    assert runtime.configure_model_access(
        "http://127.0.0.1:4567/v1", "bridge-token", "active-agent",
    )["ok"] is True
    config = Config(
        model_router_api_key="unused", allow_execute=True,
        max_steps=1, artifact_dir=str(tmp_path),
    )

    def reject_planner(*_args, **_kwargs):
        raise owl_agent.ModelCallError(
            "Model Router HTTP 502 (computer_use_planner_unavailable): "
            "forced-function arguments are invalid"
        )

    monkeypatch.setattr(owl_agent, "call_owl", reject_planner)
    result = runtime.run({
        "instruction": "click Submit", "computerUseSessionId": session_id,
        "execute": True, "approve": True, "requestId": "run-invalid-plan",
        "invocation": trusted("run-invalid-plan"),
    }, lambda request, channel: run_task(
        runtime.planner_config(config, channel), request["instruction"], channel,
        execute=True, approve=True,
    ), allow_execute=True, settle_s=0)

    assert result["ok"] is False
    assert result["error"]["code"] == "BACKEND_UNAVAILABLE"
    assert "before action dispatch" in result["error"]["message"]
    assert "forced-function arguments are invalid" in result["error"]["details"]["plannerErrorMessage"]
    assert backend.performed == []
    assert runtime.status()["requests"] == 0
    assert runtime.status()["sessions"] == 1
    assert runtime.release({
        "computerUseSessionId": session_id, "requestId": "release-invalid-plan",
        "invocation": trusted("release-invalid-plan"),
    })["ok"] is True
    assert runtime.status()["activeLeases"] == 0


def test_planner_deadline_returns_partial_trace_after_completed_action(monkeypatch, tmp_path):
    backend = FakeCdpBackend()
    runtime = service(backend)
    session_id = bind(runtime)["data"]["computerUseSessionId"]
    assert runtime.configure_model_access(
        "http://127.0.0.1:4567/v1", "bridge-token", "active-agent",
    )["ok"] is True
    config = Config(
        model_router_api_key="unused", allow_execute=True, max_steps=2,
        artifact_dir=str(tmp_path),
    )
    calls = 0

    def planner(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return (
                'Action: click Submit\n<tool_call>'
                '{"name":"computer_use","arguments":{"action":"click","coordinate":[500,500]}}'
                '</tool_call>'
            )
        time.sleep(0.06)
        raise requests.Timeout("planner response exceeded child deadline")

    monkeypatch.setattr(owl_agent, "call_owl", planner)
    result = runtime.run({
        "instruction": "click then continue",
        "computerUseSessionId": session_id,
        "deadlineMs": 40,
        "execute": True,
        "approve": True,
        "requestId": "run-partial-timeout",
        "invocation": trusted("run-partial-timeout"),
    }, lambda request, channel: run_task(
        runtime.planner_config(config, channel), request["instruction"], channel,
        execute=True, approve=True,
    ), allow_execute=True, settle_s=0)

    assert result["ok"] is False
    assert result["error"]["code"] == "TIMEOUT"
    partial = result["error"]["details"]
    assert partial["status"] == "timed_out"
    assert partial["stepCount"] == 1
    assert partial["steps"][0]["executed"] is True
    assert partial["targetId"] == TARGETS[0]["targetId"]
    assert partial["backend"] == "browser-cdp"
    assert partial["requestedIsolation"] == "host-app-scoped"
    assert partial["effectiveIsolation"] == "host-app-scoped"
    assert partial["finalObservation"]["revision"] == "cdp:1"
    assert runtime.status()["requests"] == 0


def test_cdp_unavailable_never_falls_back_to_legacy():
    backend = FakeCdpBackend(available=False)
    runtime = service(backend)
    result = bind(runtime)
    assert result["ok"] is False
    assert result["error"]["code"] == "BACKEND_UNAVAILABLE"
    assert backend.opened == []
    assert runtime.status()["activeChannels"] == 0


def test_capability_discovery_fails_closed_when_adapter_transport_is_down():
    backend = FakeCdpBackend()

    def unavailable():
        raise requests.ConnectionError("adapter transport unavailable")

    backend.capabilities = unavailable
    capabilities = service(backend).capabilities()
    assert capabilities["backends"][0]["backend"] == "legacy-pyautogui"
    assert capabilities["backends"][1] == {
        "backend": "browser-cdp", "available": False,
        "effectiveIsolation": "host-app-scoped",
        "reason": "CDP adapter is unavailable (ConnectionError).",
        "supportedTargetKinds": ["browser-page"],
        "requiresHostFocus": False, "affectsUserInput": False,
        "usesHostClipboard": False, "activatesTargetForObservation": True,
        "leaseScope": "target",
    }


class FakeResponse:
    def __init__(self, data: dict[str, Any], status: int = 200) -> None:
        self._data = data
        self.status_code = status
        self.ok = 200 <= status < 300

    def json(self):
        return self._data


class TransportLossSession:
    def __init__(self) -> None:
        self.paths: list[str] = []

    def request(self, method, url, **kwargs):
        del method, kwargs
        path = url.split("/v1", 1)[1]
        self.paths.append(path)
        if path == "/action":
            raise requests.ConnectionError("response lost")
        if path == "/observe":
            image = Image.new("RGB", (2, 2), "white")
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            return FakeResponse({"ok": True, "data": {
                "targetId": TARGETS[0]["targetId"], "generation": "generation-1",
                "revision": "cdp:2", "url": "http://127.0.0.1/after",
                "semanticTree": [{"tag": "output", "name": "possibly changed"}],
                "imageBase64": base64.b64encode(buffer.getvalue()).decode(),
            }})
        raise AssertionError(path)


def test_post_dispatch_transport_loss_is_unknown_single_write_with_one_readback():
    transport = TransportLossSession()
    backend = CdpAdapterBackend(session=transport)
    handle = type("Handle", (), {})()
    from driver.backends.cdp_adapter import CdpHandle
    handle = CdpHandle(
        adapter_url="http://127.0.0.1:4001", token="test-token",
        adapter_handle_id="handle-1", target=TARGETS[0], generation="generation-1",
        revision="cdp:1",
    )
    channel = SessionInputChannel(
        request_id="run-1", cancellation=threading.Event(), backend=backend, handle=handle,
    )
    with pytest.raises(ChannelError) as caught:
        channel.perform({"action": "type", "text": "alpha"}, 2, 2)
    assert caught.value.code == "ACTION_OUTCOME_UNKNOWN"
    assert caught.value.details["writeDispatchCount"] == 1
    assert caught.value.details["targetId"] == TARGETS[0]["targetId"]
    assert transport.paths.count("/action") == 1
    assert transport.paths.count("/observe") == 1


class ParallelTransportLossSession:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.handles: dict[str, dict[str, Any]] = {}
        self.action_counts: dict[str, int] = {}
        self.observe_counts: dict[str, int] = {}

    def request(self, method, url, **kwargs):
        path = url.split("/v1", 1)[1]
        body = kwargs.get("json") or {}
        if method == "GET" and path == "/targets":
            return FakeResponse({"ok": True, "data": {"targets": TARGETS}})
        if path == "/handles/open":
            target = body["target"]
            handle_id = f"handle-{target['targetId'].rsplit('-', 1)[-1]}"
            with self._lock:
                self.handles[handle_id] = target
            return FakeResponse({"ok": True, "data": {
                "handleId": handle_id, "targetId": target["targetId"],
                "generation": target["generation"],
            }})
        if path == "/action":
            handle_id = body["handleId"]
            with self._lock:
                self.action_counts[handle_id] = self.action_counts.get(handle_id, 0) + 1
            raise requests.ConnectionError("response lost after target-scoped dispatch")
        if path == "/observe":
            handle_id = body["handleId"]
            with self._lock:
                target = self.handles[handle_id]
                self.observe_counts[handle_id] = self.observe_counts.get(handle_id, 0) + 1
                revision = self.observe_counts[handle_id]
            image = Image.new("RGB", (2, 2), "white")
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            return FakeResponse({"ok": True, "data": {
                "targetId": target["targetId"], "generation": target["generation"],
                "revision": f"cdp:{revision}", "imageBase64": base64.b64encode(buffer.getvalue()).decode(),
                "metadata": {"url": target["metadata"]["url"], "semanticTree": [
                    {"tag": "output", "name": f"readback-{handle_id}"},
                ]},
            }})
        if path == "/handles/close":
            with self._lock:
                self.handles.pop(body["handleId"], None)
            return FakeResponse({"ok": True, "data": {"closed": True}})
        raise AssertionError((method, path))


def test_parallel_post_dispatch_losses_each_write_once_read_back_once_and_never_replay():
    transport = ParallelTransportLossSession()
    backend = CdpAdapterBackend(session=transport)
    backend.configure("http://127.0.0.1:4001", "test-token")
    runtime = ComputerUseService(SessionRegistry(), BackendRouter([backend]))
    session_ids = [
        bind(runtime, target["targetId"])["data"]["computerUseSessionId"]
        for target in TARGETS
    ]

    def execute(_request, channel):
        image = channel.observe()
        channel.perform({"action": "type", "text": "one-write"}, *image.size)
        raise AssertionError("transport loss must not be treated as success")

    result = runtime.run({
        "parallel": [
            {"instruction": "alpha", "computerUseSessionId": session_ids[0]},
            {"instruction": "beta", "computerUseSessionId": session_ids[1]},
        ],
        "execute": True, "approve": True, "requestId": "batch-transport-loss",
        "invocation": trusted("batch-transport-loss"),
    }, execute, allow_execute=True, settle_s=0)

    assert result["data"]["successCount"] == 0
    assert result["data"]["failureCount"] == 2
    assert {item["result"]["error"]["code"] for item in result["data"]["results"]} == {
        "ACTION_OUTCOME_UNKNOWN",
    }
    assert set(transport.action_counts.values()) == {1}
    assert set(transport.observe_counts.values()) == {2}
    assert runtime.status()["requests"] == 0
    release_sessions(runtime, session_ids, "release-transport-loss")
    assert transport.handles == {}
    assert runtime.status()["backendHandles"] == 0


class OpenGenerationMismatchSession:
    def __init__(self) -> None:
        self.paths: list[str] = []

    def request(self, method, url, **kwargs):
        del method, kwargs
        path = url.split("/v1", 1)[1]
        self.paths.append(path)
        if path == "/handles/open":
            return FakeResponse({"ok": True, "data": {
                "handleId": "handle-provisional", "targetId": TARGETS[0]["targetId"],
                "generation": "wrong-generation",
            }})
        if path == "/handles/close":
            return FakeResponse({"ok": True, "data": {"closed": True}})
        raise AssertionError(path)


def test_open_generation_mismatch_closes_provisional_adapter_handle():
    transport = OpenGenerationMismatchSession()
    backend = CdpAdapterBackend(session=transport)
    backend.configure("http://127.0.0.1:4001", "test-token")
    with pytest.raises(BackendOperationError) as caught:
        backend.open(BackendOpenContext(
            execute=True, settle_s=0, screenshot_provider=None,
            request_id="bind-mismatch", target=TARGETS[0], cancellation=threading.Event(),
        ))
    assert caught.value.code == "TARGET_LOST"
    assert transport.paths == ["/handles/open", "/handles/close"]


class PreDispatchTimeoutSession:
    def __init__(self) -> None:
        self.paths: list[str] = []

    def request(self, method, url, **kwargs):
        del method, kwargs
        path = url.split("/v1", 1)[1]
        self.paths.append(path)
        raise requests.ConnectTimeout("connect timed out before dispatch")


def test_pre_dispatch_connect_timeout_is_classified_without_readback():
    transport = PreDispatchTimeoutSession()
    backend = CdpAdapterBackend(session=transport)
    from driver.backends.cdp_adapter import CdpHandle
    handle = CdpHandle(
        adapter_url="http://127.0.0.1:4001", token="test-token",
        adapter_handle_id="handle-1", target=TARGETS[0], generation="generation-1",
        revision="cdp:1",
    )
    channel = SessionInputChannel(
        request_id="run-1", cancellation=threading.Event(), backend=backend, handle=handle,
    )
    with pytest.raises(ChannelError) as caught:
        channel.perform({"action": "click", "coordinate": [1, 1]}, 2, 2)
    assert caught.value.code == "BACKEND_UNAVAILABLE"
    assert transport.paths == ["/action"]
