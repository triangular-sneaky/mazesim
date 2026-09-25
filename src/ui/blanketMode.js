/**
 * "Blanket" interlude — an interactive movement (not a timeline). Three buttons:
 *   - Blanket → lays a low blanket as a CONCENTRIC wave from the outside in: the field settles on
 *               the floor, ~10% of panels light dimly (30%), and the DROP cell's 4 edges lift to
 *               z=2 (also 30%). Once the wave reaches the centre, all lights turn OFF in the same
 *               outside→in sequence — a blanket that fills, then fades.
 *   - Flat   → lowers the central 4 (drop-cell) edges back to the floor (they're already dark).
 *   - Moon   → raises one panel (note 88) to z=6 at full brightness — a lone moon over the blanket.
 *
 * Controller contract (DemoBank collapsible controls): { el, setActive(on), tick(dt) }. Blanket is
 * button-driven; the concentric wave is scheduled with timers (cancelled on re-click / close), so
 * tick is a no-op. All panel motion routes through the engine's combined move at the global speed.
 */
import { cellEdgeList, edgeKey, panelCenter } from '../model/layout.js';
import { zToPos } from '../model/mazeState.js';

const MOON_NOTE = 88;   // the panel the Moon button raises
const LIT_FRAC  = 0.10; // fraction of (non-drop) panels lit by Blanket
const DIM       = 0.30; // brightness of every lit panel (0..1)
const WAVE_MS   = 150;  // per unit of distance — how fast the concentric wave sweeps in
const HOLD_MS   = 400;  // how long the full blanket sits lit before it fades out

export class BlanketMode {
  constructor(engine, cells) {
    this.engine = engine;
    // Drop's impact cell = the centroid cell (matches lullaby-drop's default centre).
    const cx = cells.reduce((s, c) => s + c.x, 0) / cells.length;
    const cy = cells.reduce((s, c) => s + c.y, 0) / cells.length;
    this.centerX = Math.round(cx);
    this.centerY = Math.round(cy);
    this._active = false;
    this._timers = [];

    this.el = document.createElement('div');
    const btnRow = document.createElement('div');
    btnRow.className = 'row';
    const blanketBtn = document.createElement('button');
    blanketBtn.textContent = 'Blanket';
    blanketBtn.style.flex = '1';
    blanketBtn.title = 'Concentric wave (outside → in): floor, ~10% dimly lit + drop cell lifted to z2 (30%), then all lights off in the same order';
    blanketBtn.addEventListener('click', () => this._blanket());
    const flatBtn = document.createElement('button');
    flatBtn.textContent = 'Flat';
    flatBtn.title = 'Lower the central 4 (drop-cell) edges back to the floor';
    flatBtn.addEventListener('click', () => this._flat());
    const moonBtn = document.createElement('button');
    moonBtn.textContent = 'Moon';
    moonBtn.title = `Raise panel ${MOON_NOTE} to z6 at full brightness`;
    moonBtn.addEventListener('click', () => this._moon());
    btnRow.append(blanketBtn, flatBtn, moonBtn);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Blanket sweeps in from the outside then fades in the same order. Flat lowers the central 4. Moon raises panel 88 to z6.';

    this.el.append(btnRow, hint);
  }

  setActive(on) { this._active = on; if (!on) this._clearTimers(); }
  tick() {}

  _clearTimers() { for (const t of this._timers) clearTimeout(t); this._timers = []; }

  /**
   * Lay the blanket as a concentric wave from the outside in — each panel to its blanket target
   * (drop cell → z2 lit; ~10% → floor lit; the rest → floor dark), timed by distance from the
   * centre so the outer ring goes first. Once the wave reaches the centre, turn every lit panel
   * off in the same outside→in order.
   */
  _blanket() {
    this._clearTimers();
    const dropKeys = new Set(cellEdgeList(this.centerX, this.centerY).map(edgeKey));
    const all = this.engine.list();
    const others = all.filter((p) => !dropKeys.has(`${p.x},${p.y},${p.orient}`));
    const litSet = new Set(others.slice().sort(() => Math.random() - 0.5)
      .slice(0, Math.round(others.length * LIT_FRAC)).map((p) => `${p.x},${p.y},${p.orient}`));

    const ccx = this.centerX + 0.5, ccy = this.centerY + 0.5;
    const scene = all.map((p) => {
      const key = `${p.x},${p.y},${p.orient}`;
      const { px, py } = panelCenter(p.x, p.y, p.orient);
      const dist = Math.hypot(px - ccx, py - ccy);
      const z = dropKeys.has(key) ? 2 : 0;
      const bright = dropKeys.has(key) || litSet.has(key) ? DIM : 0;
      return { p, dist, z, bright };
    });
    const maxD = Math.max(1, ...scene.map((s) => s.dist));

    // On-wave: outer ring (largest dist) first, centre last.
    for (const s of scene) {
      const t = (maxD - s.dist) * WAVE_MS;
      this._timers.push(setTimeout(
        () => this.engine.move(s.p.x, s.p.y, s.p.orient, zToPos(s.z), s.bright), t));
    }
    // Off-wave: after the blanket is fully laid + a hold, fade the lit panels in the SAME order.
    const onDone = maxD * WAVE_MS + HOLD_MS;
    for (const s of scene) {
      if (s.bright <= 0) continue;
      const t = onDone + (maxD - s.dist) * WAVE_MS;
      this._timers.push(setTimeout(() => this.engine.off(s.p.x, s.p.y, s.p.orient), t));
    }
  }

  /** Flat: lower the central 4 (drop-cell) edges to the floor — they're already dark, so keep light. */
  _flat() {
    this._clearTimers();
    for (const e of cellEdgeList(this.centerX, this.centerY)) {
      this.engine.move(e.x, e.y, e.orient, zToPos(0), null);
    }
  }

  /** Moon: raise panel 88 to z6 at full brightness. */
  _moon() {
    const p = this.engine.state?.get?.(MOON_NOTE);
    if (p && !p.dead) this.engine.move(p.x, p.y, p.orient, zToPos(6), 1);
  }
}
