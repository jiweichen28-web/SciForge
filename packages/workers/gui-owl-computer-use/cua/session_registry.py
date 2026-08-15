"""Process authority for ephemeral v1 sessions, requests and the host-input lease."""
from __future__ import annotations

import threading
from dataclasses import dataclass


class RegistryError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class RegistrySnapshot:
    sessions: int
    requests: int
    active_leases: int


class SessionRegistry:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._request_id: str | None = None
        self._cancel = threading.Event()
        self._sessions = 0

    def begin(self, request_id: str) -> threading.Event:
        with self._lock:
            if self._request_id is not None:
                if self._request_id == request_id:
                    raise RegistryError("REQUEST_ID_CONFLICT", "requestId is already active")
                raise RegistryError(
                    "HOST_INPUT_BUSY",
                    "the process-global host input desktop is already leased",
                )
            self._request_id = request_id
            self._cancel = threading.Event()
            self._sessions = 1
            return self._cancel

    def cancel(self, request_id: str) -> bool:
        with self._lock:
            if self._request_id != request_id:
                return False
            self._cancel.set()
            return True

    def finish(self, request_id: str) -> None:
        with self._lock:
            if self._request_id != request_id:
                return
            self._request_id = None
            self._sessions = 0
            self._cancel = threading.Event()

    def snapshot(self) -> RegistrySnapshot:
        with self._lock:
            active = int(self._request_id is not None)
            return RegistrySnapshot(self._sessions, active, active)
