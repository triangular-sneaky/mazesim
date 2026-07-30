/**
 * Demo player: turns a demo definition into a timed list of actions, then schedules
 * them against the engine's action API. Generators build the action list from the
 * live panel set so demos adapt to any layout.
 *
 * An action = { t: ms, run: () => void }.
 */
export class DemoPlayer {
  constructor(engine) {
    this.engine = engine;
    this._timers = [];
    this._running = null;
  }

  stop() {
    for (const id of this._timers) clearTimeout(id);
    this._timers = [];
    this._running = null;
  }

  isRunning() { return this._running; }

  play(demo) {
    this.stop();
    const gen = GENERATORS[demo.generator];
    if (!gen) {
      console.warn(`Unknown demo generator: ${demo.generator}`);
      return;
    }
    const actions = gen(this.engine, demo.params || {});
    this._running = demo.id;
    for (const a of actions) {
      this._timers.push(setTimeout(a.run, a.t));
    }
  }
}

// ---- Generators --------------------------------------------------------------

const cellsOf = (engine) => {
  const set = new Map();
  for (const p of engine.list()) set.set(`${p.x},${p.y}`, { x: p.x, y: p.y });
  return [...set.values()];
};

const GENERATORS = {
  /** Move every panel to a single position at once. */
  allTo(engine, params) {
    const position = params.position ?? 128;
    const opts = params.velocity ? { velocity: params.velocity } : {};
    return [{ t: 0, run: () => engine.moveAll(position, opts) }];
  },

  /** Rows (axis:y) or columns (axis:x) rise to `up` in sequence, then settle to `down`. */
  wave(engine, params) {
    const axis = params.axis === 'x' ? 'x' : 'y';
    const interval = params.interval ?? 200;
    const up = params.up ?? 255;
    const down = params.down ?? 110;
    const opts = params.velocity ? { velocity: params.velocity } : {};

    const glow = { attack: 0.15, sustain: (interval * 2) / 1000, decay: 0.6 };
    const lanes = [...new Set(engine.list().map((p) => p[axis]))].sort((a, b) => a - b);
    const actions = [];
    const rise = (panels, upPos) => panels.forEach((p) => {
      engine.movePanel(p.x, p.y, p.orient, upPos, opts);
      engine.blinkPanel(p.x, p.y, p.orient, glow);
    });
    const fall = (panels, downPos) => panels.forEach((p) => engine.movePanel(p.x, p.y, p.orient, downPos, opts));
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
    const interval = params.interval ?? 110;
    const up = params.up ?? 255;
    const down = params.down ?? 120;
    const opts = params.velocity ? { velocity: params.velocity } : {};

    const cells = cellsOf(engine);
    const cx = cells.reduce((s, c) => s + c.x, 0) / cells.length;
    const cy = cells.reduce((s, c) => s + c.y, 0) / cells.length;
    const dist = (p) => Math.round(Math.hypot(p.x - cx, p.y - cy));
    const rings = [...new Set(engine.list().map(dist))].sort((a, b) => a - b);

    const glow = { attack: 0.15, sustain: (interval * 3) / 1000, decay: 0.6 };
    const actions = [];
    const rise = (panels, upPos) => panels.forEach((p) => {
      engine.movePanel(p.x, p.y, p.orient, upPos, opts);
      engine.blinkPanel(p.x, p.y, p.orient, glow);
    });
    const fall = (panels, downPos) => panels.forEach((p) => engine.movePanel(p.x, p.y, p.orient, downPos, opts));
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

  /** Random LED blinks scattered over time. */
  sparkle(engine, params) {
    const count = params.count ?? 80;
    const interval = params.interval ?? 110;
    const all = engine.list();
    const actions = [];
    for (let i = 0; i < count; i++) {
      const p = all[Math.floor(Math.random() * all.length)];
      // jitter each blink a little so they don't lockstep
      const t = i * interval + Math.random() * interval;
      actions.push({ t, run: () => engine.blinkPanel(p.x, p.y, p.orient) });
    }
    return actions;
  },

  /** Random-ish movements and blinks: panels dart to random heights while sparks fire. */
  scatter(engine, params) {
    const duration = params.duration ?? 8000;
    const moves = params.moves ?? 60;
    const blinks = params.blinks ?? 40;
    const minPos = params.minPos ?? 0;
    const maxPos = params.maxPos ?? 255;
    const all = engine.list();
    const actions = [];

    const pick = () => all[Math.floor(Math.random() * all.length)];
    const height = () => minPos + Math.round(Math.random() * (maxPos - minPos));

    // Moves: each panel darts to a random height with a varied velocity so no two
    // move in lockstep. Times are spread across the duration with a little jitter.
    for (let i = 0; i < moves; i++) {
      const p = pick();
      const target = height();
      // velocity 90..250, curve picked at random for organic feel
      const velocity = 90 + Math.floor(Math.random() * 160);
      const curve = Math.random() < 0.5 ? 'linear' : 'smooth';
      const t = (i / moves) * duration + Math.random() * (duration / moves);
      actions.push({ t, run: () => engine.movePanel(p.x, p.y, p.orient, target, { velocity, curve }) });
    }

    // Blinks: random sparks scattered independently across the same window.
    for (let i = 0; i < blinks; i++) {
      const p = pick();
      const t = Math.random() * duration;
      actions.push({ t, run: () => engine.blinkPanel(p.x, p.y, p.orient) });
    }

    return actions;
  },
};
