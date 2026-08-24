import { loadLayout, loadDemos } from './config/loader.js';
import { Grid } from './model/grid.js';
import { PanelEngine } from './model/engine.js';
import { SceneView } from './render/scene.js';
import { PanelMeshes } from './render/panelMesh.js';
import { GridMap } from './ui/gridMap.js';
import { Controls } from './ui/controls.js';
import { CellBoard } from './ui/cellBoard.js';
import { DemoBank } from './ui/demoBank.js';
import { PrisonMode } from './ui/prisonMode.js';
import { VideoMode } from './ui/videoMode.js';
import { DemoPlayer } from './demos/player.js';
import { setupDetach } from './ui/detach.js';
import { startAutoReload } from './ui/autoReload.js';

function fail(msg) {
  const banner = document.getElementById('error-banner');
  banner.style.display = 'block';
  banner.textContent = msg;
  console.error(msg);
}

function main() {
  // Reload the tab automatically when a newer build is deployed (runs regardless of
  // whether the 3D view initializes, so a WebGL-failed page still self-updates).
  startAutoReload();

  let config, cells, panels, demos;
  try {
    ({ config, cells, panels } = loadLayout());
    demos = loadDemos();
  } catch (e) {
    fail(`Config error:\n${e.message}`);
    return;
  }

  try {
  const grid = new Grid(config);
  const engine = new PanelEngine(config, panels);

  // Render
  const viewport = document.getElementById('viewport');
  const view = new SceneView(viewport, config, grid, cells);
  const meshes = new PanelMeshes(view.scene, config, grid, engine.list());

  // Selection wiring: grid map <-> controls <-> mesh highlight
  const gridMap = new GridMap(
    document.getElementById('grid-map'), engine, cells,
    (x, y) => controls.select(x, y, controls.sel?.orient ?? 'h'),
  );
  const controls = new Controls(
    document.getElementById('controls-body'),
    document.getElementById('selection-label'),
    engine, config,
    (sel) => { gridMap.setSelected(sel.x, sel.y); meshes.setSelected(`${sel.x},${sel.y},${sel.orient}`); },
  );

  // Expanded "all cells" control board (hidden until mode = all)
  const cellBoard = new CellBoard(document.getElementById('cell-board'), engine, cells);

  // Controls mode toggle: single (per-panel) | all (cell board)
  const controlsBody = document.getElementById('controls-body');
  const cellboardWrap = document.getElementById('cellboard-wrap');
  document.querySelectorAll('#ctrl-mode [data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const all = btn.dataset.mode === 'all';
      controlsBody.style.display = all ? 'none' : '';
      cellboardWrap.style.display = all ? '' : 'none';
      document.querySelectorAll('#ctrl-mode [data-mode]').forEach((b) =>
        b.classList.toggle('primary', b === btn));
    });
  });

  // Demos
  const player = new DemoPlayer(engine);

  // Auto-cycle: play a sequence of wave/ripple demos on a repeating timer, advancing
  // every CYCLE_INTERVAL ms and looping back to the start. Runs on load until the user
  // manually triggers a demo (or Stop), and can be restarted via the "Cycle demos" button.
  const CYCLE_SEQUENCE = ['wave-ns', 'wave-we', 'ripple'];
  const CYCLE_INTERVAL = 7000;
  let cycleTimer = null;
  function stopCycle() {
    if (cycleTimer !== null) { clearInterval(cycleTimer); cycleTimer = null; }
  }
  function startCycle() {
    stopCycle();
    let i = 0;
    const step = () => {
      const demo = demos.find((d) => d.id === CYCLE_SEQUENCE[i % CYCLE_SEQUENCE.length]);
      if (demo) player.play(demo);
      i++;
    };
    step();
    cycleTimer = setInterval(step, CYCLE_INTERVAL);
  }

  // Interactive movements (live controllers instead of timelines), keyed by movement id.
  const prison = new PrisonMode(engine, cells, config);

  new DemoBank(document.getElementById('demo-list'), demos, player, {
    onManual: stopCycle,
    onCycle: startCycle,
    searchEl: document.getElementById('move-search'),
    controllers: { prison },
  });
  startCycle();

  // Global movement speed (cruise units/sec) — applies to every movement.
  const speed = document.getElementById('move-speed');
  const speedVal = document.getElementById('move-speed-val');
  speed.value = engine.speed;
  speedVal.textContent = engine.speed;
  speed.addEventListener('input', () => {
    engine.setSpeed(Number(speed.value));
    speedVal.textContent = speed.value;
  });

  // Camera presets
  document.querySelectorAll('#camera-presets [data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => view.setPreset(btn.dataset.preset));
  });

  // Walls toggle
  const wallsToggle = document.getElementById('toggle-walls');
  wallsToggle.addEventListener('change', () => view.setWallsVisible(wallsToggle.checked));

  // Video overlay: transparent scene + wireframe room over a live camera feed.
  new VideoMode(
    document.getElementById('bg-video'),
    document.getElementById('toggle-video'),
    document.getElementById('video-source'),
    (on) => view.setVideoMode(on),
    document.getElementById('video-adjust'),
    (lock) => { view.controls.enabled = !lock; }, // lock the maze while adjusting the video
  );

  // Camera FOV — match the virtual camera's perspective to the physical one (video mode).
  const fov = document.getElementById('video-fov');
  const fovVal = document.getElementById('video-fov-val');
  fov.value = view.camera.fov;
  fovVal.textContent = view.camera.fov;
  fov.addEventListener('input', () => {
    view.setFov(Number(fov.value));
    fovVal.textContent = fov.value;
  });

  // Mobile controls toggle: show/hide the overlay sidebar (button is hidden on desktop).
  const sidebarToggle = document.getElementById('sidebar-toggle');
  sidebarToggle.addEventListener('click', () => {
    const open = document.body.classList.toggle('controls-open');
    sidebarToggle.textContent = open ? '✕ close' : '☰ controls';
  });

  // Detachable controls window (docked by default). Resize the 3D view on dock/detach.
  setupDetach(document.getElementById('sidebar'), () => {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });

  // Animation loop
  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1); // clamp big gaps
    last = now;
    engine.tick(dt);
    prison.tick(dt); // drives caged panels directly; no-op unless its controls are open
    meshes.sync();
    gridMap.draw();
    cellBoard.draw();
    controls.refresh();
    view.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  console.log(`mazesim: ${cells.length} cells, ${panels.length} panels loaded.`);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/webgl|context/i.test(msg)) {
      fail('WebGL could not start, so the 3D view can\'t render.\n\n' +
           'Fix: enable hardware acceleration in your browser settings (or update your GPU driver), ' +
           'then reload. Chrome/Edge: Settings → System → "Use graphics acceleration when available".');
    } else {
      fail(`Init error:\n${(e && e.stack) || e}`);
    }
  }
}

main();
