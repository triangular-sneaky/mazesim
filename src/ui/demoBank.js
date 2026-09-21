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

    if (this.searchEl) {
      this.searchEl.addEventListener('input', () => {
        this._filter = this.searchEl.value.trim().toLowerCase();
        this._render();
      });
    }
    this._render();
  }

  /** Return the live (user-editable) params for a demo, initialised from its config. */
  _getParams(demo) {
    if (!this._liveParams.has(demo.id)) {
      this._liveParams.set(demo.id, { ...(demo.params || {}) });
    }
    return this._liveParams.get(demo.id);
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
      cb.addEventListener('change', () => { liveP[spec.key] = cb.checked ? 1 : 0; });
      row.append(label, cb);
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
    });

    display.addEventListener('change', () => {
      const raw = parseFloat(display.value);
      const num = Math.max(spec.min, Math.min(spec.max, isNaN(raw) ? spec.min : raw));
      liveP[spec.key] = num;
      display.value = fmt(num);
      input.value = num;
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

      const header = document.createElement('div');
      header.className = 'demo-group';
      header.innerHTML =
        `<span class="caret">${collapsed ? '▸' : '▾'}</span>` +
        `<span class="grp-name">${group}</span>` +
        `<span class="grp-count">${matched.length}</span>`;
      header.addEventListener('click', () => this._toggleGroup(group));
      this.listEl.append(header);

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
          this.listEl.append(row);
          if (open) {
            const box = document.createElement('div');
            box.className = 'demo-controls';
            box.append(controller.el);
            this.listEl.append(box);
          }
        } else {
          const hasUi = Array.isArray(demo.uiParams) && demo.uiParams.length > 0;
          const paramsOpen = hasUi && this._openParams.has(demo.id);
          const liveP = hasUi ? this._getParams(demo) : (demo.params || {});

          const playBtn = document.createElement('button');
          playBtn.textContent = 'Play';
          playBtn.addEventListener('click', () => {
            this.onManual?.();
            this.player.play({ ...demo, params: liveP });
          });

          if (hasUi) {
            const gearBtn = document.createElement('button');
            gearBtn.textContent = '⚙';
            gearBtn.title = 'Edit parameters';
            gearBtn.style.cssText = 'padding:5px 7px;flex:none';
            gearBtn.classList.toggle('primary', paramsOpen);
            gearBtn.addEventListener('click', () => this._toggleParams(demo.id));
            row.append(info, gearBtn, playBtn);
          } else {
            row.append(info, playBtn);
          }

          this.listEl.append(row);

          if (paramsOpen) {
            const form = document.createElement('div');
            form.className = 'demo-controls';
            for (const spec of demo.uiParams) {
              form.append(this._paramRow(spec, liveP));
            }
            this.listEl.append(form);
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
    stop.addEventListener('click', () => { this.onManual?.(); this.player.stop(); });

    const cycle = document.createElement('button');
    cycle.textContent = 'Cycle demos';
    cycle.addEventListener('click', () => this.onCycle?.());

    transport.append(cycle, stop);
    this.listEl.append(transport);
  }
}
