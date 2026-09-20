"""The Sourdough Fermentation integration."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import DOMAIN, FRONTEND_SCRIPT_URL, PLATFORMS
from .coordinator import SourdoughCoordinator

_LOGGER = logging.getLogger(__name__)

_FRONTEND_REGISTERED_KEY = f"{DOMAIN}_frontend_registered"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Sourdough Fermentation from a config entry."""
    coordinator = SourdoughCoordinator(hass, entry)
    entry.runtime_data = coordinator
    coordinator.async_setup()
    entry.async_on_unload(coordinator.async_shutdown)

    await _async_register_frontend(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload entry on options update."""
    await hass.config_entries.async_reload(entry.entry_id)


def _script_url(cache_bust: str) -> str:
    """Build the auto-loaded script URL with a cache-busting query param."""
    return f"{FRONTEND_SCRIPT_URL}?v={cache_bust}"


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Serve the dashboard card's JS and auto-load it on every dashboard.

    Runs once per Home Assistant session no matter how many config entries
    exist, guarded by a flag in hass.data. No manual 'Add Resource' step is
    needed in Settings -> Dashboards -> Resources.
    """
    if hass.data.get(_FRONTEND_REGISTERED_KEY):
        return
    hass.data[_FRONTEND_REGISTERED_KEY] = True

    www_dir = Path(__file__).parent / "www"

    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig("/sourdough_ferment_static", str(www_dir), False)]
        )
    except AttributeError:
        # Fallback for older Home Assistant cores predating the async API.
        await hass.async_add_executor_job(
            hass.http.register_static_path,
            "/sourdough_ferment_static",
            str(www_dir),
            False,
        )

    try:
        integration = await async_get_integration(hass, DOMAIN)
        cache_bust = str(integration.version) if integration.version else "0"
    except Exception:  # noqa: BLE001 - cosmetic cache-busting only, never fatal
        cache_bust = "0"

    add_extra_js_url(hass, _script_url(cache_bust))
    _LOGGER.debug("Registered Sourdough Fermentation dashboard card (v%s)", cache_bust)
