"""Bound-session and request authority for Computer Use."""
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
        self._request_session_id: str | None = None
        self._cancel = threading.Event()
        self._sessions: dict[str, str] = {}

    def register_session(self, session_id: str, target_id: str) -> None:
        with self._lock:
            if session_id in self._sessions:
                raise RegistryError("REQUEST_ID_CONFLICT", "session id is already active")
            if target_id in self._sessions.values():
                raise RegistryError("HOST_INPUT_BUSY", "target already has an active session")
            self._sessions[session_id] = target_id

    def release_session(self, session_id: str) -> None:
        with self._lock:
            if self._request_session_id == session_id:
                raise RegistryError("HOST_INPUT_BUSY", "session has an active request")
            self._sessions.pop(session_id, None)

    def has_session(self, session_id: str) -> bool:
        with self._lock:
            return session_id in self._sessions

    def begin(self, request_id: str, session_id: str | None = None) -> threading.Event:
        with self._lock:
            if self._request_id is not None:
                if self._request_id == request_id:
                    raise RegistryError("REQUEST_ID_CONFLICT", "requestId is already active")
                raise RegistryError("HOST_INPUT_BUSY", "a Computer Use request is already active")
            if session_id is not None and session_id not in self._sessions:
                raise RegistryError("NOT_FOUND", "Computer Use session is unavailable")
            self._request_id = request_id
            self._request_session_id = session_id
            self._cancel = threading.Event()
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
            self._request_session_id = None
            self._cancel = threading.Event()

    def snapshot(self) -> RegistrySnapshot:
        with self._lock:
            active = int(self._request_id is not None)
            transient_legacy = int(active and self._request_session_id is None)
            leases = len(self._sessions) + transient_legacy
            return RegistrySnapshot(len(self._sessions) + transient_legacy, active, leases)
