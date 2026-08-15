from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
import io
import os
import sys
import threading
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

    def configured_url(self) -> str:
        return "http://127.0.0.1:4001" if self.available else ""

    def capabilities(self) -> dict[str, Any]:
        return {"backend": self.backend_id, "available": self.available,
                "effectiveIsolation": self.input_isolation, "activeHandleCount": 0,
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
        return {"target": context.target, "revision": "cdp:0", "verification": {}}

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
        del handle, reason
        if self.fail_close:
            raise BackendOperationError("adapter close failed", code="CLEANUP_INCOMPLETE")
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
        "cleanupPending": 0, "sessions": 0, "requests": 0, "activeLeases": 0,
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
