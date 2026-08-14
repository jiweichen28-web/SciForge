"""Isolation labels used by the PR2 host-desktop compatibility channel."""
from __future__ import annotations

from enum import Enum


class RequestedIsolation(str, Enum):
    AUTO = "auto"
    HOST_APPROVED = "host-approved"
    HOST_APP_SCOPED = "host-app-scoped"
    AGENT_ISOLATED = "agent-isolated"


def parse_requested_isolation(value: object) -> RequestedIsolation:
    if value is None:
        return RequestedIsolation.AUTO
    if not isinstance(value, str):
        raise ValueError("requestedIsolation must be a string")
    try:
        return RequestedIsolation(value)
    except ValueError as error:
        raise ValueError("requestedIsolation is unsupported") from error


def legacy_satisfies(requested: RequestedIsolation) -> bool:
    return requested in {RequestedIsolation.AUTO, RequestedIsolation.HOST_APPROVED}
