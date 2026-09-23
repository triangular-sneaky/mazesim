/**
 * Physical-maze panel <-> cell geometry — the SINGLE source of truth for the
 * `h` = SOUTH-edge, `v` = EAST-edge convention (matches Grid.placement and
 * midi-mapping.yaml). Every movement that reasons about where a panel sits, or which
 * panels frame a cell, must go through here so the convention can never drift again.
 *
 * Cell (x,y) occupies [x,x+1] × [y,y+1] in cell units (X = W→E, Y = N→S). Its four
 * bounding walls are each shared with a neighbour:
 *
 *        h(x,y-1)  ← north
 *      ┌───────────┐
 * west │           │ east
 * v(x-1,y)  (x,y)  v(x,y)
 *      └───────────┘
 *        h(x,y)    ← south
 *
 * Equivalently: h(x,y) is the SOUTH wall of cell (x,y) and the NORTH wall of (x,y+1);
 * v(x,y) is the EAST wall of (x,y) and the WEST wall of (x+1,y).
 */

/**
 * Planar (cell-unit) center of a panel. `h` spans E–W along the cell's south edge, so its
 * center is (x+0.5, y+1); `v` spans N–S along the east edge, so its center is (x+1, y+0.5).
 * @returns {{px:number, py:number}}
 */
export const panelCenter = (x, y, orient) =>
  orient === 'h' ? { px: x + 0.5, py: y + 1 } : { px: x + 1, py: y + 0.5 };

/**
 * The four edge-wall panels around cell (x,y), as {x,y,orient} addresses.
 * @returns {{north:object, south:object, west:object, east:object}}
 */
export const cellEdges = (x, y) => ({
  north: { x, y: y - 1, orient: 'h' },
  south: { x, y, orient: 'h' },
  west: { x: x - 1, y, orient: 'v' },
  east: { x, y, orient: 'v' },
});

/** The four edge panels as a flat list, in N, S, W, E order. */
export const cellEdgeList = (x, y) => {
  const e = cellEdges(x, y);
  return [e.north, e.south, e.west, e.east];
};

/** Key string for a panel address, matching the "x,y,orient" convention used across the app. */
export const edgeKey = ({ x, y, orient }) => `${x},${y},${orient}`;

/**
 * The field's SE "rim": the EAST wall (easternmost vertical wall of each full-width row) plus the
 * SE staircase's OUTER STEPPED EDGE (south-facing h walls + the staircase's east-facing v walls).
 * This is the same silhouette the Flowie "Diagonal" lights on its E/SE side. Given the live panel
 * list, returns the rim panels as {x,y,orient} addresses.
 */
export function seRimPanels(panels) {
  const occupied = new Set(panels.map((p) => `${p.x},${p.y}`));
  const has = (x, y) => occupied.has(`${x},${y}`);
  const maxX = Math.max(...panels.map((p) => p.x));
  const maxVxByRow = new Map();
  for (const p of panels) if (p.orient === 'v') maxVxByRow.set(p.y, Math.max(maxVxByRow.get(p.y) ?? -Infinity, p.x));
  const maxFullWidthRow = Math.max(...panels.filter((p) => p.x === maxX).map((p) => p.y));
  const isSouth = (p) => p.orient === 'h' && has(p.x, p.y) && !has(p.x, p.y + 1);
  const isEast = (p) => p.orient === 'v' && has(p.x, p.y) && !has(p.x + 1, p.y);
  const isEwall = (p) => p.orient === 'v' && p.x === maxVxByRow.get(p.y) && p.y <= maxFullWidthRow;
  return panels
    .filter((p) => isEwall(p) || isSouth(p) || (isEast(p) && p.y > maxFullWidthRow))
    .map((p) => ({ x: p.x, y: p.y, orient: p.orient }));
}
