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

const MOON_NOTE  = 88;   // the panel the Moon button raises
const LIT_FRAC   = 0.10; // fraction of (non-drop) panels the blanket selects
const DIM        = 0.30; // brightness of the central (drop-cell) panels — lit, and it stays lit
const RANDOM_DIM = 0;    // the random ~10% (selection kept in code) — 0% for now; set to DIM to sprinkle them
const WAVE_MS   = 150;  // per unit of distance — how fast the concentric wave sweeps in
const GLOW_MS   = 150;  // a lit step goes dark this soon after it lights (a brief flash)

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
      const central = dropKeys.has(key);
      const z = central ? 2 : 0;
      // Central drop cell lights (and stays lit); the random ~10% are kept in code but held at 0%.
      const bright = central ? DIM : (litSet.has(key) ? RANDOM_DIM : 0);
      return { p, dist, z, bright, central };
    });
    const maxD = Math.max(1, ...scene.map((s) => s.dist));

    // Concentric wave, outer ring (largest dist) first, centre last:
    //   - central drop cell → lift to z2, lit, and STAY lit;
    //   - a selected ~10%   → flash: light on the floor, then dark RIGHT AWAY (GLOW_MS later);
    //   - everything else   → just go dark IN PLACE — a bare note-off, NO move/step (no vel-1 blink).
    // (With the random ~10% at 0% nothing flashes for now — restore RANDOM_DIM for the sparkle.)
    for (const s of scene) {
      const tOn = (maxD - s.dist) * WAVE_MS;
      if (s.central) {
        this._timers.push(setTimeout(() => this.engine.move(s.p.x, s.p.y, s.p.orient, zToPos(2), DIM), tOn));
      } else if (s.bright > 0) {
        this._timers.push(setTimeout(() => this.engine.move(s.p.x, s.p.y, s.p.orient, zToPos(0), s.bright), tOn));
        this._timers.push(setTimeout(() => this.engine.off(s.p.x, s.p.y, s.p.orient), tOn + GLOW_MS));
      } else {
        this._timers.push(setTimeout(() => this.engine.off(s.p.x, s.p.y, s.p.orient), tOn));
      }
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
