"""Sensor platform for the Sourdough Fermentation integration."""

from __future__ import annotations

import logging
from datetime import datetime

from homeassistant.components.sensor import (
    RestoreSensor,
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE, UnitOfTime
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .coordinator import SourdoughCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the fermentation sensors from a config entry."""
    coordinator: SourdoughCoordinator = entry.runtime_data
    async_add_entities(
        [
            BulkFermentTimeSensor(coordinator, entry),
            FermentRateSensor(coordinator, entry),
            HydrationSensor(coordinator, entry),
            BulkProgressSensor(coordinator, entry),
            BulkRemainingSensor(coordinator, entry),
            BulkReadyAtSensor(coordinator, entry),
        ]
    )


class _BaseFermentSensor(SensorEntity):
    """Recalc on source-sensor OR recipe/timer changes."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, coordinator: SourdoughCoordinator, entry: ConfigEntry) -> None:
        self._cfg = coordinator
        self._entry = entry
        self._data: dict = {}
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Sourdough Fermentation",
            model="Q10 two-phase model",
        )

    async def async_added_to_hass(self) -> None:
        self._recalculate()

        @callback
        def _handle(*_args) -> None:
            self._recalculate()
            self.async_write_ha_state()

        if self._cfg.source_entities:
            self.async_on_remove(
                async_track_state_change_event(
                    self.hass, self._cfg.source_entities, _handle
                )
            )
        self.async_on_remove(
            async_dispatcher_connect(self.hass, self._cfg.signal, _handle)
        )

    @callback
    def _recalculate(self) -> None:
        self._data = self._cfg.resolve()

    @property
    def available(self) -> bool:
        return bool(self._data.get("available"))


class BulkFermentTimeSensor(_BaseFermentSensor):
    """Estimated total bulk fermentation time under current conditions."""

    _attr_icon = "mdi:bread-slice-outline"
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.HOURS
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator, entry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_bulk_time"
        self._attr_name = "Bulk fermentation time"

    @property
    def native_value(self) -> float | None:
        return self._data.get("hours")

    @property
    def extra_state_attributes(self) -> dict:
        if not self._data.get("available"):
            return {}
        return {
            "temperature_used_c": self._data["temp_used_c"],
            "temperature_source": self._data["temp_source"],
            "humidity_applied": self._data["humidity_applied"],
            "starter_percent": self._data["starter_pct"],
            "hydration_percent": self._data["hydration_pct"],
            "protein_percent": self._data["protein_pct"],
            "pace": self._data["pace"],
        }


class FermentRateSensor(_BaseFermentSensor):
    """Current fermentation rate as a fraction of bulk completed per hour."""

    _attr_icon = "mdi:chart-bell-curve-cumulative"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "1/h"

    def __init__(self, coordinator, entry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_rate"
        self._attr_name = "Fermentation rate"

    @property
    def native_value(self) -> float | None:
        return self._data.get("rate_per_hour")


class HydrationSensor(_BaseFermentSensor):
    """Total dough hydration, including the flour/water inside the starter."""

    _attr_icon = "mdi:water-percent"
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator, entry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_hydration"
        self._attr_name = "Total hydration"

    @property
    def available(self) -> bool:
        return True  # purely recipe-derived; no sensor needed

    @property
    def native_value(self) -> float:
        return round(self._cfg.true_hydration_pct, 1)

    @property
    def extra_state_attributes(self) -> dict:
        s_flour, s_water = self._cfg._starter_split
        return {
            "starter_percent": round(self._cfg.starter_ratio * 100, 1),
            "recipe_flour_g": round(self._cfg.flour_g, 1),
            "recipe_water_g": round(self._cfg.water_g, 1),
            "starter_flour_g": round(s_flour, 1),
            "starter_water_g": round(s_water, 1),
            "total_flour_g": round(self._cfg.flour_g + s_flour, 1),
            "total_water_g": round(self._cfg.water_g + s_water, 1),
        }


class _BaseTimerSensor(SensorEntity):
    """Timer sensors read from the coordinator's countdown state."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, coordinator: SourdoughCoordinator, entry: ConfigEntry) -> None:
        self._cfg = coordinator
        self._entry = entry
        self._state: dict = {}
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Sourdough Fermentation",
            model="Q10 two-phase model",
        )

    async def async_added_to_hass(self) -> None:
        self._state = self._cfg.countdown_state()

        @callback
        def _handle(*_args) -> None:
            self._state = self._cfg.countdown_state()
            self.async_write_ha_state()

        if self._cfg.source_entities:
            self.async_on_remove(
                async_track_state_change_event(
                    self.hass, self._cfg.source_entities, _handle
                )
            )
        self.async_on_remove(
            async_dispatcher_connect(self.hass, self._cfg.signal, _handle)
        )


class BulkProgressSensor(_BaseTimerSensor, RestoreSensor, RestoreEntity):
    """Cumulative bulk progress (%). Owns countdown-state persistence."""

    _attr_icon = "mdi:progress-clock"
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator, entry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_progress"
        self._attr_name = "Bulk progress"

    async def async_added_to_hass(self) -> None:
        # Restore accumulator state into the coordinator before wiring up.
        last = await self.async_get_last_state()
        if last is not None and last.state not in (None, "unknown", "unavailable"):
            try:
                progress = float(last.state) / 100.0
            except (ValueError, TypeError):
                progress = 0.0
            a = last.attributes
            self._cfg.restore(
                progress=progress,
                active=bool(a.get("active", False)),
                started_at=_parse_dt(a.get("started_at")),
                completed_at=_parse_dt(a.get("completed_at")),
            )
        await super().async_added_to_hass()

    @property
    def native_value(self) -> float:
        return self._state.get("progress_pct", 0.0)

    @property
    def extra_state_attributes(self) -> dict:
        return {
            "active": self._state.get("active", False),
            "started_at": _iso(self._state.get("started_at")),
            "completed_at": _iso(self._state.get("completed_at")),
        }


class BulkRemainingSensor(_BaseTimerSensor):
    """Dynamically re-forecast time remaining (hours) at current conditions."""

    _attr_icon = "mdi:timer-sand"
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.HOURS
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator, entry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_remaining"
        self._attr_name = "Bulk time remaining"

    @property
    def native_value(self) -> float | None:
        return self._state.get("remaining_h")


class BulkReadyAtSensor(_BaseTimerSensor):
    """Projected completion time (updates as temperature changes)."""

    _attr_icon = "mdi:clock-check-outline"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(self, coordinator, entry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_ready_at"
        self._attr_name = "Bulk ready at"

    @property
    def native_value(self) -> datetime | None:
        return self._state.get("ready_at")


def _iso(value) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _parse_dt(value):
    if not value:
        return None
    return dt_util.parse_datetime(value) if isinstance(value, str) else None
