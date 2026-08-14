"""Target-scoped browser-page backend backed by the domain-owned CDP adapter."""
from __future__ import annotations

import base64
import io
import threading
from dataclasses import dataclass, field
from typing import Any, Mapping
from urllib.parse import urlparse

import requests
from PIL import Image

from driver.backend import BackendOpenContext, BackendOperationError


@dataclass
class CdpHandle:
    adapter_url: str
    token: str
    adapter_handle_id: str
    target: dict[str, Any]
    generation: str
    revision: str = ""
    semantic_tree: list[dict[str, Any]] = field(default_factory=list)
    url: str = ""
    last_verification: dict[str, Any] = field(default_factory=dict)
    unknown_readback: dict[str, Any] | None = None
    closed: bool = False
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False)


class CdpAdapterBackend:
    backend_id = "browser-cdp"
    input_isolation = "host-app-scoped"

    def __init__(self, timeout_s: float = 10.0, session: requests.Session | None = None) -> None:
        if timeout_s <= 0:
            raise ValueError("CDP adapter timeout must be positive")
        self.timeout_s = timeout_s
        self._session = session
        self._adapter_url = ""
        self._token = ""
        self._lock = threading.RLock()

    def configure(self, adapter_url: str, token: str) -> None:
        normalized = _loopback(adapter_url) if adapter_url else ""
        if bool(normalized) != bool(token.strip()):
            raise ValueError("adapter URL and token must be set or cleared together")
        with self._lock:
            self._adapter_url = normalized
            self._token = token.strip()

    def configured_url(self) -> str:
        with self._lock:
            return self._adapter_url

    def capabilities(self) -> dict[str, Any]:
        with self._lock:
            configured = bool(self._adapter_url and self._token)
        if not configured:
            return {
                "backend": self.backend_id,
                "available": False,
                "effectiveIsolation": self.input_isolation,
                "reason": "CDP adapter is not configured",
            }
        data = self._request("GET", "/v1/capabilities")
        return {
            "backend": self.backend_id,
            "available": data.get("available") is True,
            "effectiveIsolation": self.input_isolation,
            "reason": data.get("reason"),
            "activeHandleCount": int(data.get("activeHandleCount") or 0),
        }

    def discover_targets(self) -> list[dict[str, Any]]:
        data = self._request("GET", "/v1/targets")
        values = data.get("targets")
        if not isinstance(values, list):
            raise BackendOperationError("CDP adapter returned an invalid target list")
        targets: list[dict[str, Any]] = []
        for value in values:
            target = _target(value)
            if target["kind"] == "browser-page":
                targets.append(target)
        return targets

    def open(self, context: BackendOpenContext) -> CdpHandle:
        if not context.target:
            raise BackendOperationError("CDP target is required", code="INVALID_ARGUMENT")
        target = _target(context.target)
        if target["kind"] != "browser-page":
            raise BackendOperationError("CDP backend accepts browser-page targets only")
        with self._lock:
            adapter_url, token = self._adapter_url, self._token
        if not adapter_url or not token:
            raise BackendOperationError("CDP adapter is unavailable")
        payload = self._request_at(adapter_url, token, "POST", "/v1/handles/open", {
            "target": target,
            "requestId": context.request_id,
        })
        handle_id = _required(payload.get("handleId"), "handleId")
        try:
            if payload.get("targetId") != target["targetId"]:
                raise BackendOperationError("CDP adapter opened a different target")
            generation = str(payload.get("generation") or "")
            if not generation or generation != target["generation"]:
                raise BackendOperationError("CDP target generation changed", code="TARGET_LOST")
        except BackendOperationError as error:
            try:
                self._request_at(adapter_url, token, "POST", "/v1/handles/close", {
                    "handleId": handle_id, "reason": "open_validation_failed",
                })
            except Exception as cleanup_error:  # noqa: BLE001
                raise BackendOperationError(
                    str(error), code=error.code,
                    details={"cleanupErrors": [str(cleanup_error)]},
                ) from error
            raise
        return CdpHandle(
            adapter_url=adapter_url,
            token=token,
            adapter_handle_id=handle_id,
            target=target,
            generation=generation,
        )

    def observe(self, handle: object) -> Image.Image:
        current = self._handle(handle)
        with current.lock:
            payload = self._readback(current)
            return _image(payload.get("imageBase64"))

    def perform(self, handle: object, action: dict[str, Any], width: int, height: int) -> None:
        del width, height
        current = self._handle(handle)
        with current.lock:
            if not current.revision:
                self._readback(current)
            request = {
                "handleId": current.adapter_handle_id,
                "expectedRevision": current.revision,
                "action": dict(action),
            }
            try:
                payload = self._request_at(
                    current.adapter_url, current.token, "POST", "/v1/action", request
                )
            except BackendOperationError as error:
                if not error.may_have_taken_effect:
                    raise
                readback: dict[str, Any] | None = None
                try:
                    readback = self._readback(current)
                except Exception as read_error:  # noqa: BLE001
                    readback = {"readbackError": str(read_error)}
                current.unknown_readback = _bounded_readback(readback)
                raise BackendOperationError(
                    f"CDP action outcome is unknown: {error}",
                    code="ACTION_OUTCOME_UNKNOWN",
                    may_have_taken_effect=True,
                    details={
                        "targetId": current.target["targetId"],
                        "readback": current.unknown_readback,
                        "writeDispatchCount": 1,
                        "providerCode": error.code,
                    },
                ) from error
            except Exception as error:  # response may have been lost after dispatch
                readback: dict[str, Any] | None = None
                try:
                    readback = self._readback(current)
                except Exception as read_error:  # noqa: BLE001
                    readback = {"readbackError": str(read_error)}
                current.unknown_readback = _bounded_readback(readback)
                raise BackendOperationError(
                    f"CDP action response was lost: {error}",
                    code="ACTION_OUTCOME_UNKNOWN",
                    may_have_taken_effect=True,
                    details={
                        "targetId": current.target["targetId"],
                        "readback": current.unknown_readback,
                        "writeDispatchCount": 1,
                    },
                ) from error
            self._assert_identity(current, payload)
            verification = payload.get("verification")
            if not isinstance(verification, dict):
                raise BackendOperationError(
                    "CDP adapter omitted target-scoped verification",
                    code="ACTION_OUTCOME_UNKNOWN",
                    may_have_taken_effect=True,
                )
            current.last_verification = dict(verification)
            current.revision = _required(payload.get("revision"), "revision")

    def cancel(self, handle: object, reason: str) -> None:
        current = self._handle(handle)
        self._request_at(current.adapter_url, current.token, "POST", "/v1/handles/cancel", {
            "handleId": current.adapter_handle_id, "reason": reason,
        })

    def close(self, handle: object, reason: str) -> None:
        current = self._handle(handle)
        with current.lock:
            if current.closed:
                return
            self._request_at(current.adapter_url, current.token, "POST", "/v1/handles/close", {
                "handleId": current.adapter_handle_id, "reason": reason,
            })
            current.closed = True

    def observation_metadata(self, handle: object) -> dict[str, Any]:
        current = self._handle(handle)
        return {
            "targetId": current.target["targetId"],
            "revision": current.revision,
            "semanticTree": list(current.semantic_tree),
            "url": current.url,
        }

    def verification(self, handle: object) -> dict[str, Any]:
        return dict(self._handle(handle).last_verification)

    def _readback(self, current: CdpHandle) -> dict[str, Any]:
        payload = self._request_at(current.adapter_url, current.token, "POST", "/v1/observe", {
            "handleId": current.adapter_handle_id,
        })
        self._assert_identity(current, payload)
        current.revision = _required(payload.get("revision"), "revision")
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        current.url = str(metadata.get("url") or "")[:4096]
        tree = metadata.get("semanticTree")
        current.semantic_tree = [dict(value) for value in tree[:256] if isinstance(value, dict)] if isinstance(tree, list) else []
        return payload

    def _assert_identity(self, current: CdpHandle, payload: Mapping[str, Any]) -> None:
        if payload.get("targetId") != current.target["targetId"]:
            raise BackendOperationError("CDP adapter returned a different target", code="TARGET_LOST")
        if payload.get("generation") != current.generation:
            raise BackendOperationError("CDP adapter generation changed", code="TARGET_LOST")

    def _request(self, method: str, path: str) -> dict[str, Any]:
        with self._lock:
            url, token = self._adapter_url, self._token
        if not url or not token:
            raise BackendOperationError("CDP adapter is unavailable")
        return self._request_at(url, token, method, path, None)

    def _request_at(
        self, url: str, token: str, method: str, path: str,
        body: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        sender = self._session.request if self._session is not None else requests.request
        try:
            response = sender(
                method, f"{url}{path}",
                headers={"Authorization": f"Bearer {token}"},
                json=dict(body) if body is not None else None,
                timeout=self.timeout_s,
                allow_redirects=False,
            )
        except requests.RequestException as error:
            if method == "POST" and path == "/v1/action" and _pre_dispatch_failure(error):
                raise BackendOperationError(
                    f"CDP action was not dispatched: {error}",
                    code="BACKEND_UNAVAILABLE",
                    may_have_taken_effect=False,
                ) from error
            raise RuntimeError(str(error)) from error
        try:
            payload = response.json()
        except Exception as error:  # noqa: BLE001
            raise RuntimeError("CDP adapter returned non-JSON") from error
        if not isinstance(payload, dict):
            raise RuntimeError("CDP adapter returned an invalid envelope")
        if not response.ok or payload.get("ok") is not True:
            error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
            raise BackendOperationError(
                str(error.get("message") or f"CDP adapter HTTP {response.status_code}"),
                code=str(error.get("code") or "BACKEND_UNAVAILABLE"),
                may_have_taken_effect=error.get("mayHaveTakenEffect") is True,
            )
        data = payload.get("data")
        if not isinstance(data, dict):
            raise RuntimeError("CDP adapter omitted data")
        return data

    @staticmethod
    def _handle(value: object) -> CdpHandle:
        if not isinstance(value, CdpHandle) or value.closed:
            raise BackendOperationError("CDP handle is unavailable", code="TARGET_LOST")
        return value


def _loopback(raw: str) -> str:
    value = raw.strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("CDP adapter must use credential-free loopback HTTP")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("CDP adapter must use credential-free loopback HTTP")
    return value


def _target(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise BackendOperationError("invalid CDP target", code="INVALID_ARGUMENT")
    target = dict(value)
    for field_name in ("targetId", "generation"):
        target[field_name] = _required(target.get(field_name), field_name)
    if target.get("kind") != "browser-page" or target.get("ownership") != "attached":
        raise BackendOperationError("unsupported CDP target", code="INVALID_ARGUMENT")
    locator = target.get("locator")
    if not isinstance(locator, Mapping):
        raise BackendOperationError("CDP target locator is missing", code="INVALID_ARGUMENT")
    target["locator"] = dict(locator)
    target["metadata"] = dict(target.get("metadata") or {})
    return target


def public_target(target: Mapping[str, Any]) -> dict[str, Any]:
    metadata = target.get("metadata") if isinstance(target.get("metadata"), Mapping) else {}
    return {
        "targetId": target["targetId"],
        "kind": "browser-page",
        "generation": target["generation"],
        "title": str(metadata.get("title") or "")[:512],
        "url": str(metadata.get("url") or "")[:4096],
    }


def _required(value: object, name: str) -> str:
    text = str(value or "").strip()
    if not text or len(text) > 4096:
        raise BackendOperationError(f"{name} is required", code="INVALID_ARGUMENT")
    return text


def _image(value: object) -> Image.Image:
    if not isinstance(value, str) or not value:
        raise BackendOperationError("CDP observation omitted screenshot")
    return Image.open(io.BytesIO(base64.b64decode(value))).convert("RGB")


def _bounded_readback(value: Mapping[str, Any] | None) -> dict[str, Any]:
    if value is None:
        return {}
    return {
        key: value.get(key)
        for key in ("targetId", "generation", "revision", "url", "semanticTree", "readbackError")
        if key in value
    }


def _pre_dispatch_failure(error: requests.RequestException) -> bool:
    if isinstance(error, requests.ConnectTimeout):
        return True
    current: BaseException | None = error
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if type(current).__name__ in {"NewConnectionError", "NameResolutionError"}:
            return True
        current = current.__cause__ or current.__context__
    return False
