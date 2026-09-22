import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelEngine } from '../src/model/engine.js';
import { GENERATORS } from '../src/demos/player.js';
import { cellEdgeList } from '../src/model/layout.js';

// Minimal config mirroring layout.yaml's motion/room defaults.
const CONFIG = {
  room: { width: 7, depth: 10, height: 4.0 },
  motion: { travelMin: 0.8, travelMax: 3.6, restPosition: 255, velocity: 25, ease: 0.25 },
  blink: { peak: 0.7, attack: 0.08, sustain: 0.15, decay: 0.4 },
};

// Two vertically-adjacent cells => two single-cell blocks that SHARE the wall h(0,0)
// (h=south/v=east convention: south edge of cell (0,0) == north edge of cell (0,1) == h(0,0)).
const CELLS = [{ x: 0, y: 0 }, { x: 0, y: 1 }];
const GROUPS = [
  { block: '1', cells: [{ x: 0, y: 0 }] }, // block A
  { block: '2', cells: [{ x: 0, y: 1 }] }, // block B
];
const SHARED = [0, 0, 'h']; // wall between A and B (A's south == B's north)
const A_OWN = [0, -1, 'h']; // A's north wall (never contested)

function panelDefs(cells) {
  const seen = new Set();
  const defs = [];
  for (const c of cells) {
    for (const e of cellEdgeList(c.x, c.y)) {
      const k = `${e.x},${e.y},${e.orient}`;
      if (seen.has(k)) continue;
      seen.add(k);
      defs.push(e);
    }
  }
  return defs;
}

const buildEngine = () => new PanelEngine(CONFIG, panelDefs(CELLS));

// Motion constants derived exactly as the generator does.
const EASE = CONFIG.motion.ease;
const RATE = CONFIG.motion.velocity * (1 - EASE); // units/sec at cruise
const DOWN = Math.round(((CONFIG.room.height / 2 - CONFIG.motion.travelMin) /
  (CONFIG.motion.travelMax - CONFIG.motion.travelMin)) * 255); // 109
const UP = 255;
// Full-range travel time in ms (one activation or deactivation) — the schedule's beat.
const MID = (UP + DOWN) / 2;
const T = (Math.abs(UP - DOWN) / RATE) * 1000;
const STEAL_AFTER = T / 2; // steal at the geometric midpoint

/**
 * Run the loop generator's actions on a real PanelEngine against a deterministic clock.
 * Fires actions in (time, insertion-index) order — exactly the browser's setTimeout tie
 * rule that DemoPlayer relies on — and ticks the engine at a fixed dt, sampling panels.
 */
function simulate(actions, engine, watch, { dt = 20, end }) {
  const timed = actions.map((a, i) => ({ ...a, i })).sort((p, q) => p.t - q.t || p.i - q.i);
  const trace = [];
  let next = 0;
  for (let clock = 0; clock <= end; clock += dt) {
    while (next < timed.length && timed[next].t <= clock) { timed[next].run(); next++; }
    engine.tick(dt / 1000);
    const sample = {};
    for (const [name, key] of Object.entries(watch)) {
      const p = engine.get(...key);
      sample[name] = { pos: p.position, bri: p.brightness };
    }
    trace.push({ t: clock, sample });
  }
  return trace;
}

// Schedule with cycles:2, delays 0 => blocks A,B,A,B activate at 0,T,2T,3T.
// The discriminating phase is [T .. 2T]: block A deactivates (rises) while block B
// activates (descends). The shared wall h(0,0) must RISE with A then be met/stolen by B.
function run() {
  const engine = buildEngine();
  const actions = GENERATORS['blocks-descending'](engine, {
    groups: GROUPS, cycles: 2, deactivationDelay: 0, activationDelay: 0,
  });
  return simulate(actions, engine, { shared: SHARED, aOwn: A_OWN }, { end: 4 * T + 4000 });
}
const between = (trace, lo, hi) => trace.filter((r) => r.t >= lo && r.t <= hi);
const peakPos = (rows, sel) => Math.max(...rows.map((r) => r.sample[sel].pos));

test('block A actually brings the shared wall down while it is active', () => {
  const trace = run();
  // By end of A's activation (~T) the shared wall should be near the down height.
  const atEnd = trace.find((r) => r.t >= T * 0.95);
  assert.ok(
    atEnd.sample.shared.pos < DOWN + 25,
    `shared wall should be down (~${DOWN}) at end of A's activation, got ${atEnd.sample.shared.pos.toFixed(1)}`,
  );
});

test('A\'s own wall rises during its deactivation phase [T..2T]', () => {
  const trace = run();
  // Reference: the UNCONTESTED wall clearly rises toward UP while A deactivates.
  const peak = peakPos(between(trace, T, 2 * T), 'aOwn');
  assert.ok(peak > MID, `A's own wall should rise past mid (${MID}) while deactivating, peaked ${peak.toFixed(1)}`);
});

test('shared wall RISES + dims during handoff, then is met/stolen by B', () => {
  const trace = run();
  const phase = between(trace, T, 2 * T); // A deactivating, B activating

  // (1) It must rise well above the down height — "dim and go up", not stuck down.
  const peak = peakPos(phase, 'shared');
  assert.ok(
    peak > DOWN + 40,
    `shared wall must RISE during handoff (peak ${peak.toFixed(1)} vs down ${DOWN}); it is pinned at the down height`,
  );

  // (2) Meeting: the rise reverses — by the end of the phase it is heading back DOWN
  // (stolen by B), landing near the down height again with B fully active.
  const settled = trace.find((r) => r.t >= 2 * T * 0.98);
  assert.ok(
    settled.sample.shared.pos < DOWN + 25,
    `after B steals it, shared wall should return to the down height, got ${settled.sample.shared.pos.toFixed(1)}`,
  );

  // (3) It dims as it rises: brightness should drop meaningfully somewhere in the rise.
  const minBri = Math.min(...phase.map((r) => r.sample.shared.bri));
  assert.ok(minBri < 0.4, `shared wall should dim while rising, min brightness was ${minBri.toFixed(2)}`);

  // (4) Steal fires at STEAL_AFTER < T/2 (early, for ease compensation), so the peak is
  // below MID. Check it rose meaningfully and was NOT ridden to the top.
  assert.ok(peak > DOWN + 20, `wall should rise meaningfully, peak ${peak.toFixed(1)}`);
  assert.ok(peak < UP - 20, `wall should not reach the top, peak ${peak.toFixed(1)}`);
});

test('stolen wall tracks B\'s descent closely after the handoff', () => {
  const engine = buildEngine();
  const actions = GENERATORS['blocks-descending'](engine, {
    groups: GROUPS, cycles: 2, deactivationDelay: 0, activationDelay: 0,
  });
  // Watch the shared wall against B's OWN (uncontested) wall as B descends (B's south = h(0,1)).
  const trace = simulate(actions, engine, { shared: SHARED, bOwn: [0, 1, 'h'] }, { end: 4 * T + 4000 });

  // Both should arrive at DOWN by the end of B's activation period (2T).
  const settled = trace.find((r) => r.t >= 2 * T - 200);
  assert.ok(
    settled.sample.shared.pos < DOWN + 20,
    `stolen wall should reach the down height with B, got ${settled.sample.shared.pos.toFixed(1)}`,
  );
  assert.ok(
    settled.sample.bOwn.pos < DOWN + 20,
    `B's own wall should reach the down height, got ${settled.sample.bOwn.pos.toFixed(1)}`,
  );

  // The steal fires at T + STEAL_AFTER. After that, the shared wall should lag no more
  // than ~25 units behind B's own panels at any point — a tighter bound than the old
  // midpoint steal (where lag was ~12 at 0.75T; earlier steal reduces the worst-case gap).
  const afterSteal = trace.filter((r) => r.t >= T + STEAL_AFTER && r.t <= 2 * T);
  const maxGap = Math.max(...afterSteal.map((r) => Math.abs(r.sample.shared.pos - r.sample.bOwn.pos)));
  assert.ok(
    maxGap < 20,
    `stolen wall should track B's descent (max gap ${maxGap.toFixed(1)} units, threshold 20)`,
  );
});
