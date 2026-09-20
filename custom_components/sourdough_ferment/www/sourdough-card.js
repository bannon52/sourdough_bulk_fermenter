/**
 * Sourdough Fermentation card — a Lovelace custom card for the
 * Sourdough Fermentation integration.
 *
 * No build step, no external dependencies (works without internet access).
 * Renders inside a shadow root so it never leaks styles into the rest of
 * the dashboard, and never inherits the dashboard theme's colors — this
 * card intentionally uses its own bread-toned palette.
 */

const DOME_TOP = 14;
const DOME_BASE = 150;
const DOME_HEIGHT = DOME_BASE - DOME_TOP;
const DOME_PATH =
  "M14,150 L14,84 C14,42 46,14 100,14 C154,14 186,42 186,84 L186,150 Z";

/**
 * Entity-name suffixes this integration produces. Used to auto-discover the
 * card's entities from a device, so the card works no matter what the user
 * named the config entry (the device name becomes the entity_id prefix).
 */
const ENTITY_SUFFIXES = {
  progress_entity: ["_bulk_progress"],
  ready_at_entity: ["_bulk_ready_at"],
  finish_now_entity: ["_finish_time_if_started_now", "_finish_if_started_now"],
  remaining_entity: ["_bulk_time_remaining"],
  hydration_entity: ["_total_hydration"],
  starter_entity: ["_starter"],
  flour_entity: ["_flour"],
  water_entity: ["_water"],
  start_entity: ["_start_bulk"],
  reset_entity: ["_reset_bulk"],
};

// Suffixes that would also match a longer sibling; require an exact tail match
// so "_flour" never captures "_flour_protein".
const AMBIGUOUS = new Set(["_starter", "_flour", "_water"]);

/** All entity_ids belonging to a device, via the frontend entity registry. */
function entitiesForDevice(hass, deviceId) {
  if (!deviceId || !hass.entities) return [];
  const out = [];
  for (const [entityId, entry] of Object.entries(hass.entities)) {
    if (entry && entry.device_id === deviceId) out.push(entityId);
  }
  return out;
}

/**
 * Resolve the full entity set for the card.
 * Explicit config always wins; anything missing is discovered from device_id.
 */
function resolveEntities(hass, config) {
  const resolved = {};
  const pool = entitiesForDevice(hass, config.device_id);

  for (const key of Object.keys(ENTITY_SUFFIXES)) {
    if (config[key]) {
      resolved[key] = config[key];
      continue;
    }
    if (!pool.length) continue;

    let match;
    for (const suffix of ENTITY_SUFFIXES[key]) {
      match = pool.find((id) => {
        const objectId = id.split(".")[1] || "";
        if (!objectId.endsWith(suffix)) return false;
        if (AMBIGUOUS.has(suffix)) {
          // Guard against "_flour" matching "..._flour_protein".
          const others = Object.values(ENTITY_SUFFIXES)
            .flat()
            .filter((s) => s !== suffix && s.startsWith(suffix));
          if (others.some((s) => objectId.endsWith(s))) return false;
        }
        return true;
      });
      if (match) break;
    }
    if (match) resolved[key] = match;
  }
  return resolved;
}

function formatHours(hoursFloat) {
  if (hoursFloat === null || hoursFloat === undefined || isNaN(hoursFloat)) {
    return "—";
  }
  const totalMinutes = Math.round(hoursFloat * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function stateOf(hass, entityId) {
  return entityId ? hass.states[entityId] : undefined;
}

const TEMPLATE = `
<style>
  :host {
    --sf-bg: #1c1710;
    --sf-recessed: #241d14;
    --sf-line: #332a1c;
    --sf-crust: #d9974d;
    --sf-gold: #e6b04a;
    --sf-gold-glow: rgba(230, 176, 74, 0.35);
    --sf-text: #f2ece0;
    --sf-muted: #a3937a;
    display: block;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  .card {
    background: var(--sf-bg);
    border: 1px solid var(--sf-line);
    border-radius: 20px;
    padding: 20px 20px 14px;
    color: var(--sf-text);
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 15px;
    font-weight: 600;
  }
  .title .jar {
    width: 30px; height: 30px;
    display: flex; align-items: center; justify-content: center;
    background: var(--sf-recessed);
    border-radius: 9px;
    font-size: 15px;
  }
  .pill {
    font-size: 12px;
    padding: 4px 11px;
    border-radius: 100px;
    font-weight: 600;
  }
  .pill.idle { background: var(--sf-recessed); color: var(--sf-muted); }
  .pill.fermenting { background: rgba(217,151,77,0.16); color: var(--sf-crust); }
  .pill.ready { background: rgba(230,176,74,0.16); color: var(--sf-gold); }

  .dome-wrap {
    display: flex; flex-direction: column; align-items: center;
    padding: 12px 0 4px;
  }
  .dome-svg {
    width: 160px; height: 128px;
    transition: filter 0.6s ease;
  }
  .dome-svg.ready {
    animation: sf-glow 2.6s ease-in-out infinite;
  }
  @keyframes sf-glow {
    0%, 100% { filter: drop-shadow(0 0 10px var(--sf-gold-glow)); }
    50%      { filter: drop-shadow(0 0 18px var(--sf-gold-glow)); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dome-svg.ready { animation: none; filter: drop-shadow(0 0 14px var(--sf-gold-glow)); }
  }
  .fill-rect { transition: y 0.6s ease, height 0.6s ease, fill 0.4s ease; }
  .bubble { fill: rgba(255,255,255,0.55); opacity: 0; }
  .dome-svg.fermenting .bubble { animation: sf-rise 3.2s ease-in infinite; }
  .bubble.b2 { animation-delay: 0.9s !important; }
  .bubble.b3 { animation-delay: 1.8s !important; }
  .bubble.b4 { animation-delay: 0.4s !important; }
  @keyframes sf-rise {
    0%   { opacity: 0; transform: translateY(0); }
    12%  { opacity: 0.8; }
    85%  { opacity: 0.15; }
    100% { opacity: 0; transform: translateY(-40px); }
  }
  @media (prefers-reduced-motion: reduce) {
    .bubble { animation: none !important; opacity: 0 !important; }
  }
  .dome-caption {
    margin-top: 2px;
    font-size: 12.5px;
    color: var(--sf-muted);
  }

  .stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin: 12px 0 12px;
  }
  .stat {
    background: var(--sf-recessed);
    border-radius: 12px;
    padding: 10px 13px;
  }
  .stat-label { font-size: 11.5px; color: var(--sf-muted); margin-bottom: 3px; }
  .stat-value {
    font-family: Georgia, "Iowan Old Style", serif;
    font-size: 18px;
    font-weight: 500;
  }
  .stat-value.dim { color: var(--sf-muted); font-family: inherit; font-size: 14px; }

  .starter-control {
    background: var(--sf-recessed);
    border-radius: 12px;
    padding: 11px 14px 12px;
    margin-bottom: 10px;
  }
  .starter-control .row {
    display: flex; justify-content: space-between;
    font-size: 12.5px; color: var(--sf-muted); margin-bottom: 8px;
  }
  .starter-control b {
    color: var(--sf-crust);
    font-family: Georgia, "Iowan Old Style", serif;
    font-size: 15px; font-weight: 600;
  }

  input[type="range"] {
    -webkit-appearance: none; appearance: none;
    width: 100%; height: 5px; border-radius: 3px;
    background: var(--sf-line); outline: none;
    display: block;
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px; height: 16px; border-radius: 50%;
    background: var(--sf-crust); cursor: pointer;
    border: 2px solid var(--sf-bg);
  }
  input[type="range"]::-moz-range-thumb {
    width: 16px; height: 16px; border-radius: 50%;
    background: var(--sf-crust); cursor: pointer;
    border: 2px solid var(--sf-bg);
  }

  .recipe { border-top: 1px solid var(--sf-line); margin-top: 2px; }
  .recipe-summary {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 2px; cursor: pointer; user-select: none;
  }
  .recipe-summary-text { font-size: 13px; color: var(--sf-muted); }
  .recipe-summary-text b { color: var(--sf-text); font-weight: 500; }
  .chevron { color: var(--sf-muted); transition: transform 0.2s; font-size: 12px; }
  .recipe.open .chevron { transform: rotate(180deg); }
  .recipe-detail { max-height: 0; overflow: hidden; transition: max-height 0.25s ease; }
  .recipe.open .recipe-detail { max-height: 300px; }
  .slider-row { padding: 6px 2px 14px; display: flex; flex-direction: column; gap: 14px; }
  .slider-item label {
    display: flex; justify-content: space-between;
    font-size: 12.5px; color: var(--sf-muted); margin-bottom: 6px;
  }
  .slider-item label b { color: var(--sf-text); font-weight: 600; }

  .actions {
    display: flex; gap: 8px; padding-top: 12px;
    border-top: 1px solid var(--sf-line); margin-top: 2px;
  }
  .btn {
    flex: 1; padding: 11px 0; border-radius: 11px; border: none;
    font-family: inherit; font-size: 13.5px; font-weight: 600;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    gap: 6px; transition: filter 0.15s, background 0.2s;
  }
  .btn:hover { filter: brightness(1.08); }
  .btn:disabled { opacity: 0.5; cursor: default; filter: none; }
  .btn-ghost { background: var(--sf-recessed); color: var(--sf-muted); }
  .btn-primary { background: var(--sf-crust); color: #1c1710; }
  .btn-primary.ready { background: var(--sf-gold); }

  .unavailable {
    padding: 24px 4px; text-align: center; color: var(--sf-muted); font-size: 13px;
  }
</style>
<div class="card">
  <div class="body"></div>
</div>
`;

class SourdoughFermentationCard extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._config = null;
    this._pendingStarter = null;
    this._pendingFlour = null;
    this._pendingWater = null;
  }

  setConfig(config) {
    if (!config.progress_entity && !config.device_id) {
      throw new Error(
        "sourdough-fermentation-card: pick a device (or set 'progress_entity')"
      );
    }
    this._config = config;
    this._render();
  }

  static getConfigElement() {
    return document.createElement("sourdough-fermentation-card-editor");
  }

  static getStubConfig(hass) {
    // Prefill with the first Sourdough Fermentation device found, if any.
    let deviceId;
    if (hass && hass.entities && hass.devices) {
      for (const entry of Object.values(hass.entities)) {
        if (entry && entry.platform === "sourdough_ferment" && entry.device_id) {
          deviceId = entry.device_id;
          break;
        }
      }
    }
    return deviceId ? { device_id: deviceId } : {};
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 6;
  }

  _ensureShell() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = TEMPLATE;
    this._body = this.shadowRoot.querySelector(".body");
  }

  _call(entityId, domain, service, extra) {
    if (!this._hass || !entityId) return;
    this._hass.callService(domain, service, {
      entity_id: entityId,
      ...extra,
    });
  }

  _render() {
    if (!this._config || !this._hass) return;
    this._ensureShell();

    const hass = this._hass;
    // Explicit config wins; anything unset is discovered from the device.
    const cfg = { ...this._config, ...resolveEntities(hass, this._config) };
    const progress = stateOf(hass, cfg.progress_entity);

    if (!progress) {
      const msg = cfg.progress_entity
        ? `Entity not found: ${cfg.progress_entity}`
        : "No Sourdough Fermentation device selected — edit the card and pick one.";
      this._body.innerHTML = `<div class="unavailable">${msg}</div>`;
      return;
    }

    const pct = Math.max(0, Math.min(100, parseFloat(progress.state) || 0));
    const active = progress.attributes.active === true;
    const completedAt = progress.attributes.completed_at;

    let status = "idle";
    if (active) status = "fermenting";
    else if (pct >= 100 || completedAt) status = "ready";

    const readyAtState = stateOf(hass, cfg.ready_at_entity);
    const finishNowState = stateOf(hass, cfg.finish_now_entity);
    const remainingState = stateOf(hass, cfg.remaining_entity);

    const readyAtClock = readyAtState?.attributes?.clock;
    const finishNowClock = finishNowState?.attributes?.clock;
    const estBulkHours = finishNowState?.attributes?.bulk_hours;
    const remainingHours = remainingState ? parseFloat(remainingState.state) : null;

    let statLeftLabel, statLeftValue, statLeftDim;
    let statRightLabel, statRightValue, statRightDim;

    if (status === "idle") {
      statLeftLabel = "If started now";
      statLeftValue = finishNowClock || "—";
      statLeftDim = false;
      statRightLabel = "Est. bulk time";
      statRightValue = formatHours(estBulkHours);
      statRightDim = false;
    } else if (status === "fermenting") {
      statLeftLabel = "Ready at";
      statLeftValue = readyAtClock || "—";
      statLeftDim = false;
      statRightLabel = "Remaining";
      statRightValue = formatHours(remainingHours);
      statRightDim = false;
    } else {
      statLeftLabel = "Finished at";
      statLeftValue = readyAtClock || "—";
      statLeftDim = false;
      statRightLabel = "Status";
      statRightValue = "Done";
      statRightDim = true;
    }

    const domeCaption =
      status === "idle" ? "Not started" : `${pct.toFixed(0)}% risen`;

    const fillHeight = (pct / 100) * DOME_HEIGHT;
    const fillY = DOME_BASE - fillHeight;
    const fillColor = status === "ready" ? "var(--sf-gold)" : "var(--sf-crust)";

    // --- Recipe entities (all optional beyond starter/progress) ---
    const starterState = stateOf(hass, cfg.starter_entity);
    const flourState = stateOf(hass, cfg.flour_entity);
    const waterState = stateOf(hass, cfg.water_entity);
    const hydrationState = stateOf(hass, cfg.hydration_entity);

    const starterVal =
      this._pendingStarter ?? (starterState ? parseFloat(starterState.state) : 0);
    const flourVal =
      this._pendingFlour ?? (flourState ? parseFloat(flourState.state) : 0);
    const waterVal =
      this._pendingWater ?? (waterState ? parseFloat(waterState.state) : 0);
    const hydrationVal = hydrationState ? parseFloat(hydrationState.state) : null;

    const starterMin = starterState?.attributes?.min ?? 0;
    const starterMax = starterState?.attributes?.max ?? 200;
    const starterStep = starterState?.attributes?.step ?? 5;
    const flourMin = flourState?.attributes?.min ?? 50;
    const flourMax = flourState?.attributes?.max ?? 1000;
    const flourStep = flourState?.attributes?.step ?? 5;
    const waterMin = waterState?.attributes?.min ?? 0;
    const waterMax = waterState?.attributes?.max ?? 1000;
    const waterStep = waterState?.attributes?.step ?? 5;

    const recipeOpen = this._recipeOpen ? "open" : "";
    const hydrationBit =
      hydrationVal !== null ? ` · <b>${hydrationVal.toFixed(0)}%</b> hyd` : "";

    const startLabel =
      status === "idle" ? "▶ Start bulk" :
      status === "fermenting" ? "Running…" :
      "▶ Start bulk";
    const startDisabled = status === "fermenting";

    this._body.innerHTML = `
      <div class="header">
        <div class="title"><span class="jar">🍞</span>${cfg.title || "Sourdough Bulk"}</div>
        <span class="pill ${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>
      </div>

      <div class="dome-wrap">
        <svg class="dome-svg ${status}" viewBox="0 0 200 160">
          <defs><clipPath id="sfClip-${this._uid()}"><path d="${DOME_PATH}"/></clipPath></defs>
          <path d="${DOME_PATH}" fill="none" stroke="#332a1c" stroke-width="2"/>
          <g clip-path="url(#sfClip-${this._uid()})">
            <rect class="fill-rect" x="14" y="${fillY}" width="172" height="${fillHeight}" fill="${fillColor}"/>
            <circle class="bubble b1" cx="70" cy="120" r="3.5"/>
            <circle class="bubble b2" cx="110" cy="130" r="2.5"/>
            <circle class="bubble b3" cx="90" cy="110" r="4"/>
            <circle class="bubble b4" cx="130" cy="115" r="3"/>
          </g>
        </svg>
        <div class="dome-caption">${domeCaption}</div>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="stat-label">${statLeftLabel}</div>
          <div class="stat-value ${statLeftDim ? "dim" : ""}">${statLeftValue}</div>
        </div>
        <div class="stat">
          <div class="stat-label">${statRightLabel}</div>
          <div class="stat-value ${statRightDim ? "dim" : ""}">${statRightValue}</div>
        </div>
      </div>

      ${cfg.starter_entity ? `
      <div class="starter-control">
        <div class="row"><span>Starter</span><b id="starterLabel">${starterVal} g</b></div>
        <input type="range" id="starterSlider" min="${starterMin}" max="${starterMax}" step="${starterStep}" value="${starterVal}">
      </div>` : ""}

      ${(cfg.flour_entity || cfg.water_entity) ? `
      <div class="recipe ${recipeOpen}" id="recipeBox">
        <div class="recipe-summary" id="recipeSummary">
          <div class="recipe-summary-text">
            ${flourState ? `<b>${flourVal}g</b> flour` : ""}${flourState && waterState ? " · " : ""}${waterState ? `<b>${waterVal}g</b> water` : ""}${hydrationBit}
          </div>
          <span class="chevron">▾</span>
        </div>
        <div class="recipe-detail">
          <div class="slider-row">
            ${flourState ? `
            <div class="slider-item">
              <label>Flour <b id="flourLabel">${flourVal} g</b></label>
              <input type="range" id="flourSlider" min="${flourMin}" max="${flourMax}" step="${flourStep}" value="${flourVal}">
            </div>` : ""}
            ${waterState ? `
            <div class="slider-item">
              <label>Water <b id="waterLabel">${waterVal} g</b></label>
              <input type="range" id="waterSlider" min="${waterMin}" max="${waterMax}" step="${waterStep}" value="${waterVal}">
            </div>` : ""}
          </div>
        </div>
      </div>` : ""}

      ${(cfg.start_entity || cfg.reset_entity) ? `
      <div class="actions">
        ${cfg.reset_entity ? `<button class="btn btn-ghost" id="resetBtn">↻ Reset</button>` : ""}
        ${cfg.start_entity ? `<button class="btn btn-primary ${status === "ready" ? "ready" : ""}" id="startBtn" ${startDisabled ? "disabled" : ""}>${startLabel}</button>` : ""}
      </div>` : ""}
    `;

    this._wireEvents(cfg);
  }

  _uid() {
    if (!this.__uid) this.__uid = Math.random().toString(36).slice(2, 9);
    return this.__uid;
  }

  _wireEvents(cfg) {
    const root = this.shadowRoot;

    const starterSlider = root.getElementById("starterSlider");
    if (starterSlider) {
      starterSlider.addEventListener("input", (e) => {
        this._pendingStarter = parseFloat(e.target.value);
        root.getElementById("starterLabel").textContent = `${this._pendingStarter} g`;
      });
      starterSlider.addEventListener("change", (e) => {
        this._call(cfg.starter_entity, "number", "set_value", { value: parseFloat(e.target.value) });
        this._pendingStarter = null;
      });
    }

    const flourSlider = root.getElementById("flourSlider");
    if (flourSlider) {
      flourSlider.addEventListener("input", (e) => {
        this._pendingFlour = parseFloat(e.target.value);
        root.getElementById("flourLabel").textContent = `${this._pendingFlour} g`;
      });
      flourSlider.addEventListener("change", (e) => {
        this._call(cfg.flour_entity, "number", "set_value", { value: parseFloat(e.target.value) });
        this._pendingFlour = null;
      });
    }

    const waterSlider = root.getElementById("waterSlider");
    if (waterSlider) {
      waterSlider.addEventListener("input", (e) => {
        this._pendingWater = parseFloat(e.target.value);
        root.getElementById("waterLabel").textContent = `${this._pendingWater} g`;
      });
      waterSlider.addEventListener("change", (e) => {
        this._call(cfg.water_entity, "number", "set_value", { value: parseFloat(e.target.value) });
        this._pendingWater = null;
      });
    }

    const recipeSummary = root.getElementById("recipeSummary");
    if (recipeSummary) {
      recipeSummary.addEventListener("click", () => {
        this._recipeOpen = !this._recipeOpen;
        root.getElementById("recipeBox").classList.toggle("open", this._recipeOpen);
      });
    }

    const startBtn = root.getElementById("startBtn");
    if (startBtn) {
      startBtn.addEventListener("click", () => {
        this._call(cfg.start_entity, "button", "press");
      });
    }

    const resetBtn = root.getElementById("resetBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        this._call(cfg.reset_entity, "button", "press");
      });
    }
  }
}

customElements.define("sourdough-fermentation-card", SourdoughFermentationCard);

/**
 * Visual editor shown in the dashboard card UI.
 *
 * Uses Home Assistant's own <ha-form> with a device selector filtered to this
 * integration, so configuring the card is picking one device from a dropdown
 * rather than typing out a dozen entity IDs.
 */
const EDITOR_SCHEMA = [
  {
    name: "device_id",
    required: true,
    selector: { device: { integration: "sourdough_ferment" } },
  },
  { name: "title", selector: { text: {} } },
];

const EDITOR_LABELS = {
  device_id: "Sourdough device",
  title: "Card title (optional)",
};

class SourdoughFermentationCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._form = null;
  }

  setConfig(config) {
    this._config = config || {};
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  connectedCallback() {
    this._update();
  }

  _update() {
    if (!this._hass) return;

    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (schema) => EDITOR_LABELS[schema.name] || schema.name;
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: ev.detail.value },
            bubbles: true,
            composed: true,
          })
        );
      });
      this.appendChild(this._form);
    }

    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = this._config;
  }
}

customElements.define(
  "sourdough-fermentation-card-editor",
  SourdoughFermentationCardEditor
);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "sourdough-fermentation-card",
  name: "Sourdough Fermentation Card",
  description: "A rising-dough dashboard card for the Sourdough Fermentation integration.",
  preview: true,
  documentationURL: "https://github.com/bannon52/sourdough_bulk_fermenter",
});
