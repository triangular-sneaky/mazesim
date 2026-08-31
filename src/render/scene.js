import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * Builds the three.js scene: dark room shell, floor, ceiling rail hint, lighting,
 * camera + OrbitControls, and named camera presets. Rendering of panels is added
 * by panelMesh.js into `scene`.
 */
export class SceneView {
  constructor(container, config, grid, cells) {
    this.config = config;
    this.grid = grid;

    const room = config.room;
    // alpha:true lets us clear the canvas to transparent in video mode, so a live
    // camera feed behind the (DOM) canvas shows through around the maze.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(0x07080a, 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this._fog = new THREE.Fog(0x07080a, 10, 26);
    this.scene.fog = this._fog;

    this.camera = new THREE.PerspectiveCamera(
      55, container.clientWidth / container.clientHeight, 0.1, 100,
    );

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // Look at the center of the occupied field.
    const b = grid.bounds(cells);
    this.fieldBounds = b;
    this.fieldCenter = new THREE.Vector3(
      (b.minX + b.maxX) / 2,
      (grid.travelMin + grid.travelMax) / 2,
      (b.minZ + b.maxZ) / 2,
    );
    this.controls.target.copy(this.fieldCenter);

    this._buildRoom(room);
    this._buildLights(room);
    this._buildFigure(room);
    this.setPreset('audience');

    window.addEventListener('resize', () => this._onResize(container));
  }

  _buildRoom(room) {
    const w = room.width, d = room.depth, h = room.height;

    // Floor — warm concrete that catches the light pool.
    const floorGeo = new THREE.PlaneGeometry(w, d);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x2a2018, roughness: 0.95, metalness: 0.0,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(w / 2, 0, d / 2);
    this.scene.add(floor);
    this.floor = floor;

    // Wireframe room outline (all 12 box edges). Hidden normally; in video mode the solid
    // floor/walls are hidden and only this edge cage is drawn, to register the virtual
    // room against the real one in the camera feed.
    const roomEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
      new THREE.LineBasicMaterial({ color: 0x6ea8ff }),
    );
    roomEdges.position.set(w / 2, h / 2, d / 2);
    roomEdges.visible = false;
    this.scene.add(roomEdges);
    this.roomEdges = roomEdges;

    // Two back walls (north at z=0, west at x=0) forming the back-left corner behind
    // the dense field. White material that reads dark under the low light. Toggleable.
    this.walls = new THREE.Group();
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
    });
    const north = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    north.position.set(w / 2, h / 2, 0);               // faces +Z (into room)
    this.walls.add(north);
    const west = new THREE.Mesh(new THREE.PlaneGeometry(d, h), wallMat);
    west.rotation.y = Math.PI / 2;                     // faces +X
    west.position.set(0, h / 2, d / 2);
    this.walls.add(west);
    this.scene.add(this.walls);

    // Ceiling rail hint: thin lines running north->south (front-back) across the field.
    const railMat = new THREE.LineBasicMaterial({ color: 0x2a2d33 });
    const rails = new THREE.Group();
    const g = this.grid;
    // Draw a rail near each grid column line, spanning the room depth, just below ceiling.
    const railY = h - 0.15;
    const cols = 12;
    for (let i = 0; i <= cols; i++) {
      const x = g.originX + i * g.cellWidth;
      if (x > w) break;
      const pts = [new THREE.Vector3(x, railY, 0.5), new THREE.Vector3(x, railY, d - 0.5)];
      rails.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), railMat));
    }
    this.scene.add(rails);

    // Reference marker for the piano (front-left), purely visual context.
    const piano = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 1.0, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.6 }),
    );
    piano.position.set(1.0, 0.5, d - 1.0);
    // this.scene.add(piano); // hidden for now
    this.piano = piano;
  }

  _buildLights(room) {
    // Very low ambient — overall dim; the scattered panel lights carry the room.
    this.scene.add(new THREE.AmbientLight(0x1c1913, 0.22));

    // Faint warm pool on the floor toward the front-center (like the photo).
    const pool = new THREE.SpotLight(0xffd39a, 3, 0, Math.PI / 5, 0.6, 0);
    pool.position.set(room.width * 0.5, room.height, room.depth * 0.72);
    pool.target.position.set(room.width * 0.5, 0, room.depth * 0.72);
    this.scene.add(pool);
    this.scene.add(pool.target);

    // Whisper of cool fill so forms don't go fully black at rest.
    const fill = new THREE.DirectionalLight(0x6b768c, 0.12);
    fill.position.set(room.width * 0.3, room.height, room.depth * 0.2);
    this.scene.add(fill);

    // Scattered warm light fixtures on the ceiling — the room's actual light sources.
    // They illuminate the field and floor from above; panels stay dark until they blink.
    const b = this.fieldBounds;
    const ceilY = room.height - 0.1;
    const spots = [
      [0.25, 0.2], [0.75, 0.25],
      [0.5, 0.5],
      [0.25, 0.8], [0.75, 0.8],
    ];
    for (const [fx, fz] of spots) {
      const x = b.minX + fx * (b.maxX - b.minX);
      const z = b.minZ + fz * (b.maxZ - b.minZ);
      const fixture = new THREE.PointLight(0xffd9a8, 4.8, 9, 2); // 20% dimmer than the original 6
      fixture.position.set(x, ceilY, z);
      this.scene.add(fixture);
      // tiny visible bulb
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffe6bf }),
      );
      bulb.position.copy(fixture.position);
      this.scene.add(bulb);
    }
  }

  _buildFigure(room) {
    // A static, stylized SEATED figure — an East Asian woman — sitting in the middle of
    // cell (2,2) (0-based from top-left) under the panel field, facing into the room.
    // Purely decorative: a handful of cheap primitives grouped so it stays performant.
    // Local model faces +Z (front); the group is rotated so she faces into the room (+X).
    const fig = new THREE.Group();

    // Shared low-poly materials.
    const skin = new THREE.MeshStandardMaterial({ color: 0xe6b98f, roughness: 0.75, metalness: 0.0 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x14100d, roughness: 0.6, metalness: 0.0 });
    const dress = new THREE.MeshStandardMaterial({ color: 0x8f3f52, roughness: 0.85, metalness: 0.0 });

    const seat = 0.45; // hip/seat height (m), as if sitting on a low stool

    // Thighs — horizontal, from the hips forward (+Z) to the knees, at seat height.
    for (const dx of [-0.09, 0.09]) {
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.055, 0.42, 8), skin);
      thigh.rotation.x = Math.PI / 2; // lay the cylinder along +Z
      thigh.position.set(dx, seat, 0.21);
      fig.add(thigh);
    }

    // Shins — vertical, from the knees down to the feet.
    for (const dx of [-0.09, 0.09]) {
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.45, 8), skin);
      shin.position.set(dx, seat - 0.225, 0.42);
      fig.add(shin);
    }

    // Skirt — dress fabric draped over the lap (a low, wide cone stretched over the thighs).
    const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.26, 12), dress);
    skirt.position.set(0, seat + 0.05, 0.12);
    skirt.scale.set(1.0, 1.0, 1.3);
    fig.add(skirt);

    // Torso — a capsule for the upper body, rising from the hips to the shoulders.
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.34, 4, 8), dress);
    torso.position.set(0, seat + 0.27, 0); // ~0.72m
    fig.add(torso);

    // Arms — slim capsules angled forward to rest on the lap.
    for (const dx of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.34, 4, 8), skin);
      arm.position.set(dx * 0.18, seat + 0.24, 0.12);
      arm.rotation.x = 0.9;         // angle forward-down toward the lap
      arm.rotation.z = dx * 0.1;
      fig.add(arm);
    }

    // Neck — short cylinder bridging shoulders to head.
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 8), skin);
    neck.position.set(0, seat + 0.57, 0); // ~1.02m
    fig.add(neck);

    // Head — sphere with skin tone (~1.13m seated).
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), skin);
    head.position.set(0, seat + 0.68, 0);
    fig.add(head);

    // Hair — a slightly larger dark half-sphere cap plus a bun at the back.
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.108, 16, 12), hair);
    cap.position.set(0, seat + 0.70, -0.01);
    cap.scale.set(1.0, 1.05, 1.05);
    fig.add(cap);
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), hair);
    bun.position.set(0, seat + 0.68, -0.11);
    fig.add(bun);

    // Sit in the middle of cell (2,2), facing into the room (+X).
    const nw = this.grid.cellNW(2, 2);
    fig.position.set(nw.x + this.grid.cellWidth / 2, 0, nw.z + this.grid.cellDepth / 2);
    fig.rotation.y = Math.PI / 2; // local +Z front -> +X, into the room
    this.scene.add(fig);
    this.figure = fig;
  }

  /** Toggle the two back walls (remembered so video mode can restore the choice). */
  setWallsVisible(v) {
    this._wallsWanted = v;
    if (this.walls && !this.videoMode) this.walls.visible = v;
  }

  /**
   * Video overlay mode. On: clear to transparent (camera feed shows through the DOM
   * canvas behind it), drop fog, hide the solid room/decor (floor, walls, piano, figure)
   * and draw only the wireframe room cage so the maze can be composited over a real room.
   * Off: restore the normal dark room.
   */
  setVideoMode(on) {
    this.videoMode = on;
    this.scene.fog = on ? null : this._fog;
    this.renderer.setClearColor(0x07080a, on ? 0 : 1);
    if (this.floor) this.floor.visible = !on;
    if (this.piano) this.piano.visible = !on;
    if (this.figure) this.figure.visible = !on;
    if (this.roomEdges) this.roomEdges.visible = on;
    if (this.walls) this.walls.visible = on ? false : (this._wallsWanted ?? true);
  }

  /**
   * Set the camera's vertical field-of-view (degrees). Used in video mode to match the
   * perspective of the physical camera the maze is being overlaid onto.
   */
  setFov(deg) {
    this.camera.fov = deg;
    this.camera.updateProjectionMatrix();
  }

  /** Camera presets framed around the field. */
  setPreset(name) {
    const room = this.config.room;
    const c = this.fieldCenter;
    if (name === 'top') {
      this.camera.position.set(c.x, room.height + 8, c.z + 0.01);
    } else if (name === 'inside') {
      this.camera.position.set(c.x, this.grid.travelMin + 0.3, c.z);
    } else {
      // audience: stand at the front (south), looking north into the field.
      this.camera.position.set(room.width * 0.5, 1.6, room.depth + 3.5);
    }
    this.controls.update();
  }

  _onResize(container) {
    const w = container.clientWidth, h = container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
