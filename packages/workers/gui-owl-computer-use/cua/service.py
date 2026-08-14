"""Single lifecycle authority for Legacy v1 and target-scoped CDP sessions."""
from __future__ import annotations

import re
import threading
import uuid
from dataclasses import replace
from typing import Any, Callable

from driver.backend import BackendOpenContext
from driver.backends.cdp_adapter import CdpAdapterBackend, public_target
from driver.channel import ChannelError, SessionInputChannel
from driver.router import BackendRouter, RoutingError

from . import contract
from . import result as R
from .isolation import RequestedIsolation
from .session_registry import RegistryError, SessionRegistry


ChannelExecutor = Callable[[dict[str, Any], SessionInputChannel], dict[str, Any]]


def _default_router() -> BackendRouter:
    from driver.backends.legacy_pyautogui import LegacyPyAutoGUIBackend
    return BackendRouter([LegacyPyAutoGUIBackend(), CdpAdapterBackend()])


class ComputerUseService:
    def __init__(
        self,
        registry: SessionRegistry | None = None,
        router: BackendRouter | None = None,
    ) -> None:
        self.registry = registry or SessionRegistry()
        self.router = router or _default_router()
        self._request_channels: dict[str, SessionInputChannel] = {}
        self._sessions: dict[str, SessionInputChannel] = {}
        self._session_targets: dict[str, dict[str, Any]] = {}
        self._cleanup_pending: set[str] = set()
        self._model_access: dict[str, str] = {}
        self._lock = threading.RLock()

    def configure_cdp_adapter(
        self, adapter_url: str, token: str, *, expected_adapter_url: str = ""
    ) -> dict[str, Any]:
        backend = self._cdp()
        with self._lock:
            if self._sessions or self._request_channels or self._cleanup_pending:
                return R.err("HOST_INPUT_BUSY", "CDP adapter cannot change while resources are active")
            if not adapter_url and expected_adapter_url and backend.configured_url() != expected_adapter_url:
                return R.ok({"configured": bool(backend.configured_url()), "cleared": False})
            try:
                backend.configure(adapter_url, token)
            except ValueError as error:
                return R.err("INVALID_ARGUMENT", str(error))
        return R.ok({"configured": bool(adapter_url), "cleared": not bool(adapter_url)})

    def configure_model_access(
        self, base_url: str, api_key: str, model: str, *, expected_base_url: str = ""
    ) -> dict[str, Any]:
        with self._lock:
            if self._request_channels:
                return R.err("HOST_INPUT_BUSY", "planner access cannot change while requests are active")
            current = self._model_access.get("base_url", "")
            if not base_url and expected_base_url and current != expected_base_url:
                return R.ok({"configured": bool(current), "cleared": False})
            if bool(base_url) != bool(api_key) or bool(base_url) != bool(model):
                return R.err("INVALID_ARGUMENT", "baseUrl, apiKey and model must be set or cleared together")
            self._model_access = (
                {"base_url": base_url, "api_key": api_key, "model": model}
                if base_url else {}
            )
        return R.ok({"configured": bool(base_url), "cleared": not bool(base_url)})

    def planner_config(self, config, channel: SessionInputChannel):
        if channel.backend.backend_id != "browser-cdp":
            return config
        with self._lock:
            access = dict(self._model_access)
        if not access:
            raise ChannelError("BACKEND_UNAVAILABLE", "Host Agent planner bridge is unavailable")
        return replace(
            config,
            model_router_base_url=access["base_url"],
            model_router_api_key=access["api_key"],
            model_router_model=access["model"],
        )

    def capabilities(self) -> dict[str, Any]:
        try:
            cdp = self._cdp().capabilities()
        except Exception as error:  # noqa: BLE001
            cdp = {
                "backend": "browser-cdp",
                "available": False,
                "effectiveIsolation": "host-app-scoped",
                "reason": f"CDP adapter is unavailable ({type(error).__name__}).",
            }
        return {
            "backends": [
                {
                    "backend": "legacy-pyautogui",
                    "available": True,
                    "effectiveIsolation": "host-approved",
                    "leaseScope": "process-global",
                },
                {**cdp, "leaseScope": "target"},
            ]
        }

    def targets(self) -> dict[str, Any]:
        try:
            targets = self._cdp().discover_targets()
            return R.ok({"targets": [public_target(target) for target in targets]})
        except Exception as error:  # noqa: BLE001
            return R.err("BACKEND_UNAVAILABLE", str(error))

    def bind(self, value: object, *, settle_s: float) -> dict[str, Any]:
        if not isinstance(value, dict):
            return R.err("INVALID_ARGUMENT", "bind input must be an object")
        request_id = str(value.get("requestId") or "")
        if not _trusted_invocation(value.get("invocation"), request_id):
            return R.err("NEEDS_APPROVAL", "binding a browser target requires trusted Host approval")
        target_id = str(value.get("targetId") or "")
        requested = str(value.get("requestedIsolation") or "host-app-scoped")
        if requested != "host-app-scoped":
            return R.err("BACKEND_UNAVAILABLE", "browser targets require host-app-scoped isolation")
        try:
            target = next(
                (candidate for candidate in self._cdp().discover_targets() if candidate["targetId"] == target_id),
                None,
            )
            if target is None:
                return R.err("NOT_FOUND", "target is unavailable")
            cancellation = threading.Event()
            backend, handle = self.router.open(
                RequestedIsolation.HOST_APP_SCOPED,
                BackendOpenContext(
                    execute=True,
                    settle_s=settle_s,
                    screenshot_provider=None,
                    request_id=request_id,
                    target=target,
                    cancellation=cancellation,
                ),
            )
            session_id = f"session-{uuid.uuid4()}"
            channel = SessionInputChannel(
                request_id=request_id,
                cancellation=cancellation,
                backend=backend,
                handle=handle,
            )
            with self._lock:
                self._sessions[session_id] = channel
                self._session_targets[session_id] = target
            try:
                self.registry.register_session(session_id, target_id)
            except Exception:
                with self._lock:
                    self._sessions.pop(session_id, None)
                    self._session_targets.pop(session_id, None)
                channel.close("bind_failed")
                raise
            return R.ok({
                "computerUseSessionId": session_id,
                "target": public_target(target),
                "backend": "browser-cdp",
                "effectiveIsolation": "host-app-scoped",
                "leaseScope": "target",
            })
        except RegistryError as error:
            return R.err(error.code, str(error))
        except RoutingError as error:
            return R.err(error.code, str(error), blocked_reason="requested-isolation-unavailable")
        except Exception as error:  # noqa: BLE001
            return R.err("BACKEND_UNAVAILABLE", str(error))

    def release(self, value: object) -> dict[str, Any]:
        if not isinstance(value, dict):
            return R.err("INVALID_ARGUMENT", "release input must be an object")
        request_id = str(value.get("requestId") or "")
        if not _trusted_invocation(value.get("invocation"), request_id):
            return R.err("NEEDS_APPROVAL", "releasing a browser target requires trusted Host approval")
        session_id = str(value.get("computerUseSessionId") or "")
        with self._lock:
            channel = self._sessions.get(session_id)
            active = channel is not None and channel in self._request_channels.values()
            if channel is None:
                return R.err("NOT_FOUND", "Computer Use session is unavailable")
            if active:
                return R.err("HOST_INPUT_BUSY", "Computer Use session has an active request")
            # Keep service authority across the close/forget transition so a
            # target run cannot register between the active check and release.
            errors = channel.close("client_release")
            if errors:
                self._cleanup_pending.add(session_id)
                return R.err(
                    "CLEANUP_INCOMPLETE",
                    "CDP session cleanup did not release its adapter handle.",
                    details={"computerUseSessionId": session_id, "errors": errors},
                )
            self._forget_session(session_id)
        return R.ok({"computerUseSessionId": session_id, "status": "closed"})

    def run(
        self,
        value: object,
        executor: ChannelExecutor,
        *,
        allow_execute: bool,
        settle_s: float,
        screenshot_provider=None,
    ) -> dict[str, Any]:
        try:
            request = contract.normalize_run_input(value)
        except ValueError as error:
            return R.err("INVALID_ARGUMENT", str(error))
        request_id = request.get("requestId") or f"request-{uuid.uuid4()}"
        request["requestId"] = request_id
        session_id = request.get("computerUseSessionId")
        if request["execute"] and not (
            request["approve"] and allow_execute and
            _trusted_invocation(request.get("invocation"), request_id)
        ):
            return R.err(
                "NEEDS_APPROVAL",
                "Execution requires trusted Host approval.",
                blocked_reason="external-side-effect-requires-approval",
            )

        ownership_acquired = False
        persistent_session = bool(session_id)
        channel: SessionInputChannel | None = None
        cleanup_errors: list[str] = []
        result: dict[str, Any]
        try:
            recovery = self.reclaim_pending()
            if not recovery["ok"]:
                return recovery
            if session_id:
                with self._lock:
                    cancellation = self.registry.begin(request_id, session_id)
                    ownership_acquired = True
                    channel = self._sessions.get(session_id)
                    if channel is None:
                        raise RegistryError("NOT_FOUND", "Computer Use session is unavailable")
                    channel.request_id = request_id
                    channel.cancellation = cancellation
                    self._request_channels[request_id] = channel
            else:
                cancellation = self.registry.begin(request_id, session_id)
                ownership_acquired = True
                backend, handle = self.router.open(
                    RequestedIsolation(request["requestedIsolation"]),
                    BackendOpenContext(
                        execute=request["execute"], settle_s=settle_s,
                        screenshot_provider=screenshot_provider,
                        request_id=request_id, cancellation=cancellation,
                    ),
                )
                channel = SessionInputChannel(
                    request_id=request_id, cancellation=cancellation,
                    backend=backend, handle=handle,
                )
                with self._lock:
                    self._request_channels[request_id] = channel
            result = executor(request, channel)
        except RegistryError as error:
            result = R.err(error.code, str(error))
        except RoutingError as error:
            result = R.err(error.code, str(error), blocked_reason="requested-isolation-unavailable")
        except ChannelError as error:
            result = R.err(error.code, str(error), details=error.details or None)
        except Exception as error:  # noqa: BLE001
            result = R.err("INTERNAL_ERROR", str(error), retryable=False)
        finally:
            if channel is not None and not persistent_session:
                cleanup_errors = channel.close("request_terminal")
            if cleanup_errors:
                with self._lock:
                    self._cleanup_pending.add(request_id)
            elif ownership_acquired:
                with self._lock:
                    self._request_channels.pop(request_id, None)
                    self._cleanup_pending.discard(request_id)
                self.registry.finish(request_id)
        if cleanup_errors:
            return R.err(
                "CLEANUP_INCOMPLETE",
                "Legacy channel cleanup did not release process-global host input.",
                details={"requestId": request_id, "errors": cleanup_errors},
            )
        return result

    def cancel(self, value: object) -> dict[str, Any]:
        if not isinstance(value, dict) or not isinstance(value.get("requestId"), str):
            return R.err("INVALID_ARGUMENT", "requestId is required")
        request_id = value["requestId"]
        cancelled = self.registry.cancel(request_id)
        with self._lock:
            channel = self._request_channels.get(request_id)
        errors = channel.cancel_backend("client_cancel") if cancelled and channel else []
        if errors:
            return R.err("CLEANUP_INCOMPLETE", "backend cancellation failed", details={"errors": errors})
        return R.ok({"requestId": request_id, "status": "accepted" if cancelled else "not-found"})

    def reclaim(self, resource_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(resource_id)
            request = self._request_channels.get(resource_id)
            channel = session or request
            if channel is None:
                return R.ok({"resourceId": resource_id, "reclaimed": False})
            if session is not None and channel in self._request_channels.values():
                return R.err("HOST_INPUT_BUSY", "session has an active request")
            errors = channel.close("reclaim")
            if errors:
                return R.err("CLEANUP_INCOMPLETE", "channel cleanup remains incomplete", details={
                    "resourceId": resource_id, "errors": errors,
                })
            if session is not None:
                self._forget_session(resource_id)
            else:
                self._request_channels.pop(resource_id, None)
                self._cleanup_pending.discard(resource_id)
                self.registry.finish(resource_id)
        return R.ok({"resourceId": resource_id, "reclaimed": True})

    def reclaim_pending(self) -> dict[str, Any]:
        with self._lock:
            resource_ids = tuple(self._cleanup_pending)
        errors = []
        for resource_id in resource_ids:
            result = self.reclaim(resource_id)
            if not result["ok"]:
                errors.append({"resourceId": resource_id, "error": result.get("error", {})})
        if errors:
            return R.err("CLEANUP_INCOMPLETE", "Pending cleanup could not be reclaimed", details={"pending": errors})
        return R.ok({"reclaimed": len(resource_ids)})

    def status(self) -> dict[str, Any]:
        with self._lock:
            unique_channels = {id(channel) for channel in [*self._sessions.values(), *self._request_channels.values()]}
            cleanup_pending = len(self._cleanup_pending)
            session_backends = {channel.backend.backend_id for channel in self._sessions.values()}
        snapshot = self.registry.snapshot()
        return {
            "backend": "browser-cdp" if "browser-cdp" in session_backends else "legacy-pyautogui",
            "effectiveIsolation": "host-app-scoped" if "browser-cdp" in session_backends else "host-approved",
            "leaseScope": "target" if "browser-cdp" in session_backends else "process-global",
            "activeChannels": len(unique_channels),
            "cleanupPending": cleanup_pending,
            "sessions": snapshot.sessions,
            "requests": snapshot.requests,
            "activeLeases": snapshot.active_leases,
        }

    def _forget_session(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)
            self._session_targets.pop(session_id, None)
            self._cleanup_pending.discard(session_id)
        self.registry.release_session(session_id)

    def _cdp(self) -> CdpAdapterBackend:
        backend = self.router.backend("browser-cdp")
        if not isinstance(backend, CdpAdapterBackend):
            raise RuntimeError("CDP backend is unavailable")
        return backend


def _trusted_invocation(value: object, request_id: str) -> bool:
    if not isinstance(value, dict) or value.get("approval") != "confirmation":
        return False
    required = ("requestId", "runtimeId", "threadId", "actionId", "invocationId")
    return value.get("requestId") == request_id and all(
        isinstance(value.get(field), str)
        and bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", value[field]))
        for field in required
    )


SERVICE = ComputerUseService()
