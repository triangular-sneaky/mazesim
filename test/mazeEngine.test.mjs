import test from 'node:test';
import assert from 'node:assert/strict';
import { MazeEngine } from '../src/model/mazeEngine.js';
import { MazeState } from '../src/model/mazeState.js';

const CONFIG = {
  motion: { velocity: 55, ease: 0.15, restPosition: 128, tempoReference: 120 },
  blink: { peak: 0.7, attack: 0.08, sustain: 0.15, decay: 0.4 },
};

// One panel at (0,0,h) = note 60. A fake transport that records every sendSteps plan.
function makeEngine() {
  const byNote = new Map([[60, { x: 0, y: 0, orient: 'h', name: 'C4', deadInit: false }]]);
  const state = new MazeState(byNote, null);
  const sent = [];
  const midi = { enabled: true, deadNotes: new Set(), sendSteps: (plan) => sent.push(plan) };
  const engine = new MazeEngine(CONFIG, [{ x: 0, y: 0, orient: 'h' }], { state, midi });
  return { engine, state, sent };
}

const stepsFor = (plan, note) => plan.get(note)?.steps;

test('a move to a NEW height plans the minimal steps (planMove)', () => {
  const { engine, state, sent } = makeEngine();
  engine.move(0, 0, 'h', 96, 1);            // z=0 -> posToZ(96)=3
  assert.equal(sent.length, 1);
  assert.equal(stepsFor(sent[0], 60), 3);
  assert.equal(state.get(60).z, 3);
});

test('a move to the SAME height is never 0 steps — it stays in place (16 at an endpoint)', () => {
  const { engine, state, sent } = makeEngine();          // fresh belief: z=0 (an endpoint)
  engine.move(0, 0, 'h', 0, 1);                          // target z=0 == current z=0
  assert.equal(sent.length, 1, 'still sends');
  assert.equal(stepsFor(sent[0], 60), 16, 'endpoint stay = full 16-step loop');
  assert.equal(state.get(60).z, 0, 'ends back at the same height');
});

test('a mid-height in-place move stays via the near wall (non-zero, < 16)', () => {
  const { engine, state, sent } = makeEngine();
  state.commit(60, { z: 4, v: 1 }, 0);                   // put belief mid-range
  engine.move(0, 0, 'h', 128, 1);                        // posToZ(128)=4 == current z=4
  const s = stepsFor(sent[0], 60);
  assert.ok(s > 0 && s < 16, `mid stay is non-zero and less than a full loop (got ${s})`);
  assert.equal(state.get(60).z, 4, 'still at the same height');
});

test('the light rides the stay: velocity is carried even with no net move', () => {
  const { engine, sent } = makeEngine();
  engine.move(0, 0, 'h', 0, 1);                          // full brightness, in place
  assert.equal(sent[0].get(60).vel, 127);
});

test('dead panels are skipped entirely (no stay, no send)', () => {
  const { engine, state, sent } = makeEngine();
  state.setDead(60, true);
  const ok = engine.move(0, 0, 'h', 0, 1);
  assert.equal(ok, false);
  assert.equal(sent.length, 0);
});
