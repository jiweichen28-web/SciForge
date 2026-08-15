"""GUI-Owl observe/plan/act loop over one request-owned input channel."""
from __future__ import annotations

import json
import os
import platform as _platform
import re
import time
from typing import Any, Dict, List

from driver.channel import ChannelError, SessionInputChannel

from . import owl_agent, reflector
from . import result as R
from .config import Config

_OS_NAME = {"Windows": "windows", "Darwin": "macos", "Linux": "linux"}.get(
    _platform.system(), "linux"
)
_TERMINAL = {"terminate", "answer", "stop", "done", "interact", "call_user"}


def _norm_action(action: str) -> str:
    value = re.sub(r"\d+", lambda match: str(int(match.group()) // 20), (action or "").lower())
    return re.sub(r"\s+", " ", value).strip()


def _action_summary(output_text: str) -> str:
    match = re.search(r"Action:\s*(.+?)(?:<tool_call>|$)", output_text, re.DOTALL | re.IGNORECASE)
    if match:
        return re.sub(r"\s+", " ", match.group(1)).strip()[:300]
    return re.sub(r"\s+", " ", output_text).strip()[:300]


def run_task(
    cfg: Config,
    instruction: str,
    channel: SessionInputChannel,
    *,
    execute: bool = False,
    approve: bool = False,
) -> Dict[str, Any]:
    started = time.time()
    provenance = R.provenance("computer_use_run", channel.request_id, started)
    if not instruction or not instruction.strip():
        return R.err("INVALID_ARGUMENT", "instruction is required", prov=provenance)
    if execute and not (approve and cfg.allow_execute):
        return R.err(
            "NEEDS_APPROVAL",
            "Execution touches process-global host input and requires trusted approval.",
            blocked_reason="external-side-effect-requires-approval",
            prov=provenance,
        )
    run_dir = os.path.join(cfg.artifact_dir, channel.request_id)
    os.makedirs(run_dir, exist_ok=True)
    try:
        return _run_loop(cfg, instruction, channel, bool(execute), run_dir, started)
    except ChannelError as error:
        return R.err(error.code, str(error), prov=provenance)
    except Exception as error:  # noqa: BLE001
        return R.err("INTERNAL_ERROR", f"runner failed: {error}", prov=provenance)


def _run_loop(
    cfg: Config,
    instruction: str,
    channel: SessionInputChannel,
    really_execute: bool,
    run_dir: str,
    started: float,
) -> Dict[str, Any]:
    image = channel.observe()
    status = "exhausted_steps"
    answer_text = ""
    steps: List[Dict[str, Any]] = []
    artifacts: List[Dict[str, Any]] = []
    history: List[Dict[str, str]] = []
    recent_actions: List[str] = []
    progress_status = ""
    action_outcomes: List[str] = []
    replan_hint = False

    for index in range(cfg.max_steps):
        if channel.cancelled:
            status = "cancelled"
            break
        shot_path = os.path.join(run_dir, f"step{index:02d}.png")
        image.save(shot_path)
        artifacts.append(R.artifact_ref("screenshot", f"step {index} screenshot", path=shot_path))
        width, height = image.size
        try:
            messages = owl_agent.build_messages(
                instruction,
                history,
                image,
                image_window=cfg.image_window,
                progress_status=progress_status,
                replan_hint=replan_hint,
            )
            output_text = owl_agent.call_owl(
                cfg.model_router_base_url,
                cfg.model_router_model,
                cfg.model_router_api_key,
                messages,
            )
        except Exception as error:  # noqa: BLE001
            status = "error"
            steps.append({"step": index, "error": str(error)})
            break
        if channel.cancelled:
            status = "cancelled"
            break

        args = owl_agent.extract_action(output_text)
        action_type = (args.get("action") if args else "") or ""
        coordinate = (args or {}).get("coordinate")
        step_record: Dict[str, Any] = {
            "step": index,
            "plan": _action_summary(output_text),
            "action": json.dumps(args, ensure_ascii=False)[:400] if args else "<no-action>",
            "coords": owl_agent.to_screen(coordinate, width, height)
            if coordinate and len(coordinate) >= 2 else None,
            "screenshot": shot_path,
            "backend": channel.backend.backend_id,
            "executed": False,
        }
        history.append({"output": output_text, "image": shot_path})
        low = action_type.lower()
        if low in _TERMINAL:
            if low in {"interact", "call_user"}:
                answer_text = (args or {}).get("text", "") or ""
                step_record.update({"terminal": low, "text": answer_text})
                status = "needs_user"
            elif low == "answer":
                answer_text = (args or {}).get("text", "") or ""
                step_record.update({"terminal": "answer", "answer": answer_text})
                status = "agent_reported_done"
            else:
                succeeded = str((args or {}).get("status", "success")).lower() != "failure"
                step_record["terminal"] = action_type
                status = "agent_reported_done" if succeeded else "agent_reported_fail"
            steps.append(step_record)
            break
        if low == "wait":
            steps.append(step_record)
            channel.wait(float((args or {}).get("time", 2) or 2))
            image = channel.observe()
            continue

        normalized = _norm_action(step_record["action"]) or "<no-action>"
        recent_actions.append(normalized)
        del recent_actions[: -(cfg.nonprogress_limit * 2)]
        if recent_actions.count(normalized) >= cfg.nonprogress_limit:
            step_record["stuck"] = "repeated_action"
            steps.append(step_record)
            status = "stuck_repeated_action"
            break
        if not really_execute:
            steps.append(step_record)
            status = "dry_run_planned"
            break
        if not args:
            steps.append(step_record)
            image = channel.observe()
            continue

        before_image = image
        channel.perform(args, width, height)
        step_record["executed"] = True
        after_image = channel.observe()
        if cfg.reflect:
            try:
                reflection = reflector.reflect(
                    cfg,
                    instruction,
                    progress_status,
                    current_subgoal=instruction,
                    last_action=args,
                    last_summary=step_record["plan"],
                    before_img=before_image,
                    after_img=after_image,
                )
                step_record["reflect"] = {
                    "outcome": reflection["outcome"],
                    "error": reflection["error_description"],
                }
                history[-1]["reflect_outcome"] = reflection["outcome"]
                history[-1]["reflect_error"] = reflection["error_description"]
                if reflection["progress_status"]:
                    progress_status = reflection["progress_status"]
                action_outcomes.append(reflection["outcome"])
                window = action_outcomes[-cfg.reflect_escalate:]
                replan_hint = len(window) >= cfg.reflect_escalate and all(
                    outcome in {"B", "C"} for outcome in window
                )
            except Exception as error:  # noqa: BLE001
                step_record["reflect_error"] = str(error)
        steps.append(step_record)
        image = after_image

    summary = (
        f"{len(steps)} step(s); status={status}; "
        f"{'executed' if really_execute else 'dry-run (no actions performed)'}."
    )
    if answer_text:
        summary += f" answer: {answer_text[:200]}"
    width, height = image.size
    data = {
        "status": status,
        "executed": really_execute,
        "instruction": instruction,
        "answer": answer_text,
        "platform": _OS_NAME,
        "screen": [width, height],
        "steps": steps,
        "stepCount": len(steps),
        "backend": channel.backend.backend_id,
        "effectiveIsolation": channel.backend.input_isolation,
    }
    return R.ok(
        data,
        summary=summary,
        artifacts=artifacts,
        prov=R.provenance("computer_use_run", channel.request_id, started),
    )
