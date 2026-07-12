"""Button platform: start / reset the bulk fermentation countdown."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import SourdoughCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create the timer control buttons."""
    coordinator: SourdoughCoordinator = entry.runtime_data
    async_add_entities(
        [
            StartBulkButton(coordinator, entry),
            ResetBulkButton(coordinator, entry),
        ]
    )


class _BaseButton(ButtonEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: SourdoughCoordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Sourdough Fermentation",
            model="Q10 two-phase model",
        )


class StartBulkButton(_BaseButton):
    """Start (or restart) the countdown from now."""

    _attr_icon = "mdi:play-circle-outline"

    def __init__(self, coordinator: SourdoughCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_start"
        self._attr_name = "Start bulk"

    async def async_press(self) -> None:
        self._coordinator.start()


class ResetBulkButton(_BaseButton):
    """Stop and clear the countdown."""

    _attr_icon = "mdi:stop-circle-outline"

    def __init__(self, coordinator: SourdoughCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_reset"
        self._attr_name = "Reset bulk"

    async def async_press(self) -> None:
        self._coordinator.reset()
