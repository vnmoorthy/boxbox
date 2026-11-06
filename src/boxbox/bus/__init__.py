"""Topic buses: the in-process bus (default) and Kafka-compatible brokers."""

from boxbox.bus.base import TOPICS, Bus, Record
from boxbox.bus.memory import MemoryBus


def create_bus(broker: str | None, *, group: str = "boxbox") -> Bus:
    """``None`` or ``memory`` -> in-process bus; anything else is a Kafka bootstrap address."""
    if not broker or broker == "memory":
        return MemoryBus()
    from boxbox.bus.kafka import KafkaBus

    return KafkaBus(broker.removeprefix("kafka://"), group=group)


__all__ = ["TOPICS", "Bus", "MemoryBus", "Record", "create_bus"]
