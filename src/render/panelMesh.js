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

    /** @type {Map<string,{mesh:THREE.Mesh, line:THREE.Line, panel:object}>} */
    this.items = new Map();

    this.group = new THREE.Group();
    this.stringMat = new THREE.LineBasicMaterial({ color: 0x1c1e22 });

    for (const panel of panels) {
      const item = this._build(panel);
      this.items.set(panel.key, item);
    }
    scene.add(this.group);
    this.sync(); // place at initial positions
  }

  _build(panel) {
    const pl = this.grid.placement(panel);
    const geo = new THREE.BoxGeometry(pl.size.x, pl.size.y, pl.size.z);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xfff6e8,
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

    return { mesh, line, panel };
  }

  /** Highlight a selected panel (or clear with null). */
  setSelected(key) {
    for (const [k, item] of this.items) {
      const selected = k === key;
      item.mesh.material.color.set(selected ? 0x9ec5ff : 0xfff6e8);
    }
  }

  /** Push current engine state into the meshes. Call every frame. */
  sync() {
    const g = this.grid;
    for (const item of this.items.values()) {
      const p = item.panel;
      const pl = g.placement(p);
      item.mesh.position.set(pl.center.x, pl.center.y, pl.center.z);
      item.mesh.material.emissiveIntensity = this.baseEmissive + p.brightness * this.glowRange;

      // String: from ceiling straight down to panel top.
      const topY = pl.center.y + g.panelHeight / 2;
      const pts = item.line.geometry.attributes.position;
      pts.setXYZ(0, pl.center.x, this.ceilingY, pl.center.z);
      pts.setXYZ(1, pl.center.x, topY, pl.center.z);
      pts.needsUpdate = true;
    }
  }
}
