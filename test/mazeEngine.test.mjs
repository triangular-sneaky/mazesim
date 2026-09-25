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
  const wireCbs = [];   // captured { note, onSent } for wire-synced sends
  const midi = {
    enabled: true,
    logging: false,
    deadNotes: new Set(),
    sendSteps: (plan, opts = {}) => {
      sent.push(plan);
      if (opts.onSent) wireCbs.push({ note: [...plan.keys()][0], onSent: opts.onSent });
    },
    sendOff: (notes) => offs.push([...notes]),
  };
  const engine = new MazeEngine(CONFIG, [{ x: 0, y: 0, orient: 'h' }], { state, midi, ...deps });
  // Simulate the transport putting a note's steps on the wire (fires the engine's onSent).
  const fireWire = (note, when = 0) => {
    for (let i = wireCbs.length - 1; i >= 0; i--) {
      if (wireCbs[i].note === note) { wireCbs[i].onSent(note, when); return; }
    }
  };
  return { engine, state, sent, offs, fireWire };
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

// ---- Wire-synced moves (syncToWire) -----------------------------------------

test('syncToWire OFF (default): back-to-back moves to the same panel both send + commit immediately', () => {
  const { engine, state, sent } = makeEngine();
  engine.move(0, 0, 'h', 96, 1);   // z0 -> z3
  engine.move(0, 0, 'h', 0, 1);    // immediate second move — no gate
  assert.equal(sent.length, 2, 'both sends go out with wire-sync off');
  assert.equal(state.get(60).z, 0, 'committed immediately, back at floor');
});

test('syncToWire ON: belief commits only on the wire callback; a busy panel queues (no send)', () => {
  let t = 0;
  const { engine, state, sent, fireWire } = makeEngine({ now: () => t });
  engine.syncToWire = true;

  engine.move(0, 0, 'h', 96, 1);   // z0 -> z3: dispatched to the wire, NOT committed yet
  assert.equal(sent.length, 1, 'first move dispatched');
  assert.equal(state.get(60).z, 0, 'belief holds until the wire actually sends');
  assert.ok(engine._awaitingWire.has(60), 'awaiting the wire callback');

  engine.move(0, 0, 'h', 0, 1);    // panel busy -> FIFO-queued, nothing on the wire
  assert.equal(sent.length, 1, 'second move queued, not sent');
  assert.equal(engine._moveQueue.get(60).length, 1, 'queued in FIFO');

  fireWire(60);                    // transport reports the steps hit the wire (real move-start)
  assert.equal(state.get(60).z, 3, 'belief commits on the wire callback');
  assert.ok(engine._busyUntil.get(60) > 0, 'travel clock armed from the send');
});

test('syncToWire ON: a light-off queued behind a move fires AFTER it (registers, not dropped)', () => {
  let t = 0;
  const { engine, state, offs, fireWire } = makeEngine({ now: () => t });
  engine.syncToWire = true;

  engine.move(0, 0, 'h', 96, 1);   // A: z0->z3 lit — dispatched (awaiting wire)
  engine.move(0, 0, 'h', 255, 1);  // B: queued (panel busy)
  engine.off(0, 0, 'h');           // off: must go AFTER B, not before it
  assert.equal(engine._moveQueue.get(60).length, 2, 'B and the off are queued in order');
  assert.equal(offs.length, 0, 'the off is held behind the queued unit, not sent early');

  fireWire(60);               // A on the wire → commit z3 lit
  t += 1e6; engine.tick(0);   // A done → dispatch B
  fireWire(60);               // B on the wire → commit z8 lit
  assert.equal(state.get(60).brightness > 0, true, 'panel lit after B');
  assert.equal(offs.length, 0, 'off still waits — B has not finished');

  t += 1e6; engine.tick(0);   // B done → the queued off finally fires
  assert.equal(offs.length, 1, 'the light-off registers, after both moves');
  assert.equal(state.get(60).brightness, 0, 'belief lands dark');
});

test('syncToWire ON: move-end drains the FIFO in order and fires onPanelDone', () => {
  let t = 0;
  const done = [];
  const { engine, state, sent, fireWire } = makeEngine({ now: () => t });
  engine.syncToWire = true;
  engine.onPanelDone = (n) => done.push(n);

  engine.move(0, 0, 'h', 255, 1);  // z0 -> z8: dispatched
  engine.move(0, 0, 'h', 0, 1);    // queued (return to floor)
  fireWire(60);                    // commit z8, arm the travel clock
  assert.equal(state.get(60).z, 8, 'first move committed on its wire send');

  t += 1e6; engine.tick(0);        // move-end: done fires, queued move dispatches
  assert.deepEqual(done, [60], 'onPanelDone fired at move-end');
  assert.equal(sent.length, 2, 'queued move dispatched only after the first finished');
  assert.ok(engine._awaitingWire.has(60), 'the drained move now awaits its own wire send');

  fireWire(60);                    // commit the second (z8 -> z0)
  assert.equal(state.get(60).z, 0, 'landed at the queued target, in order');
});
