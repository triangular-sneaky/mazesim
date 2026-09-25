/**
 * "Prison" interlude — an interactive movement (not a timeline). A maze-cell board plus a
 * cell text box and Up / Down buttons. NOTHING moves on activation:
 *   - Click a cell (or type "x,y") → it just populates the text box (the selection).
 *   - Up   → the selected cell's 4 edges rise to z=4, lit; every other panel goes up and dark.
 *   - Down → the classic cage bob begins from wherever the cell is now: it drops and then
 *            ping-pongs between the ground and ~1 m, pulsing red, until you press Up / reselect.
 *
 * Controller contract used by DemoBank's collapsible controls:
 *   .el              — root DOM element to mount
 *   .setActive(on)   — start/stop the interactive mode (idempotent; start does NOT move)
 *   .tick(dt)        — advance per frame
 *
 * All panel motion goes through the engine's combined move/sweep at the GLOBAL speed (no
 * velocity override), carrying the light with the move; the bob flips target on arrival so its
 * amplitude is fixed while its period follows the global speed. The red glow pulse is an LED
 * effect driven directly onto the board.
 */
import { cellEdgeList } from '../model/layout.js';
import { zToPos, posToZ, applyStep } from '../model/mazeState.js';

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
    this.cagePos = zToPos(4);           // "Up" cage height = z=4
    this.releasePos = m.restPosition ?? 255;

    // Timing / feel. Panel travel speed is always the global engine speed; only the glow keeps
    // its own timer.
    this.glowPeriod = 0.9;   // s per glow pulse
    this.releaseFade = 0.5;  // s to dim a released cage
    this.peak = 0.95;        // glow / lit brightness ceiling

    // Down-bob params (operator-editable below).
    this.oscillations = 2;   // total up-down cycles before holding at the ground (0 = endless)
    this.bottomDwell = 0.2;  // s held at the ground before rising
    this.topDwell = 0.2;     // s held at the top before dropping

    // "get lost" params (operator-editable below): scatter a few random panels to a low mid level
    // at faint, varied brightness.
    this.lostCount = 5;      // how many random panels to drop
    this.lostZLo = 2;        // random target z, low bound
    this.lostZHi = 3;        // random target z, high bound
    this.lostLitMax = 40;    // max brightness, percent (each panel gets a random 0..this)

    // State.
    this._active = false;
    this._selected = null;   // {x,y} chosen on the board / text box (no movement)
    this._bobbing = false;   // true only while the Down bob is running
    this._osc = 0;           // completed oscillations this run
    this._hasRisen = false;  // has the cage gone up at least once (so the initial drop isn't counted)
    this.trapCell = null;    // {x,y} currently actioned (Up or Down)
    this.trapPanels = [];    // Panel refs of the actioned cell's 4 edges
    this.bobTarget = null;   // current ping-pong target for the caged panels
    this._cPanels = [];      // "switch to C" — the # of panels currently lit around the chosen cell
    this._dwell = 0;         // seconds held at the current bob end
    this.glowPhase = 0;      // seconds accumulated for the glow pulse
    this.releasing = new Map(); // panel.key -> { panel, b } fading brightness on release

    // DOM: board canvas + a cell text box + Up/Down buttons + hint.
    this.el = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.className = 'prison-board';
    this.cell = 26; this.pad = 4;
    canvas.width = this.cols * this.cell + this.pad * 2;
    canvas.height = this.rows * this.cell + this.pad * 2;
    canvas.addEventListener('click', (e) => this._onClick(e));

    const selRow = document.createElement('div');
    selRow.className = 'row';
    const lbl = document.createElement('label');
    lbl.textContent = 'cell';
    this._cellInput = document.createElement('input');
    this._cellInput.type = 'text';
    this._cellInput.className = 'val';
    this._cellInput.style.width = '60px';
    this._cellInput.placeholder = 'x,y';
    this._cellInput.addEventListener('input', () => { this._selected = this._parseCell(); this._draw(); });
    selRow.append(lbl, this._cellInput);

    const btnRow = document.createElement('div');
    btnRow.className = 'row';
    const upBtn = document.createElement('button');
    upBtn.textContent = 'Up';
    upBtn.title = 'Selected cell to z=4 (lit); every other panel up and dark';
    upBtn.addEventListener('click', () => this._up());
    const downBtn = document.createElement('button');
    downBtn.textContent = 'Down';
    downBtn.title = 'Drop the selected cell and start the bob from where it is';
    downBtn.addEventListener('click', () => this._down());
    const cBtn = document.createElement('button');
    cBtn.textContent = 'switch to C';
    cBtn.title = 'Turn the current prison lights off (no movement), then light a “#” around the newly-selected cell (its 4 edges + 8 extensions) with a +1-step lights-on';
    cBtn.addEventListener('click', () => this._switchToC());
    const lostBtn = document.createElement('button');
    lostBtn.textContent = 'get lost';
    lostBtn.title = 'Drop a few random panels to a low mid level (z 2–3) at faint, varied brightness (0–40%)';
    lostBtn.addEventListener('click', () => this._getLost());
    btnRow.append(upBtn, downBtn, cBtn, lostBtn);

    // Down-bob params: total oscillations (0 = endless) + dwell at each end.
    const numRow = (label, get, set, min, max, step) => {
      const r = document.createElement('div');
      r.className = 'row';
      const l = document.createElement('label');
      l.textContent = label;
      const i = document.createElement('input');
      i.type = 'number'; i.className = 'val'; i.style.width = '56px';
      i.min = min; i.max = max; i.step = step; i.value = get();
      i.addEventListener('change', () => {
        const v = Math.max(min, Math.min(max, Number(i.value) || 0));
        i.value = v; set(v);
      });
      r.append(l, i);
      return r;
    };
    const oscRow = numRow('oscillations', () => this.oscillations,
      (v) => { this.oscillations = Math.round(v); }, 0, 99, 1);
    const botRow = numRow('bottom delay (s)', () => this.bottomDwell, (v) => { this.bottomDwell = v; }, 0, 10, 0.1);
    const topRow = numRow('top delay (s)', () => this.topDwell, (v) => { this.topDwell = v; }, 0, 10, 0.1);
    const lostCountRow = numRow('lost: count',    () => this.lostCount,  (v) => { this.lostCount = Math.round(v); }, 0, 30, 1);
    const lostZLoRow   = numRow('lost: z from',   () => this.lostZLo,    (v) => { this.lostZLo = Math.round(v); }, 0, 8, 1);
    const lostZHiRow   = numRow('lost: z to',     () => this.lostZHi,    (v) => { this.lostZHi = Math.round(v); }, 0, 8, 1);
    const lostLitRow   = numRow('lost: max lit %', () => this.lostLitMax, (v) => { this.lostLitMax = v; }, 0, 100, 5);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Click a cell (or type x,y) to select — Up cages it high, Down starts the bob, “switch to C” darkens the current lights and lights a # around the newly-selected cell.';

    this.el.append(canvas, selRow, btnRow, oscRow, botRow, topRow,
      lostCountRow, lostZLoRow, lostZHiRow, lostLitRow, hint);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Default selection (operator-editable via the box / board): cell (1,5) if the layout has it.
    const dfltX = 1, dfltY = 5;
    if (this.occupied.has(`${dfltX},${dfltY}`)) {
      this._selected = { x: dfltX, y: dfltY };
      this._cellInput.value = `${dfltX},${dfltY}`;
    }
  }

  /** The 4 panels framing cell (x,y): N/S h-walls, W/E v-walls (h=south / v=east; see
   *  model/layout.js — north=h(x,y-1), south=h(x,y), west=v(x-1,y), east=v(x,y)). */
  _edgesOf(x, y) {
    return cellEdgeList(x, y)
      .map((e) => this.engine.get(e.x, e.y, e.orient))
      .filter(Boolean);
  }

  setActive(on) {
    if (on === this._active) return;    // idempotent
    this._active = on;
    // Wire-synced moves: while Prison is live, a panel's belief/animation commit on the real wire
    // send and its next move waits until move-end (the bob already waits on sim `moving`; this makes
    // that truthful and enforces it at the wire level too). Reset when the controls close.
    this.engine.syncToWire = on;
    if (!on) { this._release(); this.engine.resetWireGate?.(); } // stop the bob, free the cage, drop gate state
    // Turning on does NOT move anything — wait for the operator to select and press Up/Down.
  }

  /** Parse the cell text box ("x,y"), returning {x,y} only if it names an occupied cell. */
  _parseCell() {
    const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(this._cellInput.value);
    if (!m) return null;
    const x = +m[1], y = +m[2];
    return this.occupied.has(`${x},${y}`) ? { x, y } : null;
  }

  /** Build a sweep move list sending all currently caged panels to `target`. */
  _moves(target) {
    return this.trapPanels.map((p) => ({ x: p.x, y: p.y, orient: p.orient, target }));
  }

  /** Click a cell — selection only, no movement. Populates the text box. */
  _onClick(e) {
    if (!this._active) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (this.canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (this.canvas.height / rect.height);
    const x = Math.floor((px - this.pad) / this.cell);
    const y = Math.floor((py - this.pad) / this.cell);
    if (!this.occupied.has(`${x},${y}`)) return;
    this._selected = { x, y };
    this._cellInput.value = `${x},${y}`;
    this._draw();
  }

  /** Up: selected cell's edges rise to z=4 (lit); every other panel goes up and dark. */
  _up() {
    const cell = this._selected || this._parseCell();
    if (!cell) return;
    this._bobbing = false;
    this.trapCell = cell;
    this.trapPanels = this._edgesOf(cell.x, cell.y);
    for (const p of this.trapPanels) this.releasing.delete(p.key);
    const cageKeys = new Set(this.trapPanels.map((p) => `${p.x},${p.y},${p.orient}`));

    // Engage the cage FIRST (z=4, lit) so it lifts right away, ahead of sending the rest of the
    // field up — otherwise its move would sit behind ~80 queued field moves in the gate.
    this.engine.sweepTo(this._moves(this.cagePos), { brightness: this.peak });
    this.glowPhase = 0;

    // Everything else: up and dark — but SKIP panels already at the top (no redundant move to
    // queue). A lit one up there just gets its light turned off (a bare note-off, no movement).
    const topZ = posToZ(this.releasePos);
    for (const p of this.engine.list()) {
      if (cageKeys.has(`${p.x},${p.y},${p.orient}`)) continue;
      const bel = this.engine.state?.get?.(this.engine.noteAt(p.x, p.y, p.orient));
      if (bel && bel.z === topZ) {
        if (bel.brightness > 0) this.engine.off(p.x, p.y, p.orient); // already up → just darken
        continue;                                                    // already up → skip the move
      }
      this.engine.move(p.x, p.y, p.orient, this.releasePos, 0);
    }
  }

  /** Down: start the classic cage bob from the cell's current position (drops, then bobs). */
  _down() {
    const cell = this._selected || this._parseCell();
    if (!cell) return;
    this.trapCell = cell;
    this.trapPanels = this._edgesOf(cell.x, cell.y);
    for (const p of this.trapPanels) this.releasing.delete(p.key);
    this.bobTarget = this.groundPos;   // start by going down
    this._dwell = 0;
    this.glowPhase = 0;
    this._osc = 0;
    this._hasRisen = false;
    this._bobbing = true;
    this.engine.sweepTo(this._moves(this.bobTarget), { brightness: this.peak });
  }

  /** Sweep the current cage back up (dark), fade its glow, and stop the bob. */
  _release() {
    if (this.trapPanels.length) {
      for (const p of this.trapPanels) this.releasing.set(p.key, { panel: p, b: p.brightness });
      this.engine.sweepTo(this._moves(this.releasePos), { brightness: 0 });
    }
    for (const p of this._cPanels) this.engine.off(p.x, p.y, p.orient); // clear any lit "#"
    this._cPanels = [];
    this._bobbing = false;
    this.trapCell = null;
    this.trapPanels = [];
    this.bobTarget = null;
  }

  /**
   * "switch to C": turn the current prison lights OFF without moving anything (a bare note-off per
   * lit panel — cage and/or previous "#" stay where they are, just dark), then light a "#" around
   * the newly-selected cell — its 4 edges plus 8 extensions off the corners — with the default
   * lights-on (a +1-step pulse per panel, the cheap in-place relight).
   */
  _switchToC() {
    const cell = this._selected || this._parseCell();
    if (!cell) return;
    this._bobbing = false;
    // 1. Clear every currently-lit panel with a 1-STEP MOVE at velocity 1 (for now) instead of a
    //    bare note-off: a note-on at vel 1 darkens the light (vel 1 = off) AND re-arms the step
    //    counter, which clears more reliably IRL than a lone note-off. Steps the panel one level.
    for (const sp of this.engine.list()) {
      const bel = this.engine.state?.get?.(this.engine.noteAt(sp.x, sp.y, sp.orient));
      if (bel && !bel.dead && bel.brightness > 0) {
        const ns = applyStep({ z: bel.z, v: bel.v });               // one step along the bounce
        this.engine.move(sp.x, sp.y, sp.orient, zToPos(ns.z), 0);   // brightness 0 → vel 1 = off
      }
    }
    this.trapPanels = [];
    this.trapCell = null;
    this.bobTarget = null;
    // 2. Light the "#" around the new cell with a +1-step lights-on (move to the panel's current z
    //    with light → a single note-on that lights and steps it up one).
    const hash = this._hashPanels(cell.x, cell.y);
    for (const p of hash) {
      const note = this.engine.noteAt(p.x, p.y, p.orient);
      const z = this.engine.state?.get?.(note)?.z ?? 0;
      this.engine.move(p.x, p.y, p.orient, zToPos(z), this.peak);
    }
    this._cPanels = hash;
  }

  /**
   * "get lost": scatter `lostCount` random panels to a random low-mid level (z in [lostZLo,lostZHi])
   * at a random faint brightness (0..lostLitMax%). Additive — leaves any existing prison lights be.
   */
  _getLost() {
    const zLo = Math.min(this.lostZLo, this.lostZHi);
    const zHi = Math.max(this.lostZLo, this.lostZHi);
    const litMax = Math.max(0, Math.min(1, this.lostLitMax / 100));
    const all = this.engine.list().slice().sort(() => Math.random() - 0.5);
    for (const p of all.slice(0, Math.max(0, Math.round(this.lostCount)))) {
      const z = zLo + Math.floor(Math.random() * (zHi - zLo + 1));
      const bright = Math.random() * litMax;
      this.engine.move(p.x, p.y, p.orient, zToPos(z), bright);
    }
  }

  /**
   * The "#" of panels around cell (x,y): its 4 edge walls, plus the 8 that extend those walls off
   * the corners (each horizontal wall reaches one cell left/right, each vertical wall one up/down).
   * Filters to panels that actually exist (drops any that fall off the maze).
   */
  _hashPanels(x, y) {
    const cand = [
      { x, y: y - 1, orient: 'h' }, { x, y, orient: 'h' },                       // N, S edges
      { x: x - 1, y, orient: 'v' }, { x, y, orient: 'v' },                       // W, E edges
      { x: x - 1, y: y - 1, orient: 'h' }, { x: x + 1, y: y - 1, orient: 'h' },  // N wall extended W/E
      { x: x - 1, y, orient: 'h' }, { x: x + 1, y, orient: 'h' },                // S wall extended W/E
      { x: x - 1, y: y - 1, orient: 'v' }, { x: x - 1, y: y + 1, orient: 'v' },  // W wall extended N/S
      { x, y: y - 1, orient: 'v' }, { x, y: y + 1, orient: 'v' },                // E wall extended N/S
    ];
    return cand.filter((p) => this.engine.get(p.x, p.y, p.orient));
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

    // Bob only runs after "Down". "Up" leaves the cage static and lit (no pulse).
    if (this._bobbing && this.trapCell) {
      if (this.trapPanels.every((p) => !p.moving)) {
        const atGround = this.bobTarget === this.groundPos;
        this._dwell += dt;
        if (this._dwell >= (atGround ? this.bottomDwell : this.topDwell)) {
          this._dwell = 0;
          // Count a completed oscillation each time we return to the ground after rising.
          if (atGround && this._hasRisen) {
            this._osc += 1;
            if (this.oscillations > 0 && this._osc >= this.oscillations) {
              this._bobbing = false; // finished: hold at the ground (still lit)
            }
          }
          if (this._bobbing) {
            this.bobTarget = atGround ? this.highPos : this.groundPos;
            if (this.bobTarget === this.highPos) this._hasRisen = true;
            this.engine.sweepTo(this._moves(this.bobTarget), { brightness: this.peak });
          }
        }
      }
      // Glow (LED, not motion): pulse brightness on its own timer.
      this.glowPhase += dt;
      const g = this._glow(this.glowPhase * ((2 * Math.PI) / this.glowPeriod));
      for (const p of this.trapPanels) p.brightness = g;
    }

    // Always draw the board while open so the clickable maze shows before any action.
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
          // Caged/actioned cell glows red; others (fading releases) stay cool.
          ctx.fillStyle = caged ? `rgba(255,90,70,${bright})` : `rgba(158,197,255,${bright})`;
          ctx.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);
        }
        // Selection outline (blue); the actioned cell is outlined red.
        const selected = this._selected && this._selected.x === x && this._selected.y === y;
        if (caged || selected) {
          ctx.strokeStyle = caged ? '#ff5a46' : '#6ea8ff';
          ctx.lineWidth = 2;
          ctx.strokeRect(gx + 1.5, gy + 1.5, cell - 3, cell - 3);
        }
      }
    }
  }
}
