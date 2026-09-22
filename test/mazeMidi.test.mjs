import test from 'node:test';
import assert from 'node:assert/strict';
import { MazeMidiController } from '../src/ui/mazeMidiController.js';

// ---- virtual clock + timer queue -------------------------------------------
// The controller takes injectable now/schedule/unschedule; we drive them from a
// deterministic virtual clock so the token-bucket guards are testable to the ms.
function makeClock() {
  let now = 0;
  let seq = 1;
  const timers = [];
  return {
    now: () => now,
    schedule: (fn, ms) => {
      const id = seq++;
      timers.push({ id, at: now + Math.max(0, ms), fn, live: true });
      return id;
    },
    unschedule: (id) => { const t = timers.find((t) => t.id === id); if (t) t.live = false; },
    /** Run scheduled timers in (time, insertion) order until the queue drains. */
    drain(maxSteps = 100000) {
      let steps = 0;
      while (steps++ < maxSteps) {
        const pending = timers.filter((t) => t.live);
        if (!pending.length) break;
        pending.sort((a, b) => a.at - b.at || a.id - b.id);
        const t = pending[0];
        t.live = false;
        now = Math.max(now, t.at);
        t.fn();
      }
      return now;
    },
  };
}

function makeController(opts = {}) {
  const clock = makeClock();
  const sends = [];
  const output = { send: (data, when) => sends.push({ data: [...data], when }) };
  const c = new MazeMidiController({
    now: clock.now, schedule: clock.schedule, unschedule: clock.unschedule, ...opts,
  });
  // Wire a fake Web MIDI output and mark enabled (bypassing the real access flow).
  c.access = { outputs: new Map([['fake', output]]) };
  c.selectedOutputId = 'fake';
  c.enabled = true;
  return { c, clock, sends };
}

const bytes = (sends) => sends.map((s) => s.data);

// ---- headless construction --------------------------------------------------

test('constructs headlessly (no document) and builds no UI element', () => {
  const c = new MazeMidiController();
  assert.equal(c.el, undefined, 'no DOM built under Node');
  assert.equal(typeof c.sendSteps, 'function');
});

// ---- sendSteps: byte order, velocity, filters ------------------------------

test('sendSteps emits [note-off, note-on@vel] pairs per step, in order', () => {
  const { c, clock, sends } = makeController();
  c.sendSteps(new Map([[60, { steps: 2, vel: 100 }]]));
  clock.drain();
  assert.deepEqual(bytes(sends), [
    [0x80, 60, 0], [0x90, 60, 100],
    [0x80, 60, 0], [0x90, 60, 100],
  ]);
});

test('sendSteps clamps velocity to 1..127', () => {
  const { c, clock, sends } = makeController();
  c.sendSteps(new Map([[60, { steps: 1, vel: 200 }], [61, { steps: 1, vel: 0 }]]));
  clock.drain();
  assert.equal(sends.find((s) => s.data[1] === 60 && s.data[0] === 0x90).data[2], 127);
  assert.equal(sends.find((s) => s.data[1] === 61 && s.data[0] === 0x90).data[2], 1);
});

test('sendSteps skips dead notes as a hard guard', () => {
  const { c, clock, sends } = makeController();
  c.deadNotes.add(60);
  const ok = c.sendSteps(new Map([[60, { steps: 3, vel: 100 }]]));
  clock.drain();
  assert.equal(ok, false, 'nothing to send');
  assert.equal(sends.length, 0);
});

test('sendSteps skips notes with steps <= 0', () => {
  const { c, clock, sends } = makeController();
  const ok = c.sendSteps(new Map([[60, { steps: 0, vel: 100 }], [61, { steps: -2, vel: 100 }]]));
  clock.drain();
  assert.equal(ok, false);
  assert.equal(sends.length, 0);
});

test('sendSteps is sequential — one note fully, then the next', () => {
  const { c, clock, sends } = makeController();
  c.sendSteps(new Map([[60, { steps: 2, vel: 50 }], [61, { steps: 2, vel: 50 }]]));
  clock.drain();
  const notes = sends.map((s) => s.data[1]);
  // all of 60 before any 61
  const firstOf61 = notes.indexOf(61);
  const lastOf60 = notes.lastIndexOf(60);
  assert.ok(lastOf60 < firstOf61, `note 60 must finish before 61 starts (${notes.join(',')})`);
});

test('sendSteps out-of-range notes are ignored', () => {
  const { c, clock, sends } = makeController();
  const ok = c.sendSteps(new Map([[-1, { steps: 1, vel: 10 }], [200, { steps: 1, vel: 10 }]]));
  clock.drain();
  assert.equal(ok, false);
  assert.equal(sends.length, 0);
});

// ---- sendOff / panic --------------------------------------------------------

test('sendOff emits exactly one note-off per note and no note-on (no movement)', () => {
  const { c, clock, sends } = makeController();
  c.sendOff([10, 11, 12]);
  clock.drain();
  assert.equal(sends.length, 3);
  assert.ok(sends.every((s) => s.data[0] === 0x80), 'all note-offs');
  assert.deepEqual(sends.map((s) => s.data[1]).sort((a, b) => a - b), [10, 11, 12]);
});

test('sendOff skips dead notes', () => {
  const { c, clock, sends } = makeController();
  c.deadNotes.add(11);
  c.sendOff([10, 11, 12]);
  clock.drain();
  assert.deepEqual(sends.map((s) => s.data[1]).sort((a, b) => a - b), [10, 12]);
});

test('panic sends a note-off for every note 0..127 and nothing else', () => {
  const { c, sends } = makeController();
  c.panic(); // panic sends synchronously (no pacing)
  assert.equal(sends.length, 128);
  assert.ok(sends.every((s) => s.data[0] === 0x80 && s.data[2] === 0));
  assert.deepEqual(sends.map((s) => s.data[1]), Array.from({ length: 128 }, (_, i) => i));
});

// ---- no output --------------------------------------------------------------

test('every send path returns false and emits nothing without an output', () => {
  const clock = makeClock();
  const c = new MazeMidiController({ now: clock.now, schedule: clock.schedule, unschedule: clock.unschedule });
  // no access wired
  assert.equal(c.sendSteps(new Map([[60, { steps: 1, vel: 10 }]])), false);
  assert.equal(c.sendOff([60]), false);
  assert.equal(c.move(new Map([[60, 100]])), false);
  assert.equal(c.panic(), false);
});

// ---- token-bucket rate limiter ---------------------------------------------

test('burst budget lets a batch through untouched, within the bucket', () => {
  // cap=8 tokens; 4 units of cost 2 = 8 msgs -> all fit; no throttling.
  const { c, clock, sends } = makeController({ rateHz: 1000, burst: 8, delayMs: 0 });
  c.sendSteps(new Map([
    [60, { steps: 1, vel: 1 }], [61, { steps: 1, vel: 1 }],
    [62, { steps: 1, vel: 1 }], [63, { steps: 1, vel: 1 }],
  ]));
  clock.drain();
  // first message of each unit (the note-off) dispatched at 1ms cadence, no rate stall.
  const unitWhen = [60, 61, 62, 63].map((n) => sends.find((s) => s.data[1] === n).when);
  assert.deepEqual(unitWhen, [1, 2, 3, 4], 'units stream out one unitDur (1ms) apart, unthrottled');
});

test('beyond the burst, units are spaced by cost/rate (sustained ceiling holds)', () => {
  // cap=2 = one unit's worth; rate=1000 msg/s -> refilling 2 tokens takes 2ms.
  // So each subsequent cost-2 unit is gated to a 2ms cadence: whens 1,3,5,7.
  const { c, clock, sends } = makeController({ rateHz: 1000, burst: 2, delayMs: 0 });
  c.sendSteps(new Map([
    [60, { steps: 1, vel: 1 }], [61, { steps: 1, vel: 1 }],
    [62, { steps: 1, vel: 1 }], [63, { steps: 1, vel: 1 }],
  ]));
  clock.drain();
  const unitWhen = [60, 61, 62, 63].map((n) => sends.find((s) => s.data[1] === n).when);
  assert.deepEqual(unitWhen, [1, 3, 5, 7], 'throttled to a 2ms/unit sustained rate');
});

test('delayMs spaces messages WITHIN a unit on the wire', () => {
  const { c, clock, sends } = makeController({ rateHz: 100000, burst: 64, delayMs: 5 });
  c.sendSteps(new Map([[60, { steps: 3, vel: 1 }]])); // cost 6 msgs
  clock.drain();
  const whens = sends.map((s) => s.when);
  assert.equal(whens.length, 6);
  for (let i = 1; i < whens.length; i++) {
    assert.equal(whens[i] - whens[i - 1], 5, `messages ${i - 1}->${i} spaced by delayMs`);
  }
});

// ---- append / flush ---------------------------------------------------------

test('a later send APPENDS to the queue — nothing is superseded, everything drains in order', () => {
  const { c, clock, sends } = makeController({ rateHz: 300, burst: 64, delayMs: 0 });
  // Send A: two notes. A's first unit dispatches synchronously; the 2nd is queued.
  c.sendSteps(new Map([[10, { steps: 1, vel: 1 }], [11, { steps: 1, vel: 1 }]]));
  // Send B before draining: appends behind A's remaining unit (does NOT cancel it).
  c.sendSteps(new Map([[20, { steps: 1, vel: 1 }], [21, { steps: 1, vel: 1 }]]));
  clock.drain();
  const order = sends.filter((s) => s.data[0] === 0x90).map((s) => s.data[1]);
  // All four fire, A fully before B (FIFO), because the shared bucket had budget.
  assert.deepEqual(order, [10, 11, 20, 21], 'FIFO: A then B, none dropped');
});

test('the token bucket holds ACROSS separate sends (the inverted per-panel drive path)', () => {
  // burst=2 (one unit's worth), rate=1000 -> 2 tokens/2ms. Four SEPARATE single-note sends
  // (as MazeEngine.movePanel issues them) must still be throttled to a 2ms/unit cadence,
  // not each granted a fresh full bucket.
  const { c, clock, sends } = makeController({ rateHz: 1000, burst: 2, delayMs: 0 });
  for (const n of [60, 61, 62, 63]) c.sendSteps(new Map([[n, { steps: 1, vel: 1 }]]));
  clock.drain();
  const unitWhen = [60, 61, 62, 63].map((n) => sends.find((s) => s.data[1] === n).when);
  assert.deepEqual(unitWhen, [1, 3, 5, 7], 'sustained ceiling holds across independent sends');
});

test('_cancel flushes the queue: only already-dispatched units survive', () => {
  const { c, clock, sends } = makeController({ rateHz: 300, burst: 64, delayMs: 0 });
  c.sendSteps(new Map([[10, { steps: 1, vel: 1 }], [11, { steps: 1, vel: 1 }]]));
  c._cancel();
  clock.drain();
  const notes = new Set(sends.map((s) => s.data[1]));
  assert.ok(notes.has(10) && !notes.has(11), 'only the already-dispatched unit survives flush');
});

test('panic flushes an in-flight paced run before sending its note-offs', () => {
  const { c, clock, sends } = makeController({ rateHz: 300, burst: 64, delayMs: 0 });
  c.sendSteps(new Map([[10, { steps: 1, vel: 1 }], [11, { steps: 1, vel: 1 }]]));
  c.panic();                       // must cancel the queued tail (note 11) and kill all lights
  clock.drain();
  const stepOns = sends.filter((s) => s.data[0] === 0x90).map((s) => s.data[1]);
  assert.ok(!stepOns.includes(11), 'panic dropped the queued step for note 11');
  const offs = sends.filter((s) => s.data[0] === 0x80 && s.data[2] === 0);
  assert.equal(offs.length >= 128, true, 'panic still emitted a note-off for every note 0..127');
});

// ---- move() wrapper ---------------------------------------------------------

test('move emits `pairs` (off,on) pairs per note, sequential by default', () => {
  const { c, clock, sends } = makeController({ pairs: 2, interleave: false });
  c.move(new Map([[60, 100]]));
  clock.drain();
  assert.deepEqual(bytes(sends), [
    [0x80, 60, 0], [0x90, 60, 100],
    [0x80, 60, 0], [0x90, 60, 100],
  ]);
});

test('move interleave mode round-robins notes within each round', () => {
  const { c, clock, sends } = makeController({ pairs: 1, interleave: true });
  c.move(new Map([[60, 80], [61, 80]]));
  clock.drain();
  // rounds = 2: round0 = off both, round1 = on both -> off60,off61,on60,on61
  assert.deepEqual(bytes(sends), [
    [0x80, 60, 0], [0x80, 61, 0],
    [0x90, 60, 80], [0x90, 61, 80],
  ]);
});

test('move clamps levels to 1..127', () => {
  const { c, clock, sends } = makeController({ pairs: 1 });
  c.move(new Map([[60, 999]]));
  clock.drain();
  assert.equal(sends.find((s) => s.data[0] === 0x90).data[2], 127);
});
