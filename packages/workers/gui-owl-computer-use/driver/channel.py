"""One request-bound channel that owns its backend handle until cleanup."""
from __future__ import annotations

import threading
import time
from typing import Any

from PIL import Image

from .backend import InputBackend


class ChannelError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class SessionInputChannel:
    def __init__(
        self,
        *,
        request_id: str,
        cancellation: threading.Event,
        backend: InputBackend,
        handle: object,
    ) -> None:
        self.request_id = request_id
        self.cancellation = cancellation
        self.backend = backend
        self.handle = handle
        self._closed = False
        self._lock = threading.RLock()

    @property
    def cancelled(self) -> bool:
        return self.cancellation.is_set()

    def observe(self) -> Image.Image:
        with self._lock:
            self._require_open()
            if self.cancelled:
                raise ChannelError("CANCEL_PENDING", "request was cancelled before observation")
            return self.backend.observe(self.handle)

    def perform(self, action: dict[str, Any], width: int, height: int) -> None:
        with self._lock:
            self._require_open()
            if self.cancelled:
                raise ChannelError("CANCEL_PENDING", "request was cancelled before host input")
            try:
                self.backend.perform(self.handle, action, width, height)
            except ChannelError:
                raise
            except Exception as error:  # noqa: BLE001
                raise ChannelError("ACTION_OUTCOME_UNKNOWN", str(error)) from error
            if self.cancelled:
                raise ChannelError("CANCEL_PENDING", "request was cancelled after host input")

    def close(self, reason: str) -> list[str]:
        with self._lock:
            if self._closed:
                return []
            try:
                self.backend.close(self.handle, reason)
            except Exception as error:  # noqa: BLE001
                return [str(error)]
            self._closed = True
            return []

    def wait(self, seconds: float) -> None:
        end = time.monotonic() + max(0.0, min(float(seconds), 30.0))
        while True:
            self._require_open()
            if self.cancelled:
                raise ChannelError("CANCEL_PENDING", "request was cancelled while waiting")
            remaining = end - time.monotonic()
            if remaining <= 0:
                return
            self.cancellation.wait(min(0.1, remaining))

    def _require_open(self) -> None:
        if self._closed:
            raise ChannelError("CHANNEL_CLOSED", "session input channel is closed")
