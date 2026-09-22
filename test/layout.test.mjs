import test from 'node:test';
import assert from 'node:assert/strict';
import { panelCenter, cellEdges, cellEdgeList, edgeKey } from '../src/model/layout.js';

// The physical convention: h = SOUTH edge, v = EAST edge (matches Grid.placement).

test('panelCenter: h spans E-W on the south edge, v spans N-S on the east edge', () => {
  assert.deepEqual(panelCenter(2, 3, 'h'), { px: 2.5, py: 4 }); // south edge of (2,3): z = y+1
  assert.deepEqual(panelCenter(2, 3, 'v'), { px: 3, py: 3.5 }); // east edge of (2,3):  x = x+1
});

test('cellEdges: north/west are shared with the up/left neighbours, south/east are the cell own', () => {
  assert.deepEqual(cellEdges(4, 5), {
    north: { x: 4, y: 4, orient: 'h' },   // h(x,y-1)
    south: { x: 4, y: 5, orient: 'h' },   // h(x,y)
    west:  { x: 3, y: 5, orient: 'v' },   // v(x-1,y)
    east:  { x: 4, y: 5, orient: 'v' },   // v(x,y)
  });
});

test('a shared wall is named consistently from both cells it divides', () => {
  // h(x,y) is the SOUTH wall of (x,y) and the NORTH wall of (x,y+1).
  assert.equal(edgeKey(cellEdges(4, 5).south), edgeKey(cellEdges(4, 6).north));
  // v(x,y) is the EAST wall of (x,y) and the WEST wall of (x+1,y).
  assert.equal(edgeKey(cellEdges(4, 5).east), edgeKey(cellEdges(5, 5).west));
});

test('cellEdgeList is [north, south, west, east]', () => {
  assert.deepEqual(cellEdgeList(1, 1).map(edgeKey), ['1,0,h', '1,1,h', '0,1,v', '1,1,v']);
});
