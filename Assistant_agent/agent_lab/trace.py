from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class TraceEvent:
    sequence: int
    actor: str
    event: str
    detail: Any
    created_at: str


@dataclass
class Trace:
    enabled: bool = True
    events: list[TraceEvent] = field(default_factory=list)

    def emit(self, actor: str, event: str, detail: Any = "") -> None:
        trace_event = TraceEvent(
            sequence=len(self.events) + 1,
            actor=actor,
            event=event,
            detail=detail,
            created_at=datetime.now().astimezone().isoformat(timespec="seconds"),
        )
        self.events.append(trace_event)
        if self.enabled:
            rendered = (
                json.dumps(detail, ensure_ascii=False) if isinstance(detail, (dict, list)) else str(detail)
            )
            print(f"[{trace_event.sequence:02d}] {actor} | {event} | {rendered}")

