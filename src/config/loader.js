import yaml from 'js-yaml';
// Vite `?raw` imports: the YAML files are bundled as text and reloaded on refresh.
import layoutText from '../../config/layout.yaml?raw';
import demosText from '../../config/demos.yaml?raw';

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
