import yaml from 'js-yaml';
// Vite `?raw` imports: the YAML files are bundled as text and reloaded on refresh.
import layoutText from '../../config/layout.yaml?raw';
import demosText from '../../config/demos.yaml?raw';
import loopsText from '../../config/loops.yaml?raw';
import midiMappingText from '../../config/midi-mapping.yaml?raw';
import { parseMidiMapping } from './midiMapping.js';

/**
 * Parse the layout YAML into a validated config object plus an expanded panel list.
 * Throws with a clear message on malformed input.
 * @returns {{ config: object, cells: {x:number,y:number}[], panels: {x:number,y:number,orient:'h'|'v'}[] }}
 */
export function loadLayout() {
  let doc;
  try {
    doc = yaml.load(layoutText);
  } catch (e) {
    throw new Error(`layout.yaml is not valid YAML: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object') throw new Error('layout.yaml is empty or not a mapping');
  for (const key of ['room', 'grid', 'panel', 'motion', 'blink', 'layout']) {
    if (!(key in doc)) throw new Error(`layout.yaml missing required section: "${key}"`);
  }
  if (typeof doc.layout !== 'string') throw new Error('layout.layout must be a block string matrix');

  const cells = parseMatrix(doc.layout);
  const panels = expandPanels(cells);
  return { config: doc, cells, panels };
}

/**
 * Expand occupied cells into panels by emitting EVERY bounding edge of the region,
 * with shared interior edges drawn once. This guarantees every square is framed on
 * all four sides (no 2-sided cells along the wedge boundary).
 *   - `h` (x,y) = horizontal wall on the north edge of cell-row y (spans column x)
 *   - `v` (x,y) = vertical wall on the west edge of cell-column x (spans row y)
 * A cell (x,y) is thus enclosed by h(x,y)+h(x,y+1)+v(x,y)+v(x+1,y).
 */
export function expandPanels(cells) {
  const h = new Set(); // horizontal walls, keyed "x,yEdge"
  const v = new Set(); // vertical walls, keyed "xEdge,y"
  for (const c of cells) {
    h.add(`${c.x},${c.y}`);       // north
    h.add(`${c.x},${c.y + 1}`);   // south
    v.add(`${c.x},${c.y}`);       // west
    v.add(`${c.x + 1},${c.y}`);   // east
  }
  const panels = [];
  for (const k of h) { const [x, y] = k.split(',').map(Number); panels.push({ x, y, orient: 'h' }); }
  for (const k of v) { const [x, y] = k.split(',').map(Number); panels.push({ x, y, orient: 'v' }); }
  return panels;
}

/**
 * Parse the ASCII occupied-cell matrix.
 * Row index = y (north->south), column index = x (west->east).
 * Any non-space, non-'.' character marks an occupied cell.
 */
export function parseMatrix(text) {
  const rows = text.replace(/\r/g, '').split('\n');
  const cells = [];
  let y = 0;
  for (const raw of rows) {
    // Drop spaces used purely for readability; each remaining glyph is one column.
    const chars = raw.replace(/ /g, '');
    if (chars.length === 0 && raw.trim() === '') {
      // Skip fully blank lines entirely (don't advance y) so trailing newline is harmless.
      continue;
    }
    for (let x = 0; x < chars.length; x++) {
      if (chars[x] !== '.') cells.push({ x, y });
    }
    y++;
  }
  return cells;
}

/**
 * Load + parse `config/midi-mapping.yaml` (the physical maze's note→panel map) from the
 * bundled `?raw` text. The parsing lives in the pure, unit-tested `parseMidiMapping`.
 */
export function loadMidiMapping() {
  return parseMidiMapping(midiMappingText);
}

export function loadDemos() {
  let doc;
  try {
    doc = yaml.load(demosText);
  } catch (e) {
    throw new Error(`demos.yaml is not valid YAML: ${e.message}`);
  }
  const demos = doc && Array.isArray(doc.demos) ? doc.demos : [];
  return demos;
}

/**
 * Parse a BLOCK matrix — the same glyph-per-column style as parseMatrix, but each
 * glyph is captured as a block label instead of just marking occupancy.
 * '.' (and spaces, which are stripped) = a cell in no block.
 * @returns {{x:number,y:number,block:string}[]}
 */
export function parseBlockMatrix(text) {
  const rows = text.replace(/\r/g, '').split('\n');
  const out = [];
  let y = 0;
  for (const raw of rows) {
    const chars = raw.replace(/ /g, '');
    if (chars.length === 0 && raw.trim() === '') continue; // skip blank lines, don't advance y
    for (let x = 0; x < chars.length; x++) {
      if (chars[x] !== '.') out.push({ x, y, block: chars[x] });
    }
    y++;
  }
  return out;
}

/**
 * Load loop definitions from loops.yaml. Each entry maps cells to blocks via a
 * `blocks` matrix; cells sharing a glyph form one block (a slab that moves in unison).
 * Returns entries with their cells grouped per block, ready for the `loop` generator.
 * @returns {{id:string,name:string,desc:string,groups:{block:string,cells:{x:number,y:number}[]}[],params:object}[]}
 */
export function loadLoops() {
  let doc;
  try {
    doc = yaml.load(loopsText);
  } catch (e) {
    throw new Error(`loops.yaml is not valid YAML: ${e.message}`);
  }
  const entries = doc && Array.isArray(doc.loops) ? doc.loops : [];
  return entries.map((e) => {
    if (typeof e.blocks !== 'string') {
      throw new Error(`loop "${e.id ?? '(no id)'}" must have a "blocks" matrix string`);
    }
    if (!e.behavior) {
      throw new Error(`loop "${e.id ?? '(no id)'}" must have a "behavior" field`);
    }
    // Merge behavior defaults (top-level section named by behavior) with per-entry params.
    const behaviorDef = (doc && typeof doc[e.behavior] === 'object') ? doc[e.behavior] : {};
    // `generator` inside the behavior section lets a behavior reuse an existing generator
    // with different default params — without any new code. Falls back to behavior name.
    const generator = behaviorDef.generator ?? e.behavior;
    const { generator: _drop, ...defaults } = behaviorDef; // strip generator key from params
    const params = { ...defaults, ...(e.params || {}) };

    // 'x'/'X' mark occupied-but-unassigned cells (like '.', they join no block).
    const RESERVED = new Set(['x', 'X']);
    const byBlock = new Map();
    for (const { x, y, block } of parseBlockMatrix(e.blocks)) {
      if (RESERVED.has(block)) continue;
      if (!byBlock.has(block)) byBlock.set(block, []);
      byBlock.get(block).push({ x, y });
    }
    const groups = [...byBlock.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
      .map(([block, cells]) => ({ block, cells }));
    return { id: e.id, name: e.name, desc: e.desc, behavior: e.behavior, generator, groups, params };
  });
}
