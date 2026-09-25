/**
 * Demo player: turns a demo definition into a timed list of actions, then schedules
 * them against the engine's action API. Generators build the action list from the
 * live panel set so demos adapt to any layout.
 *
 * An action = { t: ms, run: () => void }.
 */
import { panelCenter, cellEdges, cellEdgeList, edgeKey, seRimPanels } from '../model/layout.js';
import { zToPos, posToZ } from '../model/mazeState.js';

export class DemoPlayer {
  /**
   * @param engine
   * @param {{schedule?:(fn,ms)=>any, unschedule?:(id)=>void}} [opts] timer source — inject the
   *   background clock so scheduled actions keep firing when the tab is hidden; defaults to
   *   the native (background-throttled) setTimeout/clearTimeout.
   */
  constructor(engine, opts = {}) {
    this.engine         = engine;
    this._schedule      = opts.schedule   ?? ((fn, ms) => setTimeout(fn, ms));
    this._unschedule    = opts.unschedule ?? ((id) => clearTimeout(id));
    this._timers        = [];
    this._triggerTimers = [];
    this._running       = null;
    this._demo          = null;
    this._triggerArmed  = false;
    this._playsRemaining = 0;   // loop re-plays left (see play()); Infinity = unlimited
  }

  stop() {
    for (const id of this._timers)        this._unschedule(id);
    for (const id of this._triggerTimers) this._unschedule(id);
    this._timers        = [];
    this._triggerTimers = [];
    this._running       = null;
    this._demo          = null;
    if (this.engine) { // reset per-movement flags + drop stale wire-gate state (flushed sends never call back)
      this.engine.syncToWire = false; this.engine.stayLight = false; this.engine.onPanelDone = null;
      this.engine.resetWireGate?.();
    }
  }

  isRunning() { return this._running; }

  /**
   * Arm or disarm MIDI trigger mode for the loaded movement.
   * Armed: play() suppresses auto-loop and only settles the structure.
   * Disarmed: re-plays the current demo normally so its loop resumes.
   */
  armTrigger(on) {
    if (this._triggerArmed === on) return;
    this._triggerArmed = on;
    if (this._demo) this.play(this._demo);
  }

  /** True when the current movement supports external triggering. */
  isCurrentTriggerable() {
    return !!(this._demo && TRIGGERABLE[this._demo.generator]);
  }

  /**
   * Fire one burst for the current triggerable movement.
   * In-flight bursts are NOT cancelled — concurrent sweeps overlap by design.
   * Returns true on success, false if no triggerable movement is loaded.
   */
  fireTrigger() {
    if (!this._triggerArmed || !this.isCurrentTriggerable()) return false;
    const burst = TRIGGERABLE[this._demo.generator](this.engine, this._demo.params || {});
    for (const a of burst) {
      this._triggerTimers.push(this._schedule(a.run, a.t));
    }
    return true;
  }

  play(demo, isReplay = false) {
    this.stop();
    const gen = GENERATORS[demo.generator];
    if (!gen) {
      console.warn(`Unknown demo generator: ${demo.generator}`);
      return;
    }
    this._running = demo.id;
    this._demo    = demo;
    const params  = demo.params || {};

    // Wire-synced moves (opt-in per movement, toggleable in the GUI): commit/animate on the real
    // wire send and gate the next move per panel. Re-read each play/loop so a live checkbox change
    // takes effect on the next cycle; stop() resets it.
    this.engine.syncToWire = !!params.syncToWire;
    // In-place relight via planStay (z-exact) instead of the 1-step pulse — per movement.
    this.engine.stayLight = !!params.stayLight;

    // Arm the repeat counter on a fresh (user-initiated) play: `repeats` = total cycles for a
    // looping movement, 0 = unlimited. Loop re-plays keep counting down without re-arming.
    if (!isReplay) {
      const repeats = params.repeats ?? 0;
      this._playsRemaining = repeats > 0 ? repeats - 1 : Infinity;
    }

    // Trigger-armed mode: only settle the structure, suppress auto-loop.
    if (this._triggerArmed && TRIGGERABLE[demo.generator]) {
      const actions = gen(this.engine, { ...params, staticOnly: true });
      for (const a of actions) this._timers.push(this._schedule(a.run, a.t));
      return;
    }

    const actions = gen(this.engine, params);
    for (const a of actions) {
      this._timers.push(this._schedule(a.run, a.t));
    }
    // Auto-retrigger: `period > 0` waits N seconds after the movement ends then replays;
    // `loop: true` replays immediately when the last action fires. Bounded by `repeats`.
    const period = params.period;
    const loop   = params.loop;
    if ((period > 0 || loop) && this._playsRemaining > 0) {
      this._playsRemaining -= 1;
      const endT  = actions.length ? Math.max(...actions.map((a) => a.t)) : 0;
      const delay = period > 0 ? endT + period * 1000 : endT;
      this._timers.push(this._schedule(() => this.play(demo, true), delay));
    }
  }
}

// ---- Generators --------------------------------------------------------------

const cellsOf = (engine) => {
  const set = new Map();
  for (const p of engine.list()) set.set(`${p.x},${p.y}`, { x: p.x, y: p.y });
  return [...set.values()];
};

/**
 * The global speed acts as a TEMPO. Generators author their intervals/durations for the
 * engine's reference speed; multiplying those timings by this factor makes a movement's
 * PERIOD track the speed control while its AMPLITUDE (heights) stays fixed. Faster speed
 * → smaller factor → tighter cascade, matching the faster per-panel travel. Because every
 * downstream time (action offsets, blink sustains, jitter) is derived from the scaled
 * interval/duration, the whole movement compresses coherently.
 */
const timeScale = (engine) => engine.baseSpeed / engine.speed;

/**
 * particlesPlan — shared setup for the particles generator and external trigger bursts.
 * Returns { settleAction, settleMs, buildBurst(tBase) }.
 *   settleAction  — action that moves all panels to their catenary structure positions.
 *   settleMs      — estimated ms for panels to reach those positions from their current state.
 *   buildBurst(t) — builds a one-cycle particle sweep with all times offset by t ms.
 *                   Re-reads engine.speed at call time so live speed slider applies.
 */
function particlesPlan(engine, params) {
  const n               = Math.max(1, Math.round(params.n               ?? 2));
  const spiralIn        = (params.spiralIn  ?? 0) > 0;
  const numTurns        = params.numTurns   ?? 2;
  const structureHeight = params.structureHeight ?? 128;
  const elasticity      = params.elasticity ?? 0.9;
  const topPos          = params.topPos     ?? 255;
  const speed           = params.speed      ?? 300;
  const rippleSize      = params.rippleSize ?? 0.08;
  const holdMs          = Math.max(0, params.holdMs ?? 800);
  const oppose          = (params.oppose  ?? 0) > 0;

  const panels = engine.list();
  const cells  = cellsOf(engine);
  const cx     = cells.reduce((s, c) => s + c.x, 0) / cells.length;
  const cy     = cells.reduce((s, c) => s + c.y, 0) / cells.length;
  const ccx    = cx + 0.5, ccy = cy + 0.5;

  const maxDist = Math.max(1, ...panels.map((p) => {
    const { px, py } = panelCenter(p.x, p.y, p.orient);
    return Math.hypot(px - ccx, py - ccy);
  }));

  // HILL that is 0 on EVERY wall and peaks in the middle: height tracks how deep a cell sits inside
  // the maze, not radial distance. Multi-source BFS inward from the boundary — a cell touching the
  // outside (a missing neighbour or the grid edge) is depth 0; each ring inward is +1.
  const occ   = new Set(cells.map((c) => `${c.x},${c.y}`));
  const isOcc = (x, y) => occ.has(`${x},${y}`);
  const depth = new Map();
  const queue = [];
  for (const c of cells) {
    const onWall = !isOcc(c.x - 1, c.y) || !isOcc(c.x + 1, c.y) || !isOcc(c.x, c.y - 1) || !isOcc(c.x, c.y + 1);
    if (onWall) { depth.set(`${c.x},${c.y}`, 0); queue.push(c); }
  }
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h], d = depth.get(`${c.x},${c.y}`);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${c.x + dx},${c.y + dy}`;
      if (isOcc(c.x + dx, c.y + dy) && !depth.has(k)) { depth.set(k, d + 1); queue.push({ x: c.x + dx, y: c.y + dy }); }
    }
  }
  const maxDepth = Math.max(1, ...depth.values());

  const structData = panels.map((p) => {
    // Panel height from its cell's depth: 0 on the walls, rising to a peak (structureHeight) in the
    // middle. `elasticity` scales how far the middle rises (1 = full height, 0 = flat on the floor).
    const d = depth.get(`${p.x},${p.y}`) ?? 0;
    const pos = Math.round(structureHeight * elasticity * (d / maxDepth));
    return { p, pos };
  });
  const posOf = new Map(structData.map(({ p, pos }) => [`${p.x},${p.y},${p.orient}`, pos]));

  // Archimedean spiral trajectory (nearest-panel mapping).
  const numSamples  = Math.max(panels.length * 4, 400);
  const spiralOrder = [];
  const visited     = new Set();
  for (let i = 0; i < numSamples; i++) {
    const t     = spiralIn ? 1 - i / numSamples : i / numSamples;
    const theta = t * 2 * Math.PI * numTurns;
    const r     = t * maxDist;
    const sx    = ccx + r * Math.cos(theta);
    const sy    = ccy + r * Math.sin(theta);
    let nearest = null, nd = Infinity;
    for (const p of panels) {
      const { px, py } = panelCenter(p.x, p.y, p.orient);
      const d  = Math.hypot(px - sx, py - sy);
      if (d < nd) { nd = d; nearest = p; }
    }
    if (nearest) {
      const key = `${nearest.x},${nearest.y},${nearest.orient}`;
      if (!visited.has(key)) { spiralOrder.push(nearest); visited.add(key); }
    }
  }
  for (const p of panels) {
    const key = `${p.x},${p.y},${p.orient}`;
    if (!visited.has(key)) spiralOrder.push(p);
  }

  const settleAction = { t: 0, run: () => {
    for (const { p, pos } of structData) engine.move(p.x, p.y, p.orient, pos, 0); // settle, dark
  }};

  // Wait for panels to reach their structure positions before any particle ripples them (rippling a
  // panel still travelling to place = a step sent mid-motion). Measure the distance to the SNAPPED
  // target engine.move actually commits (zToPos(posToZ(pos))), not the raw structure position — a
  // panel that quantizes up to ~half a z-level away travels further than the raw estimate, and the
  // slowest one (the centre, for spiral-out) would otherwise be rippled mid-settle. A small guard
  // keeps the first ripple from leading the last panel in.
  const SETTLE_GUARD = 1.15;
  const rate    = engine.speed * (1 - engine.ease);
  const settleDist = Math.max(0, ...structData.map(({ p, pos }) => Math.abs(p.position - zToPos(posToZ(pos)))));
  const settleMs = rate > 0 ? (settleDist / rate) * 1000 * SETTLE_GUARD : 500;

  const totalSteps    = spiralOrder.length;
  const cycleDuration = totalSteps * speed;
  const groupSize     = oppose ? Math.max(1, Math.ceil(n / 2)) : n;

  const buildBurst = (tBase) => {
    const burst = [];
    for (let i = 0; i < totalSteps; i++) {
      for (let pn = 0; pn < n; pn++) {
        const isOpposed = oppose && (pn % 2 === 1);
        const spiralIdx = isOpposed ? (totalSteps - 1 - i) : i;
        const p         = spiralOrder[spiralIdx];
        const sPos      = posOf.get(`${p.x},${p.y},${p.orient}`) ?? topPos;
        const lift      = Math.round(Math.max(1, (topPos - sPos) * rippleSize));

        const pairGroup = oppose ? Math.floor(pn / 2) : pn;
        const stagger   = (pairGroup / groupSize) * cycleDuration;
        const t0        = tBase + stagger + i * speed;

        // Particle passes: lift + light the panel on, hold it for `holdMs`, then drop back dark.
        // `holdMs` is independent of the propagation `speed` (ms/panel), so trails overlap — on
        // average ~holdMs/speed panels stay lit behind each particle.
        burst.push({ t: t0,           run: () => engine.move(p.x, p.y, p.orient, sPos + lift, 1) });
        burst.push({ t: t0 + holdMs,  run: () => engine.move(p.x, p.y, p.orient, sPos, 0) });
      }
    }
    return burst;
  };

  return { settleAction, settleMs, buildBurst };
}

/**
 * TRIGGERABLE — movements that support external (e.g. MIDI) one-shot triggering.
 * Each entry: (engine, params) => action[] for one burst starting at t=0.
 * To add a new movement: implement a <gen>Plan helper and add one line here.
 */
const TRIGGERABLE = {
  particles: (engine, params) => particlesPlan(engine, params).buildBurst(0),
};

export const GENERATORS = {
  /**
   * Move every panel to a single position at once. With `lightsOff: true`, also extinguish
   * every LED — the move carries brightness 0 (dark). Otherwise the light is left unchanged.
   */
  allTo(engine, params) {
    const position = params.position ?? 128;
    const lightsOff = params.lightsOff ?? false;
    return [{
      t: 0,
      run: () => engine.moveAll(position, lightsOff ? 0 : null),
    }];
  },

  /** Rows (axis:y) or columns (axis:x) rise to `up` in sequence, then settle to `down`. */
  wave(engine, params) {
    const axis = params.axis === 'x' ? 'x' : 'y';
    const interval = (params.interval ?? 200) * timeScale(engine);
    const up = params.up ?? 255;
    const down = params.down ?? 110;

    const LIT = 1;
    const lanes = [...new Set(engine.list().map((p) => p[axis]))].sort((a, b) => a - b);
    const actions = [];
    // Rise = move up + light on; fall = move down + go dark (the pulse passes over the lane).
    const rise = (panels, upPos) => panels.forEach((p) => engine.move(p.x, p.y, p.orient, upPos, LIT));
    const fall = (panels, downPos) => panels.forEach((p) => engine.move(p.x, p.y, p.orient, downPos, 0));
    lanes.forEach((lane, i) => {
      const inLane = engine.list().filter((p) => p[axis] === lane);
      const h = inLane.filter((p) => p.orient === 'h');
      const v = inLane.filter((p) => p.orient === 'v');
      const t = i * interval;
      // h and v move independently: v lags by half an interval and settles higher.
      actions.push({ t, run: () => rise(h, up) });
      actions.push({ t: t + interval * 0.5, run: () => rise(v, Math.max(0, up - 45)) });
      actions.push({ t: t + interval * 2, run: () => fall(h, down) });
      actions.push({ t: t + interval * 2.5, run: () => fall(v, down + 35) });
    });
    return actions;
  },

  /** Radial rise outward from the field center, then settle. */
  ripple(engine, params) {
    const interval = (params.interval ?? 110) * timeScale(engine);
    const up = params.up ?? 255;
    const down = params.down ?? 120;

    const cells = cellsOf(engine);
    const cx = cells.reduce((s, c) => s + c.x, 0) / cells.length;
    const cy = cells.reduce((s, c) => s + c.y, 0) / cells.length;
    const dist = (p) => Math.round(Math.hypot(p.x - cx, p.y - cy));
    const rings = [...new Set(engine.list().map(dist))].sort((a, b) => a - b);

    const LIT = 1;
    const actions = [];
    // Rise = move up + light on; fall = move down + go dark (the ring pulse passes outward).
    const rise = (panels, upPos) => panels.forEach((p) => engine.move(p.x, p.y, p.orient, upPos, LIT));
    const fall = (panels, downPos) => panels.forEach((p) => engine.move(p.x, p.y, p.orient, downPos, 0));
    rings.forEach((r, i) => {
      const inRing = engine.list().filter((p) => dist(p) === r);
      const h = inRing.filter((p) => p.orient === 'h');
      const v = inRing.filter((p) => p.orient === 'v');
      const t = i * interval;
      // h and v move independently: v lags and settles at a different height.
      actions.push({ t, run: () => rise(h, up) });
      actions.push({ t: t + interval * 0.6, run: () => rise(v, Math.max(0, up - 50)) });
      actions.push({ t: t + interval * 3, run: () => fall(h, down) });
      actions.push({ t: t + interval * 3.6, run: () => fall(v, down + 40) });
    });
    return actions;
  },

  /**
   * Static mountain: a parabolic DOME of heights — highest at the center cell, falling off to
   * the ground at the walls. Each panel's height is set by its position BETWEEN the grounded
   * walls and the center (climb = dWall / (dWall + dCenter)), so the rise is consistent from
   * every wall regardless of how off-centre the peak is. `groundWalls` pins named exterior
   * walls flat to `base`; the 'n' wall is the whole north row (h AND v panels).
   * @param params.peak        center height, position 0..255 (default 128 ≈ z=4)
   * @param params.base        wall/ground height, position 0..255 (default 0)
   * @param params.centerX/Y   center cell (default: field centroid)
   * @param params.groundWalls exterior walls to pin to base: any of 'n','w','e','s'
   * @param params.brightness  light level 0..1 for every panel (default null = keep)
   */
  mountain(engine, params) {
    const peak = params.peak ?? 128;
    const base = params.base ?? 0;
    const bright = params.brightness ?? null;
    const ground = new Set(params.groundWalls ?? []);

    const cells = cellsOf(engine);
    const panels = engine.list();
    const xs = cells.map((c) => c.x), ys = cells.map((c) => c.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    // Easternmost vertical wall per row, and the last full-width row (E silhouette, as in geo).
    const maxVxByRow = new Map();
    for (const p of panels) if (p.orient === 'v') maxVxByRow.set(p.y, Math.max(maxVxByRow.get(p.y) ?? -Infinity, p.x));
    const maxFullWidthRow = Math.max(...cells.filter((c) => c.x === maxX).map((c) => c.y));

    // Exterior wall silhouette (index-based, h=south / v=east convention). 'n' = the whole
    // north row (both h and v panels); 'w'/'e' the left/right vertical edges; 's' the south row.
    const isGroundWall = (p) =>
      (ground.has('n') && p.y === minY) ||
      (ground.has('w') && p.orient === 'v' && p.x === minX) ||
      (ground.has('e') && p.orient === 'v' && p.x === maxVxByRow.get(p.y) && p.y <= maxFullWidthRow) ||
      (ground.has('s') && p.orient === 'h' && p.y === maxY);

    const cx = params.centerX ?? (cells.reduce((s, c) => s + c.x, 0) / cells.length);
    const cy = params.centerY ?? (cells.reduce((s, c) => s + c.y, 0) / cells.length);
    const ccx = cx + 0.5, ccy = cy + 0.5; // cell center
    const ptOf = (p) => panelCenter(p.x, p.y, p.orient);
    const wallPts = panels.filter(isGroundWall).map(ptOf);
    const maxD = Math.max(1, ...panels.map((p) => { const { px, py } = ptOf(p); return Math.hypot(px - ccx, py - ccy); }));

    return panels.map((p) => {
      let pos;
      if (isGroundWall(p)) {
        pos = base;                                            // named exterior walls flat on the ground
      } else {
        const { px, py } = ptOf(p);
        const dCenter = Math.hypot(px - ccx, py - ccy);
        // Consistent climb: normalise by THIS panel's distance to the nearest grounded wall, so
        // the rise from wall (0) to centre (peak) is even in every direction. Fall back to the
        // farthest-panel radius when no walls are grounded.
        let t;
        if (wallPts.length) {
          const dWall = Math.min(...wallPts.map((w) => Math.hypot(px - w.px, py - w.py)));
          t = 1 - dWall / (dWall + dCenter);                   // 0 at centre .. 1 at a wall
        } else {
          t = Math.min(1, dCenter / maxD);
        }
        pos = Math.round(base + (peak - base) * (1 - t * t));  // parabolic dome
      }
      return { t: 0, run: () => engine.move(p.x, p.y, p.orient, pos, bright) };
    });
  },

  /**
   * Random LED blinks scattered over time. A blink is a light pulse in place: move to the
   * panel's current height (0 steps on the real maze — a light-in-place, 3D only for now) at
   * full brightness, auto-off after `blinkMs`.
   */
  sparkle(engine, params) {
    const count = params.count ?? 80;
    const interval = (params.interval ?? 110) * timeScale(engine);
    const blinkMs = params.blinkMs ?? Math.max(120, interval * 1.5);
    const all = engine.list();
    const actions = [];
    for (let i = 0; i < count; i++) {
      const p = all[Math.floor(Math.random() * all.length)];
      // jitter each blink a little so they don't lockstep
      const t = i * interval + Math.random() * interval;
      actions.push({ t, run: () => engine.move(p.x, p.y, p.orient, p.position, 1, blinkMs) });
    }
    return actions;
  },

  /**
   * Chase into a static "top" pattern. Over `duration` ms the field sweeps (diagonally,
   * NW→SE) into a SYMMETRIC, mostly-flat pattern near the top built from just two heights
   * (`topA` raised+lit, `topB` slightly lower+dark). Each panel blinks slowly while it
   * travels and, as it lands, its light settles to its final on/off state — so once the
   * sweep completes both the panels AND the lights hold perfectly static.
   *
   * Respects the global-speed rule: panels travel ONLY at the global speed. The 10 s
   * duration comes purely from staggering START times — travel time per panel is measured
   * at the current speed and starts are reverse-scheduled so every panel finishes by
   * `duration` (the last one lands right at the end).
   */
  chase(engine, params) {
    const duration = params.duration ?? 10000;   // total transition (ms)
    const topA = params.topA ?? 255;             // upper bound of the pattern band
    const topB = params.topB ?? 225;             // lower bound of the pattern band
    const random = params.random ?? false;       // random heights across the band vs. two layers
    const rate = engine.speed * (1 - engine.ease); // units/sec actually covered at cruise
    const lo = Math.min(topA, topB), hi = Math.max(topA, topB);

    const panels = engine.list();
    const xs = panels.map((p) => p.x), ys = panels.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const maxDiag = Math.max(1, (maxX - minX) + (maxY - minY));

    // Symmetric class from mirror distance to the field center (same under reflection about
    // either center line → the pattern is mirror-symmetric on both axes). Parity gives
    // alternating concentric diamond rings: class A = lit + high, class B = dark + lower.
    const isA = (p) =>
      (Math.round(Math.abs(p.x - cx)) + Math.round(Math.abs(p.y - cy))) % 2 === 0;

    // Precompute each panel's final target height, whether it ends lit, and its chase rank
    // (0..1) ONCE — random targets/order must be stable between the travel calc and the move.
    const plan = panels.map((p) => {
      let target, lit, rank;
      if (random) {
        target = Math.round(lo + Math.random() * (hi - lo)); // any height across the band
        lit = Math.random() < 0.5;                           // on/off shuffled, independent of height
        rank = Math.random();                                // scattered start order
      } else {
        const a = isA(p);
        target = a ? topA : topB;                            // two symmetric layers
        lit = a;
        rank = ((p.x - minX) + (p.y - minY)) / maxDiag;      // diagonal NW→SE sweep
      }
      return { p, target, lit, rank };
    });

    // Per-panel travel time at the global speed, and the longest of them.
    let maxTravel = 0;
    for (const it of plan) {
      it.travel = rate > 0 ? (Math.abs(it.target - it.p.position) / rate) * 1000 : 0;
      if (it.travel > maxTravel) maxTravel = it.travel;
    }
    // Leftover window to stagger starts in, so the last (slowest) panel finishes at `duration`.
    const startWindow = Math.max(0, duration - maxTravel);

    const actions = [];
    for (const { p, target, lit, rank } of plan) {
      const start = rank * startWindow;
      // One combined move per panel: travel to its target carrying its FINAL light — lit panels
      // sweep in glowing, dark ones sweep in dark. The result is a static lit/dark pattern.
      actions.push({ t: start, run: () => engine.move(p.x, p.y, p.orient, target, lit ? 0.9 : 0) });
    }
    return actions;
  },

  /**
   * blocks-descending: cell BLOCKS activate one after another. Each block (a group of cells sharing a
   * glyph in loops.yaml) moves as one slab — all its edge panels sweep together, every
   * panel still traveling at the global speed (via sweepTo). One block's cycle is:
   *   - ACTIVATE:   sweep DOWN to the mid-room height in unison, LED lit up from 0 to full.
   *   - DEACTIVATE: LED snaps off (fast 50 ms fade) as it starts, then sweeps all the way UP.
   * Blocks are stepped through in order, wrapping for `cycles` rounds, so with two blocks
   * they alternate. Two configurable delays shape the timing (both default 0), measured
   * from a block's ACTIVATION END:
   *   - deactivationDelay: activation end -> that block's deactivation begins.
   *   - activationDelay:   activation end -> the NEXT block's activation begins.
   * With both 0, each block deactivates exactly as the next activates (a clean handoff).
   *
   * A cell (x,y) is enclosed by 4 edge panels (edge-union model, see model/layout.js):
   * h(x,y-1) north, h(x,y) south, v(x-1,y) west, v(x,y) east. Panels on a boundary between two blocks
   * are shared; a shared wall FOLLOWS its current owner — the block that last activated
   * over it. While that owner is activated the wall is down + lit; when the owner
   * deactivates the wall rises + dims WITH it, until an activating block meets and STEALS
   * it (down + lit again, now owned by the stealer). An activating block therefore always
   * wins a contested wall: we emit ALL deactivations before ALL activations so an
   * activation fires LAST at any equal-timestamp handoff and wins (last-writer).
   *
   * Range is [top .. mid-room]: an activated block drops only to half the room's height, not
   * the floor (override via downPos). The optional `rim` is the exception — it travels the
   * FULL range (floor ↔ top) with block 1 (see below).
   *
   * Only START times are scheduled; travel is always at the global speed. The range
   * travel time (used to place the schedule) is measured from the current speed.
   *
   * @param params.groups  [{ block, cells:[{x,y}] }]  from loadLoops()
   * @param params.downPos  activated height (default = mid-room height)
   * @param params.upPos    deactivated height (default 255, all the way up)
   * @param params.deactivationDelay  ms; activation end -> deactivation begin (default 0)
   * @param params.activationDelay    ms; activation end -> next activation begin (default 0)
   * @param params.cycles   times to run through all blocks (default 4)
   * @param params.rim      truthy → the E wall + SE diagonal rim moves with block 1, but travels
   *                        the FULL range (all the way down to the floor and back up)
   */
  'blocks-descending'(engine, params) {
    const groups = params.groups || [];
    // Blocks descend to the mid-room height (inverse of Grid.heightFor) and rise back to the top.
    const room = engine.config.room;
    const m = engine.config.motion;
    const posForHeight = (yWorld) => {
      const f = (yWorld - m.travelMin) / (m.travelMax - m.travelMin);
      return Math.max(0, Math.min(255, Math.round(f * 255)));
    };
    const downPos = params.downPos ?? posForHeight(room.height / 2);
    const upPos = params.upPos ?? 255;
    const deactDelay = params.deactivationDelay ?? 0;
    const nextDelay = params.activationDelay ?? 0;
    const cycles = params.cycles ?? 4;

    const edgesOf = ({ x, y }) => cellEdgeList(x, y);

    // Resolve each block's unique, existing edge panels once.
    const blockPanels = groups.map((g) => {
      const seen = new Set();
      const panels = [];
      for (const c of g.cells) {
        for (const e of edgesOf(c)) {
          const key = `${e.x},${e.y},${e.orient}`;
          if (seen.has(key) || !engine.get(e.x, e.y, e.orient)) continue;
          seen.add(key);
          panels.push(e);
        }
      }
      return panels;
    });

    // Optional rim (E wall + SE diagonal) that MOVES WITH block 1 but travels the FULL range —
    // all the way DOWN to the floor and all the way UP — while the blocks keep their own range.
    // The rim owns its panels: remove them from every block so nothing double-drives them; it's
    // swept separately in the schedule below, at block 1's activate/deactivate times.
    const rimIdx = params.rim ? Math.max(0, groups.findIndex((g) => g.block === '1')) : -1;
    let rimPanels = [];
    if (params.rim && blockPanels.length) {
      rimPanels = seRimPanels(engine.list()).filter((e) => engine.get(e.x, e.y, e.orient));
      const rimKeys = new Set(rimPanels.map((e) => `${e.x},${e.y},${e.orient}`));
      for (let i = 0; i < blockPanels.length; i++) {
        blockPanels[i] = blockPanels[i].filter((e) => !rimKeys.has(`${e.x},${e.y},${e.orient}`));
      }
    }

    // Full-range travel time at the global speed — used only to place the schedule.
    const rate = engine.speed * (1 - engine.ease);
    const fullTravelMs = rate > 0 ? (Math.abs(upPos - downPos) / rate) * 1000 : 0;

    // Light levels (envelopes retired): an activated slab is lit, a deactivated one goes dark.
    const LIT = 1;   // activated / stolen: on
    const DARK = 0;  // deactivated: off (rides the rise up)

    const n = groups.length;
    if (n === 0) return [];

    // ---- Shared walls: the "teepee" handoff -----------------------------------
    // A wall on the boundary between two blocks belongs to two blocks. When block A
    // deactivates (rises + dims) at the same moment block B activates (descends + lit),
    // that shared wall must NOT snap straight down with B. It "dims and goes UP" with A
    // until "met by the activating block at the same height" — because both blocks travel
    // at the same global rate from opposite ends starting together, they cross at the mid
    // height exactly halfway through the range travel. At that meeting B STEALS the wall
    // (re-lit) and carries it back down, arriving with the rest of B's slab. The wall thus
    // traces an inverted-V: DOWN -> MID over the first half, MID -> DOWN over the second.
    //
    // We schedule this explicitly rather than leaning on tie-breaking:
    //   - A's deactivation sweeps ALL A's panels UP (contested ones start rising too).
    //   - B's activation sweeps B's panels DOWN, EXCLUDING the wall it shares with A.
    //   - A separate "steal" fires half a range-travel later, sweeping just the shared
    //     wall DOWN (from the mid height it has reached) so it lands with B's slab.
    // No shared wall is ever commanded by two sweeps at the same instant, so ordering of
    // the returned actions is irrelevant.
    const key = (p) => `${p.x},${p.y},${p.orient}`;
    const blockKeys = blockPanels.map((ps) => new Set(ps.map(key)));
    // Panels block `a` shares with block `b` (empty for a===b or a missing neighbour).
    const sharedBetween = (a, b) => {
      if (a == null || b == null || a === b) return [];
      return blockPanels[a].filter((p) => blockKeys[b].has(key(p)));
    };

    // Activation start time of each step (delays measured from activation END).
    const N = n * cycles;
    const actStart = [];
    let t = 0;
    for (let s = 0; s < N; s++) { actStart[s] = t; t = actStart[s] + fullTravelMs + nextDelay; }
    const deactStart = (s) => actStart[s] + fullTravelMs + deactDelay;
    // The rising wall and the descending stealer start together and move at the same rate,
    // so they meet at the mid height exactly half a range-travel after the deactivation begins.
    const stealAfter = fullTravelMs / 2;

    const sweep = (panels, target, bright) => () =>
      engine.sweepTo(panels.map((p) => ({ ...p, target })), { brightness: bright });

    const actions = [];
    for (let s = 0; s < N; s++) {
      const cur = s % n;
      const panels = blockPanels[cur];
      const prev = s > 0 ? (s - 1) % n : null;         // block deactivating as `cur` activates
      const next = s + 1 < N ? (s + 1) % n : null;     // block activating as `cur` deactivates

      // Walls `cur` shares with the block it takes over FROM: those are mid-air being handed
      // to us; we don't grab them in the activation sweep — the earlier owner's steal does.
      const inherited = new Set(sharedBetween(cur, prev).map(key));
      const activateSet = panels.filter((p) => !inherited.has(key(p)));

      // Activate: sweep our (non-inherited) panels down to the mid-room height, lit.
      actions.push({ t: actStart[s], run: sweep(activateSet, downPos, LIT) });

      // Deactivate: sweep ALL our panels up, going dark as they rise. Any wall we share with
      // the NEXT block will be overridden mid-rise by that block's steal (below).
      actions.push({ t: deactStart(s), run: sweep(panels, upPos, DARK) });

      // Steal: half a range-travel into our deactivation, the next block meets our shared
      // wall at the mid height and pulls it back down (re-lit), landing with its slab.
      const handoff = sharedBetween(cur, next);
      if (handoff.length) {
        actions.push({ t: deactStart(s) + stealAfter, run: sweep(handoff, downPos, LIT) });
      }

      // The rim moves WITH block 1 but travels the FULL range (floor ↔ top), independent of
      // the blocks' mid-room range. Sweep it down/up on block 1's own activate/deactivate.
      if (cur === rimIdx && rimPanels.length) {
        actions.push({ t: actStart[s], run: sweep(rimPanels, 0, LIT) });      // all the way down, lit
        actions.push({ t: deactStart(s), run: sweep(rimPanels, 255, DARK) }); // all the way up, dark
      }
    }
    return actions;
  },

  /**
   * lullaby-drop: the field rests on the floor; one cell in the center bounces like
   * a descending block (lit on the way down, dark on the way up). Each time it
   * hits the floor it sends a radial ripple — a 10 % lift wave — outward from the
   * impact point. Brightness peaks at the top of each panel's lift.
   *
   * @param params.floorPos       resting position for the whole field (default 0)
   * @param params.dropHeight     peak height the center cell reaches (default 200)
   * @param params.cycles         number of bounces (default 6)
   * @param params.rippleInterval ms delay per unit of cell-distance for the ripple wave (default 200)
   * @param params.centerX/Y      override auto-computed center cell (optional)
   * @param params.maxRipplePanels cap on rippled panels (0/absent = auto from the wire budget)
   * @param params.rippleWindowMs  budget window for the ripple (0/absent = the bounce-cycle time)
   */
  'lullaby-drop'(engine, params) {
    const cells = cellsOf(engine);
    const floorPos       = params.floorPos       ?? 0;
    const dropLo         = params.dropLo         ?? 0;    // center's impact height (bottom of bounce)
    const dropHeight     = params.dropHeight      ?? 200;  // center's peak height (top of bounce)
    const rippleInterval = params.rippleInterval  ?? 200; // ms per cell-unit of distance

    // Centroid → nearest integer cell = impact point.
    const cx = cells.reduce((s, c) => s + c.x, 0) / cells.length;
    const cy = cells.reduce((s, c) => s + c.y, 0) / cells.length;
    const centerX = params.centerX ?? Math.round(cx);
    const centerY = params.centerY ?? Math.round(cy);

    const allPanels = engine.list();
    const centerKeys = new Set(cellEdgeList(centerX, centerY).map(edgeKey));
    const centerPanels = allPanels.filter((p) => centerKeys.has(`${p.x},${p.y},${p.orient}`));
    const otherPanels  = allPanels.filter((p) => !centerKeys.has(`${p.x},${p.y},${p.orient}`));

    const rate = engine.speed * (1 - engine.ease);
    // Ripple mode:
    //   none — panels lift+flash then note-off; they NEVER travel back (no reversal). We also skip
    //          the per-cycle settle so the field holds where ripples leave it.
    //   all  — every in-scope panel (auto/specified count) also RETURNS (no-light move back to the
    //          floor); the returns are split half/half across two phases of the centre's bounce.
    //   some — like all, but the two return batches are sized to FIT their phase windows, so they
    //          finish without backlog (batch on the fall done by impact). Default.
    const rippleMode = params.rippleMode || 'some';
    const doReturn = rippleMode !== 'none';
    // "At the floor" is a BELIEF question — the sim render can still be gliding down (it starts at
    // the rest position, not the floor), so check tracked z, not the sim position. If the field
    // already believes it's on the floor, skip the settle and drop right away (settleMs = 0, no
    // settle action). Fall back to the sim position for a non-state engine (tests).
    const floorZ = posToZ(floorPos);
    const belief = engine.state?.list?.();
    const maxOffFloor = Math.max(0, ...allPanels.map((p) => Math.abs(p.position - floorPos)));
    const alreadyAtFloor = belief
      ? belief.every((bp) => bp.dead || bp.z === floorZ)
      : maxOffFloor < 1;
    const wantSettle = doReturn && !alreadyAtFloor && rate > 0;
    const settleMs = wantSettle ? (maxOffFloor / rate) * 1000 : 0;
    // Center travels floor→peak (risingMs) then peak→dropLo (fallingMs).
    const risingMs  = rate > 0 ? ((dropHeight - floorPos) / rate) * 1000 : 0;
    const fallingMs = rate > 0 ? ((dropHeight - dropLo)   / rate) * 1000 : 0;
    // Ripple lift = one level up (a genuine 1-step move), lit.
    const rippleTop = zToPos(posToZ(floorPos) + 1);
    // Glow lifetime: the lit panel goes dark after this — BEFORE it returns (or as the whole pass,
    // if it doesn't) — so each pass reads as a brief ripple flash, not a panel lit for the entire
    // slow travel. Default = 2× the per-cell propagation time.
    const glowMs = params.rippleGlowMs > 0 ? params.rippleGlowMs : rippleInterval * 2;

    const actions = [];

    // Phase 0 — settle everything to the floor, lights off. Skipped when the field is already on
    // the floor (settleMs = 0), so the bounce/drop starts right away.
    if (wantSettle) actions.push({ t: 0, run: () => engine.sweepAll(floorPos, { brightness: 0 }) });

    // Centre bounce timeline (loop drives continuous repeat):
    //   t0 .. tFall   rise to the peak (dark) — the windup
    //   tFall         START OF FALL (centre descends, lit) — the FALL return batch fires here
    //   tImpact       centre hits dropLo, light off, then BOUNCES back up (dark) — BOUNCE batch fires
    const ccx = centerX + 0.5, ccy = centerY + 0.5;
    const tFall   = settleMs + risingMs;
    const tImpact = tFall + fallingMs;
    const cpTo = (target, brightness) => () =>
      engine.sweepTo(centerPanels.map((p) => ({ ...p, target })), { brightness });

    actions.push({ t: settleMs, run: cpTo(dropHeight, 0) });                                   // rise (dark)
    actions.push({ t: tFall,    run: cpTo(dropLo, 1) });                                        // fall (lit)
    actions.push({ t: tImpact,  run: () => centerPanels.forEach((p) => engine.off(p.x, p.y, p.orient)) }); // impact: light off
    actions.push({ t: tImpact,  run: cpTo(dropHeight, 0) });                                    // bounce back up (dark)

    // How many in-scope panels take part, and how the RETURNS split across the two phases. A return
    // (no-light move back to the floor) costs ~16 steps; at ~rateHz/2 steps/s only so many fit each
    // phase window. In 'some' each batch is sized to fit its window (fall batch done by impact); in
    // 'all' the auto/specified count is split half/half. `maxRipplePanels` caps/sets the count.
    const stepsPerSec = Math.max(1, (engine.midi?.rateHz ?? 100) / 2);
    const RETURN_COST = 16;
    const fitFall = Math.max(0, Math.floor(stepsPerSec * (fallingMs / 1000) / RETURN_COST));
    const fitRise = Math.max(0, Math.floor(stepsPerSec * (risingMs  / 1000) / RETURN_COST));
    const autoAll = params.maxRipplePanels > 0
      ? params.maxRipplePanels
      : Math.floor(stepsPerSec * Math.max(0.001, (params.rippleWindowMs || (risingMs + fallingMs)) / 1000) / RETURN_COST);
    let nFall, nBounce;                              // fall batch (at tFall), bounce batch (at tImpact)
    if (rippleMode === 'some') { nFall = fitFall; nBounce = fitRise; }
    else { const t = Math.max(1, autoAll); nFall = Math.floor(t / 2); nBounce = t - nFall; } // 'all'
    const total = doReturn
      ? Math.max(1, Math.min(nFall + nBounce, otherPanels.length))
      : Math.max(1, Math.min(autoAll, otherPanels.length));            // 'none': count is just the lifts

    // Participants: a UNIFORM SCATTER across the field (farthest-point sampling, seeded at the impact)
    // — sparse ripples spread by angle and distance, not a dense wave; the rest sit it out.
    const pts = otherPanels.map((p) => {
      const { px, py } = panelCenter(p.x, p.y, p.orient);
      return { p, px, py, dist: Math.hypot(px - ccx, py - ccy) };
    });
    const ranked = [];
    if (pts.length) {
      const pool = pts.slice();
      let seed = 0;
      for (let i = 1; i < pool.length; i++) if (pool[i].dist < pool[seed].dist) seed = i; // nearest impact
      ranked.push(pool.splice(seed, 1)[0]);
      while (ranked.length < total && pool.length) {
        let bestI = 0, bestD = -Infinity;
        for (let i = 0; i < pool.length; i++) {
          let dMin = Infinity;
          for (const c of ranked) {
            const d = Math.hypot(pool[i].px - c.px, pool[i].py - c.py);
            if (d < dMin) dMin = d;
          }
          if (dMin > bestD) { bestD = dMin; bestI = i; }
        }
        ranked.push(pool.splice(bestI, 1)[0]);
      }
    }

    // Lifts: the field stays at the floor until the drop lands — then, FROM THE IMPACT, every
    // participant lifts +1 (lit) as an outward ripple and goes dark after the glow (a brief flash).
    // (In 'none' this is the whole pass; the panels stay lifted.) Nothing ripples during the windup.
    const rippleStartCap = params.rippleStartCap ?? 300;
    const firstDist = ranked.length ? Math.min(...ranked.map((r) => r.dist)) : 0;
    const rippleShift = Math.min(0, rippleStartCap - firstDist * rippleInterval);
    for (const { p, dist } of ranked) {
      const wt = tImpact + dist * rippleInterval + rippleShift;
      actions.push({ t: wt,          run: () => engine.move(p.x, p.y, p.orient, rippleTop, 1) });
      actions.push({ t: wt + glowMs, run: () => engine.off(p.x, p.y, p.orient) });
    }

    // Returns (all/some): a no-light move back to the floor, staged AFTER the impact in two batches
    // over the centre's rebound — the bounce batch as the centre springs back up (window ≈ risingMs),
    // the fall batch as it drops again (window ≈ fallingMs). Different panels than the centre, so
    // these fire without waiting on it; each panel's own return queues behind its lift (per-panel gate).
    if (doReturn) {
      const back = (p) => () => engine.move(p.x, p.y, p.orient, floorPos, 0);
      const cut = Math.min(nBounce, ranked.length);
      for (const { p } of ranked.slice(0, cut)) actions.push({ t: tImpact,             run: back(p) }); // bounce batch
      for (const { p } of ranked.slice(cut))    actions.push({ t: tImpact + risingMs,  run: back(p) }); // fall batch
    }

    return actions;
  },

  /**
   * particles: N particles travel an Archimedean spiral through a static elastic structure,
   * briefly rippling each panel (lift + glow) as they pass.
   *
   * Structure = elastic catenary: panels held at topPos + (structureHeight - topPos) * falloff * elasticity.
   * Trajectory = Archimedean spiral mapped to nearest panels by sampling the curve.
   * N particles are staggered evenly across one full cycle so they chase each other.
   * With oppose=1, odd-numbered particles traverse the spiral in reverse from the same
   * start time as their pair — particles travel toward each other from opposite ends.
   *
   * @param params.n               number of particles (default 2)
   * @param params.spiralIn        0 = spiral out from center, 1 = spiral in from periphery (default 0)
   * @param params.numTurns        spiral turns from center to edge (default 2)
   * @param params.structureHeight center height for elastic structure (default 128)
   * @param params.elasticity      elastic falloff strength 0–1 (default 0.9)
   * @param params.topPos          resting height for periphery panels (default 255)
   * @param params.speed           ms per step along the trajectory (default 300)
   * @param params.rippleSize      lift fraction: how far each panel rises above structure (default 0.08)
   * @param params.holdMs          how long each traced panel stays lit + lifted, ms (default 800).
   *                               Independent of `speed`, so trails overlap (~holdMs/speed panels).
   * @param params.oppose          1 = odd particles travel reverse spiral in sync with even pair (default 0)
   */
  particles(engine, params) {
    if (params.staticOnly) {
      const { settleAction } = particlesPlan(engine, params);
      return [settleAction];
    }
    const { settleAction, settleMs, buildBurst } = particlesPlan(engine, params);
    return [settleAction, ...buildBurst(settleMs)];
  },

  /**
   * geo: outlines parts of a 3D box using lit panels at heights that match a
   * perspective view of the box (back/north = high, front/south = low).
   * Non-participating panels rest at restPos (up, unlit) — the field is full and dark,
   * the box edges emerge as glowing panels at their geometrically appropriate heights.
   *
   * Shapes:
   *   corners  — four corner pillar clusters, each at its perspective height
   *   faces    — N wall (high) + S stepped wall (low): two opposing box faces
   *   corner   — N wall (high) + W wall (mid): one box corner, two planes meeting
   *   diagonal — NW-half panels lit and swept from high (NW) down to low (diagonal edge)
   *
   * @param params.shape    'corners' | 'faces' | 'corner' | 'diagonal'
   * @param params.restPos  height for non-participating panels (default 255, all-up)
   * @param params.exclude  panel keys ("x,y,orient") to force non-participating (off) — a
   *                        layout-specific escape hatch for panels that shouldn't join a shape
   */
  geo(engine, params) {
    const restPos = params.restPos ?? 255;
    const shape   = params.shape ?? 'corners';
    const exclude = new Set(params.exclude ?? []);

    const panels   = engine.list();
    const cells    = cellsOf(engine);
    const occupied = new Set(cells.map((c) => `${c.x},${c.y}`));

    const xs    = cells.map((c) => c.x), ys = cells.map((c) => c.y);
    const minX  = Math.min(...xs), maxX = Math.max(...xs);
    const minY  = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = maxX - minX + 1, spanY = maxY - minY + 1;

    const panelXY = (p) => panelCenter(p.x, p.y, p.orient);

    // Exterior walls, in the h=south / v=east convention: h(x,y) is the north wall of cell
    // (x,y+1) and the south wall of (x,y); v(x,y) is the west wall of (x+1,y) and the east
    // wall of (x,y). A wall is on the field's exterior when the cell on one side is missing.
    const isNorth = (p) => p.orient === 'h' &&  occupied.has(`${p.x},${p.y + 1}`) && !occupied.has(`${p.x},${p.y}`);
    const isSouth = (p) => p.orient === 'h' &&  occupied.has(`${p.x},${p.y}`)     && !occupied.has(`${p.x},${p.y + 1}`);
    const isWest  = (p) => p.orient === 'v' &&  occupied.has(`${p.x + 1},${p.y}`) && !occupied.has(`${p.x},${p.y}`);
    const isEast  = (p) => p.orient === 'v' &&  occupied.has(`${p.x},${p.y}`)     && !occupied.has(`${p.x + 1},${p.y}`);

    // The last row that spans the full x width — use its south boundary as the
    // "full-width south wall", ignoring the stairstepped arm/wedge below it. h(x,R) IS the
    // south edge of row R.
    const maxFullWidthRow    = Math.max(...cells.filter((c) => c.x === maxX).map((c) => c.y));
    const isFullWidthSouth   = (p) => p.orient === 'h' && p.y === maxFullWidthRow;

    // Four structural corners: north pair equal-high, south pair equal-low.
    const armMaxX = Math.max(...cells.filter((c) => c.y === maxY).map((c) => c.x), minX);
    const gCorners = [
      { pt: [minX,         minY    ], pos: 210 },  // NW — north, high
      { pt: [maxX + 1,     minY    ], pos: 210 },  // NE — north, high
      { pt: [minX,         maxY + 1], pos: 40  },  // SW — south, low
      { pt: [armMaxX + 1,  maxY + 1], pos: 40  },  // SE arm — south, low
    ];
    const colRadius = Math.min(spanX, spanY) * 0.35;

    const nearestCornerIdx = (p) => {
      const { px, py } = panelXY(p);
      let best = 0, bestD = Infinity;
      for (let i = 0; i < gCorners.length; i++) {
        const d = Math.hypot(px - gCorners[i].pt[0], py - gCorners[i].pt[1]);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    };
    const minCornerDist = (p) => {
      const { px, py } = panelXY(p);
      return Math.min(...gCorners.map(({ pt: [gcx, gcy] }) => Math.hypot(px - gcx, py - gcy)));
    };

    // Diagonal-shape silhouette helpers (computed once): the easternmost vertical wall in each
    // row (the E edge), and a north→south height ramp where "down" is the floor.
    const maxVxByRow = new Map();
    for (const q of panels) {
      if (q.orient !== 'v') continue;
      maxVxByRow.set(q.y, Math.max(maxVxByRow.get(q.y) ?? -Infinity, q.x));
    }
    const diagDown = (y, y0, y1) => {
      const t = y1 > y0 ? Math.max(0, Math.min(1, (y - y0) / (y1 - y0))) : 0;
      return Math.round(255 * (1 - t)); // 255 (up) at the north end → 0 (floor) at the south end
    };

    // Returns { pos } for participating panels, null for non-participating.
    const assign = (p) => {
      if (exclude.has(`${p.x},${p.y},${p.orient}`)) return null; // forced off (layout-specific)
      switch (shape) {
        case 'corners': {
          if (minCornerDist(p) >= colRadius) return null;
          return { pos: gCorners[nearestCornerIdx(p)].pos };
        }
        case 'faces':
          if (isNorth(p))          return { pos: 220 };
          if (isFullWidthSouth(p)) return { pos: 30  };
          return null;
        case 'corner':
          if (isNorth(p)) return { pos: 220 };
          if (isWest(p))  return { pos: 160 };
          return null;
        case 'diagonal': {
          // Flowie "Diagonal": the N wall stays up; the W and E walls drape diagonally down
          // north→south; the OUTER STEPPED EDGE of the SE side sits on the floor (just the
          // staircase boundary, not the whole triangle). All these lit, everything else off.
          if (p.orient === 'h' && p.y === minY) return { pos: 255 };                        // N wall — up
          if (p.orient === 'v' && p.x === minX) return { pos: diagDown(p.y, minY, maxY) };  // W wall — diag down (full height)
          if (p.orient === 'v' && p.x === maxVxByRow.get(p.y) && p.y <= maxFullWidthRow)
            return { pos: diagDown(p.y, minY, maxFullWidthRow) };                            // E wall — diag down (north block)
          // SE stepped edge: south-facing h walls + the staircase's east-facing v walls → down.
          if (isSouth(p) || (isEast(p) && p.y > maxFullWidthRow)) return { pos: 0 };
          return null;                                                                       // interior / everything else — off
        }
        default: return null;
      }
    };

    // Participating panels cascade in; non-participating snap to rest immediately.
    const SWEEP_MS = 800;
    const delayOf  = (p) => {
      const { px, py } = panelXY(p);
      switch (shape) {
        case 'corners': {
          const cwOrder = [0, 1, 3, 2]; // NW → NE → SE-arm → SW
          const ci = cwOrder.indexOf(nearestCornerIdx(p));
          return (ci < 0 ? 0 : ci) * (SWEEP_MS / 4);
        }
        case 'faces':   return isNorth(p) ? 0 : SWEEP_MS * 0.4;
        case 'corner':  return isNorth(p) ? 0 : SWEEP_MS * 0.45;
        case 'diagonal': {
          const t = (px - minX) / spanX + (py - minY) / spanY;
          return Math.min(t, 1.0) * SWEEP_MS;
        }
        default: return 0;
      }
    };

    const actions = [];
    for (const p of panels) {
      const result = assign(p);
      const pos    = result ? result.pos : restPos;
      const bright = result ? 0.9 : 0;          // participating box edges lit; the rest dark
      const t      = result ? Math.round(delayOf(p)) : 0;
      // One combined move: edge panels sweep into the box outline lit, the field stays dark.
      actions.push({ t, run: () => engine.move(p.x, p.y, p.orient, pos, bright) });
    }
    return actions;
  },

  /**
   * Generates a random navigatable maze using a randomized DFS (recursive backtracker).
   * Cells are discovered from the live panel set: cell (cx, cy) exists when all 4 of its
   * edge panels exist — h(cx,cy), h(cx,cy+1), v(cx,cy), v(cx+1,cy).
   *
   * Wall panels → topB (low, lit).  Passage panels → topA (high, lit).
   * The panel map shows "down" panels = the maze walls. New maze each retrigger.
   */
  maze(engine, params) {
    const topA     = params.topA     ?? 255;
    const topB     = params.topB     ?? 64;
    const duration = params.duration ?? 12000;

    const rate   = engine.speed * (1 - engine.ease);
    const panels = engine.list();

    // ---- Discover cell grid -------------------------------------------------
    // Cell (cx, cy): north=h(cx,cy), south=h(cx,cy+1), west=v(cx,cy), east=v(cx+1,cy).
    const allKeys = new Set(panels.map((p) => `${p.x},${p.y},${p.orient}`));
    const has = (x, y, o) => allKeys.has(`${x},${y},${o}`);

    const cells = [];
    const cellMap = new Map();
    for (const p of panels) {
      if (p.orient !== 'h') continue;
      // p = h(p.x,p.y) is the SOUTH wall of candidate cell (p.x,p.y); the cell exists when
      // all four of its edge walls (see model/layout.js) are present.
      const cx = p.x, cy = p.y;
      if (cellEdgeList(cx, cy).every((e) => has(e.x, e.y, e.orient))) {
        const k = `${cx},${cy}`;
        if (!cellMap.has(k)) { cells.push({ cx, cy }); cellMap.set(k, { cx, cy }); }
      }
    }
    if (cells.length === 0) return [];

    // ---- Randomized DFS maze ------------------------------------------------
    // Passages stored as the panel key of the removed wall between two cells (h=south /
    // v=east convention, see model/layout.js). The wall to a neighbour is that cell's edge:
    //   south → h(cx,cy)      north → h(cx,cy-1)
    //   east  → v(cx,cy)      west  → v(cx-1,cy)
    const passages = new Set();
    const visited  = new Set();

    const start = cells[Math.floor(Math.random() * cells.length)];
    const stack = [start];
    visited.add(`${start.cx},${start.cy}`);

    const DIRS = [
      { dx: 0, dy:  1, wall: (cx, cy) => edgeKey(cellEdges(cx, cy).south) },
      { dx: 0, dy: -1, wall: (cx, cy) => edgeKey(cellEdges(cx, cy).north) },
      { dx:  1, dy: 0, wall: (cx, cy) => edgeKey(cellEdges(cx, cy).east)  },
      { dx: -1, dy: 0, wall: (cx, cy) => edgeKey(cellEdges(cx, cy).west)  },
    ];

    while (stack.length > 0) {
      const { cx, cy } = stack[stack.length - 1];
      // Shuffle directions each step for variety.
      const shuffled = DIRS.slice().sort(() => Math.random() - 0.5);
      let moved = false;
      for (const { dx, dy, wall } of shuffled) {
        const nk = `${cx + dx},${cy + dy}`;
        if (cellMap.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          passages.add(wall(cx, cy));
          stack.push({ cx: cx + dx, cy: cy + dy });
          moved = true;
          break;
        }
      }
      if (!moved) stack.pop();
    }

    // ---- Add a single exit on the left, top, or right border (not at corners) ----
    // Collect the unique sorted cx/cy values of cells to identify the border row/column.
    const cxVals = [...new Set(cells.map((c) => c.cx))].sort((a, b) => a - b);
    const cyVals = [...new Set(cells.map((c) => c.cy))].sort((a, b) => a - b);
    const minCX = cxVals[0], maxCX = cxVals[cxVals.length - 1];
    const minCY = cyVals[0];

    // Candidates: border panels that exist and whose adjacent interior cell is not a corner cell
    // (i.e. skip the first and last entry in the border so the exit isn't flush with two walls).
    // Border walls are each cell's exterior edge (h=south / v=east convention):
    //   top row's NORTH edge = h(cx,minCY-1); left col's WEST edge = v(minCX-1,cy);
    //   right col's EAST edge = v(maxCX,cy).
    const exits = [];
    for (const cx of cxVals.slice(1, -1)) {  // top border — skip leftmost/rightmost columns
      const k = edgeKey(cellEdges(cx, minCY).north);
      if (allKeys.has(k)) exits.push(k);
    }
    for (const cy of cyVals.slice(1, -1)) {  // left border — skip top/bottom rows
      const k = edgeKey(cellEdges(minCX, cy).west);
      if (allKeys.has(k)) exits.push(k);
    }
    for (const cy of cyVals.slice(1, -1)) {  // right border — skip top/bottom rows
      const k = edgeKey(cellEdges(maxCX, cy).east);
      if (allKeys.has(k)) exits.push(k);
    }
    if (exits.length > 0) passages.add(exits[Math.floor(Math.random() * exits.length)]);

    // ---- Build timed actions (same timing model as chase) -------------------
    const plan = panels.map((p) => {
      const passage = passages.has(`${p.x},${p.y},${p.orient}`);
      const target  = passage ? topA : topB;
      return {
        p, target, passage,
        rank:   Math.random(),
        travel: rate > 0 ? (Math.abs(target - p.position) / rate) * 1000 : 0,
      };
    });

    const maxTravel   = Math.max(0, ...plan.map((it) => it.travel));
    const startWindow = Math.max(0, duration - maxTravel);

    const actions = [];
    for (const { p, target, passage, rank } of plan) {
      const t0 = rank * startWindow;
      // One combined move per panel: passages sweep up high + lit, walls sweep low + dark.
      actions.push({ t: t0, run: () => engine.move(p.x, p.y, p.orient, target, passage ? 0.9 : 0) });
    }
    return actions;
  },

  /** Random-ish movements and blinks: panels dart to random heights while sparks fire. */
  scatter(engine, params) {
    const duration = (params.duration ?? 8000) * timeScale(engine);
    const moves = params.moves ?? 60;
    const blinks = params.blinks ?? 40;
    const minPos = params.minPos ?? 0;
    const maxPos = params.maxPos ?? 255;
    const all = engine.list();
    const actions = [];

    const pick = () => all[Math.floor(Math.random() * all.length)];
    const height = () => minPos + Math.round(Math.random() * (maxPos - minPos));

    // Moves: each panel darts to a random height (light unchanged). All motion uses the
    // global cruise speed; times are spread across the duration with a little jitter so
    // panels don't move in lockstep.
    for (let i = 0; i < moves; i++) {
      const p = pick();
      const target = height();
      const t = (i / moves) * duration + Math.random() * (duration / moves);
      actions.push({ t, run: () => engine.move(p.x, p.y, p.orient, target) });
    }

    // Blinks: random sparks (light in place at the panel's current height, auto-off).
    const blinkMs = params.blinkMs ?? 200;
    for (let i = 0; i < blinks; i++) {
      const p = pick();
      const t = Math.random() * duration;
      actions.push({ t, run: () => engine.move(p.x, p.y, p.orient, p.position, 1, blinkMs) });
    }

    return actions;
  },
};
