# Sourdough Fermentation — Home Assistant integration

A UI-configured integration that estimates **bulk fermentation time** from your
existing temperature (and optionally humidity) sensors, using a Q10 biological
rate model with starter-ratio scaling.

No YAML required — you pick your sensors from dropdowns during setup.

## What it does

Creates two sensors per config entry:

- **Bulk fermentation time** (`sensor.<name>_bulk_fermentation_time`) — estimated
  total bulk time in hours under current conditions. Recalculates live whenever
  your source sensors change.
- **Fermentation rate** (`sensor.<name>_fermentation_rate`) — fraction of bulk
  completed per hour (`1/h`). Useful for graphing and for building a cumulative
  progress tracker (see below).

## Live recipe controls

Setup seeds a default recipe (Zac's standard: **50 g starter, 375 g water,
500 g flour, 12.5% protein** — i.e. 10% inoculation, 75% hydration). These
become four editable **number** entities:

- `number.<name>_starter` (g)
- `number.<name>_flour` (g)
- `number.<name>_water` (g)
- `number.<name>_flour_protein` (%)

Drop them on a dashboard and the **Bulk fermentation time** sensor updates live
as you drag the sliders — so you can trial starter ratios against the current
room temperature *before* you mix. Values persist across restarts.

Starter ratio is derived as starter/flour; hydration as water/flour.

## How protein and hydration factor in

- **Hydration** (from water/flour) is a genuine *rate* modifier — wetter dough
  ferments faster, so higher hydration shortens the estimate.
- **Protein** is *not* a rate modifier. Higher-protein flour builds stronger
  gluten that tolerates a longer bulk, so it slightly *lengthens* the target
  time (you're aiming for a bigger rise), rather than changing microbial speed.
  The effect is deliberately small (~±6% across 9–15% protein). Reference 12.5%.

## Temperature source priority

1. **Dough probe** (internal temp) — if configured and readable, it's used
   directly. This is the most accurate input; humidity is ignored because the
   probe already measures the true dough temperature.
2. **Room temperature** — used when no probe is present, with an optional
   humidity modifier.

This mirrors the reality that once you have an internal reading, external air
temp and humidity no longer matter — the modifier only ever exists to
approximate the equilibration lag when you *don't* have a probe.

## The model

```
bulk_hours = base_hours
           × Q10 ^ ((ref_temp − T) / 10)      # temperature (Q10 rate law)
           × √(ref_ratio / starter_ratio)     # inoculation, diminishing returns
           × (1 + (60 − RH%) × 0.003)         # humidity — room-temp mode only
```

Defaults are calibrated to a Tartine-style bake: **5 h at 24 °C dough temp with
20% starter**, ~72% hydration bread flour. All constants (Q10, reference temp,
base hours, starter ratio) are editable in the integration's **Options**.

## Install

### HACS (custom repository)
1. HACS → three-dot menu → *Custom repositories*.
2. Add your repo URL, category **Integration**.
3. Install *Sourdough Fermentation*, then restart Home Assistant.

### Manual
Copy `custom_components/sourdough_ferment/` into your HA `config/custom_components/`
directory and restart.

## Set up
*Settings → Devices & Services → Add Integration → Sourdough Fermentation.*
Pick your room temp sensor (required), optionally a dough probe and humidity
sensor, and set your starter ratio. Change any of it later via *Configure*.

## Bonus: cumulative progress tracker

The rate sensor is designed to be integrated over time. Add a
[Riemann sum integration](https://www.home-assistant.io/integrations/integration/)
helper over `sensor.<name>_fermentation_rate` (unit `1/h`, time unit hours). The
running total climbs toward **1.0 (100%)** as the dough ferments — reset it when
you mix a new batch, and you get a live "percent through bulk" readout that
correctly accounts for temperature swings during the rise.

## Disclaimer
A compass, not a GPS. Whole-grain flours ferment faster; stiff doughs slower.
Always confirm with dough feel, ~50–75% rise, and the windowpane test.
