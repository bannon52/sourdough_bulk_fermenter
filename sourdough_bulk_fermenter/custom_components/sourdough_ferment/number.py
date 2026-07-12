"""Number platform: live-editable recipe controls.

These let you dial in starter / flour / water / protein from a dashboard and
watch the Bulk fermentation time sensor update *before* you start the bake.
Values persist across restarts.
"""

from __future__ import annotations

from collections.abc import Callable

from homeassistant.components.number import NumberMode, RestoreNumber
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    CONF_FLOUR_G,
    CONF_PROTEIN,
    CONF_STARTER_G,
    CONF_WATER_G,
    DOMAIN,
    SIGNAL_UPDATE,
)
from .coordinator import SourdoughCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create the recipe number entities."""
    coordinator: SourdoughCoordinator = entry.runtime_data
    async_add_entities(
        [
            RecipeNumber(
                coordinator, entry, "Starter", CONF_STARTER_G, "mdi:cup",
                lambda c, v: setattr(c, "starter_g", v),
                lambda c: c.starter_g, 0, 500, 5, "g",
            ),
            RecipeNumber(
                coordinator, entry, "Flour", CONF_FLOUR_G, "mdi:grain",
                lambda c, v: setattr(c, "flour_g", v),
                lambda c: c.flour_g, 50, 2000, 5, "g",
            ),
            RecipeNumber(
                coordinator, entry, "Water", CONF_WATER_G, "mdi:water",
                lambda c, v: setattr(c, "water_g", v),
                lambda c: c.water_g, 0, 2000, 5, "g",
            ),
            RecipeNumber(
                coordinator, entry, "Flour protein", CONF_PROTEIN, "mdi:barley",
                lambda c, v: setattr(c, "protein_pct", v),
                lambda c: c.protein_pct, 7, 16, 0.1, "%",
                mode=NumberMode.BOX,
            ),
        ]
    )


class RecipeNumber(RestoreNumber):
    """A single editable recipe value, backed by the coordinator."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self,
        coordinator: SourdoughCoordinator,
        entry: ConfigEntry,
        name: str,
        key: str,
        icon: str,
        setter: Callable[[SourdoughCoordinator, float], None],
        getter: Callable[[SourdoughCoordinator], float],
        vmin: float,
        vmax: float,
        step: float,
        unit: str,
        mode: NumberMode = NumberMode.SLIDER,
    ) -> None:
        self._coordinator = coordinator
        self._setter = setter
        self._getter = getter
        self._attr_name = name
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_icon = icon
        self._attr_native_min_value = vmin
        self._attr_native_max_value = vmax
        self._attr_native_step = step
        self._attr_native_unit_of_measurement = unit
        self._attr_mode = mode
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Sourdough Fermentation",
            model="Q10 two-phase model",
        )

    async def async_added_to_hass(self) -> None:
        """Restore last value (fall back to the config default)."""
        await super().async_added_to_hass()
        last = await self.async_get_last_number_data()
        if last is not None and last.native_value is not None:
            self._setter(self._coordinator, float(last.native_value))
        # else: coordinator already holds the config default.

    @property
    def native_value(self) -> float:
        return self._getter(self._coordinator)

    async def async_set_native_value(self, value: float) -> None:
        """Store the new value and tell the sensors to recalculate."""
        self._setter(self._coordinator, value)
        self.async_write_ha_state()
        async_dispatcher_send(
            self.hass, f"{SIGNAL_UPDATE}_{self._coordinator.entry.entry_id}"
        )
