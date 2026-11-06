"""Assemble the pipeline's stages on a bus.

Roles: ``sim`` (race engine), ``processor`` (car_state operator), ``agent``
(strategist), ``dashboard`` (live views + web server). ``all`` runs every stage in one
process; with a Kafka-compatible broker, each role can run as its own process.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from boxbox.agents.engineer import RaceEngineer
from boxbox.agents.llm import DEFAULT_MODEL, resolve_llm
from boxbox.agents.strategist import StrategistOperator
from boxbox.bus import Bus, create_bus
from boxbox.server.state import LiveState
from boxbox.sim.engine import DEFAULT_SECONDS_PER_LAP, RaceEngine
from boxbox.stream.car_state import CarStateOperator

logger = logging.getLogger("boxbox")

ROLES = ("sim", "processor", "agent", "dashboard")


@dataclass
class PipelineConfig:
    broker: str | None = None
    roles: tuple[str, ...] = ROLES
    seconds_per_lap: float = DEFAULT_SECONDS_PER_LAP
    total_laps: int = 60
    autopilot: bool = True
    scripted_incident: bool = True
    strategist: str = "auto"
    llm: str = "auto"
    model: str = DEFAULT_MODEL
    seed: int | None = None
    autostart: bool = False
    lockstep: bool = False
    circuit: str = "silverstone"


@dataclass
class Pipeline:
    config: PipelineConfig
    bus: Bus
    engine: RaceEngine | None = None
    car_state: CarStateOperator | None = None
    strategist: StrategistOperator | None = None
    state: LiveState | None = None
    engineer: RaceEngineer | None = None
    llm: object = None
    extras: dict = field(default_factory=dict)

    def agent_info(self) -> dict:
        s = self.strategist
        if s is None:
            return {}
        return {
            "strategist": s.mode,
            "provider": s.provider,
            "model": s.model,
            "engineer_provider": self.engineer.provider if self.engineer else None,
            "inflight": s.inflight,
            "avg_latency_ms": s.avg_latency_ms(),
        }

    def start(self) -> None:
        if self.engine:
            self.engine.start()

    def stop(self) -> None:
        if self.engine:
            self.engine.stop()
        if self.strategist:
            self.strategist.close()
        self.bus.close()


def build_pipeline(config: PipelineConfig, *, bus: Bus | None = None) -> Pipeline:
    bus = bus or create_bus(config.broker, group="boxbox-" + "-".join(config.roles))
    pipe = Pipeline(config=config, bus=bus)
    needs_llm = "agent" in config.roles or "dashboard" in config.roles
    pipe.llm = resolve_llm(config.llm, config.model) if needs_llm else None
    # Subscribe consumers before the simulator can publish anything.
    if "dashboard" in config.roles:
        pipe.state = LiveState(
            bus, mode="embedded" if config.broker in (None, "memory") else "kafka", agent_info=pipe.agent_info
        )
        pipe.state.circuit = config.circuit
        pipe.engineer = RaceEngineer(pipe.state, pipe.llm)
    if "processor" in config.roles:
        pipe.car_state = CarStateOperator(bus)
    if "agent" in config.roles:
        pipe.strategist = StrategistOperator(bus, llm=pipe.llm, mode=config.strategist, total_laps=config.total_laps)
    if "sim" in config.roles:
        pipe.engine = RaceEngine(
            bus,
            seconds_per_lap=config.seconds_per_lap,
            total_laps=config.total_laps,
            autopilot=config.autopilot,
            scripted_incident=config.scripted_incident,
            circuit=config.circuit,
            seed=config.seed,
            lockstep=config.lockstep,
            autostart=config.autostart,
        )
    return pipe
