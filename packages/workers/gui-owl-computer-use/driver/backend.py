"""Backend protocol for the Computer Use session input channel."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol

from PIL import Image


@dataclass(frozen=True)
class BackendOpenContext:
    execute: bool
    settle_s: float
    screenshot_provider: Callable[[], Image.Image] | None
    request_id: str = ""
    target: Mapping[str, Any] | None = None
    cancellation: Any = None


class BackendOperationError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "BACKEND_UNAVAILABLE",
        may_have_taken_effect: bool = False,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.may_have_taken_effect = may_have_taken_effect
        self.details = dict(details or {})


class InputBackend(Protocol):
    backend_id: str
    input_isolation: str

    def open(self, context: BackendOpenContext) -> object: ...
    def observe(self, handle: object) -> Image.Image: ...
    def perform(self, handle: object, action: dict[str, Any], width: int, height: int) -> None: ...
    def close(self, handle: object, reason: str) -> None: ...
