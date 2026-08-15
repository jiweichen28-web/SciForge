"""Host-approved, process-global compatibility backend for GUI-Owl."""
from __future__ import annotations

import platform
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any

from PIL import Image

from driver.backend import BackendOpenContext


@dataclass
class LegacyHandle:
    context: BackendOpenContext
    pressed_keys: set[str] = field(default_factory=set)
    pressed_buttons: set[str] = field(default_factory=set)


class LegacyPyAutoGUIBackend:
    backend_id = "legacy-pyautogui"
    input_isolation = "host-approved"

    def open(self, context: BackendOpenContext) -> LegacyHandle:
        if context.execute:
            pyautogui, _, _ = _desktop_modules()
            pyautogui.FAILSAFE = True
            pyautogui.PAUSE = 0.05
        return LegacyHandle(context)

    def observe(self, handle: object) -> Image.Image:
        current = _handle(handle)
        if current.context.screenshot_provider is not None:
            return current.context.screenshot_provider().convert("RGB")
        _, mss, _ = _desktop_modules()
        with mss.mss() as capture:
            monitor = capture.monitors[1]
            raw = capture.grab(monitor)
            return Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")

    def perform(
        self,
        handle: object,
        action: dict[str, Any],
        width: int,
        height: int,
    ) -> None:
        current = _handle(handle)
        if not current.context.execute:
            raise RuntimeError("Legacy host input is disabled for this request")
        pyautogui, mss, pyperclip = _desktop_modules()
        name = str(action.get("action") or "").lower()
        coordinate = action.get("coordinate")

        def xy() -> tuple[int, int]:
            if not isinstance(coordinate, (list, tuple)) or len(coordinate) < 2:
                raise ValueError(f"{name} requires coordinate")
            x = int(float(coordinate[0]) / 1000 * width)
            y = int(float(coordinate[1]) / 1000 * height)
            with mss.mss() as capture:
                monitor = capture.monitors[1]
            return int(monitor["left"] + x), int(monitor["top"] + y)

        if name in {"left_click", "click", "right_click", "middle_click", "double_click", "triple_click"}:
            button = "right" if name == "right_click" else "middle" if name == "middle_click" else "left"
            clicks = 3 if name == "triple_click" else 2 if name == "double_click" else 1
            current.pressed_buttons.add(button)
            pyautogui.click(*xy(), clicks=clicks, button=button, interval=0.08)
            current.pressed_buttons.discard(button)
        elif name == "mouse_move":
            pyautogui.moveTo(*xy(), duration=0.15)
        elif name in {"left_click_drag", "drag"}:
            current.pressed_buttons.add("left")
            pyautogui.dragTo(*xy(), duration=0.5, button="left")
            current.pressed_buttons.discard("left")
        elif name in {"scroll", "hscroll"}:
            if coordinate is not None:
                pyautogui.moveTo(*xy(), duration=0.15)
            pyautogui.scroll(int(action.get("pixels", 1) or 1))
        elif name == "type":
            previous = None
            try:
                try:
                    previous = pyperclip.paste()
                except Exception:  # noqa: BLE001
                    previous = None
                pyperclip.copy(str(action.get("text", "") or ""))
                _press_keys(current, ["command" if platform.system() == "Darwin" else "ctrl", "v"], pyautogui)
            finally:
                if previous is not None:
                    try:
                        pyperclip.copy(previous)
                    except Exception:  # noqa: BLE001
                        pass
        elif name in {"key", "hotkey"}:
            keys = action.get("keys") or []
            if isinstance(keys, str):
                keys = [keys]
            _press_keys(current, [str(key).lower() for key in keys], pyautogui)
        elif name == "open_app":
            app_name = str(action.get("app") or action.get("text") or "").strip()
            if platform.system() == "Darwin":
                subprocess.Popen(["open", "-a", app_name])
            elif platform.system() == "Windows":
                _press_keys(current, ["win"], pyautogui)
                time.sleep(max(0.25, current.context.settle_s))
                pyperclip.copy(app_name)
                _press_keys(current, ["ctrl", "v"], pyautogui)
                pyautogui.press("enter")
            else:
                subprocess.Popen([app_name])
        else:
            raise ValueError(f"unsupported action: {name}")
        time.sleep(current.context.settle_s)

    def close(self, handle: object, reason: str) -> None:
        current = _handle(handle)
        if not current.context.execute:
            return
        pyautogui, _, _ = _desktop_modules()
        for key in tuple(current.pressed_keys):
            pyautogui.keyUp(key)
            current.pressed_keys.discard(key)
        for button in tuple(current.pressed_buttons):
            pyautogui.mouseUp(button=button)
            current.pressed_buttons.discard(button)


def _press_keys(handle: LegacyHandle, keys: list[str], pyautogui: Any) -> None:
    if not keys:
        return
    for key in keys:
        handle.pressed_keys.add(key)
        pyautogui.keyDown(key)
    for key in reversed(keys):
        pyautogui.keyUp(key)
        handle.pressed_keys.discard(key)


def _desktop_modules() -> tuple[Any, Any, Any]:
    import mss
    import pyautogui
    import pyperclip
    return pyautogui, mss, pyperclip


def _handle(value: object) -> LegacyHandle:
    if not isinstance(value, LegacyHandle):
        raise TypeError("invalid Legacy backend handle")
    return value
