/**
 * Sourdough Fermentation card — Lovelace custom card for the
 * Sourdough Fermentation integration.
 *
 * Architecture: the DOM is built ONCE and then updated in place. Home
 * Assistant pushes a new `hass` object whenever ANY entity in the system
 * changes, so rebuilding the markup on every push would destroy sliders
 * mid-drag and restart CSS animations. Instead we:
 *   - rebuild the structure only when the set of available controls changes
 *   - skip updates entirely when none of this card's entities changed
 *   - never overwrite a slider the user is currently dragging
 *
 * Syntax deliberately sticks to ES2017 (no optional chaining, nullish
 * coalescing, object spread or Array.flat) so it runs on older Android
 * WebViews used by the Companion app.
 */
(function () {
  "use strict";

  if (window.customElements.get("sourdough-fermentation-card")) {
    return; // already loaded (script injected twice)
  }

  var DOME_TOP = 14;
  var DOME_BASE = 150;
  var DOME_HEIGHT = DOME_BASE - DOME_TOP;
  var DOME_PATH =
    "M14,150 L14,84 C14,42 46,14 100,14 C154,14 186,42 186,84 L186,150 Z";
  var PENDING_HOLD_MS = 4000;

  // Entity-name suffixes this integration produces, for auto-discovery.
  var ENTITY_SUFFIXES = {
    progress_entity: ["_bulk_progress"],
    ready_at_entity: ["_bulk_ready_at"],
    finish_now_entity: ["_finish_time_if_started_now", "_finish_if_started_now"],
    remaining_entity: ["_bulk_time_remaining"],
    hydration_entity: ["_total_hydration"],
    starter_entity: ["_starter"],
    flour_entity: ["_flour"],
    water_entity: ["_water"],
    start_entity: ["_start_bulk"],
    reset_entity: ["_reset_bulk"]
  };
  var ENTITY_KEYS = Object.keys(ENTITY_SUFFIXES);

  // "_flour" must never match "..._flour_protein".
  var LONGER_SIBLINGS = { _flour: ["_flour_protein"] };

  function isNum(v) {
    return typeof v === "number" && !isNaN(v);
  }

  function pick(value, fallback) {
    return value === undefined || value === null ? fallback : value;
  }

  function attr(stateObj, name) {
    if (!stateObj || !stateObj.attributes) return undefined;
    return stateObj.attributes[name];
  }

  function num(stateObj) {
    if (!stateObj) return null;
    var v = parseFloat(stateObj.state);
    return isNaN(v) ? null : v;
  }

  function formatHours(h) {
    if (!isNum(h)) return "\u2014";
    var total = Math.round(h * 60);
    var hrs = Math.floor(total / 60);
    var mins = total % 60;
    if (hrs <= 0) return mins + "m";
    if (mins === 0) return hrs + "h";
    return hrs + "h " + mins + "m";
  }

  function entitiesForDevice(hass, deviceId) {
    var out = [];
    if (!deviceId || !hass.entities) return out;
    var ids = Object.keys(hass.entities);
    for (var i = 0; i < ids.length; i++) {
      var entry = hass.entities[ids[i]];
      if (entry && entry.device_id === deviceId) out.push(ids[i]);
    }
    return out;
  }

  function matchesSuffix(entityId, suffix) {
    var objectId = entityId.split(".")[1] || "";
    if (objectId.slice(-suffix.length) !== suffix) return false;
    var longer = LONGER_SIBLINGS[suffix] || [];
    for (var i = 0; i < longer.length; i++) {
      if (objectId.slice(-longer[i].length) === longer[i]) return false;
    }
    return true;
  }

  function resolveEntities(hass, config) {
    var resolved = {};
    var pool = entitiesForDevice(hass, config.device_id);
    for (var k = 0; k < ENTITY_KEYS.length; k++) {
      var key = ENTITY_KEYS[k];
      if (config[key]) {
        resolved[key] = config[key];
        continue;
      }
      var suffixes = ENTITY_SUFFIXES[key];
      for (var s = 0; s < suffixes.length && !resolved[key]; s++) {
        for (var p = 0; p < pool.length; p++) {
          if (matchesSuffix(pool[p], suffixes[s])) {
            resolved[key] = pool[p];
            break;
          }
        }
      }
    }
    return resolved;
  }

  var CSS = "<style>\n  :host {\n    --sf-bg: #1c1710;\n    --sf-recessed: #241d14;\n    --sf-line: #332a1c;\n    --sf-crust: #d9974d;\n    --sf-gold: #e6b04a;\n    --sf-gold-glow: rgba(230, 176, 74, 0.35);\n    --sf-text: #f2ece0;\n    --sf-muted: #a3937a;\n    display: block;\n    font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;\n  }\n  * { box-sizing: border-box; }\n  .card {\n    background: var(--sf-bg);\n    border: 1px solid var(--sf-line);\n    border-radius: 20px;\n    padding: 20px 20px 14px;\n    color: var(--sf-text);\n  }\n  .header {\n    display: flex;\n    align-items: center;\n    justify-content: space-between;\n    margin-bottom: 4px;\n  }\n  .title {\n    display: flex;\n    align-items: center;\n    gap: 10px;\n    font-size: 15px;\n    font-weight: 600;\n  }\n  .title .jar {\n    width: 30px; height: 30px;\n    display: flex; align-items: center; justify-content: center;\n    background: var(--sf-recessed);\n    border-radius: 9px;\n    font-size: 15px;\n  }\n  .pill {\n    font-size: 12px;\n    padding: 4px 11px;\n    border-radius: 100px;\n    font-weight: 600;\n  }\n  .pill.idle { background: var(--sf-recessed); color: var(--sf-muted); }\n  .pill.fermenting { background: rgba(217,151,77,0.16); color: var(--sf-crust); }\n  .pill.ready { background: rgba(230,176,74,0.16); color: var(--sf-gold); }\n\n  .dome-wrap {\n    display: flex; flex-direction: column; align-items: center;\n    padding: 12px 0 4px;\n  }\n  .dome-svg {\n    width: 160px; height: 128px;\n    transition: filter 0.6s ease;\n  }\n  .dome-svg.ready {\n    animation: sf-glow 2.6s ease-in-out infinite;\n  }\n  @keyframes sf-glow {\n    0%, 100% { filter: drop-shadow(0 0 10px var(--sf-gold-glow)); }\n    50%      { filter: drop-shadow(0 0 18px var(--sf-gold-glow)); }\n  }\n  @media (prefers-reduced-motion: reduce) {\n    .dome-svg.ready { animation: none; filter: drop-shadow(0 0 14px var(--sf-gold-glow)); }\n  }\n  .fill-rect { transition: y 0.6s ease, height 0.6s ease, fill 0.4s ease; }\n  .bubble { fill: rgba(255,255,255,0.55); opacity: 0; }\n  .dome-svg.fermenting .bubble { animation: sf-rise 3.2s ease-in infinite; }\n  .bubble.b2 { animation-delay: 0.9s !important; }\n  .bubble.b3 { animation-delay: 1.8s !important; }\n  .bubble.b4 { animation-delay: 0.4s !important; }\n  @keyframes sf-rise {\n    0%   { opacity: 0; transform: translateY(0); }\n    12%  { opacity: 0.8; }\n    85%  { opacity: 0.15; }\n    100% { opacity: 0; transform: translateY(-40px); }\n  }\n  @media (prefers-reduced-motion: reduce) {\n    .bubble { animation: none !important; opacity: 0 !important; }\n  }\n  .dome-caption {\n    margin-top: 2px;\n    font-size: 12.5px;\n    color: var(--sf-muted);\n  }\n\n  .stats {\n    display: grid;\n    grid-template-columns: 1fr 1fr;\n    gap: 10px;\n    margin: 12px 0 12px;\n  }\n  .stat {\n    background: var(--sf-recessed);\n    border-radius: 12px;\n    padding: 10px 13px;\n  }\n  .stat-label { font-size: 11.5px; color: var(--sf-muted); margin-bottom: 3px; }\n  .stat-value {\n    font-family: Georgia, \"Iowan Old Style\", serif;\n    font-size: 18px;\n    font-weight: 500;\n  }\n  .stat-value.dim { color: var(--sf-muted); font-family: inherit; font-size: 14px; }\n\n  .starter-control {\n    background: var(--sf-recessed);\n    border-radius: 12px;\n    padding: 11px 14px 12px;\n    margin-bottom: 10px;\n  }\n  .starter-control .row {\n    display: flex; justify-content: space-between;\n    font-size: 12.5px; color: var(--sf-muted); margin-bottom: 8px;\n  }\n  .starter-control b {\n    color: var(--sf-crust);\n    font-family: Georgia, \"Iowan Old Style\", serif;\n    font-size: 15px; font-weight: 600;\n  }\n\n  input[type=\"range\"] {\n    -webkit-appearance: none; appearance: none;\n    width: 100%; height: 5px; border-radius: 3px;\n    background: var(--sf-line); outline: none;\n    display: block;\n  }\n  input[type=\"range\"]::-webkit-slider-thumb {\n    -webkit-appearance: none;\n    width: 16px; height: 16px; border-radius: 50%;\n    background: var(--sf-crust); cursor: pointer;\n    border: 2px solid var(--sf-bg);\n  }\n  input[type=\"range\"]::-moz-range-thumb {\n    width: 16px; height: 16px; border-radius: 50%;\n    background: var(--sf-crust); cursor: pointer;\n    border: 2px solid var(--sf-bg);\n  }\n\n  .recipe { border-top: 1px solid var(--sf-line); margin-top: 2px; }\n  .recipe-summary {\n    display: flex; align-items: center; justify-content: space-between;\n    padding: 12px 2px; cursor: pointer; user-select: none;\n  }\n  .recipe-summary-text { font-size: 13px; color: var(--sf-muted); }\n  .recipe-summary-text b { color: var(--sf-text); font-weight: 500; }\n  .chevron { color: var(--sf-muted); transition: transform 0.2s; font-size: 12px; }\n  .recipe.open .chevron { transform: rotate(180deg); }\n  .recipe-detail { max-height: 0; overflow: hidden; transition: max-height 0.25s ease; }\n  .recipe.open .recipe-detail { max-height: 300px; }\n  .slider-row { padding: 6px 2px 14px; display: flex; flex-direction: column; gap: 14px; }\n  .slider-item label {\n    display: flex; justify-content: space-between;\n    font-size: 12.5px; color: var(--sf-muted); margin-bottom: 6px;\n  }\n  .slider-item label b { color: var(--sf-text); font-weight: 600; }\n\n  .actions {\n    display: flex; gap: 8px; padding-top: 12px;\n    border-top: 1px solid var(--sf-line); margin-top: 2px;\n  }\n  .btn {\n    flex: 1; padding: 11px 0; border-radius: 11px; border: none;\n    font-family: inherit; font-size: 13.5px; font-weight: 600;\n    cursor: pointer; display: flex; align-items: center; justify-content: center;\n    gap: 6px; transition: filter 0.15s, background 0.2s;\n  }\n  .btn:hover { filter: brightness(1.08); }\n  .btn:disabled { opacity: 0.5; cursor: default; filter: none; }\n  .btn-ghost { background: var(--sf-recessed); color: var(--sf-muted); }\n  .btn-primary { background: var(--sf-crust); color: #1c1710; }\n  .btn-primary.ready { background: var(--sf-gold); }\n\n  .unavailable {\n    padding: 24px 4px; text-align: center; color: var(--sf-muted); font-size: 13px;\n  }\n</style>";

  // ---------------------------------------------------------------------------
  // Card
  // ---------------------------------------------------------------------------
  class SourdoughFermentationCard extends HTMLElement {
    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._ents = {};
      this._structureKey = null;
      this._lastStates = null;
      this._refs = {};
      this._dragging = {};
      this._pending = {};
      this._recipeOpen = false;
      this._uid = Math.random().toString(36).slice(2, 9);
    }

    setConfig(config) {
      if (!config || (!config.progress_entity && !config.device_id)) {
        throw new Error(
          "sourdough-fermentation-card: pick a device (or set 'progress_entity')"
        );
      }
      this._config = config;
      this._structureKey = null; // force a rebuild with the new config
      this._lastStates = null;
      this._update();
    }

    set hass(hass) {
      this._hass = hass;
      this._update();
    }

    getCardSize() {
      return 6;
    }

    static getConfigElement() {
      return document.createElement("sourdough-fermentation-card-editor");
    }

    static getStubConfig(hass) {
      if (hass && hass.entities) {
        var ids = Object.keys(hass.entities);
        for (var i = 0; i < ids.length; i++) {
          var e = hass.entities[ids[i]];
          if (e && e.platform === "sourdough_ferment" && e.device_id) {
            return { device_id: e.device_id };
          }
        }
      }
      return {};
    }

    // --- orchestration -------------------------------------------------------
    _update() {
      if (!this._config || !this._hass) return;
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });

      var ents = resolveEntities(this._hass, this._config);
      this._ents = ents;

      var key = [
        this._config.title || "",
        ents.progress_entity || "",
        ents.starter_entity ? 1 : 0,
        ents.flour_entity ? 1 : 0,
        ents.water_entity ? 1 : 0,
        ents.start_entity ? 1 : 0,
        ents.reset_entity ? 1 : 0
      ].join("|");

      if (key !== this._structureKey) {
        this._build();
        this._structureKey = key;
        this._lastStates = null;
      }

      // Skip work if none of our entities changed. HA replaces a state object
      // whenever that entity changes, so reference equality is enough.
      var states = [];
      for (var i = 0; i < ENTITY_KEYS.length; i++) {
        var id = ents[ENTITY_KEYS[i]];
        states.push(id ? this._hass.states[id] : undefined);
      }
      if (this._lastStates && this._sameStates(states, this._lastStates)) return;
      this._lastStates = states;

      this._fill();
    }

    _sameStates(a, b) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    // --- build (runs rarely) -------------------------------------------------
    _build() {
      var e = this._ents;
      var clip = "sfClip-" + this._uid;
      var title = this._config.title || "Sourdough Bulk";

      var html = CSS + '<div class="card">';

      html +=
        '<div class="unavailable" data-r="unavailable" style="display:none"></div>' +
        '<div data-r="main">' +
        '<div class="header"><div class="title"><span class="jar">\uD83C\uDF5E</span>' +
        '<span data-r="title"></span></div><span class="pill idle" data-r="pill">Idle</span></div>' +
        '<div class="dome-wrap"><svg class="dome-svg" data-r="dome" viewBox="0 0 200 160">' +
        '<defs><clipPath id="' + clip + '"><path d="' + DOME_PATH + '"/></clipPath></defs>' +
        '<path d="' + DOME_PATH + '" fill="none" stroke="#332a1c" stroke-width="2"/>' +
        '<g clip-path="url(#' + clip + ')">' +
        '<rect class="fill-rect" data-r="fill" x="14" y="' + DOME_BASE + '" width="172" height="0" fill="#d9974d"/>' +
        '<circle class="bubble b1" cx="70" cy="120" r="3.5"/>' +
        '<circle class="bubble b2" cx="110" cy="130" r="2.5"/>' +
        '<circle class="bubble b3" cx="90" cy="110" r="4"/>' +
        '<circle class="bubble b4" cx="130" cy="115" r="3"/>' +
        "</g></svg>" +
        '<div class="dome-caption" data-r="caption"></div></div>' +
        '<div class="stats">' +
        '<div class="stat"><div class="stat-label" data-r="l1"></div><div class="stat-value" data-r="v1"></div></div>' +
        '<div class="stat"><div class="stat-label" data-r="l2"></div><div class="stat-value" data-r="v2"></div></div>' +
        "</div>";

      if (e.starter_entity) {
        html +=
          '<div class="starter-control"><div class="row"><span>Starter</span>' +
          '<b data-r="starterLabel"></b></div>' +
          '<input type="range" data-r="starterSlider"></div>';
      }

      if (e.flour_entity || e.water_entity) {
        html +=
          '<div class="recipe' + (this._recipeOpen ? " open" : "") + '" data-r="recipe">' +
          '<div class="recipe-summary" data-r="recipeSummary">' +
          '<div class="recipe-summary-text" data-r="recipeText"></div>' +
          '<span class="chevron">\u25BE</span></div>' +
          '<div class="recipe-detail"><div class="slider-row">';
        if (e.flour_entity) {
          html +=
            '<div class="slider-item"><label>Flour <b data-r="flourLabel"></b></label>' +
            '<input type="range" data-r="flourSlider"></div>';
        }
        if (e.water_entity) {
          html +=
            '<div class="slider-item"><label>Water <b data-r="waterLabel"></b></label>' +
            '<input type="range" data-r="waterSlider"></div>';
        }
        html += "</div></div></div>";
      }

      if (e.start_entity || e.reset_entity) {
        html += '<div class="actions">';
        if (e.reset_entity) {
          html += '<button class="btn btn-ghost" data-r="resetBtn">\u21BB Reset</button>';
        }
        if (e.start_entity) {
          html += '<button class="btn btn-primary" data-r="startBtn">\u25B6 Start bulk</button>';
        }
        html += "</div>";
      }

      html += "</div></div>";
      this.shadowRoot.innerHTML = html;

      var refs = {};
      var nodes = this.shadowRoot.querySelectorAll("[data-r]");
      for (var i = 0; i < nodes.length; i++) {
        refs[nodes[i].getAttribute("data-r")] = nodes[i];
      }
      this._refs = refs;
      refs.title.textContent = title;

      this._wireSlider("starter", "starterSlider", "starterLabel");
      this._wireSlider("flour", "flourSlider", "flourLabel");
      this._wireSlider("water", "waterSlider", "waterLabel");

      var self = this;
      if (refs.recipeSummary) {
        refs.recipeSummary.addEventListener("click", function () {
          self._recipeOpen = !self._recipeOpen;
          refs.recipe.classList.toggle("open", self._recipeOpen);
        });
      }
      if (refs.startBtn) {
        refs.startBtn.addEventListener("click", function () {
          self._press(self._ents.start_entity);
        });
      }
      if (refs.resetBtn) {
        refs.resetBtn.addEventListener("click", function () {
          self._press(self._ents.reset_entity);
        });
      }
    }

    _wireSlider(name, sliderRef, labelRef) {
      var slider = this._refs[sliderRef];
      var label = this._refs[labelRef];
      if (!slider) return;
      var self = this;

      function begin() {
        self._dragging[name] = true;
      }
      function end() {
        self._dragging[name] = false;
      }

      slider.addEventListener("pointerdown", begin);
      slider.addEventListener("touchstart", begin, { passive: true });
      slider.addEventListener("mousedown", begin);

      slider.addEventListener("input", function () {
        self._dragging[name] = true;
        label.textContent = slider.value + " g";
      });

      slider.addEventListener("change", function () {
        var value = parseFloat(slider.value);
        self._pending[name] = { value: value, at: Date.now() };
        self._dragging[name] = false;
        label.textContent = value + " g";
        var entityId = self._ents[name + "_entity"];
        if (entityId && self._hass) {
          self._hass.callService("number", "set_value", {
            entity_id: entityId,
            value: value
          });
        }
      });

      slider.addEventListener("pointercancel", end);
      slider.addEventListener("touchcancel", end);
    }

    _press(entityId) {
      if (entityId && this._hass) {
        this._hass.callService("button", "press", { entity_id: entityId });
      }
    }

    // --- fill (runs on relevant state changes) -------------------------------
    _fill() {
      var r = this._refs;
      var e = this._ents;
      var hass = this._hass;
      var progress = e.progress_entity ? hass.states[e.progress_entity] : undefined;

      if (!progress) {
        r.main.style.display = "none";
        r.unavailable.style.display = "";
        r.unavailable.textContent = e.progress_entity
          ? "Entity not found: " + e.progress_entity
          : "No Sourdough Fermentation device selected \u2014 edit the card and pick one.";
        return;
      }
      r.main.style.display = "";
      r.unavailable.style.display = "none";

      var pct = Math.max(0, Math.min(100, num(progress) || 0));
      var active = attr(progress, "active") === true;
      var completed = attr(progress, "completed_at");

      var status = "idle";
      if (active) status = "fermenting";
      else if (pct >= 100 || completed) status = "ready";

      // Status pill — only touch the DOM if it changed.
      var pillText = status.charAt(0).toUpperCase() + status.slice(1);
      if (r.pill.textContent !== pillText) {
        r.pill.textContent = pillText;
        r.pill.className = "pill " + status;
      }

      // Dome. setAttribute('class') keeps the SVG element (and its running
      // bubble animations) intact; only the class list changes.
      var domeClass = "dome-svg " + status;
      if (r.dome.getAttribute("class") !== domeClass) {
        r.dome.setAttribute("class", domeClass);
      }
      var h = (pct / 100) * DOME_HEIGHT;
      r.fill.setAttribute("y", String(DOME_BASE - h));
      r.fill.setAttribute("height", String(h));
      r.fill.setAttribute("fill", status === "ready" ? "#e6b04a" : "#d9974d");
      r.caption.textContent = status === "idle" ? "Not started" : pct.toFixed(0) + "% risen";

      // Stats
      var readyAt = e.ready_at_entity ? hass.states[e.ready_at_entity] : undefined;
      var finishNow = e.finish_now_entity ? hass.states[e.finish_now_entity] : undefined;
      var remaining = e.remaining_entity ? hass.states[e.remaining_entity] : undefined;

      var l1, v1, l2, v2, dim2 = false;
      if (status === "idle") {
        l1 = "If started now";
        v1 = pick(attr(finishNow, "clock"), "\u2014");
        l2 = "Est. bulk time";
        v2 = formatHours(attr(finishNow, "bulk_hours"));
      } else if (status === "fermenting") {
        l1 = "Ready at";
        v1 = pick(attr(readyAt, "clock"), "\u2014");
        l2 = "Remaining";
        v2 = formatHours(num(remaining));
      } else {
        l1 = "Finished at";
        v1 = pick(attr(readyAt, "clock"), "\u2014");
        l2 = "Status";
        v2 = "Done";
        dim2 = true;
      }
      r.l1.textContent = l1;
      r.v1.textContent = v1;
      r.l2.textContent = l2;
      r.v2.textContent = v2;
      r.v2.className = "stat-value" + (dim2 ? " dim" : "");

      // Sliders
      this._syncSlider("starter", "starterSlider", "starterLabel", 0, 200, 5);
      this._syncSlider("flour", "flourSlider", "flourLabel", 50, 1000, 5);
      this._syncSlider("water", "waterSlider", "waterLabel", 0, 1000, 5);

      // Recipe summary line
      if (r.recipeText) {
        var flour = e.flour_entity ? num(hass.states[e.flour_entity]) : null;
        var water = e.water_entity ? num(hass.states[e.water_entity]) : null;
        var hyd = e.hydration_entity ? num(hass.states[e.hydration_entity]) : null;
        var parts = [];
        if (flour !== null) parts.push("<b>" + flour + "g</b> flour");
        if (water !== null) parts.push("<b>" + water + "g</b> water");
        if (hyd !== null) parts.push("<b>" + hyd.toFixed(0) + "%</b> hyd");
        r.recipeText.innerHTML = parts.join(" \u00B7 ");
      }

      // Start button
      if (r.startBtn) {
        var running = status === "fermenting";
        r.startBtn.disabled = running;
        r.startBtn.textContent = running ? "Running\u2026" : "\u25B6 Start bulk";
        r.startBtn.className = "btn btn-primary" + (status === "ready" ? " ready" : "");
      }
    }

    _syncSlider(name, sliderRef, labelRef, dMin, dMax, dStep) {
      var slider = this._refs[sliderRef];
      var label = this._refs[labelRef];
      if (!slider) return;

      var stateObj = this._hass.states[this._ents[name + "_entity"]];
      if (!stateObj) return;

      // Limits only change on reconfigure, but setting them is cheap.
      slider.min = String(pick(attr(stateObj, "min"), dMin));
      slider.max = String(pick(attr(stateObj, "max"), dMax));
      slider.step = String(pick(attr(stateObj, "step"), dStep));

      // Never fight the user's finger.
      if (this._dragging[name]) return;

      var value = num(stateObj);

      // After release, HA takes a moment to confirm. Keep showing the value
      // the user chose until HA agrees (or the hold expires), so the thumb
      // doesn't snap back to the old value in between.
      var pending = this._pending[name];
      if (pending) {
        var confirmed = value !== null && Math.abs(value - pending.value) < 1e-6;
        var expired = Date.now() - pending.at > PENDING_HOLD_MS;
        if (confirmed || expired) {
          delete this._pending[name];
        } else {
          value = pending.value;
        }
      }

      if (value === null) return;
      if (String(value) !== slider.value) slider.value = String(value);
      label.textContent = value + " g";
    }
  }

  window.customElements.define("sourdough-fermentation-card", SourdoughFermentationCard);

  // ---------------------------------------------------------------------------
  // Visual editor
  // ---------------------------------------------------------------------------
  var EDITOR_SCHEMA = [
    {
      name: "device_id",
      required: true,
      selector: { device: { integration: "sourdough_ferment" } }
    },
    { name: "title", selector: { text: {} } }
  ];
  var EDITOR_LABELS = {
    device_id: "Sourdough device",
    title: "Card title (optional)"
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
      this._render();
    }

    set hass(hass) {
      this._hass = hass;
      this._render();
    }

    connectedCallback() {
      this._render();
    }

    _render() {
      if (!this._hass) return;
      var self = this;
      if (!this._form) {
        this._form = document.createElement("ha-form");
        this._form.computeLabel = function (schema) {
          return EDITOR_LABELS[schema.name] || schema.name;
        };
        this._form.addEventListener("value-changed", function (ev) {
          ev.stopPropagation();
          self.dispatchEvent(
            new CustomEvent("config-changed", {
              detail: { config: ev.detail.value },
              bubbles: true,
              composed: true
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

  if (!window.customElements.get("sourdough-fermentation-card-editor")) {
    window.customElements.define(
      "sourdough-fermentation-card-editor",
      SourdoughFermentationCardEditor
    );
  }

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "sourdough-fermentation-card",
    name: "Sourdough Fermentation Card",
    description: "A rising-dough dashboard card for the Sourdough Fermentation integration.",
    preview: true,
    documentationURL: "https://github.com/bannon52/sourdough_bulk_fermenter"
  });
})();
