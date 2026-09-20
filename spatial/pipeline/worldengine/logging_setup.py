"""Structured logs. One JSON object per line, on stdout.

RunPod ships container stdout to its log endpoint verbatim, so line-delimited
JSON is the cheapest thing that survives the trip and is still queryable.
Every record carries run_id and stage where known, because the only question
anyone ever asks of a pipeline log is "what happened to world X at stage Y".
"""
from __future__ import annotations

import contextvars
import json
import logging
import os
import sys
import time
from typing import Any

_ctx: contextvars.ContextVar[dict[str, Any]] = contextvars.ContextVar("we_ctx", default={})


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
                  + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        payload.update(_ctx.get())
        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            payload.update(extra)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str, separators=(",", ":"))


def configure(level: str | None = None) -> None:
    lvl = (level or os.environ.get("WORLDENGINE_LOG_LEVEL") or "INFO").upper()
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(JsonFormatter())
    root.addHandler(h)
    root.setLevel(lvl)
    # These three are chatty enough to bury a real error in a 40-minute run.
    for noisy in ("urllib3", "PIL", "matplotlib", "httpx"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


class log_context:
    """`with log_context(run_id=..., stage=...):` adds fields to every record
    emitted inside, including from library code."""

    def __init__(self, **fields: Any) -> None:
        self._fields = fields
        self._token: Any = None

    def __enter__(self) -> "log_context":
        merged = dict(_ctx.get())
        merged.update(self._fields)
        self._token = _ctx.set(merged)
        return self

    def __exit__(self, *exc: Any) -> None:
        if self._token is not None:
            _ctx.reset(self._token)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def log(logger: logging.Logger, level: int, msg: str, **fields: Any) -> None:
    logger.log(level, msg, extra={"fields": fields})
