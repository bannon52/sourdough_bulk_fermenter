"""Pure fermentation math for the Sourdough Fermentation integration.

Framework-free so it can be unit-tested in isolation.

Model
-----
Q10 biological rate law: fermentation rate multiplies by ``q10`` per +10 C.
Starter ratio scales time by sqrt(ref_ratio / ratio) -- more inoculant is
faster, with diminishing returns.

Three optional modifiers:

* Humidity (indirect): humid air transfers heat to the dough faster. Applied
  only in room-temp mode (a dough probe already measures true dough temp).
* Hydration (rate): wetter doughs ferment faster because water is the medium
  the microbes work in. Higher hydration -> shorter bulk.
* Protein (target/tolerance, NOT rate): higher-protein flour builds stronger
  gluten that tolerates a longer bulk, so you target a bigger rise. Modelled
  as a small lengthening of the target time, not a change in microbial speed.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelParams:
    """Tunable model constants."""

    q10: float = 2.0
    ref_temp: float = 24.0
    ref_ratio: float = 0.20
    base_hours: float = 5.0
    humidity_neutral: float = 60.0
    humidity_coeff: float = 0.003
    hydration_ref: float = 75.0
    hydration_coeff: float = 0.008
    protein_ref: float = 12.5
    protein_coeff: float = 0.02


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _temp_factor(temp_c: float, p: ModelParams) -> float:
    return p.q10 ** ((p.ref_temp - temp_c) / 10.0)


def _ratio_factor(starter_ratio: float, p: ModelParams) -> float:
    ratio = max(starter_ratio, 0.001)
    return (p.ref_ratio / ratio) ** 0.5


def _humidity_factor(humidity_pct: float, p: ModelParams) -> float:
    return _clamp(1.0 + (p.humidity_neutral - humidity_pct) * p.humidity_coeff, 0.8, 1.2)


def _hydration_factor(hydration_pct: float, p: ModelParams) -> float:
    # Higher hydration -> faster -> factor < 1.
    return _clamp(1.0 - (hydration_pct - p.hydration_ref) * p.hydration_coeff, 0.75, 1.3)


def _protein_factor(protein_pct: float, p: ModelParams) -> float:
    # Higher protein -> target a larger rise -> slightly longer bulk.
    return _clamp(1.0 + (protein_pct - p.protein_ref) * p.protein_coeff, 0.85, 1.2)


def bulk_hours(
    temp_c: float,
    starter_ratio: float,
    p: ModelParams,
    humidity_pct: float | None = None,
    hydration_pct: float | None = None,
    protein_pct: float | None = None,
) -> float:
    """Estimated total bulk fermentation time in hours.

    ``starter_ratio`` is a fraction (0.10 == 10%). Optional modifiers are only
    applied when their value is provided.
    """
    hours = p.base_hours * _temp_factor(temp_c, p) * _ratio_factor(starter_ratio, p)
    if humidity_pct is not None:
        hours *= _humidity_factor(humidity_pct, p)
    if hydration_pct is not None:
        hours *= _hydration_factor(hydration_pct, p)
    if protein_pct is not None:
        hours *= _protein_factor(protein_pct, p)
    return max(hours, 0.0)


def rate_per_hour(temp_c: float, starter_ratio: float, p: ModelParams, **kw) -> float:
    """Fraction of bulk completed per hour under current conditions."""
    hours = bulk_hours(temp_c, starter_ratio, p, **kw)
    return 0.0 if hours <= 0 else 1.0 / hours
