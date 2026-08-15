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


@dataclass(frozen=True)
class _ActiveRequest:
    session_id: str | None
    cancellation: threading.Event


class SessionRegistry:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: dict[str, str] = {}
        self._requests: dict[str, _ActiveRequest] = {}
        self._reserved_request_ids: set[str] = set()
        self._request_by_session: dict[str, str] = {}
        self._legacy_request_id: str | None = None

    def register_session(self, session_id: str, target_id: str) -> None:
        with self._lock:
            if session_id in self._sessions:
                raise RegistryError("REQUEST_ID_CONFLICT", "session id is already active")
            if target_id in self._sessions.values():
                raise RegistryError("HOST_INPUT_BUSY", "target already has an active session")
            self._sessions[session_id] = target_id

    def release_session(self, session_id: str) -> None:
        with self._lock:
            if session_id in self._request_by_session:
                raise RegistryError("HOST_INPUT_BUSY", "session has an active request")
            self._sessions.pop(session_id, None)

    def has_session(self, session_id: str) -> bool:
        with self._lock:
            return session_id in self._sessions

    def begin(self, request_id: str, session_id: str | None = None) -> threading.Event:
        with self._lock:
            if request_id in self._requests or request_id in self._reserved_request_ids:
                raise RegistryError("REQUEST_ID_CONFLICT", "requestId is already active")
            if session_id is None:
                if self._legacy_request_id is not None:
                    raise RegistryError("HOST_INPUT_BUSY", "process-global host input is already active")
            else:
                if session_id not in self._sessions:
                    raise RegistryError("NOT_FOUND", "Computer Use session is unavailable")
                if session_id in self._request_by_session:
                    raise RegistryError("HOST_INPUT_BUSY", "Computer Use session already has an active request")
            cancellation = threading.Event()
            self._requests[request_id] = _ActiveRequest(session_id, cancellation)
            if session_id is None:
                self._legacy_request_id = request_id
            else:
                self._request_by_session[session_id] = request_id
            return cancellation

    def reserve(self, request_id: str) -> None:
        """Reserve a non-backend parent request identity for a bounded batch."""
        with self._lock:
            if request_id in self._requests or request_id in self._reserved_request_ids:
                raise RegistryError("REQUEST_ID_CONFLICT", "requestId is already active")
            self._reserved_request_ids.add(request_id)

    def release_reservation(self, request_id: str) -> None:
        with self._lock:
            self._reserved_request_ids.discard(request_id)

    def cancel(self, request_id: str) -> bool:
        with self._lock:
            request = self._requests.get(request_id)
            if request is None:
                return False
            request.cancellation.set()
            return True

    def finish(self, request_id: str) -> None:
        with self._lock:
            request = self._requests.pop(request_id, None)
            if request is None:
                return
            if request.session_id is None:
                if self._legacy_request_id == request_id:
                    self._legacy_request_id = None
            elif self._request_by_session.get(request.session_id) == request_id:
                self._request_by_session.pop(request.session_id, None)

    def snapshot(self) -> RegistrySnapshot:
        with self._lock:
            active = len(self._requests) + len(self._reserved_request_ids)
            transient_legacy = int(self._legacy_request_id is not None)
            leases = len(self._sessions) + transient_legacy
            return RegistrySnapshot(len(self._sessions) + transient_legacy, active, leases)
