/**
 * Brute-force validation of the maze motion planner (src/model/mazeState.js).
 * Run: node scripts/check-maze-math.mjs
 *
 * Confirms, against an independent bounce simulator, that:
 *   - planMove reaches the requested height in the minimal number of steps
 *   - planStay returns to the same height with >0 steps
 *   - CYCLE note-ons are a net no-op (the "16 pairs" hardware invariant)
 */
import { N, CYCLE, aOf, applyStep, applyN, planMove, planStay } from '../src/model/mazeState.js';

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL:', msg); };

// Independent reference: simulate the physical bounce directly, ignoring the circle model.
function bounce({ z, v }) {
  let nz = z + v;
  let nv = v;
  if (nz > N) { nz = N - 1; nv = -1; }   // stepped past the top -> reflect
  else if (nz < 0) { nz = 1; nv = 1; }   // stepped past the bottom -> reflect
  else if (nz === N) { nv = 1; }         // landed exactly on top (canonical v per fromA)
  else if (nz === 0) { nv = 1; }         // landed exactly on bottom
  return { z: nz, v: nv };
}

// The states we ever track: interior points have a real direction; turning points
// normalize to v=+1 (both directions share the same circle index there).
const states = [];
for (let z = 0; z <= N; z++) for (const v of [1, -1]) states.push({ z, v });

// 1. applyStep must match the independent bounce simulator for every state.
for (const s of states) {
  const a = applyStep(s);
  const b = bounce(s);
  if (a.z !== b.z || a.v !== b.v) {
    fail(`applyStep(${s.z},${s.v}) = (${a.z},${a.v}) but bounce = (${b.z},${b.v})`);
  }
}

// 2. CYCLE note-ons return to the identical state (net no-op).
for (const s of states) {
  const r = applyN(s, CYCLE);
  // At turning points, v normalizes to +1; compare the circle index instead.
  if (aOf(r.z, r.v) !== aOf(s.z, s.v)) {
    fail(`applyN(${s.z},${s.v}, ${CYCLE}) landed at circle ${aOf(r.z, r.v)} != ${aOf(s.z, s.v)}`);
  }
}

// 3. planMove reaches zT, is minimal, and never exceeds CYCLE.
for (const s of states) {
  for (let zT = 0; zT <= N; zT++) {
    const { steps, newState } = planMove(s.z, s.v, zT);
    if (newState.z !== zT) fail(`planMove(${s.z},${s.v}->${zT}) ended at z=${newState.z}`);
    if (steps > CYCLE) fail(`planMove(${s.z},${s.v}->${zT}) steps=${steps} > ${CYCLE}`);
    // Minimality: no smaller step count reaches zT.
    for (let k = 0; k < steps; k++) {
      if (applyN(s, k).z === zT) { fail(`planMove(${s.z},${s.v}->${zT}) not minimal: ${k} < ${steps} also reaches it`); break; }
    }
    if (zT === s.z && steps !== 0) fail(`planMove(${s.z},${s.v}->${zT}) should be 0 steps (already there), got ${steps}`);
  }
}

// 4. planStay keeps height z, emits >=1 step.
for (const s of states) {
  const { steps, newState } = planStay(s.z, s.v);
  if (steps < 1) fail(`planStay(${s.z},${s.v}) steps=${steps} < 1`);
  if (newState.z !== s.z) fail(`planStay(${s.z},${s.v}) moved to z=${newState.z}`);
}

if (failures === 0) console.log(`OK — all planner checks passed (N=${N}, CYCLE=${CYCLE}, ${states.length} states).`);
else { console.error(`\n${failures} failure(s).`); process.exit(1); }
