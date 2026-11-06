"""The bus contract every stage talks through.

A bus carries JSON records on named topics. Producers ``publish``; consumers
``subscribe`` with a handler that is called once per record, in publish order per
topic, on a thread owned by the bus. The same contract is implemented in-process
(:class:`~boxbox.bus.memory.MemoryBus`) and over Kafka-compatible brokers
(:class:`~boxbox.bus.kafka.KafkaBus`), so every stage runs unchanged on either.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections.abc import Callable, Iterable
from dataclasses import dataclass

CAR_TELEMETRY = "car_telemetry"
RACE_STANDINGS = "race_standings"
CAR_STATE = "car_state"
PIT_DECISIONS = "pit_decisions"
RACE_EVENTS = "race_events"
RACE_CONTROL = "race_control"

TOPICS = (CAR_TELEMETRY, RACE_STANDINGS, CAR_STATE, PIT_DECISIONS, RACE_EVENTS, RACE_CONTROL)


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class Record:
    topic: str
    key: str | None
    value: dict
    ts: int  # wall-clock epoch ms when published
    offset: int


Handler = Callable[[Record], None]


class Bus(ABC):
    """A topic bus. Implementations must be thread-safe."""

    description = "bus"

    @abstractmethod
    def publish(self, topic: str, value: dict, key: str | None = None) -> None: ...

    @abstractmethod
    def subscribe(self, topics: Iterable[str], handler: Handler, *, name: str, from_beginning: bool = False) -> None:
        """Deliver every record on ``topics`` to ``handler``.

        ``from_beginning`` replays what the bus still retains before live records.
        """

    @abstractmethod
    def close(self) -> None: ...
