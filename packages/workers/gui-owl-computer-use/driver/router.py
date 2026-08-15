"""Fail-closed selection between target-scoped CDP and compatibility Legacy input."""
from __future__ import annotations

from cua.isolation import RequestedIsolation, legacy_satisfies

from .backend import BackendOpenContext, InputBackend


class RoutingError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class BackendRouter:
    def __init__(self, backends: list[InputBackend]) -> None:
        self.backends = tuple(backends)

    def backend(self, backend_id: str) -> InputBackend | None:
        return next((item for item in self.backends if item.backend_id == backend_id), None)

    def open(self, requested: RequestedIsolation, context: BackendOpenContext):
        if context.target is not None:
            if requested is not RequestedIsolation.HOST_APP_SCOPED:
                raise RoutingError(
                    "BACKEND_UNAVAILABLE",
                    "bound browser targets require host-app-scoped isolation",
                )
            backend = self.backend("browser-cdp")
            if backend is None:
                raise RoutingError("BACKEND_UNAVAILABLE", "CDP backend is unavailable")
            return backend, backend.open(context)
        if not legacy_satisfies(requested):
            raise RoutingError(
                "BACKEND_UNAVAILABLE",
                f"requested isolation {requested.value} is unavailable; Legacy fallback is forbidden",
            )
        backend = self.backend("legacy-pyautogui")
        if backend is None:
            raise RoutingError("BACKEND_UNAVAILABLE", "Legacy PyAutoGUI backend is unavailable")
        return backend, backend.open(context)
