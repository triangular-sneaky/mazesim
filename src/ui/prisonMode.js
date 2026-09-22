/**
 * "Prison" interlude — an interactive movement (not a timeline). A maze-cell board:
 * click an occupied cell and its 4 framing panels (the cell's N/S/E/W edges) drop to
 * the ground, caging whoever stands there, then bob between ground and ~1 m while
 * pulsing (biased toward on). Click another cell and the previous cage dims and rises
 * as the new one forms. Exactly one cell is caged at a time.
 *
 * Implements the controller contract used by DemoBank's collapsible controls:
 *   .el              — root DOM element to mount
 *   .setActive(on)   — start/stop the interactive mode (idempotent)
 *   .tick(dt)        — advance per frame (call from the main animation loop)
 *
 * All panel motion — the drop, the bob, the release — goes through engine.movePanel at
 * the GLOBAL speed (no velocity override): the bob ping-pongs between ground and ~1 m,
 * flipping target each time the panels arrive, so its amplitude is fixed while its period
 * follows the global speed. Only LED brightness (the glow) is driven directly here.
 */
import { cellEdgeList } from '../model/layout.js';

export class PrisonMode {
  constructor(engine, cells, config) {
    this.engine = engine;

    this.cols = Math.max(...cells.map((c) => c.x)) + 1;
    this.rows = Math.max(...cells.map((c) => c.y)) + 1;
    this.occupied = new Set(cells.map((c) => `${c.x},${c.y}`));

    // Heights (logical 0..255). Ground = lowest travel; "1 m" mapped from world height.
    const m = config.motion;
    const posForHeight = (hM) =>
      Math.max(0, Math.min(255, ((hM - m.travelMin) / (m.travelMax - m.travelMin)) * 255));
    this.groundPos = 0;
    this.highPos = posForHeight(1.0);   // top of the bob (~1 m)
    this.releasePos = m.restPosition ?? 255;

    // Timing / feel. NOTE: panel travel speed is NOT set here — it always uses the global
    // engine speed. Only the glow (an LED effect, not motion) keeps its own timer.
    this.glowPeriod = 0.9;   // s per glow pulse
    this.releaseFade = 0.5;  // s to dim a released cage
    this.peak = 0.95;        // glow brightness ceiling
    this.bobDwell = 0.2;     // s to hold at each end of the bob before reversing

    // State.
    this._active = false;
    this.trapCell = null;    // {x,y}
    this.trapPanels = [];    // Panel refs currently caged
    this.bobTarget = null;   // current ping-pong target for the caged panels
    this._dwell = 0;         // seconds held at the current bob end (before reversing)
    this.glowPhase = 0;      // seconds accumulated for the glow pulse
    this.releasing = new Map(); // panel.key -> { panel, b } fading brightness on release

    // DOM: a canvas board + a hint.
    this.el = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.className = 'prison-board';
    this.cell = 26; this.pad = 4;
    canvas.width = this.cols * this.cell + this.pad * 2;
    canvas.height = this.rows * this.cell + this.pad * 2;
    canvas.addEventListener('click', (e) => this._onClick(e));
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Click a cell to cage it; click another to move the cage.';
    this.el.append(canvas, hint);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /** The 4 panels framing cell (x,y): N/S h-walls, W/E v-walls (h=south / v=east; see
   *  model/layout.js — north=h(x,y-1), south=h(x,y), west=v(x-1,y), east=v(x,y)). */
  _edgesOf(x, y) {
    return cellEdgeList(x, y)
      .map((e) => this.engine.get(e.x, e.y, e.orient))
      .filter(Boolean);
  }

  setActive(on) {
    if (on === this._active) return;    // idempotent: don't reset an active cage on re-render
    this._active = on;
    if (on) {
      // Sweep the whole field level to rest: every panel travels at the global speed but
      // the shorter moves start later, so they all "join in" and level together.
      this.engine.sweepAll(this.releasePos);
    } else {
      this._release();                  // collapsing the controls frees the current cage
    }
  }

  /** Build a sweep move list sending all currently caged panels to `target`. */
  _moves(target) {
    return this.trapPanels.map((p) => ({ x: p.x, y: p.y, orient: p.orient, target }));
  }

  _onClick(e) {
    if (!this._active) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (this.canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (this.canvas.height / rect.height);
    const x = Math.floor((px - this.pad) / this.cell);
    const y = Math.floor((py - this.pad) / this.cell);
    if (this.occupied.has(`${x},${y}`)) this.trap(x, y);
  }

  /** Cage cell (x,y): release any current cage, then drop this cell's 4 edges to ground. */
  trap(x, y) {
    if (this.trapCell && this.trapCell.x === x && this.trapCell.y === y) return;
    this._release();
    this.trapCell = { x, y };
    this.trapPanels = this._edgesOf(x, y);
    for (const p of this.trapPanels) this.releasing.delete(p.key); // re-caged shared edges
    this.bobTarget = this.groundPos; // drop in first; the bob flips this on arrival
    this._dwell = 0;
    // Sweep the four edges down together — they arrive as one even from different heights.
    this.engine.sweepTo(this._moves(this.bobTarget));
    this.glowPhase = 0;
  }

  /** Sweep the current cage back up together (at global speed) and fade its glow. */
  _release() {
    if (this.trapPanels.length) {
      for (const p of this.trapPanels) this.releasing.set(p.key, { panel: p, b: p.brightness });
      this.engine.sweepTo(this._moves(this.releasePos));
    }
    this.trapCell = null;
    this.trapPanels = [];
    this.bobTarget = null;
  }

  /** Glow value for a phase (radians): pulses 0..1, biased to spend more time bright. */
  _glow(radians) {
    const raw = 0.5 - 0.5 * Math.cos(radians);   // 0..1, smooth
    const biased = Math.sqrt(raw);               // dwell nearer the top ("more on")
    return this.peak * (0.15 + 0.85 * biased);
  }

  tick(dt) {
    // Fade any released cages toward dark (independent of active state).
    for (const [key, r] of this.releasing) {
      r.b -= dt / this.releaseFade;
      if (r.b <= 0) { r.panel.brightness = 0; this.releasing.delete(key); }
      else r.panel.brightness = r.b;
    }

    if (!this._active) return;

    if (this.trapCell) {
      // Bob: when all caged panels have arrived, hold briefly (bobDwell) so it doesn't snap
      // straight back, then flip the target and sweep the other way — at the global speed,
      // so amplitude is fixed and period tracks speed.
      if (this.trapPanels.every((p) => !p.moving)) {
        this._dwell += dt;
        if (this._dwell >= this.bobDwell) {
          this.bobTarget = this.bobTarget === this.groundPos ? this.highPos : this.groundPos;
          this.engine.sweepTo(this._moves(this.bobTarget));
          this._dwell = 0;
        }
      }

      // Glow (LED, not motion): pulse brightness on its own timer.
      this.glowPhase += dt;
      const g = this._glow(this.glowPhase * ((2 * Math.PI) / this.glowPeriod));
      for (const p of this.trapPanels) p.brightness = g;
    }

    // Always draw the board while open, so the clickable maze shows before any cell is caged.
    this._draw();
  }

  _draw() {
    const { ctx, cell, pad } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const gx = pad + x * cell, gy = pad + y * cell;
        if (!this.occupied.has(`${x},${y}`)) {
          ctx.fillStyle = '#0d0f12';
          ctx.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);
          continue;
        }
        const h = this.engine.get(x, y, 'h');
        const v = this.engine.get(x, y, 'v');
        const pos = ((h?.position ?? 0) + (v?.position ?? 0)) / 2;
        const shade = Math.round(40 + (pos / 255) * 150);
        ctx.fillStyle = `rgb(${shade},${shade + 6},${shade + 14})`;
        ctx.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);

        const caged = this.trapCell && this.trapCell.x === x && this.trapCell.y === y;
        const bright = Math.max(h?.brightness ?? 0, v?.brightness ?? 0);
        if (bright > 0.01) {
          // Caged cell glows red (danger); others (fading releases) stay cool.
          ctx.fillStyle = caged ? `rgba(255,90,70,${bright})` : `rgba(158,197,255,${bright})`;
          ctx.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);
        }
        if (caged) {
          ctx.strokeStyle = '#ff5a46';
          ctx.lineWidth = 2;
          ctx.strokeRect(gx + 1.5, gy + 1.5, cell - 3, cell - 3);
        }
      }
    }
  }
}
