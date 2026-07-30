import { loadLayout, loadDemos } from './config/loader.js';
import { Grid } from './model/grid.js';
import { PanelEngine } from './model/engine.js';
import { SceneView } from './render/scene.js';
import { PanelMeshes } from './render/panelMesh.js';
import { GridMap } from './ui/gridMap.js';
import { Controls } from './ui/controls.js';
import { CellBoard } from './ui/cellBoard.js';
import { DemoBank } from './ui/demoBank.js';
import { DemoPlayer } from './demos/player.js';
import { setupDetach } from './ui/detach.js';

function fail(msg) {
  const banner = document.getElementById('error-banner');
  banner.style.display = 'block';
  banner.textContent = msg;
  console.error(msg);
}

function main() {
  let config, cells, panels, demos;
  try {
    ({ config, cells, panels } = loadLayout());
    demos = loadDemos();
  } catch (e) {
    fail(`Config error:\n${e.message}`);
    return;
  }

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
  new DemoBank(document.getElementById('demo-list'), demos, player);

  // Camera presets
  document.querySelectorAll('#camera-presets [data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => view.setPreset(btn.dataset.preset));
  });

  // Walls toggle
  const wallsToggle = document.getElementById('toggle-walls');
  wallsToggle.addEventListener('change', () => view.setWallsVisible(wallsToggle.checked));

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
    meshes.sync();
    gridMap.draw();
    cellBoard.draw();
    controls.refresh();
    view.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  console.log(`mazesim: ${cells.length} cells, ${panels.length} panels loaded.`);
}

main();
