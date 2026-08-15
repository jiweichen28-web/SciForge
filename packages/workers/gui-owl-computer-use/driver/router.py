"""Fail-closed backend selection for the PR2 Legacy-only foundation."""
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

    def open(self, requested: RequestedIsolation, context: BackendOpenContext):
        if not legacy_satisfies(requested):
            raise RoutingError(
                "BACKEND_UNAVAILABLE",
                f"requested isolation {requested.value} is unavailable; Legacy fallback is forbidden",
            )
        backend = next((item for item in self.backends if item.backend_id == "legacy-pyautogui"), None)
        if backend is None:
            raise RoutingError("BACKEND_UNAVAILABLE", "Legacy PyAutoGUI backend is unavailable")
        return backend, backend.open(context)
