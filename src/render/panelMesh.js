import * as THREE from 'three';

/**
 * Builds and updates the visual meshes for every panel: a translucent, emissive
 * acrylic slab plus a hanging string from the ceiling. Reads panel state each
 * frame (position -> world Y, brightness -> emissive glow). No engine mutation.
 */
export class PanelMeshes {
  constructor(scene, config, grid, panels) {
    this.grid = grid;
    this.config = config;
    this.ceilingY = config.room.height - 0.15;
    this.baseEmissive = config.panel.baseEmissive ?? 0.0; // off panels emit nothing
    this.glowRange = 1.6;       // emissive added at full blink brightness
    this.emissiveColor = config.panel.emissive ?? '#fff1d6';
    // Diffuse color hit by room lights when a panel is OFF (emissive glow ignores this).
    // Darken in layout.yaml to widen the on/off contrast without touching the glow.
    this.panelColor = new THREE.Color(config.panel.color ?? '#fff6e8');
    this.selectedColor = new THREE.Color(0x9ec5ff); // highlight for the picked panel
    this.deadColor = new THREE.Color(0x3a3d42);     // greyed-out dead panels (unlit)

    this.selectedKey = null;      // currently highlighted panel key (or null)
    this.deadKeys = new Set();    // panel keys parked as dead: grey + unlit

    /** @type {Map<string,{mesh:THREE.Mesh, line:THREE.Line, panel:object}>} */
    this.items = new Map();

    this.group = new THREE.Group();
    this.stringMat = new THREE.LineBasicMaterial({ color: 0x1c1e22 });

    // Shared counterweight geometry + brushed-metal material (one instance per panel).
    this.cwGeo = new THREE.CylinderGeometry(grid.cwRadius, grid.cwRadius, grid.cwHeight, 10);
    this.cwMat = new THREE.MeshStandardMaterial({ color: 0x9a9488, metalness: 0.85, roughness: 0.35 });

    for (const panel of panels) {
      const item = this._build(panel);
      this.items.set(panel.key, item);
    }
    this._clusterCounterweights();
    scene.add(this.group);
    this.sync(); // place at initial positions
  }

  _build(panel) {
    const pl = this.grid.placement(panel);
    const geo = new THREE.BoxGeometry(pl.size.x, pl.size.y, pl.size.z);
    const mat = new THREE.MeshStandardMaterial({
      color: this.panelColor.clone(),
      emissive: new THREE.Color(this.emissiveColor),
      emissiveIntensity: this.baseEmissive,
      transparent: true,
      opacity: this.config.panel.opacity,
      roughness: 0.3,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.key = panel.key;
    this.group.add(mesh);

    // Hanging string from ceiling to top of panel.
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0),
    ]), this.stringMat);
    this.group.add(line);

    // Counterweight: a metal cylinder on its own cable. Its hang-point (cwX,cwZ) is
    // assigned later by _clusterCounterweights() so weights bunch 4-to-a-point.
    const cw = new THREE.Mesh(this.cwGeo, this.cwMat);
    this.group.add(cw);
    const cwLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0),
    ]), this.stringMat);
    this.group.add(cwLine);

    return { mesh, line, panel, cw, cwLine, cwX: 0, cwZ: 0 };
  }

  /**
   * Group counterweights into bunches of 4 at shared hang-points (not one per grid
   * node). Panels are ordered by location so each bunch is spatially local; the 4
   * weights sit in a tight 2x2 around the bunch's centroid.
   */
  _clusterCounterweights() {
    const arr = [...this.items.values()].sort((a, b) => {
      const pa = a.panel, pb = b.panel;
      return pa.y - pb.y || pa.x - pb.x || (pa.orient < pb.orient ? -1 : 1);
    });
    const o = 0.028; // tight bunch spacing
    const offsets = [[-o, -o], [o, -o], [-o, o], [o, o]];
    for (let i = 0; i < arr.length; i += 4) {
      const bunch = arr.slice(i, i + 4);
      let cx = 0, cz = 0;
      for (const it of bunch) {
        const n = this.grid.cellNW(it.panel.x, it.panel.y);
        cx += n.x; cz += n.z;
      }
      cx /= bunch.length; cz /= bunch.length;
      bunch.forEach((it, k) => {
        it.cwX = cx + offsets[k % 4][0];
        it.cwZ = cz + offsets[k % 4][1];
      });
    }
  }

  /** Highlight a selected panel (or clear with null). Applied in sync(). */
  setSelected(key) { this.selectedKey = key; }

  /** Mark a set of panel keys dead: greyed and forced unlit. Applied in sync(). */
  setDead(keys) { this.deadKeys = new Set(keys); }

  /** Push current engine state into the meshes. Call every frame. */
  sync() {
    const g = this.grid;
    for (const item of this.items.values()) {
      const p = item.panel;
      const pl = g.placement(p);
      item.mesh.position.set(pl.center.x, pl.center.y, pl.center.z);

      // Color + glow: dead panels are grey and unlit; otherwise selected → highlight,
      // else the base diffuse, with emissive tracking brightness.
      const dead = this.deadKeys.has(p.key);
      if (dead) {
        item.mesh.material.color.copy(this.deadColor);
        item.mesh.material.emissiveIntensity = 0;
      } else {
        item.mesh.material.color.copy(p.key === this.selectedKey ? this.selectedColor : this.panelColor);
        item.mesh.material.emissiveIntensity = this.baseEmissive + p.brightness * this.glowRange;
      }

      // String: from ceiling straight down to panel top.
      const topY = pl.center.y + g.panelHeight / 2;
      const pts = item.line.geometry.attributes.position;
      pts.setXYZ(0, pl.center.x, this.ceilingY, pl.center.z);
      pts.setXYZ(1, pl.center.x, topY, pl.center.z);
      pts.needsUpdate = true;

      // Counterweight moves inversely; its cable hangs from the ceiling to the weight.
      const cwY = g.counterweightHeight(p.position);
      item.cw.position.set(item.cwX, cwY, item.cwZ);
      const cwTop = cwY + g.cwHeight / 2;
      const cpts = item.cwLine.geometry.attributes.position;
      cpts.setXYZ(0, item.cwX, this.ceilingY, item.cwZ);
      cpts.setXYZ(1, item.cwX, cwTop, item.cwZ);
      cpts.needsUpdate = true;
    }
  }
}
