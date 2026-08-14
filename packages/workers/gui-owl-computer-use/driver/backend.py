"""Backend protocol for the Computer Use session input channel."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Protocol

from PIL import Image


@dataclass(frozen=True)
class BackendOpenContext:
    execute: bool
    settle_s: float
    screenshot_provider: Callable[[], Image.Image] | None


class InputBackend(Protocol):
    backend_id: str
    input_isolation: str

    def open(self, context: BackendOpenContext) -> object: ...
    def observe(self, handle: object) -> Image.Image: ...
    def perform(self, handle: object, action: dict[str, Any], width: int, height: int) -> None: ...
    def close(self, handle: object, reason: str) -> None: ...
