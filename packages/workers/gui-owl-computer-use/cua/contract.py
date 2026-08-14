"""Public contract for the GUI-Owl computer-use worker.

This is the worker's stable surface (mirrors the TS `contract.ts` convention in
`packages/workers/*`): tool names, input/output JSON schemas, error codes, and
the mapping from a `ServiceResult` (see `result.py`) to an MCP tool result.

It has **no** runtime dependencies (no MCP SDK, no PIL, no Electron) so it can be
imported by tests, the HTTP server, and the MCP server alike.

Tool surface (capability-domain prefixed, per PROJECT_mcp.md):
  * gui_computer_use_run    -> run one natural-language desktop task
  * gui_computer_use_cancel -> stop an in-flight run between steps

Boundary: the worker returns evidence + trace + status, never a completion
truth. Screenshots are returned as artifact *refs* (paths on disk), never
inlined, so a single tool result never carries a large image payload.
"""
from __future__ import annotations

import re
from typing import Any, Dict

from . import result as R
from .isolation import parse_requested_isolation

TOOL_RUN = "gui_computer_use_run"
TOOL_CANCEL = "gui_computer_use_cancel"

# Re-exported so callers don't reach into result.py for the canonical set.
ERROR_CODES = R.ERROR_CODES
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")

RUN_INPUT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "instruction": {
            "type": "string",
            "description": "The desktop task in natural language, e.g. "
            '"open Notepad and type the meeting agenda".',
        },
        "execute": {
            "type": "boolean",
            "default": False,
            "description": "False (default) = dry-run: plan/ground only, no real "
            "mouse/keyboard. True = drive the real desktop (also needs approve + "
            "server CUA_ALLOW_EXECUTE).",
        },
        "approve": {
            "type": "boolean",
            "default": False,
            "description": "Must be true (with execute) to perform real actions. "
            "The host/runtime sets this only after a user approval gate.",
        },
        "imagePath": {
            "type": "string",
            "description": "Optional: ground against a static screenshot file "
            "instead of the live desktop (headless / dry-run testing).",
        },
        "imageBase64": {
            "type": "string",
            "description": "Optional: a base64 PNG screen, alternative to imagePath.",
        },
        "requestId": {
            "type": "string",
            "description": "Optional stable id; pass the same id to "
            "gui_computer_use_cancel to stop this run.",
        },
        "computerUseSessionId": {
            "type": "string",
            "pattern": SAFE_ID.pattern,
            "description": "Bound target session. Omit for the strict v1 Legacy path.",
        },
        "deadlineMs": {
            "type": "integer",
            "minimum": 1,
            "maximum": 600_000,
            "description": "Optional per-request deadline for target-scoped execution.",
        },
        "parallel": {
            "type": "array",
            "minItems": 2,
            "maxItems": 8,
            "description": "Two to eight independent bound-session runs.",
            "items": {
                "type": "object",
                "properties": {
                    "instruction": {"type": "string"},
                    "computerUseSessionId": {"type": "string", "pattern": SAFE_ID.pattern},
                    "deadlineMs": {"type": "integer", "minimum": 1, "maximum": 600_000},
                },
                "required": ["instruction", "computerUseSessionId"],
                "additionalProperties": False,
            },
        },
        "requestedIsolation": {
            "type": "string",
            "enum": ["auto", "host-approved", "host-app-scoped", "agent-isolated"],
            "default": "auto",
            "description": "Internal sidecar routing requirement. Legacy host input only "
            "satisfies auto or host-approved.",
        },
        "invocation": {
            "type": "object",
            "description": "Trusted Host invocation identity forwarded by the domain MCP.",
        },
    },
    "required": [],
    "oneOf": [
        {"required": ["instruction"], "not": {"required": ["parallel"]}},
        {"required": ["parallel"], "not": {"required": ["instruction"]}},
    ],
    "additionalProperties": False,
}


def normalize_run_input(value: object) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("run input must be an object")
    unknown = set(value) - set(RUN_INPUT_SCHEMA["properties"])
    if unknown:
        raise ValueError(f"unsupported fields: {', '.join(sorted(unknown))}")
    parallel = value.get("parallel")
    if parallel is not None:
        if any(field in value for field in ("instruction", "computerUseSessionId", "deadlineMs")):
            raise ValueError("parallel entries own instruction, computerUseSessionId, and deadlineMs")
        if not isinstance(parallel, list) or not 2 <= len(parallel) <= 8:
            raise ValueError("parallel must contain between 2 and 8 entries")
        entries = [_normalize_parallel_entry(entry, index) for index, entry in enumerate(parallel)]
        session_ids = [entry["computerUseSessionId"] for entry in entries]
        if len(set(session_ids)) != len(session_ids):
            raise ValueError("parallel computerUseSessionId values must be unique")
        normalized: Dict[str, Any] = {"parallel": entries}
    else:
        instruction = value.get("instruction")
        if not isinstance(instruction, str) or not instruction.strip():
            raise ValueError("instruction is required")
        if len(instruction) > 16_384:
            raise ValueError("instruction must be at most 16384 characters")
        normalized = {"instruction": instruction.strip()}
    for field in ("execute", "approve"):
        raw = value.get(field, False)
        if not isinstance(raw, bool):
            raise ValueError(f"{field} must be a boolean")
        normalized[field] = raw
    for field in ("imagePath", "imageBase64", "requestId", "computerUseSessionId"):
        raw = value.get(field)
        if raw is not None:
            if not isinstance(raw, str) or not raw.strip():
                raise ValueError(f"{field} must be a non-empty string")
            normalized[field] = raw.strip()
    deadline_ms = value.get("deadlineMs")
    if deadline_ms is not None:
        normalized["deadlineMs"] = _deadline(deadline_ms, "deadlineMs")
    requested = value.get("requestedIsolation")
    if requested is None and normalized.get("computerUseSessionId"):
        requested = "host-app-scoped"
    normalized["requestedIsolation"] = parse_requested_isolation(requested).value
    invocation = value.get("invocation")
    if invocation is not None:
        if not isinstance(invocation, dict):
            raise ValueError("invocation must be an object")
        normalized["invocation"] = dict(invocation)
    return normalized


def _normalize_parallel_entry(value: object, index: int) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"parallel[{index}] must be an object")
    unknown = set(value) - {"instruction", "computerUseSessionId", "deadlineMs"}
    if unknown:
        raise ValueError(f"parallel[{index}] has unsupported fields: {', '.join(sorted(unknown))}")
    instruction = value.get("instruction")
    session_id = value.get("computerUseSessionId")
    if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 16_384:
        raise ValueError(f"parallel[{index}].instruction must be 1-16384 characters")
    if not isinstance(session_id, str) or SAFE_ID.fullmatch(session_id) is None:
        raise ValueError(f"parallel[{index}].computerUseSessionId is required")
    normalized: Dict[str, Any] = {
        "instruction": instruction.strip(),
        "computerUseSessionId": session_id.strip(),
    }
    if "deadlineMs" in value:
        normalized["deadlineMs"] = _deadline(value["deadlineMs"], f"parallel[{index}].deadlineMs")
    return normalized


def _deadline(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 600_000:
        raise ValueError(f"{name} must be an integer between 1 and 600000")
    return value


CANCEL_INPUT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "requestId": {
            "type": "string",
            "description": "The requestId of the in-flight run to cancel.",
        }
    },
    "required": ["requestId"],
    "additionalProperties": False,
}


def service_result_to_mcp(res: Dict[str, Any]) -> Dict[str, Any]:
    """Map a ServiceResult dict to an MCP `CallToolResult`-shaped dict.

    structuredContent carries the full machine-readable result; the text content
    is a short human/model-readable summary only (per the MCP tool design rules).
    Screenshots stay as artifact refs inside structuredContent.
    """
    if res.get("ok"):
        data = res.get("data", {})
        summary = res.get("summary") or _summarize_ok(data)
        structured: Dict[str, Any] = {"ok": True, "data": data}
        for k in ("artifacts", "provenance", "warnings"):
            if k in res:
                structured[k] = res[k]
        return {
            "content": [{"type": "text", "text": summary}],
            "structuredContent": structured,
        }
    err = res.get("error", {})
    text = f"{err.get('code', 'INTERNAL_ERROR')}: {err.get('message', 'unknown error')}"
    if err.get("blockedReason"):
        text += f" (blocked: {err['blockedReason']})"
    structured = {"ok": False, "error": err}
    if "provenance" in res:
        structured["provenance"] = res["provenance"]
    return {
        "content": [{"type": "text", "text": text}],
        "structuredContent": structured,
        "isError": True,
    }


def _summarize_ok(data: Dict[str, Any]) -> str:
    return (
        f"status={data.get('status')}; "
        f"{'executed' if data.get('executed') else 'dry-run (no actions)'}; "
        f"{data.get('stepCount', 0)} step(s) on {data.get('platform')}."
    )
