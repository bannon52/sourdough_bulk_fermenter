"""Constants for the Sourdough Fermentation integration."""

from __future__ import annotations

from datetime import timedelta

from homeassistant.const import Platform

DOMAIN = "sourdough_ferment"
PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.NUMBER, Platform.BUTTON]

# Signal fired when recipe/timer state changes, so sensors recalc immediately.
SIGNAL_UPDATE = f"{DOMAIN}_update"

# How often the countdown accumulator ticks.
TICK_INTERVAL = timedelta(seconds=60)

# Sensor selection (config)
CONF_ROOM_TEMP = "room_temp_sensor"
CONF_HUMIDITY = "humidity_sensor"
CONF_DOUGH_PROBE = "dough_probe_sensor"
CONF_USE_HUMIDITY = "use_humidity_modifier"
CONF_NAME = "name"

# Recipe defaults (grams) — seed the live-editable number entities.
CONF_STARTER_G = "starter_g"
CONF_FLOUR_G = "flour_g"
CONF_WATER_G = "water_g"
CONF_PROTEIN = "protein_pct"
CONF_STARTER_HYDRATION = "starter_hydration_pct"

# Advanced model params (options)
CONF_Q10 = "q10"
CONF_REF_TEMP = "ref_temp"
CONF_BASE_HOURS = "base_hours"

# --- Defaults ---------------------------------------------------------------
DEFAULT_NAME = "Sourdough Bulk"

# Zac's standard bake: 50 g starter, 375 g water, 500 g flour
#   -> 10% inoculation, 100%-hydration starter, ~76% true hydration.
DEFAULT_STARTER_G = 50.0
DEFAULT_FLOUR_G = 500.0
DEFAULT_WATER_G = 375.0
DEFAULT_PROTEIN = 12.5
DEFAULT_STARTER_HYDRATION = 100.0   # 50% flour / 50% water

DEFAULT_Q10 = 2.0
DEFAULT_REF_TEMP = 24.0
DEFAULT_REF_RATIO = 0.20
DEFAULT_BASE_HOURS = 5.0
DEFAULT_USE_HUMIDITY = True

# Number entity slider caps
MAX_STARTER_G = 200.0
MAX_FLOUR_G = 1000.0
MAX_WATER_G = 1000.0

# Model coefficients
HUMIDITY_NEUTRAL = 60.0
HUMIDITY_COEFF = 0.003
HYDRATION_REF = 75.0
HYDRATION_COEFF = 0.008
PROTEIN_REF = 12.5
PROTEIN_COEFF = 0.02

# Pace thresholds (hours)
FAST_THRESHOLD_H = 3.0
SLOW_THRESHOLD_H = 10.0
