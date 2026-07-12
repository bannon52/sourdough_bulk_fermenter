"""Config and options flow for the Sourdough Fermentation integration."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_BASE_HOURS,
    CONF_DOUGH_PROBE,
    CONF_FLOUR_G,
    CONF_HUMIDITY,
    CONF_NAME,
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
    DEFAULT_NAME,
    DEFAULT_PROTEIN,
    DEFAULT_Q10,
    DEFAULT_REF_TEMP,
    DEFAULT_STARTER_G,
    DEFAULT_STARTER_HYDRATION,
    DEFAULT_USE_HUMIDITY,
    DEFAULT_WATER_G,
    DOMAIN,
    MAX_FLOUR_G,
    MAX_STARTER_G,
    MAX_WATER_G,
)

_TEMP_SELECTOR = selector.EntitySelector(
    selector.EntitySelectorConfig(domain="sensor", device_class="temperature")
)
_HUMIDITY_SELECTOR = selector.EntitySelector(
    selector.EntitySelectorConfig(domain="sensor", device_class="humidity")
)


def _grams(min_v, max_v, step):
    return selector.NumberSelector(
        selector.NumberSelectorConfig(
            min=min_v, max=max_v, step=step,
            unit_of_measurement="g", mode=selector.NumberSelectorMode.BOX,
        )
    )


def _base_schema(d: dict[str, Any]) -> vol.Schema:
    """Sensors + default recipe, shared by config and options."""
    return vol.Schema(
        {
            vol.Required(CONF_ROOM_TEMP, default=d.get(CONF_ROOM_TEMP)): _TEMP_SELECTOR,
            vol.Optional(
                CONF_DOUGH_PROBE,
                description={"suggested_value": d.get(CONF_DOUGH_PROBE)},
            ): _TEMP_SELECTOR,
            vol.Optional(
                CONF_HUMIDITY,
                description={"suggested_value": d.get(CONF_HUMIDITY)},
            ): _HUMIDITY_SELECTOR,
            vol.Required(
                CONF_STARTER_G, default=d.get(CONF_STARTER_G, DEFAULT_STARTER_G)
            ): _grams(0, MAX_STARTER_G, 5),
            vol.Required(
                CONF_FLOUR_G, default=d.get(CONF_FLOUR_G, DEFAULT_FLOUR_G)
            ): _grams(50, MAX_FLOUR_G, 5),
            vol.Required(
                CONF_WATER_G, default=d.get(CONF_WATER_G, DEFAULT_WATER_G)
            ): _grams(0, MAX_WATER_G, 5),
            vol.Required(
                CONF_PROTEIN, default=d.get(CONF_PROTEIN, DEFAULT_PROTEIN)
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=7, max=16, step=0.1,
                    unit_of_measurement="%", mode=selector.NumberSelectorMode.BOX,
                )
            ),
            vol.Required(
                CONF_USE_HUMIDITY,
                default=d.get(CONF_USE_HUMIDITY, DEFAULT_USE_HUMIDITY),
            ): selector.BooleanSelector(),
        }
    )


def _advanced_schema(d: dict[str, Any]) -> dict:
    return {
        vol.Optional(
            CONF_STARTER_HYDRATION,
            default=d.get(CONF_STARTER_HYDRATION, DEFAULT_STARTER_HYDRATION),
        ): selector.NumberSelector(
            selector.NumberSelectorConfig(
                min=50, max=150, step=5, unit_of_measurement="%"
            )
        ),
        vol.Optional(
            CONF_Q10, default=d.get(CONF_Q10, DEFAULT_Q10)
        ): selector.NumberSelector(
            selector.NumberSelectorConfig(min=1.5, max=3.5, step=0.1)
        ),
        vol.Optional(
            CONF_REF_TEMP, default=d.get(CONF_REF_TEMP, DEFAULT_REF_TEMP)
        ): selector.NumberSelector(
            selector.NumberSelectorConfig(
                min=15, max=30, step=0.5, unit_of_measurement="°C"
            )
        ),
        vol.Optional(
            CONF_BASE_HOURS, default=d.get(CONF_BASE_HOURS, DEFAULT_BASE_HOURS)
        ): selector.NumberSelector(
            selector.NumberSelectorConfig(
                min=1, max=24, step=0.25, unit_of_measurement="h"
            )
        ),
    }


class SourdoughConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the initial UI setup."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            name = user_input.pop(CONF_NAME, DEFAULT_NAME)
            return self.async_create_entry(title=name, data=user_input)

        schema = vol.Schema(
            {vol.Required(CONF_NAME, default=DEFAULT_NAME): selector.TextSelector()}
        ).extend(_base_schema({}).schema)

        return self.async_show_form(step_id="user", data_schema=schema)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return SourdoughOptionsFlow()


class SourdoughOptionsFlow(OptionsFlow):
    """Change sensors / default recipe / model params after setup."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        current = {**self.config_entry.data, **self.config_entry.options}
        schema = _base_schema(current).extend(_advanced_schema(current))
        return self.async_show_form(step_id="init", data_schema=schema)
