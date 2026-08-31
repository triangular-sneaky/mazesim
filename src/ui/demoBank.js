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

    this._filter = '';
    this._collapsed = new Set(opts.collapsed || []); // group names collapsed (seeded, then toggled by the user)
    this._open = new Set();       // interactive movement ids with controls expanded

    if (this.searchEl) {
      this.searchEl.addEventListener('input', () => {
        this._filter = this.searchEl.value.trim().toLowerCase();
        this._render();
      });
    }
    this._render();
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

  _render() {
    this.listEl.innerHTML = '';

    for (const [group, demos] of this._groups()) {
      const matched = demos.filter((d) => this._match(d));
      if (matched.length === 0) continue;

      // While searching, force every matching group open so results are visible.
      const collapsed = this._collapsed.has(group) && !this._filter;

      const header = document.createElement('div');
      header.className = 'demo-group';
      header.innerHTML =
        `<span class="caret">${collapsed ? '▸' : '▾'}</span>` +
        `<span class="grp-name">${group}</span>` +
        `<span class="grp-count">${matched.length}</span>`;
      header.addEventListener('click', () => {
        if (this._collapsed.has(group)) this._collapsed.delete(group);
        else this._collapsed.add(group);
        this._render();
      });
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
          const btn = document.createElement('button');
          btn.textContent = 'Play';
          btn.addEventListener('click', () => { this.onManual?.(); this.player.play(demo); });
          row.append(info, btn);
          this.listEl.append(row);
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
