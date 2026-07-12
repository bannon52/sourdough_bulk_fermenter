"""Sensor platform for the Sourdough Fermentation integration."""

from __future__ import annotations

import logging

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTime
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import (
    EventStateChangedData,
    async_track_state_change_event,
)

from .const import DOMAIN, SIGNAL_UPDATE
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
        ]
    )


class _BaseFermentSensor(SensorEntity):
    """Shared plumbing: recalc on source-sensor OR recipe changes."""

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

        # React to source-sensor state changes...
        if self._cfg.source_entities:
            self.async_on_remove(
                async_track_state_change_event(
                    self.hass, self._cfg.source_entities, _handle
                )
            )
        # ...and to live recipe (number) changes.
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, f"{SIGNAL_UPDATE}_{self._entry.entry_id}", _handle
            )
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

    def __init__(self, coordinator: SourdoughCoordinator, entry: ConfigEntry) -> None:
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
    """Current fermentation rate as a fraction of bulk completed per hour.

    Integrate this over time (Riemann-sum helper) to track cumulative progress;
    the dough is 'done' when the running total reaches ~1.0.
    """

    _attr_icon = "mdi:chart-bell-curve-cumulative"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "1/h"

    def __init__(self, coordinator: SourdoughCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_rate"
        self._attr_name = "Fermentation rate"

    @property
    def native_value(self) -> float | None:
        return self._data.get("rate_per_hour")

    @property
    def extra_state_attributes(self) -> dict:
        if not self._data.get("available"):
            return {}
        return {
            "temperature_used_c": self._data["temp_used_c"],
            "temperature_source": self._data["temp_source"],
        }
