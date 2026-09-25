/**
 * Movements bank UI: movements listed under collapsible group headers, with a
 * search box that filters by name/description, plus Stop and Cycle controls.
 * Delegates playback to a DemoPlayer.
 *
 * A movement flagged `interactive: true` in the config is driven by a live
 * controller instead of a timeline: its row shows an Open/Close toggle that
 * expands an inline collapsible controls panel (the controller's own UI) rather
 * than a Play button. A controller implements { el, setActive(on) }.
 *
 * A movement with a `uiParams` array in its config gets a ⚙ toggle button that
 * expands an inline parameter editor. Edited values persist for the session and
 * are passed to the generator each time Play is pressed.
 *
 * @param {object} [opts]
 * @param {() => void} [opts.onManual]  called when the user manually plays or stops
 *   a movement (used to cancel the auto-cycle).
 * @param {() => void} [opts.onCycle]  called when the user clicks "Cycle demos".
 * @param {HTMLInputElement} [opts.searchEl]  search field that filters the list.
 * @param {string[]} [opts.collapsed]  group names to start collapsed (user can still toggle).
 * @param {Object<string, {el: HTMLElement, setActive: (on:boolean)=>void}>} [opts.controllers]
 *   controllers for interactive movements, keyed by movement id.
 */
import { logEvent } from '../eventLog.js';

// Injected into every timeline movement's params so the wire-sync gate is exposed everywhere
// (commit/animate on the real send + wait for each panel's move-end). Movements opt into ON by
// default with `syncToWire: true` in their config params; others start off.
const SYNC_SPEC = { key: 'syncToWire', label: 'sync to wire', type: 'checkbox' };

export class DemoBank {
  constructor(listEl, demos, player, opts = {}) {
    this.listEl = listEl;
    this.demos = demos;
    this.player = player;
    this.onManual = opts.onManual;
    this.onCycle = opts.onCycle;
    this.searchEl = opts.searchEl || null;
    this.controllers = opts.controllers || {};
    this.engine = opts.engine || null;

    this._filter = '';
    this._collapseAll = opts.collapseAll ?? false;
    this._collapsed  = new Set(opts.collapsed || []);  // explicitly collapsed groups
    this._expanded   = new Set();                      // explicitly expanded groups (used when collapseAll)
    this._open = new Set();       // interactive movement ids with controls expanded
    this._openParams = new Set(); // ids with param editor expanded
    this._liveParams = new Map(); // id -> current param values (user-editable copy)
    this._paramsTimer = null;
    this._loadParams();           // restore edited movement params from a previous session

    if (this.searchEl) {
      this.searchEl.addEventListener('input', () => {
        this._filter = this.searchEl.value.trim().toLowerCase();
        this._render();
      });
    }
    this._render();
  }

  /** Return the live (user-editable) params for a demo, initialised from its config (+ persisted). */
  _getParams(demo) {
    if (!this._liveParams.has(demo.id)) {
      this._liveParams.set(demo.id, { ...(demo.params || {}), ...(this._persisted?.[demo.id] || {}) });
    }
    return this._liveParams.get(demo.id);
  }

  /** Load persisted per-movement param overrides (applied over each demo's config defaults). */
  _loadParams() {
    if (typeof localStorage === 'undefined') return;
    try { this._persisted = JSON.parse(localStorage.getItem('demoBank.params.v1') || 'null') || {}; }
    catch { this._persisted = {}; }
  }

  /** Debounced save of all edited movement params (a map of id -> params). */
  _saveParams() {
    if (typeof localStorage === 'undefined') return;
    if (this._paramsTimer) clearTimeout(this._paramsTimer);
    this._paramsTimer = setTimeout(() => {
      const blob = {};
      for (const [id, p] of this._liveParams) blob[id] = p;
      try { localStorage.setItem('demoBank.params.v1', JSON.stringify(blob)); }
      catch { /* quota / disabled — best effort */ }
    }, 300);
  }

  /** Section background tint for a group (matched by keyword; empty = untinted). */
  _groupColor(group) {
    const g = String(group).toLowerCase();
    if (g.includes('flowie'))  return 'rgba(235, 238, 245, 0.22)'; // near-white (light in dark mode)
    if (g.includes('chase'))   return 'rgba(214, 108, 108, 0.24)'; // reddish, desaturated
    if (g.includes('loops'))   return 'rgba(104, 200, 128, 0.24)'; // green
    if (g.includes('lullaby')) return 'rgba(226, 202, 84, 0.26)';  // yellow
    return '';
  }

  /** Group movements by their `group` field (default "Demos"), preserving order. */
  _groups() {
    const map = new Map();
    for (const d of this.demos) {
      const g = d.group || 'Demos';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(d);
    }
    return map;
  }

  _match(d) {
    if (!this._filter) return true;
    return `${d.name} ${d.desc || ''}`.toLowerCase().includes(this._filter);
  }

  _toggleGroup(group) {
    if (this._collapseAll) {
      if (this._expanded.has(group)) this._expanded.delete(group);
      else this._expanded.add(group);
    } else {
      if (this._collapsed.has(group)) this._collapsed.delete(group);
      else this._collapsed.add(group);
    }
    this._render();
  }

  /** Expand/collapse an interactive movement's inline controls (one open at a time). */
  _toggleControls(id) {
    const wasOpen = this._open.has(id);
    this._open.clear();           // only one interactive movement live at a time
    if (!wasOpen) {
      this._open.add(id);
      this.onManual?.();          // stop the auto-cycle so it can't fight the controller
      this.player.stop();
    }
    this._render();
  }

  _toggleParams(id) {
    if (this._openParams.has(id)) this._openParams.delete(id);
    else this._openParams.add(id);
    this._render();
  }

  /** Build a param editor row for one uiParam spec. Mutates the liveP object on change. */
  _paramRow(spec, liveP) {
    if (spec.type === 'panelMap') return this._panelMapRow(spec, liveP);

    if (spec.type === 'checkbox') {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = spec.label;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!(liveP[spec.key] ?? 0);
      cb.addEventListener('change', () => { liveP[spec.key] = cb.checked ? 1 : 0; this._saveParams(); });
      row.append(label, cb);
      return row;
    }

    if (spec.type === 'select') {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = spec.label;
      const sel = document.createElement('select');
      sel.style.cssText = 'flex:1;width:auto';
      const cur = liveP[spec.key] ?? spec.options?.[0]?.value ?? spec.options?.[0];
      for (const opt of spec.options || []) {
        const value = opt.value ?? opt, text = opt.label ?? String(value);
        const o = document.createElement('option');
        o.value = value; o.textContent = text;
        if (value === cur) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => { liveP[spec.key] = sel.value; this._saveParams(); });
      row.append(label, sel);
      return row;
    }

    const val = liveP[spec.key] ?? spec.min;
    const isInt = Number.isInteger(spec.step ?? 1);
    const fmt = (v) => isInt ? String(Math.round(v)) : v.toFixed(2);

    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('label');
    label.textContent = spec.label;
    row.append(label);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = spec.min;
    input.max = spec.max;
    input.step = spec.step ?? 1;
    input.value = val;
    row.append(input);

    const display = document.createElement('input');
    display.type = 'number';
    display.className = 'val';
    display.min = spec.min; display.max = spec.max; display.step = spec.step ?? 1;
    display.value = fmt(val);
    row.append(display);

    input.addEventListener('input', () => {
      const num = parseFloat(input.value);
      liveP[spec.key] = num;
      display.value = fmt(num);
      this._saveParams();
    });

    display.addEventListener('change', () => {
      const raw = parseFloat(display.value);
      const num = Math.max(spec.min, Math.min(spec.max, isNaN(raw) ? spec.min : raw));
      liveP[spec.key] = num;
      display.value = fmt(num);
      input.value = num;
      this._saveParams();
    });

    return row;
  }

  /**
   * Live canvas showing which panels are currently in the lower half of the movement range.
   * Threshold = (liveP[spec.hiKey] + liveP[spec.loKey]) / 2.
   * Uses a self-terminating rAF loop: stops automatically when the canvas leaves the DOM.
   */
  _panelMapRow(spec, liveP) {
    if (!this.engine) return document.createElement('div');

    const COLS = 7, ROWS = 9; // v-panel grid: x=0..6, y=0..8 edge-space
    const CS = 18;             // cell size px
    const PAD = 2;
    const W = COLS * CS + PAD * 2, Hc = ROWS * CS + PAD * 2;

    const wrap = document.createElement('div');
    wrap.className = 'row';
    const label = document.createElement('label');
    label.textContent = spec.label;
    wrap.append(label);

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = Hc;
    canvas.style.cssText = `width:${W}px;height:${Hc}px;background:#0d0f12;border-radius:3px;flex:none`;
    wrap.append(canvas);

    const ctx = canvas.getContext('2d');
    const panels = this.engine.list();

    const drawMap = () => {
      if (!canvas.isConnected) return; // self-terminate when removed from DOM
      const lo = liveP[spec.loKey] ?? 0, hi = liveP[spec.hiKey] ?? 255;
      const threshold = (lo + hi) / 2;

      ctx.fillStyle = '#0d0f12';
      ctx.fillRect(0, 0, W, Hc);

      for (const p of panels) {
        // h(x,y) panel: draw at cell column x, row y (horizontal edge)
        // v(x,y) panel: draw at cell column x, row y (vertical edge)
        const cx = PAD + p.x * CS, cy = PAD + p.y * CS;
        const down = p.position <= threshold;
        ctx.fillStyle = down ? '#c8a060' : '#1c2030';
        if (p.orient === 'h') ctx.fillRect(cx, cy, CS - 1, 3);
        else ctx.fillRect(cx, cy, 3, CS - 1);
      }
      requestAnimationFrame(drawMap);
    };
    requestAnimationFrame(drawMap);

    return wrap;
  }

  _render() {
    this.listEl.innerHTML = '';

    for (const [group, demos] of this._groups()) {
      const matched = demos.filter((d) => this._match(d));
      if (matched.length === 0) continue;

      // While searching, force every matching group open so results are visible.
      const collapsed = !this._filter && (
        this._collapseAll ? !this._expanded.has(group) : this._collapsed.has(group)
      );

      // Each group is its own tinted section (background follows the group; see _groupColor).
      const section = document.createElement('div');
      section.className = 'demo-section';
      const bg = this._groupColor(group);
      if (bg) section.style.cssText = `background:${bg};border-radius:6px;padding:3px;margin-bottom:5px`;

      const header = document.createElement('div');
      header.className = 'demo-group';
      header.innerHTML =
        `<span class="caret">${collapsed ? '▸' : '▾'}</span>` +
        `<span class="grp-name">${group}</span>` +
        `<span class="grp-count">${matched.length}</span>`;
      header.addEventListener('click', () => this._toggleGroup(group));
      section.append(header);
      this.listEl.append(section);

      if (collapsed) continue;

      for (const demo of matched) {
        const controller = demo.interactive ? this.controllers[demo.id] : null;
        const row = document.createElement('div');
        row.className = 'demo';
        const info = document.createElement('div');
        info.innerHTML = `<div class="name">${demo.name}</div><div class="desc">${demo.desc || ''}</div>`;

        if (controller) {
          const open = this._open.has(demo.id);
          const btn = document.createElement('button');
          btn.textContent = open ? 'Close' : 'Open';
          btn.classList.toggle('primary', open);
          btn.addEventListener('click', () => this._toggleControls(demo.id));
          row.append(info, btn);
          section.append(row);
          if (open) {
            const box = document.createElement('div');
            box.className = 'demo-controls';
            box.append(controller.el);
            section.append(box);
          }
        } else {
          // Every timeline movement gets a params panel with at least the sync-to-wire checkbox.
          const uiParams = [...(demo.uiParams || []), SYNC_SPEC];
          const paramsOpen = this._openParams.has(demo.id);
          const liveP = this._getParams(demo);

          // One movement active at a time: the running timeline's button is Stop; starting
          // a movement closes any open interactive controller (reconciled below).
          const playing = this.player.isRunning() === demo.id;
          const playBtn = document.createElement('button');
          playBtn.textContent = playing ? 'Stop' : 'Play';
          playBtn.classList.toggle('primary', playing);
          playBtn.addEventListener('click', () => {
            if (this.player.isRunning() === demo.id) {
              this.player.stop();
              this._haltTransport();  // drop any queued sends so the maze stops now
              logEvent('info', `⏹ stopped ${demo.name}`);
            } else {
              this.onManual?.();
              this._open.clear();     // close any open interactive controller — one active at a time
              this._haltTransport();  // clear the previous movement's queued sends before the new one
              this.player.play({ ...demo, params: liveP });
              logEvent('info', `▶ ${demo.name}`);
            }
            this._render();
          });

          const gearBtn = document.createElement('button');
          gearBtn.textContent = '⚙';
          gearBtn.title = 'Edit parameters';
          gearBtn.style.cssText = 'padding:5px 7px;flex:none';
          gearBtn.classList.toggle('primary', paramsOpen);
          gearBtn.addEventListener('click', () => this._toggleParams(demo.id));
          row.append(info, gearBtn, playBtn);

          section.append(row);

          if (paramsOpen) {
            const form = document.createElement('div');
            form.className = 'demo-controls';
            for (const spec of uiParams) {
              form.append(this._paramRow(spec, liveP));
            }
            section.append(form);
          }
        }
      }
    }

    // Reconcile controller lifecycles: a controller is active only while its controls
    // are both open and actually mounted (a filtered-out row won't have appended its el).
    for (const id in this.controllers) {
      const c = this.controllers[id];
      c.setActive(this._open.has(id) && c.el.isConnected);
    }

    // Transport row: Stop halts everything (including the cycle); Cycle (re)starts it.
    const transport = document.createElement('div');
    transport.className = 'demo';
    transport.style.marginTop = '6px';

    const stop = document.createElement('button');
    stop.textContent = 'Stop';
    stop.addEventListener('click', () => { this.onManual?.(); this.stopAll(); });

    const cycle = document.createElement('button');
    cycle.textContent = 'Cycle demos';
    cycle.addEventListener('click', () => this.onCycle?.());

    transport.append(cycle, stop);
    this.listEl.append(transport);
  }

  /** Stop every movement: halt the timeline player, close any interactive controller, and drop
   *  any MIDI still queued in the transport so the maze stops immediately (not after the backlog). */
  stopAll() {
    if (this.player.isRunning() || this._open.size) logEvent('info', '⏹ stop all');
    this._open.clear();
    this.player.stop();
    this._haltTransport();
    this._render();   // reconcile deactivates the closed controllers
  }

  /** Flush the MIDI transport's paced queue (via the state-backed engine's transport). */
  _haltTransport() {
    this.engine?.midi?.flush?.();
  }
}
