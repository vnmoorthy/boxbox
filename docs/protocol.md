# BoxBox protocol: streams, events, and the web API

BoxBox is a real-time AI pit wall. A race simulator streams a car's telemetry; stream operators window it, join it with live standings, and run anomaly detection; a strategist agent reads every window and calls `STAY OUT`, `PIT SOON`, or `PIT NOW`; the car obeys (closed loop); a web dashboard shows everything live.

This file is the contract between the backend (`src/boxbox/*`) and the web app (`src/boxbox/web/*`).

## Topics

Every stage talks over named topics on a bus. The default bus is in-process (zero setup); the same topics run over any Kafka-compatible broker with `--broker`.

| Topic | Key | Producer | One record per |
|---|---|---|---|
| `car_telemetry` | car number | simulator | sensor reading (10 per lap, hero car only) |
| `race_standings` | car number | simulator | car per lap (22 per lap) |
| `car_state` | car number | `car_state` operator | 20-second window (= 1 lap of sim time) |
| `pit_decisions` | car number | `pit_strategy_agent` | `car_state` window |
| `race_events` | none | simulator / control | race event (pit stop, scenario, flag, finish, ...) |
| `race_control` | none | web app / CLI | command to the simulator |

Times: `event_time`, `window_start`, `window_end` are **simulation** epoch milliseconds (one lap = 20 000 ms of sim time, whatever the playback speed). `ts` on a wire event is **wall-clock** epoch milliseconds.

### `car_telemetry`

```json
{"car_number": 88, "lap": 24, "lap_fraction": 0.35, "event_time": 1793900000000,
 "tire_temp_fl_c": 144.8, "tire_temp_fr_c": 104.6, "tire_temp_rl_c": 101.2, "tire_temp_rr_c": 100.1,
 "tire_pressure_fl_psi": 20.8, "tire_pressure_fr_psi": 20.9, "tire_pressure_rl_psi": 19.9, "tire_pressure_rr_psi": 19.9,
 "engine_temp_c": 120.4, "brake_temp_fl_c": 452.1, "brake_temp_fr_c": 468.0,
 "battery_charge_pct": 71.2, "fuel_remaining_kg": 27.2, "drs_active": false,
 "speed_kph": 301.4, "throttle_pct": 88.0, "brake_pct": 0.0}
```

`lap_fraction` is where the hero car is around the lap (0 = start/finish line).

### `race_standings`

```json
{"car_number": 88, "driver": "Elio Varga", "driver_code": "VAR", "team": "Kestrel Racing", "team_color": "#12e3a5",
 "lap": 24, "position": 8, "gap_to_leader_sec": 21.4, "gap_to_ahead_sec": 0.9,
 "last_lap_time_sec": 92.81, "pit_stops": 0, "tire_compound": "SOFT", "tire_age_laps": 24,
 "in_pit_lane": false, "event_time": 1793900000000}
```

`tire_compound` is `SOFT`, `MEDIUM`, or `HARD`. `in_pit_lane` is true on the lap a car stops.

### `car_state`

One row per window: averages of the window's telemetry, the standings row as of the window, and the detector's verdicts.

```json
{"car_number": 88, "lap": 24, "window_start": 1793900000000, "window_end": 1793900020000,
 "tire_temp_fl_c": 145.1, "tire_temp_fr_c": 104.7, "tire_temp_rl_c": 101.3, "tire_temp_rr_c": 100.2,
 "tire_pressure_fl_psi": 20.8, "tire_pressure_fr_psi": 20.9, "tire_pressure_rl_psi": 19.9, "tire_pressure_rr_psi": 19.9,
 "engine_temp_c": 120.1, "brake_temp_fl_c": 449.0, "brake_temp_fr_c": 461.2,
 "battery_charge_pct": 70.9, "fuel_remaining_kg": 27.2,
 "position": 8, "gap_to_ahead_sec": 0.9, "gap_to_leader_sec": 21.4, "pit_stops": 0,
 "tire_compound": "SOFT", "tire_age_laps": 24,
 "anomaly_tire_temp_fl": true, "anomaly_tire_pressure_fl": false, "anomaly_engine_temp": false,
 "bounds": {
   "tire_temp_fl_c": {"expected": 105.2, "lower": 101.9, "upper": 108.5},
   "tire_pressure_fl_psi": {"expected": 20.8, "lower": 20.3, "upper": 21.3},
   "engine_temp_c": {"expected": 120.0, "lower": 117.1, "upper": 122.9}
 },
 "training_windows": 23, "safety_car": false, "readings": 10}
```

A `bounds` entry is `null` while its detector is still training (fewer than 6 windows in the current stint).

### `pit_decisions`

```json
{"car_number": 88, "lap": 24, "position": 8, "tire_compound_current": "SOFT", "tire_age_laps": 24,
 "anomaly_tire_temp_fl": true, "anomaly_tire_pressure_fl": false, "anomaly_engine_temp": false,
 "suggestion": "PIT NOW",
 "condition_summary": "Front-left tire anomaly at 145C, 37C above its expected upper bound.",
 "race_context": "P8, 21.4s off the lead with 36 laps remaining.",
 "recommended_tire_compound": "MEDIUM", "recommended_stint_laps": 36,
 "recommended_reason": "Mediums reach the flag in one stint.",
 "reasoning": "The detector flagged the front-left as outside its expected bounds ...",
 "raw_response": "Suggestion: PIT NOW\n...",
 "agent": "claude", "model": "claude-opus-5-5", "phase": "final", "latency_ms": 1840,
 "window_end": 1793900020000, "decided_at": 1793900021840}
```

`suggestion` is exactly `STAY OUT`, `PIT SOON`, or `PIT NOW`. Recommended fields are `null` for `STAY OUT`. `agent` is `claude` or `rules` (which brain made the call).

`phase` is `final` or `reflex`. On an incident lap (any anomaly flag or the safety car) with an LLM brain, the rules engine first publishes a `reflex` decision within milliseconds so the car can react, then Claude's `final` decision for the same lap follows. Keep the latest decision per lap; a lap can have a reflex and a final. The autopilot acts on the first `PIT NOW`.

### `race_events`

`{"kind": "...", "lap": 24, "race_id": 3, "message": "human readable", "data": {...}}`

| kind | data |
|---|---|
| `race_start` | `race_id`, `total_laps`, `seconds_per_lap`, `circuit`, `our_car`, `grid: [{car_number, driver, driver_code, team, team_color, start_position, start_tire}]`, `scripted_incidents: [{lap, kind}]` |
| `settings` | `seconds_per_lap`, `autopilot`, `scripted_incident`, `state`: sent at race start and whenever one changes |
| `scenario` | `kind`, `label`, `source` (`manual` or `scripted`) |
| `scenario_end` | `kind`, `label` |
| `box_call` | `car_number`, `compound`, `by` (`agent`, `engineer`, or `tyre_life`), `decision_lap` (the lap of the PIT NOW decision, or null) |
| `pit_stop` | `car_number`, `driver`, `driver_code`, `from_compound`, `to_compound`, `reason` (`agent`, `engineer`, `strategy` for scripted rival stops, `tyre_life`), `stop_time_sec` (sent for every car that stops) |
| `flag` | `flag`: `GREEN`, `SC` (safety car), `CHEQUERED` |
| `paused` / `resumed` | none |
| `abandoned` | none: the race was restarted; a `race_start` follows |
| `finish` | `results: [{position, car_number, driver, driver_code, team, team_color, gap_to_leader_sec, pit_stops}]`, `summary: {our_position, start_position, positions_gained, pit_laps, decisions: {"STAY OUT": n, "PIT SOON": n, "PIT NOW": n}, anomaly_laps, avg_decision_latency_ms}` |

## Web API

All JSON. Served by `boxbox` on `http://127.0.0.1:8088` by default.

### `GET /api/status`

```json
{"app": "boxbox", "version": "1.0.0", "mode": "embedded",
 "race": {"race_id": 3, "state": "running", "lap": 24, "total_laps": 60, "seconds_per_lap": 5,
          "flag": "GREEN", "autopilot": true, "scripted_incident": true,
          "active_scenarios": [{"kind": "fl_overheat", "label": "Front-left overheating", "since_lap": 24}],
          "circuit": "silverstone", "our_car": 88},
 "agent": {"strategist": "hybrid", "provider": "anthropic", "model": "claude-opus-5-5",
           "engineer_provider": "anthropic", "inflight": 0, "avg_latency_ms": 1650},
 "pipeline": {"broker": "in-memory",
              "topics": {"car_telemetry": {"count": 240, "rate": 2.0, "last_ts": 1793900021000}},
              "stages": [{"name": "simulator", "status": "ok"}, {"name": "car_state", "status": "ok"},
                         {"name": "pit_strategy_agent", "status": "ok"}]},
 "capabilities": {"control": true, "chat": true,
                  "speeds": [20, 10, 5, 2, 1],
                  "scenarios": [{"kind": "fl_overheat", "label": "Front-left overheating", "icon": "flame",
                                 "description": "..."}]}}
```

`race.state`: `idle`, `running`, `paused`, `finished`. `flag`: `PRE`, `GREEN`, `SC`, `CHEQUERED`. `speeds` are wall-clock seconds per lap.

### `POST /api/control`

Body `{"command": "...", ...}`. Returns `{"ok": true, "status": {...}}`, or HTTP 400 `{"ok": false, "error": "..."}`.

| command | extra fields | effect |
|---|---|---|
| `start` | none | start a new race (if idle or finished) |
| `pause` / `resume` | none | freeze or continue the simulator |
| `restart` | none | abandon the race and start a new one |
| `speed` | `seconds_per_lap` | wall-clock pacing, one of `capabilities.speeds` |
| `scenario` | `kind` | inject a scenario from `capabilities.scenarios` |
| `box` | `compound` | engineer override: pit the hero car next lap |
| `autopilot` | `enabled` | when true, the car obeys the agent's `PIT NOW` |
| `scripted_incident` | `enabled` | when true, races schedule a front-left overheat at lap 24 |

### `POST /api/engineer`

Body `{"question": "Why did we pit?", "history": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}` → `{"answer": "...", "provider": "anthropic" | "claude-cli" | "analyst", "model": "..." , "latency_ms": 1200}`.

### `GET /api/session`

The current race as a replay file: `{"format": "boxbox-session/1", "meta": {...}, "events": [Event, ...]}`.

### `GET /api/query`

`?topic=car_state&limit=20&lap=24` → `{"topic": "...", "rows": [...]}`. Latest-first rows from a topic's materialized view (the MCP server uses this).

### WebSocket `/ws`

Server-to-client messages:

- `{"type": "hello", "status": {...}, "backlog": [Event, ...]}` once on connect: every event of the current race so far.
- `{"type": "events", "events": [Event, ...]}` as they happen (batched about every 100 ms).
- `{"type": "status", "status": {...}}` about once a second, and right after any control command.

`Event = {"seq": 1234, "topic": "car_state", "key": "88", "ts": 1793900021840, "value": {...}}`. A `race_events` record with `kind: "race_start"` means "reset: a new race begins".

### Replay files

`web/demo/session.json` uses the `GET /api/session` format. The web app replays it when no backend answers `/api/status` (for example on GitHub Pages), scheduling events by `ts`.
