"""Shared runtime state for the Sourdough Fermentation integration.

Holds the live-editable recipe values (written by the number entities) and
resolves the current fermentation estimate from the selected source sensors.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .calc import ModelParams, bulk_hours, rate_per_hour
from .const import (
    CONF_BASE_HOURS,
    CONF_DOUGH_PROBE,
    CONF_FLOUR_G,
    CONF_HUMIDITY,
    CONF_PROTEIN,
    CONF_Q10,
    CONF_REF_TEMP,
    CONF_ROOM_TEMP,
    CONF_STARTER_G,
    CONF_USE_HUMIDITY,
    CONF_WATER_G,
    DEFAULT_BASE_HOURS,
    DEFAULT_FLOUR_G,
    DEFAULT_PROTEIN,
    DEFAULT_Q10,
    DEFAULT_REF_RATIO,
    DEFAULT_REF_TEMP,
    DEFAULT_STARTER_G,
    DEFAULT_USE_HUMIDITY,
    DEFAULT_WATER_G,
    FAST_THRESHOLD_H,
    HUMIDITY_COEFF,
    HUMIDITY_NEUTRAL,
    HYDRATION_COEFF,
    HYDRATION_REF,
    PROTEIN_COEFF,
    PROTEIN_REF,
    SLOW_THRESHOLD_H,
)


class SourdoughCoordinator:
    """Central object shared by the sensor and number platforms."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        cfg = {**entry.data, **entry.options}

        # Source sensors
        self.room_temp_id: str | None = cfg.get(CONF_ROOM_TEMP)
        self.dough_probe_id: str | None = cfg.get(CONF_DOUGH_PROBE)
        self.humidity_id: str | None = cfg.get(CONF_HUMIDITY)
        self.use_humidity: bool = bool(cfg.get(CONF_USE_HUMIDITY, DEFAULT_USE_HUMIDITY))

        # Live recipe values (seeded from config; number entities update them)
        self.starter_g: float = float(cfg.get(CONF_STARTER_G, DEFAULT_STARTER_G))
        self.flour_g: float = float(cfg.get(CONF_FLOUR_G, DEFAULT_FLOUR_G))
        self.water_g: float = float(cfg.get(CONF_WATER_G, DEFAULT_WATER_G))
        self.protein_pct: float = float(cfg.get(CONF_PROTEIN, DEFAULT_PROTEIN))

        self.params = ModelParams(
            q10=float(cfg.get(CONF_Q10, DEFAULT_Q10)),
            ref_temp=float(cfg.get(CONF_REF_TEMP, DEFAULT_REF_TEMP)),
            ref_ratio=DEFAULT_REF_RATIO,
            base_hours=float(cfg.get(CONF_BASE_HOURS, DEFAULT_BASE_HOURS)),
            humidity_neutral=HUMIDITY_NEUTRAL,
            humidity_coeff=HUMIDITY_COEFF,
            hydration_ref=HYDRATION_REF,
            hydration_coeff=HYDRATION_COEFF,
            protein_ref=PROTEIN_REF,
            protein_coeff=PROTEIN_COEFF,
        )

    # --- Derived recipe figures ------------------------------------------
    @property
    def starter_ratio(self) -> float:
        """Inoculation as a fraction of flour weight."""
        if self.flour_g <= 0:
            return 0.0
        return self.starter_g / self.flour_g

    @property
    def hydration_pct(self) -> float:
        """Dough hydration (water / flour), as a percentage."""
        if self.flour_g <= 0:
            return 0.0
        return self.water_g / self.flour_g * 100.0

    # --- Source sensor reads ---------------------------------------------
    @property
    def source_entities(self) -> list[str]:
        return [
            e
            for e in (self.room_temp_id, self.dough_probe_id, self.humidity_id)
            if e
        ]

    def _read_float(self, entity_id: str | None) -> float | None:
        if not entity_id:
            return None
        state = self.hass.states.get(entity_id)
        if state is None or state.state in ("unknown", "unavailable", "", None):
            return None
        try:
            return float(state.state)
        except (ValueError, TypeError):
            return None

    def resolve(self) -> dict:
        """Compute the current estimate from live values + sensor readings."""
        probe = self._read_float(self.dough_probe_id)
        room = self._read_float(self.room_temp_id)
        humidity = self._read_float(self.humidity_id)

        if probe is not None:
            temp, source, hum_arg = probe, "dough_probe", None
        elif room is not None:
            temp, source = room, "room_temp"
            hum_arg = humidity if (self.use_humidity and humidity is not None) else None
        else:
            return {"available": False}

        kw = {
            "humidity_pct": hum_arg,
            "hydration_pct": self.hydration_pct,
            "protein_pct": self.protein_pct,
        }
        hours = bulk_hours(temp, self.starter_ratio, self.params, **kw)
        rate = rate_per_hour(temp, self.starter_ratio, self.params, **kw)

        pace = (
            "fast" if hours < FAST_THRESHOLD_H
            else "slow" if hours > SLOW_THRESHOLD_H
            else "normal"
        )

        return {
            "available": True,
            "hours": round(hours, 2),
            "rate_per_hour": round(rate, 4),
            "temp_used_c": round(temp, 1),
            "temp_source": source,
            "humidity_applied": hum_arg is not None,
            "starter_pct": round(self.starter_ratio * 100, 1),
            "hydration_pct": round(self.hydration_pct, 1),
            "protein_pct": round(self.protein_pct, 1),
            "pace": pace,
        }
