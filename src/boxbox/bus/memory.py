"""In-process bus: zero setup, same semantics as a broker.

Each subscriber gets its own queue and dispatcher thread, so a slow consumer (the
LLM strategist) never blocks the simulator. Each topic keeps a bounded log so a late
subscriber can replay from the beginning, like a consumer group starting at the
earliest offset.
"""

from __future__ import annotations

import itertools
import logging
import queue
import threading
from collections import deque
from collections.abc import Iterable

from boxbox.bus.base import Bus, Handler, Record, now_ms

logger = logging.getLogger("boxbox.bus")

RETAIN_PER_TOPIC = 20_000
_STOP = object()


class _Subscriber:
    def __init__(self, name: str, topics: set[str], handler: Handler) -> None:
        self.name = name
        self.topics = topics
        self.handler = handler
        self.queue: queue.SimpleQueue = queue.SimpleQueue()
        self.thread = threading.Thread(target=self._run, name=f"bus-{name}", daemon=True)

    def _run(self) -> None:
        while True:
            item = self.queue.get()
            if item is _STOP:
                return
            try:
                self.handler(item)
            except Exception:  # a consumer bug must not kill its dispatcher
                logger.exception("subscriber %s failed on %s record", self.name, item.topic)


class MemoryBus(Bus):
    description = "in-memory"

    def __init__(self, retain: int = RETAIN_PER_TOPIC) -> None:
        self._lock = threading.Lock()
        self._logs: dict[str, deque[Record]] = {}
        self._subs: list[_Subscriber] = []
        self._offsets = itertools.count()
        self._retain = retain
        self._closed = False

    def publish(self, topic: str, value: dict, key: str | None = None) -> None:
        with self._lock:
            if self._closed:
                return
            record = Record(topic=topic, key=key, value=value, ts=now_ms(), offset=next(self._offsets))
            self._logs.setdefault(topic, deque(maxlen=self._retain)).append(record)
            targets = [s for s in self._subs if topic in s.topics]
            for sub in targets:
                sub.queue.put(record)

    def subscribe(self, topics: Iterable[str], handler: Handler, *, name: str, from_beginning: bool = False) -> None:
        sub = _Subscriber(name, set(topics), handler)
        with self._lock:
            if from_beginning:
                backlog = sorted(
                    (r for t in sub.topics for r in self._logs.get(t, ())),
                    key=lambda r: r.offset,
                )
                for record in backlog:
                    sub.queue.put(record)
            self._subs.append(sub)
        sub.thread.start()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            subs, self._subs = self._subs, []
        for sub in subs:
            sub.queue.put(_STOP)
