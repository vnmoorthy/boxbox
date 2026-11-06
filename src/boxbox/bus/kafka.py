"""Kafka-compatible broker bus (Apache Kafka, Redpanda, ...).

Records are JSON. Every subscriber gets its own consumer group, so each process sees
every record on its topics (the stages are independent stream-processing jobs).
Topics are created on startup with one partition, which keeps per-topic order.
"""

from __future__ import annotations

import contextlib
import json
import logging
import threading
import uuid
from collections.abc import Iterable

from boxbox.bus.base import TOPICS, Bus, Handler, Record

logger = logging.getLogger("boxbox.kafka")


class KafkaBus(Bus):
    def __init__(self, bootstrap: str, *, group: str = "boxbox") -> None:
        try:
            from kafka import KafkaAdminClient, KafkaConsumer, KafkaProducer
            from kafka.admin import NewTopic
            from kafka.errors import TopicAlreadyExistsError
        except ImportError:
            raise SystemExit(
                "Broker mode needs the Kafka client: uv sync --extra kafka (or pip install 'boxbox[kafka]')."
            ) from None
        self._consumer_cls = KafkaConsumer
        self.bootstrap = bootstrap
        self.group = group
        self.description = f"kafka://{bootstrap}"
        admin = KafkaAdminClient(bootstrap_servers=bootstrap, client_id=f"{group}-admin")
        try:
            existing = set(admin.list_topics())
            missing = [NewTopic(t, num_partitions=1, replication_factor=1) for t in TOPICS if t not in existing]
            if missing:
                with contextlib.suppress(TopicAlreadyExistsError):
                    admin.create_topics(missing)
        finally:
            admin.close()
        self._producer = KafkaProducer(
            bootstrap_servers=bootstrap,
            value_serializer=lambda v: json.dumps(v, separators=(",", ":")).encode(),
            key_serializer=lambda k: k.encode() if k is not None else None,
            linger_ms=5,
        )
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def publish(self, topic: str, value: dict, key: str | None = None) -> None:
        self._producer.send(topic, value=value, key=key)

    def subscribe(self, topics: Iterable[str], handler: Handler, *, name: str, from_beginning: bool = False) -> None:
        topics = list(topics)
        consumer = self._consumer_cls(
            *topics,
            bootstrap_servers=self.bootstrap,
            group_id=f"{self.group}-{name}-{uuid.uuid4().hex[:6]}",
            auto_offset_reset="earliest" if from_beginning else "latest",
            enable_auto_commit=False,
            value_deserializer=lambda b: json.loads(b),
            key_deserializer=lambda b: b.decode() if b is not None else None,
        )

        def run() -> None:
            while not self._stop.is_set():
                batches = consumer.poll(timeout_ms=200)
                for records in batches.values():
                    for msg in records:
                        try:
                            handler(Record(msg.topic, msg.key, msg.value, msg.timestamp, msg.offset))
                        except Exception:
                            logger.exception("subscriber %s failed on %s record", name, msg.topic)
            consumer.close()

        thread = threading.Thread(target=run, name=f"kafka-{name}", daemon=True)
        thread.start()
        self._threads.append(thread)

    def flush(self) -> None:
        self._producer.flush()

    def close(self) -> None:
        self._stop.set()
        with contextlib.suppress(Exception):
            self._producer.flush(timeout=5)
            self._producer.close(timeout=5)
