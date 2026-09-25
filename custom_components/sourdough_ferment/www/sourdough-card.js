/**
 * Sourdough Fermentation card — Lovelace custom card for the
 * Sourdough Fermentation integration.
 *
 * Design notes
 *  - DOM is built once and updated in place; updates for unrelated entities
 *    are ignored.
 *  - Sliders are custom (not <input type=range>) and use pointer capture, so a
 *    drag keeps going until the finger lifts, however long it lasts and even
 *    if it drifts off the track. State pushes never touch a slider mid-drag.
 *  - Bubbles are positioned from the absolute clock each frame, so nothing
 *    (re-render, element recreation, state change) can restart them.
 *  - ES2015 syntax only, for older Android WebViews.
 */
(function () {
  "use strict";

  if (window.__sourdoughCardLoaded) return; // script imported twice
  window.__sourdoughCardLoaded = true;

  var CARD_VERSION = "1.4.3";
  console.info(
    "%c SOURDOUGH-FERMENTATION-CARD %c " + CARD_VERSION + " ",
    "color:#1c1710;background:#d9974d;font-weight:600;",
    "color:#d9974d;background:#1c1710;"
  );

  var DOME_BASE = 150;
  var DOME_HEIGHT = 136; // base (150) - top (14)
  var DOME_PATH =
    "M14,150 L14,84 C14,42 46,14 100,14 C154,14 186,42 186,84 L186,150 Z";
  var PENDING_HOLD_MS = 5000;
  // Dough is present from the start of bulk: the dome begins this full at 0%
  // risen and fills completely at 100%.
  var BASE_FRACTION = 0.4;
  var NUDGE_COMMIT_MS = 600;
  var SVG_NS = "http://www.w3.org/2000/svg";

  // Shared across card instances/recreations so a just-committed value isn't
  // lost if Home Assistant rebuilds the card before confirming it.
  var PENDING = {};

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
    reset_entity: ["_reset_bulk"],
    bulk_time_entity: ["_bulk_fermentation_time"]
  };
  var ENTITY_KEYS = Object.keys(ENTITY_SUFFIXES);
  var LONGER_SIBLINGS = { _flour: ["_flour_protein"] };

  // Deterministic bubble layout (x in dome units, rise period s, phase s, radius)
  var BUBBLES = [
    { x: 40, period: 3.4, phase: 0.0, r: 3.8 },
    { x: 70, period: 4.1, phase: 1.3, r: 2.8 },
    { x: 100, period: 3.0, phase: 2.2, r: 4.4 },
    { x: 126, period: 3.7, phase: 0.6, r: 3.0 },
    { x: 156, period: 4.4, phase: 2.9, r: 3.6 },
    { x: 56, period: 2.8, phase: 3.5, r: 2.4 },
    { x: 140, period: 3.2, phase: 1.8, r: 2.6 },
    { x: 86, period: 3.9, phase: 0.9, r: 2.2 },
    { x: 114, period: 2.6, phase: 3.1, r: 2.0 }
  ];

  function fireMoreInfo(node, entityId) {
    if (!entityId) return;
    var ev = new Event("hass-more-info", { bubbles: true, composed: true });
    ev.detail = { entityId: entityId };
    node.dispatchEvent(ev);
  }

  var RISEN_KEY = "sourdough-risen-dismissed:";
  function storeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  function localClock(d) {
    var h = d.getHours(), m = d.getMinutes();
    return (h % 12 || 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h < 12 ? "AM" : "PM");
  }

  function isNum(v) { return typeof v === "number" && !isNaN(v); }
  function pick(v, f) { return v === undefined || v === null ? f : v; }
  function attr(s, n) { return s && s.attributes ? s.attributes[n] : undefined; }
  function num(s) {
    if (!s) return null;
    var v = parseFloat(s.state);
    return isNaN(v) ? null : v;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function roundTo(v, step) {
    var d = (String(step).split(".")[1] || "").length;
    return parseFloat((Math.round(v / step) * step).toFixed(d));
  }
  function fmtGrams(v) { return (Math.round(v * 10) / 10) + " g"; }

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
      var e = hass.entities[ids[i]];
      if (e && e.device_id === deviceId) out.push(ids[i]);
    }
    return out;
  }

  function matchesSuffix(entityId, suffix) {
    var obj = entityId.split(".")[1] || "";
    if (obj.slice(-suffix.length) !== suffix) return false;
    var longer = LONGER_SIBLINGS[suffix] || [];
    for (var i = 0; i < longer.length; i++) {
      if (obj.slice(-longer[i].length) === longer[i]) return false;
    }
    return true;
  }

  function resolveEntities(hass, config) {
    var out = {};
    var pool = entitiesForDevice(hass, config.device_id);
    for (var k = 0; k < ENTITY_KEYS.length; k++) {
      var key = ENTITY_KEYS[k];
      if (config[key]) { out[key] = config[key]; continue; }
      var sfx = ENTITY_SUFFIXES[key];
      for (var s = 0; s < sfx.length && !out[key]; s++) {
        for (var p = 0; p < pool.length; p++) {
          if (matchesSuffix(pool[p], sfx[s])) { out[key] = pool[p]; break; }
        }
      }
    }
    return out;
  }

  var ICON_TEMP = '<svg viewBox="0 0 24 24" fill="none" stroke="#d9974d" stroke-width="2" stroke-linecap="round"><path d="M10 13.5V5a2 2 0 1 1 4 0v8.5a4 4 0 1 1-4 0z"/><path d="M12 9v7"/></svg>';
  var ICON_HUM = '<svg viewBox="0 0 24 24" fill="none" stroke="#d9974d" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5c3 4 6 7.2 6 10.5a6 6 0 0 1-12 0c0-3.3 3-6.5 6-10.5z"/></svg>';
  var ICON_HIST = '<svg class="hist" viewBox="0 0 24 24" fill="none" stroke="#a3937a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18l5-6 4 3 7-8"/></svg>';

  var CSS =
    "<style>" +
    ":host{--sf-bg:#1c1710;--sf-recessed:#241d14;--sf-line:#332a1c;--sf-crust:#d9974d;" +
    "--sf-gold:#e6b04a;--sf-text:#f2ece0;--sf-muted:#a3937a;display:block;" +
    "font-family:var(--ha-font-family-body,var(--paper-font-body1_-_font-family,Roboto,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif));}" +
    "*{box-sizing:border-box;}" +
    "button{font:inherit;}" +
    ".card{background:var(--sf-bg);border:1px solid var(--sf-line);border-radius:20px;padding:20px 20px 14px;color:var(--sf-text);}" +
    ".header{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;}" +
    ".title{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:500;}" +
    ".tap{cursor:pointer;-webkit-tap-highlight-color:transparent;transition:filter .15s;}" +
    ".tap:hover{filter:brightness(1.12);}" +
    ".tap:active{filter:brightness(1.25);}" +
    ".header{align-items:flex-start !important;}" +
    ".hdr-right{display:flex;flex-direction:column;align-items:flex-end;gap:7px;}" +
    ".env-mini{display:flex;gap:10px;}" +
    ".env-item{display:flex;align-items:center;gap:3px;font-size:12px;color:var(--sf-muted);}" +
    ".env-item svg{width:13px;height:13px;}" +
    ".env-item.off{opacity:.45;}" +
    ".dome-wrap{position:relative;}" +
    ".risen{position:absolute;left:-14px;right:-14px;top:-10px;bottom:-4px;z-index:3;pointer-events:none;animation:sf-risen .45s ease-out;" +
      "background:radial-gradient(circle at 50% 44%,rgba(20,16,10,.42),rgba(20,16,10,0) 62%);}" +
    ".risen .cross{position:absolute;top:46%;left:50%;width:74px;height:116px;margin:-72px 0 0 -37px;" +
      "filter:drop-shadow(0 4px 12px rgba(0,0,0,.75));}" +
    ".ribbon{position:absolute;top:46%;left:50%;transform:translate(-50%,-50%) rotate(-7deg);z-index:2;background:linear-gradient(180deg,#f2c76a,#dfa53c);color:#1c1710;font-size:17px;font-weight:600;letter-spacing:.2px;padding:9px 30px;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.55);" +
      "clip-path:polygon(0 0,100% 0,90% 50%,100% 100%,0 100%,10% 50%);}" +
    ".risen-actions{display:flex;justify-content:center;margin:2px 0 10px;}" +
    ".risen-btn{display:flex;align-items:center;gap:7px;border:none;border-radius:11px;padding:10px 18px;cursor:pointer;" +
      "background:var(--sf-gold);color:#1c1710;font-size:14px;font-weight:600;box-shadow:0 3px 12px rgba(230,176,74,.28);}" +
    ".risen-btn:active{filter:brightness(1.1);}" +
    ".streamers{position:absolute;inset:0;overflow:visible;}" +
    ".streamer{position:absolute;left:50%;top:46%;width:8px;height:14px;border-radius:2px;background:var(--c);opacity:0;" +
      "animation:sf-streamer 2.6s ease-out infinite;animation-delay:var(--d);}" +
    "@keyframes sf-streamer{0%{transform:translate(-50%,-50%) rotate(0deg) scale(.6);opacity:0;}" +
      "12%{opacity:1;}70%{opacity:.9;}100%{transform:translate(var(--dx),var(--dy)) rotate(var(--rot)) scale(1);opacity:0;}}" +
    "@keyframes sf-risen{from{opacity:0;transform:scale(.92);}to{opacity:1;transform:none;}}" +
    "@media (prefers-reduced-motion:reduce){.risen{animation:none;}.streamer{animation:none;opacity:.85;}}" +
    ".nudge-btn.sm{width:26px;height:26px;font-size:15px;border-radius:8px;}" +
    ".nudge-val{min-width:56px;text-align:center;}" +
    ".stat-label{display:flex;justify-content:space-between;align-items:center;}" +
    ".stat-label .hist{width:13px;height:13px;opacity:.55;}" +
    ".pill{font-size:12px;padding:4px 11px;border-radius:100px;font-weight:500;}" +
    ".pill.idle{background:var(--sf-recessed);color:var(--sf-muted);}" +
    ".pill.fermenting{background:rgba(217,151,77,.16);color:var(--sf-crust);}" +
    ".pill.ready{background:rgba(230,176,74,.16);color:var(--sf-gold);}" +
    ".dome-wrap{display:flex;flex-direction:column;align-items:center;padding:12px 0 4px;}" +
    ".dome-svg{width:160px;height:128px;overflow:visible;}" +
    ".dome-svg.ready{filter:drop-shadow(0 0 14px rgba(230,176,74,.35));}" +
    ".dome-caption{margin-top:4px;font-size:13px;color:var(--sf-muted);}" +
    ".stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0;}" +
    ".stat{background:var(--sf-recessed);border-radius:12px;padding:10px 13px;}" +
    ".stat-label{font-size:12px;color:var(--sf-muted);margin-bottom:3px;gap:6px;}" +
    ".stat-value{font-size:20px;font-weight:500;line-height:1.25;}" +
    ".stat-value.dim{color:var(--sf-muted);font-size:15px;}" +
    ".control{background:var(--sf-recessed);border-radius:12px;padding:11px 14px 8px;margin-bottom:10px;}" +
    ".control-row{display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--sf-muted);}" +
    ".nudge{display:flex;align-items:center;gap:8px;}" +
    ".nudge-btn{width:30px;height:30px;border-radius:9px;border:none;background:var(--sf-line);color:var(--sf-text);font-size:17px;line-height:1;cursor:pointer;touch-action:manipulation;}" +
    ".nudge-btn:active{filter:brightness(1.25);}" +
    ".starter-val{min-width:58px;text-align:center;color:var(--sf-crust);font-size:17px;font-weight:500;}" +
    ".slider{position:relative;height:32px;touch-action:none;cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent;}" +
    ".slider .track{position:absolute;left:10px;right:10px;top:50%;height:6px;margin-top:-3px;border-radius:3px;background:var(--sf-line);overflow:hidden;}" +
    ".slider .track-fill{height:100%;width:0;background:var(--sf-crust);}" +
    ".slider .thumb{position:absolute;top:50%;left:10px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:var(--sf-crust);border:3px solid var(--sf-recessed);transition:transform .12s;}" +
    ".slider.dragging .thumb,.slider:focus-visible .thumb{transform:scale(1.2);}" +
    ".recipe{border-top:1px solid var(--sf-line);margin-top:2px;}" +
    ".recipe-summary{display:flex;align-items:center;justify-content:space-between;padding:12px 2px;cursor:pointer;user-select:none;}" +
    ".recipe-text{font-size:13px;color:var(--sf-muted);}" +
    ".recipe-text b{color:var(--sf-text);font-weight:500;}" +
    ".chevron{color:var(--sf-muted);transition:transform .2s;font-size:12px;}" +
    ".recipe.open .chevron{transform:rotate(180deg);}" +
    ".recipe-detail{max-height:0;overflow:hidden;transition:max-height .25s ease;}" +
    ".recipe.open .recipe-detail{max-height:320px;}" +
    ".slider-row{padding:2px 2px 12px;display:flex;flex-direction:column;gap:10px;}" +
    ".slider-label{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--sf-muted);margin-bottom:2px;}" +
    ".slider-label b{color:var(--sf-text);font-weight:500;}" +
    ".actions{display:flex;gap:8px;padding-top:12px;border-top:1px solid var(--sf-line);margin-top:2px;}" +
    ".btn{flex:1;padding:11px 0;border-radius:11px;border:none;font-size:14px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;}" +
    ".btn:disabled{opacity:.5;cursor:default;}" +
    ".btn-ghost{background:var(--sf-recessed);color:var(--sf-muted);}" +
    ".btn-primary{background:var(--sf-crust);color:#1c1710;}" +
    ".btn-primary.ready{background:var(--sf-gold);}" +
    ".unavailable{padding:24px 4px;text-align:center;color:var(--sf-muted);font-size:13px;}" +
    "</style>";

  // ---------------------------------------------------------------------------
  // Custom slider with pointer capture
  // ---------------------------------------------------------------------------
  function Slider(el, onInput, onCommit) {
    this.el = el;
    this.fill = el.querySelector(".track-fill");
    this.thumb = el.querySelector(".thumb");
    this.min = 0; this.max = 100; this.step = 1; this.value = 0;
    this.dragging = false;
    this.onInput = onInput;
    this.onCommit = onCommit;
    var self = this;

    function valueFromX(clientX) {
      var rect = el.getBoundingClientRect();
      var inset = 10; // matches the track's left/right inset
      var w = rect.width - inset * 2;
      var ratio = w > 0 ? clamp((clientX - rect.left - inset) / w, 0, 1) : 0;
      return clamp(roundTo(self.min + ratio * (self.max - self.min), self.step), self.min, self.max);
    }
    function move(clientX) {
      var v = valueFromX(clientX);
      if (v !== self.value) { self.value = v; self._paint(); self.onInput(v); }
    }
    function start(clientX) {
      self.dragging = true;
      el.classList.add("dragging");
      move(clientX);
    }
    function end() {
      if (!self.dragging) return;
      self.dragging = false;
      el.classList.remove("dragging");
      self.onCommit(self.value);
    }

    if (window.PointerEvent) {
      el.addEventListener("pointerdown", function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        start(e.clientX);
      });
      el.addEventListener("pointermove", function (e) {
        if (self.dragging) { e.preventDefault(); move(e.clientX); }
      });
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
      el.addEventListener("lostpointercapture", end);
    } else {
      el.addEventListener("touchstart", function (e) {
        e.preventDefault(); start(e.touches[0].clientX);
      }, { passive: false });
      el.addEventListener("touchmove", function (e) {
        if (self.dragging) { e.preventDefault(); move(e.touches[0].clientX); }
      }, { passive: false });
      el.addEventListener("touchend", end);
      el.addEventListener("touchcancel", end);
      el.addEventListener("mousedown", function (e) {
        e.preventDefault(); start(e.clientX);
        function mm(ev) { move(ev.clientX); }
        function mu() {
          document.removeEventListener("mousemove", mm);
          document.removeEventListener("mouseup", mu);
          end();
        }
        document.addEventListener("mousemove", mm);
        document.addEventListener("mouseup", mu);
      });
    }

    el.addEventListener("keydown", function (e) {
      var d = 0;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") d = self.step;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") d = -self.step;
      if (!d) return;
      e.preventDefault();
      self.value = clamp(roundTo(self.value + d, self.step), self.min, self.max);
      self._paint(); self.onInput(self.value); self.onCommit(self.value);
    });
  }
  Slider.prototype.setRange = function (min, max, step) {
    if (min === this.min && max === this.max && step === this.step) return;
    this.min = min; this.max = max; this.step = step > 0 ? step : 1;
    this._paint();
  };
  Slider.prototype.setValue = function (v) {
    if (this.dragging) return; // never fight the finger
    if (v === this.value) return;
    this.value = v; this._paint();
  };
  Slider.prototype._paint = function () {
    var span = this.max - this.min;
    var ratio = span > 0 ? clamp((this.value - this.min) / span, 0, 1) : 0;
    this.fill.style.width = (ratio * 100) + "%";
    this.thumb.style.left = "calc(10px + (100% - 20px) * " + ratio + ")";
    this.el.setAttribute("aria-valuemin", this.min);
    this.el.setAttribute("aria-valuemax", this.max);
    this.el.setAttribute("aria-valuenow", this.value);
  };

  function nudgeMarkup(name, noun) {
    return '<div class="nudge"><button class="nudge-btn sm" data-r="' + name + 'Minus" aria-label="Less ' + noun + '">\u2212</button>' +
      '<b class="nudge-val" data-r="' + name + 'Label"></b>' +
      '<button class="nudge-btn sm" data-r="' + name + 'Plus" aria-label="More ' + noun + '">+</button></div>';
  }

  function sliderMarkup(ref, label) {
    return '<div class="slider" data-r="' + ref + '" role="slider" tabindex="0" aria-label="' + label + '">' +
      '<div class="track"><div class="track-fill"></div></div><div class="thumb"></div></div>';
  }

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
      this._sliders = {};
      this._recipeOpen = false;
      this._status = "idle";
      this._fillTop = DOME_BASE;
      this._raf = null;
      this._nudgeTimers = {};
      this._ticker = null;
      this._risenKey = null;
      this._uid = Math.random().toString(36).slice(2, 9);
      this._reducedMotion = !!(window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      this._frame = this._frame.bind(this);
    }

    setConfig(config) {
      if (!config || (!config.progress_entity && !config.device_id)) {
        throw new Error("sourdough-fermentation-card: pick a device (or set 'progress_entity')");
      }
      this._config = config;
      this._structureKey = null;
      this._lastStates = null;
      this._safe(this._update);
    }

    set hass(hass) { this._hass = hass; this._safe(this._update); }

    // Never let an exception escape to Home Assistant: HA replaces a card that
    // throws with an error card for the rest of the session. Instead, show the
    // real error on the card, log it, and rebuild on the next update.
    _safe(fn, args) {
      try {
        fn.apply(this, args || []);
        if (this._errorEl) {
          // A rebuild may already have wiped it from the DOM; either way, clear it.
          if (this._errorEl.parentNode) this._errorEl.parentNode.removeChild(this._errorEl);
          this._errorEl = null;
        }
      } catch (err) {
        this._reportError(err);
      }
    }

    _reportError(err) {
      console.error("sourdough-fermentation-card " + CARD_VERSION + " error:", err);
      this._structureKey = null; // force a clean rebuild next time
      this._lastStates = null;
      try {
        if (!this.shadowRoot) this.attachShadow({ mode: "open" });
        if (!this._errorEl) {
          this._errorEl = document.createElement("div");
          this._errorEl.setAttribute("style",
            "margin:0 0 10px;padding:10px 12px;border-radius:12px;background:#3a1f16;" +
            "color:#f2c9b8;font:13px/1.4 var(--ha-font-family-body,Roboto,sans-serif);");
        }
        this._errorEl.textContent = "Sourdough card error (v" + CARD_VERSION + "): " +
          (err && err.message ? err.message : String(err)) + " \u2014 retrying on next update.";
        this.shadowRoot.insertBefore(this._errorEl, this.shadowRoot.firstChild);
      } catch (e2) { /* nothing more we can safely do */ }
    }
    getCardSize() { return 7; }

    connectedCallback() { this._syncAnimation(); this._syncTicker(); }
    disconnectedCallback() {
      this._stopAnimation();
      if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
    }

    static getConfigElement() {
      return document.createElement("sourdough-fermentation-card-editor");
    }
    static getStubConfig(hass) {
      if (hass && hass.entities) {
        var ids = Object.keys(hass.entities);
        for (var i = 0; i < ids.length; i++) {
          var e = hass.entities[ids[i]];
          if (e && e.platform === "sourdough_ferment" && e.device_id) return { device_id: e.device_id };
        }
      }
      return {};
    }

    _update() {
      if (!this._config || !this._hass) return;
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });

      var ents = resolveEntities(this._hass, this._config);
      this._ents = ents;
      var key = [this._config.title || "", ents.progress_entity || "",
        ents.starter_entity ? 1 : 0, ents.flour_entity ? 1 : 0, ents.water_entity ? 1 : 0,
        ents.start_entity ? 1 : 0, ents.reset_entity ? 1 : 0, ents.bulk_time_entity ? 1 : 0].join("|");
      if (key !== this._structureKey) {
        this._build();
        this._structureKey = key;
        this._lastStates = null;
      }

      var states = [];
      for (var i = 0; i < ENTITY_KEYS.length; i++) {
        var id = ents[ENTITY_KEYS[i]];
        states.push(id ? this._hass.states[id] : undefined);
      }
      if (this._lastStates && this._same(states, this._lastStates)) return;
      this._lastStates = states;
      this._fill();
    }

    _same(a, b) {
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return a.length === b.length;
    }

    _build() {
      var e = this._ents;
      var clip = "sfClip-" + this._uid;
      var h = CSS + '<div class="card">' +
        '<div class="unavailable" data-r="unavailable" style="display:none"></div>' +
        '<div data-r="main">' +
        '<div class="header"><div class="title"><span data-r="title"></span></div>' +
        '<div class="hdr-right"><span class="pill idle" data-r="pill">Idle</span>' +
        '<div class="env-mini">' +
        '<span class="env-item tap" data-r="tempChip" style="display:none">' + ICON_TEMP + '<span data-r="tempVal"></span></span>' +
        '<span class="env-item tap" data-r="humChip" style="display:none">' + ICON_HUM + '<span data-r="humVal"></span></span>' +
        '</div></div></div>' +
        '<div class="dome-wrap"><svg class="dome-svg tap" data-r="dome" viewBox="0 0 200 160">' +
        '<defs><clipPath id="' + clip + '"><path d="' + DOME_PATH + '"/></clipPath></defs>' +
        '<path d="' + DOME_PATH + '" fill="#241d14"/>' +
        '<g clip-path="url(#' + clip + ')">' +
        '<rect data-r="fill" x="0" y="' + DOME_BASE + '" width="200" height="0" fill="#d9974d"/>' +
        '<rect data-r="surface" x="0" y="' + DOME_BASE + '" width="200" height="0" fill="#e6b04a"/>' +
        '<g data-r="bubbles"></g></g>' +
        '<path d="' + DOME_PATH + '" fill="none" stroke="#4a3d2a" stroke-width="3"/>' +
        '</svg><div class="dome-caption" data-r="caption"></div>' +
        '<div class="risen" data-r="risen" style="display:none">' +
        '<div class="streamers" data-r="streamers"></div>' +
        '<svg class="cross" viewBox="0 0 78 104" aria-hidden="true">' +
        '<rect x="29" y="2" width="16" height="112" rx="3" fill="#f6ead2"/>' +
        '<rect x="2" y="34" width="70" height="16" rx="3" fill="#f6ead2"/>' +
        '<rect x="33" y="2" width="4" height="112" fill="#ffffff" opacity=".5"/>' +
        '<rect x="6" y="34" width="62" height="4" fill="#ffffff" opacity=".4"/>' +
        '</svg>' +
        '<div class="ribbon">He has risen!</div>' +
        '</div></div>' +
        '<div class="risen-actions" data-r="risenActions" style="display:none">' +
        '<button class="risen-btn" data-r="risenBtn">\u2713 He has risen indeed</button></div>' +
        '<div class="stats">' +
        '<div class="stat tap" data-r="s1"><div class="stat-label"><span data-r="l1"></span>' + ICON_HIST + '</div><div class="stat-value" data-r="v1"></div></div>' +
        '<div class="stat tap" data-r="s2"><div class="stat-label"><span data-r="l2"></span>' + ICON_HIST + '</div><div class="stat-value" data-r="v2"></div></div></div>';

      if (e.starter_entity) {
        h += '<div class="control"><div class="control-row"><span>Starter</span>' +
          '<div class="nudge"><button class="nudge-btn" data-r="starterMinus" aria-label="Less starter">\u2212</button>' +
          '<span class="starter-val" data-r="starterLabel"></span>' +
          '<button class="nudge-btn" data-r="starterPlus" aria-label="More starter">+</button></div></div>' +
          sliderMarkup("starterSlider", "Starter") + '</div>';
      }

      if (e.flour_entity || e.water_entity) {
        h += '<div class="recipe' + (this._recipeOpen ? " open" : "") + '" data-r="recipe">' +
          '<div class="recipe-summary" data-r="recipeSummary"><div class="recipe-text" data-r="recipeText"></div>' +
          '<span class="chevron">\u25BE</span></div><div class="recipe-detail"><div class="slider-row">';
        if (e.flour_entity) {
          h += '<div><div class="slider-label"><span>Flour</span>' + nudgeMarkup("flour", "flour") + '</div>' + sliderMarkup("flourSlider", "Flour") + '</div>';
        }
        if (e.water_entity) {
          h += '<div><div class="slider-label"><span>Water</span>' + nudgeMarkup("water", "water") + '</div>' + sliderMarkup("waterSlider", "Water") + '</div>';
        }
        h += '</div></div></div>';
      }

      if (e.start_entity || e.reset_entity) {
        h += '<div class="actions">';
        if (e.reset_entity) h += '<button class="btn btn-ghost" data-r="resetBtn">\u21BB Reset</button>';
        if (e.start_entity) h += '<button class="btn btn-primary" data-r="startBtn">\u25B6 Start bulk</button>';
        h += '</div>';
      }
      h += '</div></div>';

      this.shadowRoot.innerHTML = h;
      var refs = {};
      var nodes = this.shadowRoot.querySelectorAll("[data-r]");
      for (var i = 0; i < nodes.length; i++) refs[nodes[i].getAttribute("data-r")] = nodes[i];
      this._refs = refs;
      refs.title.textContent = this._config.title || "Sourdough Bulk";

      // Streamers for the "He has risen!" burst (deterministic, not random,
      // so every device shows the same thing).
      var COLORS = ["#e6b04a", "#f3e6cf", "#d9974d", "#8fae5d", "#f2c76a"];
      for (var s = 0; s < 18; s++) {
        var angle = (s / 18) * Math.PI * 2 + (s % 3) * 0.12;
        var dist = 78 + (s % 4) * 18;
        var sp = document.createElement("span");
        sp.className = "streamer";
        sp.setAttribute("style",
          "--dx:" + Math.round(Math.cos(angle) * dist) + "px;" +
          "--dy:" + Math.round(Math.sin(angle) * dist * 0.8) + "px;" +
          "--rot:" + (((s * 57) % 360) - 180) + "deg;" +
          "--c:" + COLORS[s % COLORS.length] + ";" +
          "--d:" + ((s % 6) * 0.22).toFixed(2) + "s;");
        refs.streamers.appendChild(sp);
      }

      // Bubbles (positions set per animation frame)
      this._bubbleEls = [];
      for (var b = 0; b < BUBBLES.length; b++) {
        var c = document.createElementNS(SVG_NS, "circle");
        c.setAttribute("r", BUBBLES[b].r);
        c.setAttribute("fill", "#f3e6cf");
        c.setAttribute("opacity", "0");
        refs.bubbles.appendChild(c);
        this._bubbleEls.push(c);
      }

      this._sliders = {};
      this._makeSlider("starter", "starterSlider", "starterLabel");
      this._makeSlider("flour", "flourSlider", "flourLabel");
      this._makeSlider("water", "waterSlider", "waterLabel");

      var self = this;
      ["starter", "flour", "water"].forEach(function (n) {
        if (refs[n + "Minus"]) refs[n + "Minus"].addEventListener("click", function () { self._safe(self._nudge, [n, -1]); });
        if (refs[n + "Plus"]) refs[n + "Plus"].addEventListener("click", function () { self._safe(self._nudge, [n, 1]); });
      });
      refs.risenBtn.addEventListener("click", function () {
        // Acknowledge and clear the finished bake, ready for the next loaf.
        if (self._risenKey) storeSet(RISEN_KEY + self._ents.progress_entity, self._risenKey);
        refs.risen.style.display = "none";
        refs.risenActions.style.display = "none";
        self._safe(self._press, [self._ents.reset_entity]);
      });
      if (refs.recipeSummary) {
        refs.recipeSummary.addEventListener("click", function () {
          self._recipeOpen = !self._recipeOpen;
          refs.recipe.classList.toggle("open", self._recipeOpen);
        });
      }
      if (refs.startBtn) refs.startBtn.addEventListener("click", function () { self._press(self._ents.start_entity); });
      if (refs.resetBtn) refs.resetBtn.addEventListener("click", function () { self._press(self._ents.reset_entity); });

      // Tap to open Home Assistant's more-info dialog (with history graph).
      this._targets = {};
      ["s1", "s2", "dome", "tempChip", "humChip"].forEach(function (k) {
        refs[k].addEventListener("click", function () { fireMoreInfo(self, self._targets[k]); });
      });
    }

    _makeSlider(name, sliderRef, labelRef) {
      var el = this._refs[sliderRef];
      if (!el) return;
      var label = this._refs[labelRef];
      var self = this;
      this._sliders[name] = new Slider(el,
        function (v) { label.textContent = fmtGrams(v); },
        function (v) { self._safe(self._commit, [name, v]); });
    }

    _commit(name, value) {
      var entityId = this._ents[name + "_entity"];
      if (!entityId || !this._hass) return;
      PENDING[entityId] = { value: value, at: Date.now() };
      this._hass.callService("number", "set_value", { entity_id: entityId, value: value });
    }

    _nudge(name, dir) {
      var s = this._sliders[name];
      if (!s) return;
      var v = clamp(roundTo(s.value + dir * s.step, s.step), s.min, s.max);
      s.value = v; s._paint();
      this._refs[name + "Label"].textContent = fmtGrams(v);
      // Debounce so rapid taps send one update, not ten.
      var self = this;
      if (this._nudgeTimers[name]) clearTimeout(this._nudgeTimers[name]);
      PENDING[this._ents[name + "_entity"]] = { value: v, at: Date.now() };
      this._nudgeTimers[name] = setTimeout(function () {
        self._nudgeTimers[name] = null;
        self._commit(name, s.value);
      }, NUDGE_COMMIT_MS);
    }

    _press(entityId) {
      if (entityId && this._hass) this._hass.callService("button", "press", { entity_id: entityId });
    }

    _fill() {
      var r = this._refs, e = this._ents, hass = this._hass;
      var progress = e.progress_entity ? hass.states[e.progress_entity] : undefined;

      if (!progress) {
        r.main.style.display = "none";
        r.unavailable.style.display = "";
        r.unavailable.textContent = e.progress_entity
          ? "Entity not found: " + e.progress_entity
          : "No Sourdough Fermentation device selected \u2014 edit the card and pick one.";
        this._status = "idle";
        this._syncAnimation();
        return;
      }
      r.main.style.display = "";
      r.unavailable.style.display = "none";

      var pct = clamp(num(progress) || 0, 0, 100);
      var status = "idle";
      if (attr(progress, "active") === true) status = "fermenting";
      else if (pct >= 100 || attr(progress, "completed_at")) status = "ready";

      var pillText = status.charAt(0).toUpperCase() + status.slice(1);
      if (r.pill.textContent !== pillText) { r.pill.textContent = pillText; r.pill.className = "pill " + status; }
      var domeClass = "dome-svg " + status;
      if (r.dome.getAttribute("class") !== domeClass) r.dome.setAttribute("class", domeClass);

      var frac = status === "idle" ? BASE_FRACTION : BASE_FRACTION + (1 - BASE_FRACTION) * (pct / 100);
      var fh = frac * DOME_HEIGHT;
      this._fillTop = DOME_BASE - fh;
      r.fill.setAttribute("y", this._fillTop);
      r.fill.setAttribute("height", fh);
      r.fill.setAttribute("fill", status === "ready" ? "#e6b04a" : status === "idle" ? "#8a6a44" : "#d9974d");
      r.surface.setAttribute("fill", status === "idle" ? "#a8835a" : "#e6b04a");
      r.surface.setAttribute("y", this._fillTop);
      r.surface.setAttribute("height", fh > 0 ? Math.min(4, fh) : 0);
      r.caption.textContent = status === "idle" ? "Not started" : pct.toFixed(0) + "% risen";

      var readyAt = e.ready_at_entity ? hass.states[e.ready_at_entity] : undefined;
      var finishNow = e.finish_now_entity ? hass.states[e.finish_now_entity] : undefined;
      var remaining = e.remaining_entity ? hass.states[e.remaining_entity] : undefined;
      var l1, v1, l2, v2, dim = false;
      if (status === "idle") {
        l1 = "If started now"; v1 = pick(attr(finishNow, "clock"), "\u2014");
        l2 = "Est. bulk time"; v2 = formatHours(attr(finishNow, "bulk_hours"));
      } else if (status === "fermenting") {
        l1 = "Ready at"; v1 = pick(attr(readyAt, "clock"), "\u2014");
        l2 = "Remaining"; v2 = formatHours(num(remaining));
      } else {
        // The ready-at sensor clears once the timer stops, so work from the
        // actual completion time instead.
        var done = attr(progress, "completed_at");
        var doneAt = done ? new Date(done) : null;
        if (doneAt && isNaN(doneAt.getTime())) doneAt = null;
        l1 = "Finished at";
        v1 = doneAt ? localClock(doneAt) : pick(attr(readyAt, "clock"), "\u2014");
        l2 = "Since finished";
        if (doneAt) {
          var since = Math.max(0, (Date.now() - doneAt.getTime()) / 3600000);
          v2 = since < 1 / 60 ? "Just now" : formatHours(since);
        } else {
          v2 = "Done"; dim = true;
        }
      }

      // "He has risen!" banner, once per completed bake, dismissible per device.
      var risenKey = status === "ready" ? (attr(progress, "completed_at") || null) : null;
      this._risenKey = risenKey;
      var showRisen = !!risenKey && storeGet(RISEN_KEY + e.progress_entity) !== risenKey;
      r.risen.style.display = showRisen ? "" : "none";
      r.risenActions.style.display = showRisen ? "" : "none";
      r.l1.textContent = l1; r.v1.textContent = v1;
      r.l2.textContent = l2; r.v2.textContent = v2;
      r.v2.className = "stat-value" + (dim ? " dim" : "");

      var t = this._targets;
      if (status === "idle") { t.s1 = e.finish_now_entity; t.s2 = e.bulk_time_entity || e.finish_now_entity; }
      else if (status === "fermenting") { t.s1 = e.ready_at_entity; t.s2 = e.remaining_entity; }
      else { t.s1 = e.ready_at_entity; t.s2 = e.progress_entity; }
      t.dome = e.progress_entity;
      this._fillEnv();

      this._syncSlider("starter", "starterLabel", 0, 200, 1);
      this._syncSlider("flour", "flourLabel", 50, 1000, 5);
      this._syncSlider("water", "waterLabel", 0, 1000, 5);

      if (r.recipeText) {
        var flour = e.flour_entity ? num(hass.states[e.flour_entity]) : null;
        var water = e.water_entity ? num(hass.states[e.water_entity]) : null;
        var hyd = e.hydration_entity ? num(hass.states[e.hydration_entity]) : null;
        var parts = [];
        if (flour !== null) parts.push("<b>" + flour + " g</b> flour");
        if (water !== null) parts.push("<b>" + water + " g</b> water");
        if (hyd !== null) parts.push("<b>" + hyd.toFixed(0) + "%</b> hydration");
        r.recipeText.innerHTML = parts.join(" \u00B7 ");
      }

      if (r.startBtn) {
        var running = status === "fermenting";
        r.startBtn.disabled = running;
        r.startBtn.textContent = running ? "Running\u2026" : "\u25B6 Start bulk";
        r.startBtn.className = "btn btn-primary" + (status === "ready" ? " ready" : "");
      }

      this._status = status;
      this._syncAnimation();
      this._syncTicker();
    }

    _syncTicker() {
      var want = this._status === "ready" && this.isConnected;
      var self = this;
      if (want && !this._ticker) {
        this._ticker = setInterval(function () { if (self._hass) self._safe(self._fill); }, 30000);
      } else if (!want && this._ticker) {
        clearInterval(this._ticker); this._ticker = null;
      }
    }

    _fillEnv() {
      var r = this._refs, e = this._ents, t = this._targets;
      var bulk = e.bulk_time_entity ? this._hass.states[e.bulk_time_entity] : undefined;
      var temp = attr(bulk, "temperature_used_c");
      if (isNum(temp)) {
        r.tempChip.style.display = "";
        r.tempVal.textContent = temp.toFixed(1) + "\u00B0C";
        r.tempChip.title = attr(bulk, "temperature_source") === "dough_probe" ? "Dough probe temperature" : "Room temperature";
        t.tempChip = attr(bulk, "temperature_entity");
      } else {
        r.tempChip.style.display = "none";
      }
      var hum = attr(bulk, "humidity_percent");
      if (isNum(hum)) {
        var applied = attr(bulk, "humidity_applied") === true;
        r.humChip.style.display = "";
        r.humChip.className = "env-item tap" + (applied ? "" : " off");
        r.humVal.textContent = Math.round(hum) + "%";
        r.humChip.title = applied ? "Humidity" : "Humidity (not used while the dough probe is active)";
        t.humChip = attr(bulk, "humidity_entity");
      } else {
        r.humChip.style.display = "none";
      }
    }

    _syncSlider(name, labelRef, dMin, dMax, dStep) {
      var slider = this._sliders[name];
      var entityId = this._ents[name + "_entity"];
      var stateObj = entityId ? this._hass.states[entityId] : undefined;
      if (!slider || !stateObj) return;

      slider.setRange(
        parseFloat(pick(attr(stateObj, "min"), dMin)),
        parseFloat(pick(attr(stateObj, "max"), dMax)),
        parseFloat(pick(attr(stateObj, "step"), dStep)));

      if (slider.dragging) return;
      if (this._nudgeTimers[name]) return; // mid-nudge

      var value = num(stateObj);
      var pending = PENDING[entityId];
      if (pending) {
        var confirmed = value !== null && Math.abs(value - pending.value) < 1e-6;
        if (confirmed || Date.now() - pending.at > PENDING_HOLD_MS) delete PENDING[entityId];
        else value = pending.value;
      }
      if (value === null) return;
      slider.setValue(value);
      this._refs[labelRef].textContent = fmtGrams(value);
    }

    // --- bubbles: clock-driven, so they can never restart -----------------
    _syncAnimation() {
      var want = this._status === "fermenting" && !this._reducedMotion && this.isConnected;
      if (want && !this._raf) this._raf = window.requestAnimationFrame(this._frame);
      if (!want) {
        this._stopAnimation();
        if (this._bubbleEls) for (var i = 0; i < this._bubbleEls.length; i++) this._bubbleEls[i].setAttribute("opacity", "0");
      }
    }

    _stopAnimation() {
      if (this._raf) { window.cancelAnimationFrame(this._raf); this._raf = null; }
    }

    _frame(now) {
      try { this._frameInner(now); } catch (err) { this._raf = null; this._reportError(err); }
    }

    _frameInner(now) {
      this._raf = null;
      if (this._status !== "fermenting" || !this.isConnected) return;
      var t = (window.performance ? window.performance.now() : now) / 1000;
      var bottom = DOME_BASE - 6;
      var top = this._fillTop + 5;
      var travel = Math.max(bottom - top, 0);
      for (var i = 0; i < BUBBLES.length; i++) {
        var b = BUBBLES[i];
        var p = ((t + b.phase) % b.period) / b.period; // 0..1, from absolute time
        var y = bottom - p * travel;
        var wobble = Math.sin((t + b.phase) * 2.1) * 2;
        var op = p < 0.15 ? p / 0.15 : p > 0.8 ? (1 - p) / 0.2 : 1;
        var el = this._bubbleEls[i];
        el.setAttribute("cx", (b.x + wobble).toFixed(1));
        el.setAttribute("cy", y.toFixed(1));
        el.setAttribute("opacity", (op * 0.75).toFixed(2));
      }
      this._raf = window.requestAnimationFrame(this._frame);
    }
  }


  // ---------------------------------------------------------------------------
  // Visual editor
  // ---------------------------------------------------------------------------
  var EDITOR_SCHEMA = [
    { name: "device_id", required: true, selector: { device: { integration: "sourdough_ferment" } } },
    { name: "title", selector: { text: {} } }
  ];
  var EDITOR_LABELS = { device_id: "Sourdough device", title: "Card title (optional)" };

  class SourdoughFermentationCardEditor extends HTMLElement {
    constructor() { super(); this._config = {}; this._hass = null; this._form = null; }
    setConfig(config) { this._config = config || {}; this._render(); }
    set hass(hass) { this._hass = hass; this._render(); }
    connectedCallback() { this._render(); }
    _render() {
      if (!this._hass) return;
      var self = this;
      if (!this._form) {
        this._form = document.createElement("ha-form");
        this._form.computeLabel = function (s) { return EDITOR_LABELS[s.name] || s.name; };
        this._form.addEventListener("value-changed", function (ev) {
          ev.stopPropagation();
          self.dispatchEvent(new CustomEvent("config-changed", {
            detail: { config: ev.detail.value }, bubbles: true, composed: true }));
        });
        this.appendChild(this._form);
      }
      this._form.hass = this._hass;
      this._form.schema = EDITOR_SCHEMA;
      this._form.data = this._config;
    }
  }
  // ---------------------------------------------------------------------------
  // Registration
  //
  // Home Assistant's frontend installs a scoped custom element registry, which
  // REPLACES window.customElements partway through page load. This module is
  // loaded early (as an extra module) and can register BEFORE that happens -
  // and anything in the old registry is invisible to the new one, so Home
  // Assistant reports "Custom element doesn't exist" and shows a Configuration
  // error card. It is a race, so it only bites on some page loads.
  //
  // Register now, then watch for the registry being swapped and register again
  // in whatever registry Home Assistant settles on. Re-registration uses a
  // subclass, because one constructor cannot be registered twice.
  // ---------------------------------------------------------------------------
  var CARD_TAG = "sourdough-fermentation-card";
  var EDITOR_TAG = "sourdough-fermentation-card-editor";

  function defineIn(registry) {
    if (!registry || typeof registry.define !== "function") return;
    try {
      if (!registry.get(CARD_TAG)) {
        registry.define(CARD_TAG, class extends SourdoughFermentationCard {});
      }
      if (!registry.get(EDITOR_TAG)) {
        registry.define(EDITOR_TAG, class extends SourdoughFermentationCardEditor {});
      }
    } catch (err) {
      console.warn("sourdough-fermentation-card: registration failed", err);
    }
  }

  defineIn(window.customElements);

  var seenRegistry = window.customElements;
  var watchTicks = 0;
  var watcher = setInterval(function () {
    if (window.customElements !== seenRegistry) {
      seenRegistry = window.customElements;
      defineIn(seenRegistry);
    }
    if (++watchTicks > 1200) clearInterval(watcher); // stop after ~60s
  }, 50);

  window.customCards = window.customCards || [];
  if (!window.customCards.some(function (c) { return c.type === CARD_TAG; })) {
    window.customCards.push({
      type: CARD_TAG,
      name: "Sourdough Fermentation Card",
      description: "A rising-dough dashboard card for the Sourdough Fermentation integration.",
      preview: true,
      documentationURL: "https://github.com/bannon52/sourdough_bulk_fermenter"
    });
  }

})();
