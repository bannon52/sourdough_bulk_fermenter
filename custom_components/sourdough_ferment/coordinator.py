"""Shared runtime state for the Sourdough Fermentation integration.

Holds the live-editable recipe values, resolves the current estimate from the
selected sensors, and runs the temperature-aware countdown accumulator.

The countdown works by integrating fermentation *rate* over time. Each tick it
adds ``rate * dt`` to a cumulative progress figure (0..1). Because ``rate``
depends on the live temperature, the countdown naturally speeds up when it's
warm and slows when it's cool. Time-remaining is then ``(1 - progress) / rate``
under whatever conditions currently hold, so the ETA re-forecasts continuously.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

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
    CONF_STARTER_HYDRATION,
    CONF_USE_HUMIDITY,
    CONF_WATER_G,
    DEFAULT_BASE_HOURS,
    DEFAULT_FLOUR_G,
    DEFAULT_PROTEIN,
    DEFAULT_Q10,
    DEFAULT_REF_RATIO,
    DEFAULT_REF_TEMP,
    DEFAULT_STARTER_G,
    DEFAULT_STARTER_HYDRATION,
    DEFAULT_USE_HUMIDITY,
    DEFAULT_WATER_G,
    FAST_THRESHOLD_H,
    HUMIDITY_COEFF,
    HUMIDITY_NEUTRAL,
    HYDRATION_COEFF,
    HYDRATION_REF,
    PROTEIN_COEFF,
    PROTEIN_REF,
    SIGNAL_UPDATE,
    SLOW_THRESHOLD_H,
    TICK_INTERVAL,
)


class SourdoughCoordinator:
    """Central object shared by the sensor, number and button platforms."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        cfg = {**entry.data, **entry.options}

        self.room_temp_id: str | None = cfg.get(CONF_ROOM_TEMP)
        self.dough_probe_id: str | None = cfg.get(CONF_DOUGH_PROBE)
        self.humidity_id: str | None = cfg.get(CONF_HUMIDITY)
        self.use_humidity: bool = bool(cfg.get(CONF_USE_HUMIDITY, DEFAULT_USE_HUMIDITY))

        # Live recipe values (seeded from config; number entities update them)
        self.starter_g: float = float(cfg.get(CONF_STARTER_G, DEFAULT_STARTER_G))
        self.flour_g: float = float(cfg.get(CONF_FLOUR_G, DEFAULT_FLOUR_G))
        self.water_g: float = float(cfg.get(CONF_WATER_G, DEFAULT_WATER_G))
        self.protein_pct: float = float(cfg.get(CONF_PROTEIN, DEFAULT_PROTEIN))
        self.starter_hydration: float = float(
            cfg.get(CONF_STARTER_HYDRATION, DEFAULT_STARTER_HYDRATION)
        )

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

        # Countdown accumulator state
        self.active: bool = False
        self.progress: float = 0.0            # 0..1
        self.started_at: datetime | None = None
        self.completed_at: datetime | None = None
        self._last_tick: datetime | None = None
        self._unsub_timer = None

    # --- Lifecycle -------------------------------------------------------
    @callback
    def async_setup(self) -> None:
        """Start the periodic accumulator tick."""
        self._unsub_timer = async_track_time_interval(
            self.hass, self._handle_tick, TICK_INTERVAL
        )

    @callback
    def async_shutdown(self) -> None:
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None

    @property
    def signal(self) -> str:
        return f"{SIGNAL_UPDATE}_{self.entry.entry_id}"

    @callback
    def _notify(self) -> None:
        async_dispatcher_send(self.hass, self.signal)

    # --- Derived recipe figures ------------------------------------------
    @property
    def _starter_split(self) -> tuple[float, float]:
        """Flour, water grams contributed by the starter."""
        sh = self.starter_hydration
        flour = self.starter_g * 100.0 / (100.0 + sh)
        water = self.starter_g * sh / (100.0 + sh)
        return flour, water

    @property
    def starter_ratio(self) -> float:
        """Inoculation as a fraction of recipe flour (baker's convention)."""
        return self.starter_g / self.flour_g if self.flour_g > 0 else 0.0

    @property
    def true_hydration_pct(self) -> float:
        """Total hydration including the flour/water inside the starter."""
        s_flour, s_water = self._starter_split
        total_flour = self.flour_g + s_flour
        total_water = self.water_g + s_water
        return total_water / total_flour * 100.0 if total_flour > 0 else 0.0

    # --- Source sensor reads ---------------------------------------------
    @property
    def source_entities(self) -> list[str]:
        return [
            e for e in (self.room_temp_id, self.dough_probe_id, self.humidity_id) if e
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

    def _current_conditions(self) -> tuple[float, str, float | None] | None:
        probe = self._read_float(self.dough_probe_id)
        room = self._read_float(self.room_temp_id)
        humidity = self._read_float(self.humidity_id)
        if probe is not None:
            return probe, "dough_probe", None
        if room is not None:
            hum = humidity if (self.use_humidity and humidity is not None) else None
            return room, "room_temp", hum
        return None

    def _kwargs(self, hum_arg: float | None) -> dict:
        return {
            "humidity_pct": hum_arg,
            "hydration_pct": self.true_hydration_pct,
            "protein_pct": self.protein_pct,
        }

    # --- Instantaneous estimate (pre-start) ------------------------------
    def resolve(self) -> dict:
        cond = self._current_conditions()
        if cond is None:
            return {"available": False}
        temp, source, hum_arg = cond
        kw = self._kwargs(hum_arg)
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
            "rate_per_hour": round(rate, 5),
            "temp_used_c": round(temp, 1),
            "temp_source": source,
            "humidity_applied": hum_arg is not None,
            "starter_pct": round(self.starter_ratio * 100, 1),
            "hydration_pct": round(self.true_hydration_pct, 1),
            "protein_pct": round(self.protein_pct, 1),
            "pace": pace,
        }

    # --- Countdown accumulator -------------------------------------------
    @callback
    def start(self) -> None:
        """Begin (or restart) a bulk ferment now."""
        now = dt_util.utcnow()
        self.active = True
        self.progress = 0.0
        self.started_at = now
        self.completed_at = None
        self._last_tick = now
        self._notify()

    @callback
    def reset(self) -> None:
        """Stop and clear the countdown."""
        self.active = False
        self.progress = 0.0
        self.started_at = None
        self.completed_at = None
        self._last_tick = None
        self._notify()

    @callback
    def restore(
        self,
        progress: float,
        active: bool,
        started_at: datetime | None,
        completed_at: datetime | None,
    ) -> None:
        """Rehydrate accumulator state after a restart."""
        self.progress = max(0.0, min(progress, 1.0))
        self.active = active
        self.started_at = started_at
        self.completed_at = completed_at
        # Don't credit downtime (unknown temps): resume from now.
        self._last_tick = dt_util.utcnow() if active else None

    @callback
    def _handle_tick(self, now: datetime | None = None) -> None:
        """Advance progress by the fermentation done since the last tick."""
        if not self.active:
            return
        now = now or dt_util.utcnow()
        if self._last_tick is None:
            self._last_tick = now
            return
        dt_h = (now - self._last_tick).total_seconds() / 3600.0
        self._last_tick = now
        cond = self._current_conditions()
        if cond is not None and dt_h > 0:
            temp, _src, hum_arg = cond
            rate = rate_per_hour(
                temp, self.starter_ratio, self.params, **self._kwargs(hum_arg)
            )
            self.progress = min(self.progress + rate * dt_h, 1.0)
            if self.progress >= 1.0:
                self.active = False
                self.completed_at = now
        self._notify()

    def countdown_state(self) -> dict:
        """Current progress / remaining / ETA for the timer sensors."""
        progress = max(0.0, min(self.progress, 1.0))
        out = {
            "progress_pct": round(progress * 100, 1),
            "active": self.active,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "remaining_h": None,
            "ready_at": None,
            "available": True,
        }
        cond = self._current_conditions()
        if cond is None:
            out["available"] = False
            return out
        if self.active:
            temp, _src, hum_arg = cond
            rate = rate_per_hour(
                temp, self.starter_ratio, self.params, **self._kwargs(hum_arg)
            )
            if rate > 0:
                remaining = max((1.0 - progress) / rate, 0.0)
                out["remaining_h"] = round(remaining, 2)
                out["ready_at"] = dt_util.utcnow() + timedelta(hours=remaining)
        return out
