/**
 * Coordinate helpers: convert logical cell/panel addresses to world-space geometry.
 * Pure math — no three.js. `render/` consumes these.
 *
 * World axes: X = west->east, Z = north->south, Y = up.
 */
export class Grid {
  constructor(config) {
    const g = config.grid;
    this.originX = g.originX;
    this.originZ = g.originZ;
    this.cellWidth = g.cellWidth;
    this.cellDepth = g.cellDepth;

    const p = config.panel;
    this.panelWidth = p.width;
    this.panelHeight = p.height;
    this.panelThickness = p.thickness;

    const m = config.motion;
    this.travelMin = m.travelMin;
    this.travelMax = m.travelMax;

    const cw = config.counterweight || {};
    this.cwRadius = cw.radius ?? 0.028;
    this.cwHeight = cw.height ?? 0.13;
    this.cwMin = cw.travelMin ?? 0.35;   // weight Y when panel is at the top
    this.cwMax = cw.travelMax ?? 1.95;   // weight Y when panel is at the bottom
  }

  /** Counterweight height: inverse of panel position (panel up -> weight down). */
  counterweightHeight(position) {
    const t = position / 255;
    return this.cwMax - (this.cwMax - this.cwMin) * t;
  }

  /** NW corner world (x,z) of a cell. */
  cellNW(x, y) {
    return { x: this.originX + x * this.cellWidth, z: this.originZ + y * this.cellDepth };
  }

  /** Map logical position 0..255 to the panel-center world Y. */
  heightFor(position) {
    const t = position / 255;
    return this.travelMin + (this.travelMax - this.travelMin) * t;
  }

  /**
   * World-space placement of a panel: center point, and the box size along each axis.
   * `h` = the cell's north-edge wall (wide face E-W); `v` = the west-edge wall (N-S).
   * Each panel is centered along its edge and shorter than the cell pitch, leaving
   * equal gaps at both ends — so the corners stay open and every grid square reads as
   * a 4-panel "cube" frame (its own N+W walls plus the S+E walls of its neighbours).
   */
  placement(panel) {
    const nw = this.cellNW(panel.x, panel.y);
    const y = this.heightFor(panel.position);
    if (panel.orient === 'h') {
      return {
        center: { x: nw.x + this.cellWidth / 2, y, z: nw.z },
        size: { x: this.panelWidth, y: this.panelHeight, z: this.panelThickness },
      };
    }
    // 'v'
    return {
      center: { x: nw.x, y, z: nw.z + this.cellDepth / 2 },
      size: { x: this.panelThickness, y: this.panelHeight, z: this.panelWidth },
    };
  }

  /** Extent of the occupied field in world X/Z, for camera framing. */
  bounds(cells) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of cells) {
      const nw = this.cellNW(c.x, c.y);
      minX = Math.min(minX, nw.x);
      maxX = Math.max(maxX, nw.x + this.cellWidth);
      minZ = Math.min(minZ, nw.z);
      maxZ = Math.max(maxZ, nw.z + this.cellDepth);
    }
    return { minX, maxX, minZ, maxZ };
  }
}
