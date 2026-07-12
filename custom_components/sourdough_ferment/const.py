"""Constants for the Sourdough Fermentation integration."""

from __future__ import annotations

from homeassistant.const import Platform

DOMAIN = "sourdough_ferment"
PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.NUMBER]

# Signal fired when a recipe number changes, so sensors recalc immediately.
SIGNAL_UPDATE = f"{DOMAIN}_update"

# Sensor selection (config)
CONF_ROOM_TEMP = "room_temp_sensor"
CONF_HUMIDITY = "humidity_sensor"
CONF_DOUGH_PROBE = "dough_probe_sensor"
CONF_USE_HUMIDITY = "use_humidity_modifier"
CONF_NAME = "name"

# Recipe defaults (grams) — these seed the live-editable number entities.
CONF_STARTER_G = "starter_g"
CONF_FLOUR_G = "flour_g"
CONF_WATER_G = "water_g"
CONF_PROTEIN = "protein_pct"

# Advanced model params (options)
CONF_Q10 = "q10"
CONF_REF_TEMP = "ref_temp"
CONF_BASE_HOURS = "base_hours"

# --- Defaults ---------------------------------------------------------------
DEFAULT_NAME = "Sourdough Bulk"

# Zac's standard bake: 50 g starter, 375 g water, 500 g flour
#   -> 10% inoculation, 75% hydration.
DEFAULT_STARTER_G = 50.0
DEFAULT_FLOUR_G = 500.0
DEFAULT_WATER_G = 375.0
DEFAULT_PROTEIN = 12.5          # typical strong bread flour

DEFAULT_Q10 = 2.0
DEFAULT_REF_TEMP = 24.0
DEFAULT_REF_RATIO = 0.20        # model calibrated at 20% inoculation
DEFAULT_BASE_HOURS = 5.0
DEFAULT_USE_HUMIDITY = True

# Model coefficients
HUMIDITY_NEUTRAL = 60.0
HUMIDITY_COEFF = 0.003
HYDRATION_REF = 75.0            # reference hydration %
HYDRATION_COEFF = 0.008        # higher hydration -> faster (shorter time)
PROTEIN_REF = 12.5             # reference protein %
PROTEIN_COEFF = 0.02          # higher protein -> target more rise -> longer

# Pace thresholds (hours)
FAST_THRESHOLD_H = 3.0
SLOW_THRESHOLD_H = 10.0
