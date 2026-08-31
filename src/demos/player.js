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

/**
 * The global speed acts as a TEMPO. Generators author their intervals/durations for the
 * engine's reference speed; multiplying those timings by this factor makes a movement's
 * PERIOD track the speed control while its AMPLITUDE (heights) stays fixed. Faster speed
 * → smaller factor → tighter cascade, matching the faster per-panel travel. Because every
 * downstream time (action offsets, blink sustains, jitter) is derived from the scaled
 * interval/duration, the whole movement compresses coherently.
 */
const timeScale = (engine) => engine.baseSpeed / engine.speed;

export const GENERATORS = {
  /**
   * Move every panel to a single position at once. With `lightsOff: true`, also
   * extinguish every LED — a zero-peak blink replaces any held-on envelope (e.g. the
   * static pattern Chase leaves lit) and holds brightness at 0.
   */
  allTo(engine, params) {
    const position = params.position ?? 128;
    const lightsOff = params.lightsOff ?? false;
    const off = { attack: 0, sustain: 0, decay: 0, peak: 0 };
    return [{
      t: 0,
      run: () => {
        engine.moveAll(position);
        if (lightsOff) engine.list().forEach((p) => engine.blinkPanel(p.x, p.y, p.orient, off));
      },
    }];
  },

  /** Rows (axis:y) or columns (axis:x) rise to `up` in sequence, then settle to `down`. */
  wave(engine, params) {
    const axis = params.axis === 'x' ? 'x' : 'y';
    const interval = (params.interval ?? 200) * timeScale(engine);
    const up = params.up ?? 255;
    const down = params.down ?? 110;

    const glow = { attack: 0.15, sustain: (interval * 2) / 1000, decay: 0.6 };
    const lanes = [...new Set(engine.list().map((p) => p[axis]))].sort((a, b) => a - b);
    const actions = [];
    const rise = (panels, upPos) => panels.forEach((p) => {
      engine.movePanel(p.x, p.y, p.orient, upPos);
      engine.blinkPanel(p.x, p.y, p.orient, glow);
    });
    const fall = (panels, downPos) => panels.forEach((p) => engine.movePanel(p.x, p.y, p.orient, downPos));
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

    const glow = { attack: 0.15, sustain: (interval * 3) / 1000, decay: 0.6 };
    const actions = [];
    const rise = (panels, upPos) => panels.forEach((p) => {
      engine.movePanel(p.x, p.y, p.orient, upPos);
      engine.blinkPanel(p.x, p.y, p.orient, glow);
    });
    const fall = (panels, downPos) => panels.forEach((p) => engine.movePanel(p.x, p.y, p.orient, downPos));
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
   * Static mountain: panels settle into a cone of heights — tallest at the field
   * center, sloping down to the edges — then hold. No animation after arrival.
   */
  mountain(engine, params) {
    const peak = params.peak ?? 255;
    const base = params.base ?? 30;

    const cells = cellsOf(engine);
    const cx = cells.reduce((s, c) => s + c.x, 0) / cells.length;
    const cy = cells.reduce((s, c) => s + c.y, 0) / cells.length;
    // Normalize distance by the farthest cell so the outermost ring sits at `base`.
    const maxD = Math.max(1, ...cells.map((c) => Math.hypot(c.x - cx, c.y - cy)));

    return engine.list().map((p) => {
      const t = Math.hypot(p.x - cx, p.y - cy) / maxD; // 0 center .. 1 edge
      const pos = Math.round(base + (peak - base) * (1 - t));
      return { t: 0, run: () => engine.movePanel(p.x, p.y, p.orient, pos) };
    });
  },

  /** Random LED blinks scattered over time. */
  sparkle(engine, params) {
    const count = params.count ?? 80;
    const interval = (params.interval ?? 110) * timeScale(engine);
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

    const slow = { attack: 0.8, sustain: 0.7, decay: 1.3, peak: 0.6 };  // gentle pulse in transit
    const litHold = { attack: 0.6, sustain: 3600, decay: 0, peak: 0.9 }; // freeze ON
    const darkHold = { attack: 0.4, sustain: 3600, decay: 0, peak: 0 };  // freeze OFF

    const actions = [];
    for (const { p, target, lit, rank, travel } of plan) {
      const start = rank * startWindow;
      const finish = start + travel;

      actions.push({ t: start, run: () => engine.movePanel(p.x, p.y, p.orient, target) });
      actions.push({ t: start, run: () => engine.blinkPanel(p.x, p.y, p.orient, slow) });
      if (travel > 1600) {
        actions.push({ t: start + travel * 0.5, run: () => engine.blinkPanel(p.x, p.y, p.orient, slow) });
      }
      // As this panel lands, settle its light to the static on/off pattern (and end any pulse).
      actions.push({ t: finish, run: () => engine.blinkPanel(p.x, p.y, p.orient, lit ? litHold : darkHold) });
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
   * A cell (x,y) is enclosed by 4 edge panels (edge-union model): h(x,y) north,
   * h(x,y+1) south, v(x,y) west, v(x+1,y) east. Panels on a boundary between two blocks
   * are shared; a shared wall FOLLOWS its current owner — the block that last activated
   * over it. While that owner is activated the wall is down + lit; when the owner
   * deactivates the wall rises + dims WITH it, until an activating block meets and STEALS
   * it (down + lit again, now owned by the stealer). An activating block therefore always
   * wins a contested wall: we emit ALL deactivations before ALL activations so an
   * activation fires LAST at any equal-timestamp handoff and wins (last-writer).
   *
   * Range is limited to [top .. mid-room-height]: an activated block drops only to the
   * world height equal to half the room's height, not to the floor.
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
   */
  'blocks-descending'(engine, params) {
    const groups = params.groups || [];
    // Limit the motion range to [top .. mid-room]: an activated block drops only to the
    // panel position whose world height is half the room height (inverse of Grid.heightFor).
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

    const edgesOf = ({ x, y }) => [
      { x, y, orient: 'h' },
      { x, y: y + 1, orient: 'h' },
      { x, y, orient: 'v' },
      { x: x + 1, y, orient: 'v' },
    ];

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

    // Full-range travel time at the global speed — used only to place the schedule.
    const rate = engine.speed * (1 - engine.ease);
    const fullTravelMs = rate > 0 ? (Math.abs(upPos - downPos) / rate) * 1000 : 0;

    // LED envelopes — configurable from YAML (activateBlink / deactivateBlink).
    const litHold = { attack: 0.3, sustain: 3600, decay: 0,    peak: 1.0, ...(params.activateBlink   ?? {}) };
    const dim      = { attack: 0,   sustain: 0,    decay: 0.05, peak: 1.0, ...(params.deactivateBlink ?? {}) };

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

    const sweep = (panels, target, env) => () => {
      engine.sweepTo(panels.map((p) => ({ ...p, target })));
      panels.forEach((p) => engine.blinkPanel(p.x, p.y, p.orient, env));
    };

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
      actions.push({ t: actStart[s], run: sweep(activateSet, downPos, litHold) });

      // Deactivate: sweep ALL our panels up, dimming as they rise. Any wall we share with
      // the NEXT block will be overridden mid-rise by that block's steal (below).
      actions.push({ t: deactStart(s), run: sweep(panels, upPos, dim) });

      // Steal: half a range-travel into our deactivation, the next block meets our shared
      // wall at the mid height and pulls it back down (re-lit), landing with its slab.
      const handoff = sharedBetween(cur, next);
      if (handoff.length) {
        actions.push({ t: deactStart(s) + stealAfter, run: sweep(handoff, downPos, litHold) });
      }
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

    // Moves: each panel darts to a random height. All motion uses the global
    // cruise speed; times are spread across the duration with a little jitter so
    // panels don't move in lockstep.
    for (let i = 0; i < moves; i++) {
      const p = pick();
      const target = height();
      const t = (i / moves) * duration + Math.random() * (duration / moves);
      actions.push({ t, run: () => engine.movePanel(p.x, p.y, p.orient, target) });
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
