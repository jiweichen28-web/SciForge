"""Single lifecycle authority for the v1 Computer Use compatibility path."""
from __future__ import annotations

import re
import threading
import uuid
from typing import Any, Callable

from driver.backend import BackendOpenContext
from driver.channel import ChannelError, SessionInputChannel
from driver.router import BackendRouter, RoutingError

from . import contract
from . import result as R
from .isolation import RequestedIsolation
from .session_registry import RegistryError, SessionRegistry


ChannelExecutor = Callable[[dict[str, Any], SessionInputChannel], dict[str, Any]]


def _default_router() -> BackendRouter:
    from driver.backends.legacy_pyautogui import LegacyPyAutoGUIBackend
    return BackendRouter([LegacyPyAutoGUIBackend()])


class ComputerUseService:
    def __init__(
        self,
        registry: SessionRegistry | None = None,
        router: BackendRouter | None = None,
    ) -> None:
        self.registry = registry or SessionRegistry()
        self.router = router or _default_router()
        self._channels: dict[str, SessionInputChannel] = {}
        self._cleanup_pending: set[str] = set()
        self._lock = threading.RLock()

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
        if request["execute"] and not (
            request["approve"]
            and allow_execute
            and _trusted_invocation(request.get("invocation"), request_id)
        ):
            return R.err(
                "NEEDS_APPROVAL",
                "Execution touches process-global host input and requires trusted Host approval.",
                blocked_reason="external-side-effect-requires-approval",
            )

        ownership_acquired = False
        channel: SessionInputChannel | None = None
        cleanup_errors: list[str] = []
        result: dict[str, Any]
        try:
            recovery = self.reclaim_pending()
            if not recovery["ok"]:
                return recovery
            cancellation = self.registry.begin(request_id)
            ownership_acquired = True
            backend, handle = self.router.open(
                RequestedIsolation(request["requestedIsolation"]),
                BackendOpenContext(
                    execute=request["execute"],
                    settle_s=settle_s,
                    screenshot_provider=screenshot_provider,
                ),
            )
            channel = SessionInputChannel(
                request_id=request_id,
                cancellation=cancellation,
                backend=backend,
                handle=handle,
            )
            with self._lock:
                self._channels[request_id] = channel
            result = executor(request, channel)
        except RegistryError as error:
            result = R.err(error.code, str(error))
        except RoutingError as error:
            result = R.err(
                error.code,
                str(error),
                blocked_reason="requested-isolation-unavailable",
            )
        except ChannelError as error:
            result = R.err(error.code, str(error))
        except Exception as error:  # noqa: BLE001
            result = R.err("INTERNAL_ERROR", str(error), retryable=False)
        finally:
            if channel is not None:
                cleanup_errors = channel.close("request_terminal")
            if cleanup_errors:
                # A backend that did not close may still own host input. Keep the
                # process-global lease and channel quarantined until a retry reclaims it.
                with self._lock:
                    self._cleanup_pending.add(request_id)
            elif ownership_acquired:
                with self._lock:
                    self._channels.pop(request_id, None)
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
        return R.ok({"requestId": request_id, "status": "accepted" if cancelled else "not-found"})

    def reclaim(self, request_id: str) -> dict[str, Any]:
        with self._lock:
            channel = self._channels.get(request_id)
        if channel is None:
            return R.ok({"requestId": request_id, "reclaimed": False})
        errors = channel.close("reclaim")
        if errors:
            return R.err(
                "CLEANUP_INCOMPLETE",
                "Legacy channel cleanup remains incomplete.",
                details={"requestId": request_id, "errors": errors},
            )
        with self._lock:
            self._channels.pop(request_id, None)
            self._cleanup_pending.discard(request_id)
        self.registry.finish(request_id)
        return R.ok({"requestId": request_id, "reclaimed": True})

    def reclaim_pending(self) -> dict[str, Any]:
        with self._lock:
            request_ids = tuple(self._cleanup_pending)
        errors: list[dict[str, Any]] = []
        for request_id in request_ids:
            result = self.reclaim(request_id)
            if not result["ok"]:
                errors.append({
                    "requestId": request_id,
                    "error": result.get("error", {}),
                })
        if errors:
            return R.err(
                "CLEANUP_INCOMPLETE",
                "Pending Legacy input cleanup could not be reclaimed.",
                details={"pending": errors},
            )
        return R.ok({"reclaimed": len(request_ids)})

    def status(self) -> dict[str, Any]:
        with self._lock:
            active_channels = len(self._channels)
            cleanup_pending = len(self._cleanup_pending)
        snapshot = self.registry.snapshot()
        return {
            "backend": "legacy-pyautogui",
            "effectiveIsolation": "host-approved",
            "leaseScope": "process-global",
            "activeChannels": active_channels,
            "cleanupPending": cleanup_pending,
            "sessions": snapshot.sessions,
            "requests": snapshot.requests,
            "activeLeases": snapshot.active_leases,
        }


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
