import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseMidiMapping } from '../src/config/midiMapping.js';

// Read a FROZEN copy of the hardware map, never the live config/midi-mapping.yaml —
// so editing the live config can't break these tests.
const YAML_PATH = fileURLToPath(new URL('./fixtures/midi-mapping.yaml', import.meta.url));
const fixtureYaml = readFileSync(YAML_PATH, 'utf8');

// ---- the (frozen) hardware map ---------------------------------------------

test('the fixture map parses to 86 panels with no warnings', () => {
  const { byNote, warnings } = parseMidiMapping(fixtureYaml);
  assert.equal(byNote.size, 86, 'expected 86 physical panels');
  assert.deepEqual(warnings, [], `unexpected warnings: ${warnings.join('; ')}`);
});

test('note set is the contiguous run 23..110 with exactly the gaps {83,108}', () => {
  const { byNote } = parseMidiMapping(fixtureYaml);
  const notes = [...byNote.keys()].sort((a, b) => a - b);
  assert.equal(notes[0], 23, 'lowest note is B-1=23');
  assert.equal(notes[notes.length - 1], 110, 'highest note is D7=110');
  const present = new Set(notes);
  const gaps = [];
  for (let n = 23; n <= 110; n++) if (!present.has(n)) gaps.push(n);
  assert.deepEqual(gaps, [83, 108], 'the only absent notes are B4=83 and C7=108');
});

test('(!) suffix seeds the dead-init flag on exactly F#2=54, B0=35, C#0=25', () => {
  const { byNote } = parseMidiMapping(fixtureYaml);
  const dead = [...byNote.entries()].filter(([, m]) => m.deadInit).map(([n]) => n).sort((a, b) => a - b);
  assert.deepEqual(dead, [25, 35, 54], 'three panels start dead in the fixture');
  for (const [note, m] of byNote) {
    if (![25, 35, 54].includes(note)) assert.equal(m.deadInit, false, `note ${note} should be alive`);
  }
});

test('(!) suffix parsing is per-token (mixed dead/alive in one row)', () => {
  const { byNote } = parseMidiMapping('grid:\n  - y: 0\n    v: [C1=36(!) D1=38 E1=40(!)]\n');
  const dead = [...byNote.entries()].filter(([, m]) => m.deadInit).map(([n]) => n).sort((a, b) => a - b);
  assert.deepEqual(dead, [36, 40], 'only the (!)-suffixed tokens start dead');
  assert.equal(byNote.get(38).deadInit, false, 'un-suffixed token is alive');
  assert.equal(byNote.get(36).name, 'C1', 'the (!) suffix is stripped from the parsed name');
});

test('every entry carries a name, coords, and a v/h orientation', () => {
  const { byNote } = parseMidiMapping(fixtureYaml);
  const d5 = byNote.get(86); // first token of row 0 v
  assert.deepEqual(d5, { x: 0, y: 0, orient: 'v', name: 'D5', deadInit: false });
  const b_minus_1 = byNote.get(23); // B-1 — negative octave name must parse
  assert.equal(b_minus_1.name, 'B-1');
  for (const [, m] of byNote) {
    assert.ok(m.orient === 'v' || m.orient === 'h');
    assert.ok(Number.isInteger(m.x) && m.x >= 0);
    assert.ok(Number.isInteger(m.y) && m.y >= 0);
    assert.ok(typeof m.name === 'string' && m.name.length > 0);
  }
});

test('byKey round-trips: "x,y,orient" -> note -> same coords', () => {
  const { byNote, byKey } = parseMidiMapping(fixtureYaml);
  for (const [note, m] of byNote) {
    assert.equal(byKey.get(`${m.x},${m.y},${m.orient}`), note);
  }
});

// ---- parsing behavior / edge cases -----------------------------------------

test('comma-less flow sequence (js-yaml one-string quirk) splits on whitespace', () => {
  // js-yaml parses `[D5=86 D7=110]` as a ONE-element array holding the whole string;
  // the parser must join-then-split so each token becomes its own panel at index x.
  const { byNote } = parseMidiMapping('grid:\n  - y: 0\n    v: [A0=21 A#0=22 B0=23]\n');
  assert.equal(byNote.size, 3);
  assert.equal(byNote.get(21).x, 0);
  assert.equal(byNote.get(22).x, 1);
  assert.equal(byNote.get(23).x, 2);
});

test('dashes are skipped and do NOT advance... they DO occupy an x index', () => {
  // A '-' means "no panel here" but still consumes a column, so the token after it
  // keeps its true West->East index.
  const { byNote } = parseMidiMapping('grid:\n  - y: 0\n    v: [C1=36 - E1=40]\n');
  assert.equal(byNote.size, 2);
  assert.equal(byNote.get(36).x, 0);
  assert.equal(byNote.get(40).x, 2, 'the dash holds index 1, so E1 lands at x=2');
});

test('row y comes from the explicit `y:` field, not the array position', () => {
  const { byNote } = parseMidiMapping('grid:\n  - y: 5\n    v: [C1=36]\n');
  assert.equal(byNote.get(36).y, 5);
});

test('missing y falls back to the row index', () => {
  const { byNote } = parseMidiMapping('grid:\n  - v: [C1=36]\n  - v: [E1=40]\n');
  assert.equal(byNote.get(36).y, 0);
  assert.equal(byNote.get(40).y, 1);
});

test('a duplicate note is warned about (last write wins in byNote)', () => {
  const { byNote, warnings } = parseMidiMapping('grid:\n  - y: 0\n    v: [C1=36 D1=36]\n');
  assert.equal(byNote.size, 1, 'both map to note 36');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duplicate note 36/);
  assert.equal(byNote.get(36).name, 'D1', 'later token overwrites');
});

test('an unparseable token is warned about and skipped', () => {
  const { byNote, warnings } = parseMidiMapping('grid:\n  - y: 0\n    v: [C1=36 garbage E1=40]\n');
  assert.equal(byNote.size, 2, 'garbage token dropped');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unparseable token "garbage"/);
});

test('sharp and negative-octave note names parse', () => {
  const { byNote } = parseMidiMapping('grid:\n  - y: 0\n    v: [D#5=87 B-1=23 C#0=25]\n');
  assert.equal(byNote.get(87).name, 'D#5');
  assert.equal(byNote.get(23).name, 'B-1');
  assert.equal(byNote.get(25).name, 'C#0');
});

test('a grid with no rows yields empty maps, not a throw', () => {
  const r = parseMidiMapping('grid: []\n');
  assert.equal(r.byNote.size, 0);
  assert.equal(r.byKey.size, 0);
  assert.deepEqual(r.warnings, []);
});

test('a document with no grid key yields empty maps', () => {
  const r = parseMidiMapping('something: else\n');
  assert.equal(r.byNote.size, 0);
});

test('invalid YAML throws with a clear message', () => {
  assert.throws(() => parseMidiMapping('grid:\n  - : : :\n  bad indent'), /not valid YAML/);
});
