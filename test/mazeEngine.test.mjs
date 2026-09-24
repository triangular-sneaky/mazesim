import test from 'node:test';
import assert from 'node:assert/strict';
import { MazeEngine } from '../src/model/mazeEngine.js';
import { MazeState } from '../src/model/mazeState.js';

const CONFIG = {
  motion: { velocity: 55, ease: 0.15, restPosition: 128, tempoReference: 120 },
  blink: { peak: 0.7, attack: 0.08, sustain: 0.15, decay: 0.4 },
};

// One panel at (0,0,h) = note 60. A fake transport that records sendSteps plans and sendOffs.
function makeEngine(deps = {}) {
  const byNote = new Map([[60, { x: 0, y: 0, orient: 'h', name: 'C4', deadInit: false }]]);
  const state = new MazeState(byNote, null);
  const sent = [];
  const offs = [];
  const midi = {
    enabled: true,
    deadNotes: new Set(),
    sendSteps: (plan) => sent.push(plan),
    sendOff: (notes) => offs.push([...notes]),
  };
  const engine = new MazeEngine(CONFIG, [{ x: 0, y: 0, orient: 'h' }], { state, midi, ...deps });
  return { engine, state, sent, offs };
}

const stepsFor = (plan, note) => plan.get(note)?.steps;

test('a move to a NEW height plans the minimal steps (planMove)', () => {
  const { engine, state, sent } = makeEngine();
  engine.move(0, 0, 'h', 96, 1);            // z=0 -> posToZ(96)=3
  assert.equal(sent.length, 1);
  assert.equal(stepsFor(sent[0], 60), 3);
  assert.equal(state.get(60).z, 3);
});

test('lighting a panel in place is a cheap 1-step pulse (a 1-level wobble), never 0 steps', () => {
  const { engine, state, sent } = makeEngine();          // fresh belief: z=0 (endpoint), off
  engine.move(0, 0, 'h', 0, 1);                          // same height, turn light ON
  assert.equal(sent.length, 1, 'still sends');
  assert.equal(stepsFor(sent[0], 60), 1, 'in-place light = single note-on');
  assert.equal(sent[0].get(60).vel, 127, 'the light rides the pulse');
  assert.equal(state.get(60).z, 1, 'wobbles up one level (z 0 -> 1)');
});

test('stayLight ON: lighting in place uses planStay — z is preserved exactly (no ±1 wobble)', () => {
  const { engine, state, sent } = makeEngine();   // fresh: z=0 (floor), off
  engine.stayLight = true;
  engine.move(0, 0, 'h', 0, 1);                    // same height, light ON, via stay
  assert.equal(sent.length, 1, 'still sends');
  assert.equal(stepsFor(sent[0], 60), 16, 'floor stay = a full 16-step wall-and-back loop');
  assert.equal(state.get(60).z, 0, 'z held exactly at the floor (not bumped to 1)');
  assert.equal(sent[0].get(60).vel, 127, 'the light rides the stay');
});

test('a mid-height in-place light pulse is also a single step', () => {
  const { engine, state, sent } = makeEngine();
  state.commit(60, { z: 4, v: 1 }, 0);                   // mid-range, off, heading up
  engine.move(0, 0, 'h', 128, 1);                        // posToZ(128)=4 == current z, turn on
  assert.equal(stepsFor(sent[0], 60), 1, 'one step, not a wall-and-back stay');
  assert.equal(state.get(60).z, 5, 'wobbles one step in its current direction (z 4 -> 5)');
});

test('an OFF panel asked to stay put and stay off is a genuine no-op — nothing sent', () => {
  const { engine, sent, offs } = makeEngine();           // z=0, brightness 0
  engine.move(0, 0, 'h', 0, 0);                          // same height, still off
  assert.equal(sent.length, 0, 'no velocity-1 reinforcement');
  assert.equal(offs.length, 0);
});

test('keeping brightness with no height change is a genuine no-op', () => {
  const { engine, state, sent, offs } = makeEngine();
  state.commit(60, { z: 3, v: 1 }, 100);                 // lit, mid-range
  engine.move(0, 0, 'h', 96);                            // posToZ(96)=3 == current, brightness omitted (keep)
  assert.equal(sent.length, 0, 'nothing to do — no restrike');
  assert.equal(offs.length, 0);
  assert.equal(state.get(60).brightness, 100, 'light unchanged');
});

test('turning a lit panel off in place is a bare note-off (no movement)', () => {
  const { engine, state, sent, offs } = makeEngine();
  state.commit(60, { z: 3, v: 1 }, 100);                 // lit
  engine.move(0, 0, 'h', 96, 0);                         // same height, turn OFF
  assert.equal(sent.length, 0, 'no steps — off does not move');
  assert.deepEqual(offs, [[60]]);
  assert.equal(state.get(60).brightness, 0);
});

test('dead panels are skipped entirely (no stay, no send)', () => {
  const { engine, state, sent, offs } = makeEngine();
  state.setDead(60, true);
  const ok = engine.move(0, 0, 'h', 0, 1);
  assert.equal(ok, false);
  assert.equal(sent.length, 0);
  assert.equal(offs.length, 0);
});

// ---- Per-panel move gate (serializeMoves) -----------------------------------

test('gate OFF (default): back-to-back moves to the same panel both send immediately', () => {
  const { engine, sent } = makeEngine();
  engine.move(0, 0, 'h', 96, 1);   // z0 -> z3
  engine.move(0, 0, 'h', 0, 1);    // immediate second move — no gate
  assert.equal(sent.length, 2, 'both sends go out with the gate off');
});

test('gate ON: a move to a still-travelling panel is deferred (no MIDI) until it finishes', () => {
  let t = 0;
  const { engine, state, sent } = makeEngine({ now: () => t });
  engine.serializeMoves = true;

  engine.move(0, 0, 'h', 96, 1);   // z0 -> z3: dispatches now, marks the panel busy
  assert.equal(sent.length, 1, 'first move dispatches');
  assert.ok(engine._busyUntil.get(60) > 0, 'panel marked busy for its travel time');

  engine.move(0, 0, 'h', 0, 1);    // new target while busy -> deferred, nothing on the wire
  assert.equal(sent.length, 1, 'second move is held, not sent');
  assert.equal(engine._pending.get(60).target, 0, 'latest target is pending');

  engine.tick(0);                  // still busy -> stays pending
  assert.equal(sent.length, 1, 'tick before travel ends does not dispatch');

  t += 1e6;                        // travel long finished
  engine.tick(0);                  // drain: panel is free -> pending dispatches
  assert.equal(sent.length, 2, 'pending move dispatched once the panel is free');
  assert.equal(engine._pending.has(60), false, 'pending cleared');
  assert.equal(state.get(60).z, 0, 'belief reflects the drained move (z back to 0)');
});

test('gate ON: only the latest deferred target survives (latest-wins)', () => {
  let t = 0;
  const { engine, state, sent } = makeEngine({ now: () => t });
  engine.serializeMoves = true;

  engine.move(0, 0, 'h', 255, 1);  // z0 -> z8: dispatches, busy
  engine.move(0, 0, 'h', 64, 1);   // deferred
  engine.move(0, 0, 'h', 128, 1);  // replaces the earlier pending
  assert.equal(engine._pending.get(60).target, 128, 'newest target wins');

  t += 1e6;
  engine.tick(0);
  assert.equal(sent.length, 2, 'exactly one deferred move dispatched');
  assert.equal(state.get(60).z, 4, 'landed at the latest target (posToZ(128)=4)');
});
