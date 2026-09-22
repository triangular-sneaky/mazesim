import test from 'node:test';
import assert from 'node:assert/strict';
import { computeScenePlan, zToPos, posToZ, brightToVel } from '../src/ui/mazeHud.js';
import { planMove, planStay } from '../src/model/mazeState.js';

// ---- coordinate/brightness mapping helpers ---------------------------------

test('zToPos maps tracked height 0..N onto sim position 0..255', () => {
  assert.equal(zToPos(0), 0);
  assert.equal(zToPos(8), 255);
  assert.equal(zToPos(4), 128);
});

test('posToZ maps sim position 0..255 back onto height 0..N', () => {
  assert.equal(posToZ(0), 0);
  assert.equal(posToZ(255), 8);
  assert.equal(posToZ(128), 4);
});

test('brightToVel: off below threshold, else clamped 1..127', () => {
  assert.equal(brightToVel(0), 0);
  assert.equal(brightToVel(0.005), 0, 'below the 0.01 dead-zone is off');
  assert.equal(brightToVel(1), 127);
  assert.equal(brightToVel(0.5), 64);
});

// ---- computeScenePlan -------------------------------------------------------

const panel = (note, z, v, over = {}) => ({ note, x: 0, y: 0, orient: 'v', z, v, dead: false, ...over });
const simMap = (obj) => (p) => obj[p.note] ?? null;

test('a panel whose target height differs is planned as a move (light forced on)', () => {
  const panels = [panel(60, 0, 1)];
  const { plan, commits } = computeScenePlan(panels, simMap({ 60: { position: 255, brightness: 1.0 } }));
  const mv = planMove(0, 1, 8);
  assert.deepEqual(plan.get(60), { steps: mv.steps, vel: 127 });
  assert.deepEqual(commits, [[60, mv.newState, 127]]);
});

test('a lit panel already at its target height is planned as a stay (relight)', () => {
  const panels = [panel(60, 4, 1)];
  const { plan, commits } = computeScenePlan(panels, simMap({ 60: { position: 128, brightness: 0.5 } }));
  const st = planStay(4, 1);
  assert.deepEqual(plan.get(60), { steps: st.steps, vel: 64 });
  assert.deepEqual(commits, [[60, st.newState, 64]]);
});

test('a dark panel already at its target height is skipped (no send)', () => {
  const panels = [panel(60, 4, 1)];
  const { plan, commits } = computeScenePlan(panels, simMap({ 60: { position: 128, brightness: 0 } }));
  assert.equal(plan.size, 0);
  assert.deepEqual(commits, []);
});

test('a move to a dark target still lights (vel forced to 1) but commits brightness 0', () => {
  const panels = [panel(60, 0, 1)];
  const { plan, commits } = computeScenePlan(panels, simMap({ 60: { position: 255, brightness: 0 } }));
  const mv = planMove(0, 1, 8);
  assert.deepEqual(plan.get(60), { steps: mv.steps, vel: 1 }, 'any move must light the panel');
  assert.deepEqual(commits, [[60, mv.newState, 0]], 'but tracked brightness reflects the dark target');
});

test('dead panels are skipped regardless of sim pose', () => {
  const panels = [panel(60, 0, 1, { dead: true })];
  const { plan, commits } = computeScenePlan(panels, simMap({ 60: { position: 255, brightness: 1 } }));
  assert.equal(plan.size, 0);
  assert.deepEqual(commits, []);
});

test('panels with no resolvable sim pose are skipped', () => {
  const panels = [panel(60, 0, 1)];
  const { plan } = computeScenePlan(panels, () => null);
  assert.equal(plan.size, 0);
});

test('a mixed scene plans each panel independently', () => {
  const panels = [
    panel(60, 0, 1),   // move up
    panel(61, 4, 1),   // relight in place
    panel(62, 2, 1),   // dark in place -> skip
    panel(63, 0, 1, { dead: true }), // dead -> skip
  ];
  const sim = simMap({
    60: { position: 255, brightness: 1.0 }, // zT=8, on
    61: { position: 128, brightness: 0.5 }, // zT=4 == z, on
    62: { position: 64, brightness: 0 },    // zT=2 == z, off
    63: { position: 255, brightness: 1.0 },
  });
  const { plan, commits } = computeScenePlan(panels, sim);
  assert.deepEqual([...plan.keys()].sort((a, b) => a - b), [60, 61]);
  assert.equal(commits.length, 2);
});
