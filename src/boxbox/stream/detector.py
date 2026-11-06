"""Streaming anomaly detection on windowed signals.

Each signal gets a :class:`TrendDetector`: a linear-trend forecaster refit on every
window. It predicts the next window's value from the clean history of the current
stint, puts a prediction interval around it at the configured confidence, and flags
the window when the actual value falls outside on the watched side.

- **Stint-aware.** A pit stop resets tyre temperatures and pressures, so history is
  cut at every stint change; until ``min_training`` windows exist the detector only
  learns (``bounds`` is ``None``).
- **Anomalies don't poison the model.** Flagged windows are not added to history, so
  a sustained fault stays flagged instead of becoming the new normal.
- **A noise floor** (``min_sigma``) stops the band collapsing on very smooth signals.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Two-sided z for common confidence levels.
_Z = {0.99: 2.5758, 0.999: 3.2905, 0.9999: 3.8906}


@dataclass(frozen=True)
class Verdict:
    expected: float | None
    lower: float | None
    upper: float | None
    is_anomaly: bool
    training_windows: int

    def bounds(self) -> dict | None:
        if self.expected is None:
            return None
        return {"expected": round(self.expected, 2), "lower": round(self.lower, 2), "upper": round(self.upper, 2)}


class TrendDetector:
    def __init__(
        self,
        *,
        side: str = "upper",
        min_training: int = 6,
        max_training: int = 50,
        confidence: float = 0.9999,
        min_sigma: float = 0.5,
    ) -> None:
        if side not in ("upper", "lower", "both"):
            raise ValueError("side must be upper, lower or both")
        self.side = side
        self.min_training = min_training
        self.max_training = max_training
        self.z = _Z[confidence]
        self.min_sigma = min_sigma
        self._stint: object = None
        self._history: list[float] = []

    def observe(self, value: float, stint: object = None, *, learn: bool = True) -> Verdict:
        """Score ``value``; add it to the model only if ``learn`` and it isn't anomalous."""
        if stint != self._stint:
            self._stint = stint
            self._history = []
        n = len(self._history)
        if n < self.min_training:
            if learn:
                self._history.append(value)
            return Verdict(None, None, None, False, len(self._history))

        expected, se = self._forecast()
        lower, upper = expected - self.z * se, expected + self.z * se
        anomalous = (self.side in ("upper", "both") and value > upper) or (
            self.side in ("lower", "both") and value < lower
        )
        if learn and not anomalous:
            self._history.append(value)
            if len(self._history) > self.max_training:
                self._history.pop(0)
        return Verdict(expected, lower, upper, anomalous, len(self._history))

    def _forecast(self) -> tuple[float, float]:
        ys = self._history
        n = len(ys)
        xs = range(n)
        mx = (n - 1) / 2
        my = sum(ys) / n
        sxx = sum((x - mx) ** 2 for x in xs)
        slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True)) / sxx if sxx else 0.0
        intercept = my - slope * mx
        resid = [y - (intercept + slope * x) for x, y in zip(xs, ys, strict=True)]
        sigma = math.sqrt(sum(r * r for r in resid) / max(1, n - 2))
        sigma = max(sigma, self.min_sigma)
        x0 = n
        se = sigma * math.sqrt(1 + 1 / n + ((x0 - mx) ** 2 / sxx if sxx else 0.0))
        return intercept + slope * x0, se


# The signals car_state watches: field -> (flag column, side, noise floor, resets per stint).
SIGNALS = {
    "tire_temp_fl_c": ("anomaly_tire_temp_fl", "upper", 0.6, True),
    "tire_pressure_fl_psi": ("anomaly_tire_pressure_fl", "lower", 0.08, True),
    "engine_temp_c": ("anomaly_engine_temp", "upper", 0.8, False),
}
