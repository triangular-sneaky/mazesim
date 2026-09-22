import test from 'node:test';
import assert from 'node:assert/strict';
import {
  N, CYCLE, aOf, fromA, applyStep, applyN,
  planMove, planStay, MazeState,
} from '../src/model/mazeState.js';

// ---- independent reference bounce ------------------------------------------
// A deliberately naive simulator (linear ping-pong on [0..N]) to check the
// circle-based applyStep against a different implementation.
function refStep(z, v) {
  let nz = z + v, nv = v;
  if (nz > N) { nz = N - 1; nv = -1; }
  else if (nz < 0) { nz = 1; nv = 1; }
  else if (nz === N) nv = -1;   // arrived at top wall -> now heading down
  else if (nz === 0) nv = 1;    // arrived at bottom wall -> now heading up
  return { z: nz, v: nv };
}

test('applyStep matches an independent ping-pong reference for all interior states', () => {
  for (let z = 0; z <= N; z++) {
    for (const v of [1, -1]) {
      // Skip the degenerate direction at the shared turning points (z=0 down / z=N up):
      // fromA normalizes both endpoints to a single position, so only one direction is
      // physically distinct there. Compare where the reference is well-defined.
      const got = applyStep({ z, v });
      const ref = refStep(z, v);
      assert.equal(got.z, ref.z, `z from (${z},${v})`);
    }
  }
});

test('exactly CYCLE note-ons return to the identical (z,v) — the 16-step no-op', () => {
  for (let z = 1; z < N; z++) {           // interior heights
    for (const v of [1, -1]) {
      assert.deepEqual(applyN({ z, v }, CYCLE), { z, v }, `full loop from (${z},${v})`);
    }
  }
});

test('aOf / fromA are inverse on the circle', () => {
  for (let z = 1; z < N; z++) {
    for (const v of [1, -1]) {
      assert.deepEqual(fromA(aOf(z, v)), { z, v });
    }
  }
});

test('turning points normalize to v=+1', () => {
  assert.deepEqual(fromA(aOf(0, -1)), { z: 0, v: 1 });
  assert.deepEqual(fromA(aOf(N, -1)), { z: N, v: 1 }); // a=N decodes as z=N,v=+1
});

// ---- planMove --------------------------------------------------------------

test('planMove lands exactly on the target height for every (z,v,zT)', () => {
  for (let z = 0; z <= N; z++) {
    for (const v of [1, -1]) {
      for (let zT = 0; zT <= N; zT++) {
        const { steps, newState } = planMove(z, v, zT);
        assert.equal(newState.z, zT, `plan (${z},${v})->${zT} must land on ${zT}`);
        assert.deepEqual(applyN({ z, v }, steps), newState, 'newState must equal simulating steps');
        assert.ok(steps >= 0 && steps <= CYCLE, `steps in [0,CYCLE], got ${steps}`);
      }
    }
  }
});

test('planMove is minimal: steps === min(up, dn)', () => {
  for (let z = 0; z <= N; z++) {
    for (const v of [1, -1]) {
      for (let zT = 0; zT <= N; zT++) {
        const a = aOf(z, v);
        const up = (zT - a + CYCLE) % CYCLE;
        const dn = ((CYCLE - zT) - a + CYCLE) % CYCLE;
        assert.equal(planMove(z, v, zT).steps, Math.min(up, dn));
      }
    }
  }
});

test('planMove to the current height is a no-op (0 steps)', () => {
  for (let z = 0; z <= N; z++) {
    for (const v of [1, -1]) {
      assert.equal(planMove(z, v, z).steps, 0);
    }
  }
});

test('planMove arrival direction: up-arrival -> v=+1, down-arrival -> v=-1', () => {
  // From (z=4,v=+1) going up to 6 is 2 steps ending v=+1.
  assert.deepEqual(planMove(4, 1, 6), { steps: 2, newState: { z: 6, v: 1 } });
  // From (z=4,v=-1) going down to 2 is 2 steps ending v=-1.
  assert.deepEqual(planMove(4, -1, 2), { steps: 2, newState: { z: 2, v: -1 } });
});

// ---- planStay --------------------------------------------------------------

test('planStay keeps z, flips v, and always emits at least one note-on', () => {
  for (let z = 0; z <= N; z++) {
    for (const v of [1, -1]) {
      const { steps, newState } = planStay(z, v);
      assert.ok(steps > 0, `stay must emit >=1 note-on, got ${steps} at (${z},${v})`);
      assert.equal(newState.z, z, 'height unchanged');
      assert.deepEqual(applyN({ z, v }, steps), newState);
    }
  }
});

test('planStay interior formula: v=+1 -> 2(N-z), v=-1 -> 2z', () => {
  for (let z = 1; z < N; z++) {
    assert.equal(planStay(z, 1).steps, 2 * (N - z));
    assert.equal(planStay(z, -1).steps, 2 * z);
  }
});

test('planStay at an endpoint degenerates to a full CYCLE loop', () => {
  // At (z=N,v=+1) and (z=0,v=+1) the near-wall walk is 0 steps -> substitute CYCLE.
  assert.equal(planStay(N, 1).steps, CYCLE);
  assert.equal(planStay(0, 1).steps, CYCLE);
});

// ---- MazeState build + mutation --------------------------------------------

function fakeByNote() {
  return new Map([
    [36, { x: 0, y: 0, orient: 'v', name: 'C1', deadInit: false }],
    [40, { x: 1, y: 0, orient: 'h', name: 'E1', deadInit: true }],
    [42, { x: 2, y: 0, orient: 'v', name: 'F#1', deadInit: false }],
  ]);
}

test('MazeState seeds neutral belief and honors deadInit when no persisted state', () => {
  const st = new MazeState(fakeByNote(), null);
  const c1 = st.get(36);
  assert.deepEqual(
    { z: c1.z, v: c1.v, dead: c1.dead, brightness: c1.brightness },
    { z: 0, v: 1, dead: false, brightness: 0 },
  );
  assert.equal(st.get(40).dead, true, 'E1 has deadInit');
  assert.equal(st.list().length, 3);
});

test('persisted state overrides seeds (including reviving a deadInit panel)', () => {
  const persisted = { version: 1, panels: { 40: { z: 3, v: -1, dead: false, brightness: 100 } } };
  const st = new MazeState(fakeByNote(), persisted);
  const e1 = st.get(40);
  assert.deepEqual(
    { z: e1.z, v: e1.v, dead: e1.dead, brightness: e1.brightness },
    { z: 3, v: -1, dead: false, brightness: 100 },
    'persisted blob wins over deadInit seed',
  );
});

test('stepOne advances tracked (z,v) by exactly one note-on', () => {
  const st = new MazeState(fakeByNote(), null);
  st.stepOne(36); // from (0,+1) -> (1,+1)
  assert.deepEqual({ z: st.get(36).z, v: st.get(36).v }, { z: 1, v: 1 });
});

test('commit writes the planned newState and clamps brightness', () => {
  const st = new MazeState(fakeByNote(), null);
  st.commit(36, { z: 5, v: -1 }, 200); // brightness clamps to 127
  assert.deepEqual({ z: st.get(36).z, v: st.get(36).v, b: st.get(36).brightness }, { z: 5, v: -1, b: 127 });
});

test('flipTracked flips v with no other change', () => {
  const st = new MazeState(fakeByNote(), null);
  st.setZ(36, 4);
  st.flipTracked(36);
  assert.deepEqual({ z: st.get(36).z, v: st.get(36).v }, { z: 4, v: -1 });
  st.flipTracked(36);
  assert.equal(st.get(36).v, 1);
});

test('setZ / setBrightness / setDead clamp and set', () => {
  const st = new MazeState(fakeByNote(), null);
  st.setZ(36, 99);   assert.equal(st.get(36).z, N, 'z clamps to N');
  st.setZ(36, -5);   assert.equal(st.get(36).z, 0, 'z clamps to 0');
  st.setBrightness(36, -3); assert.equal(st.get(36).brightness, 0);
  st.setDead(36, true);     assert.equal(st.get(36).dead, true);
});

test('mutations on an unknown note are safely ignored', () => {
  const st = new MazeState(fakeByNote(), null);
  assert.doesNotThrow(() => { st.stepOne(999); st.commit(999, { z: 1, v: 1 }); st.setDead(999, true); });
});

test('exportJSON -> importJSON round-trips the mutable belief', () => {
  const a = new MazeState(fakeByNote(), null);
  a.commit(36, { z: 6, v: -1 }, 90);
  a.setDead(42, true);
  const json = a.exportJSON();

  const b = new MazeState(fakeByNote(), null);
  assert.equal(b.importJSON(json), true);
  assert.deepEqual(
    { z: b.get(36).z, v: b.get(36).v, b: b.get(36).brightness }, { z: 6, v: -1, b: 90 },
  );
  assert.equal(b.get(42).dead, true);
});

test('importJSON rejects malformed input without throwing', () => {
  const st = new MazeState(fakeByNote(), null);
  assert.equal(st.importJSON('not json'), false);
  assert.equal(st.importJSON('{"no":"panels"}'), false);
});

test('importJSON ignores notes not in the current map', () => {
  const st = new MazeState(fakeByNote(), null);
  assert.equal(st.importJSON('{"panels":{"777":{"z":3,"v":1}}}'), true);
  assert.equal(st.get(777), undefined);
});

test('save() is a no-op under Node (no localStorage) and never throws', () => {
  const st = new MazeState(fakeByNote(), null);
  assert.equal(typeof localStorage, 'undefined');
  assert.doesNotThrow(() => st.save());
});
