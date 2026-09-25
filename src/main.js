import { loadLayout, loadDemos, loadLoops, loadMidiMapping } from './config/loader.js';
import { MazeState } from './model/mazeState.js';
import { MazeHud } from './ui/mazeHud.js';
import { Grid } from './model/grid.js';
import { MazeEngine } from './model/mazeEngine.js';
import { SceneView } from './render/scene.js';
import { PanelMeshes } from './render/panelMesh.js';
import { GridMap } from './ui/gridMap.js';
import { Controls } from './ui/controls.js';
import { CellBoard } from './ui/cellBoard.js';
import { DemoBank } from './ui/demoBank.js';
import { PrisonMode } from './ui/prisonMode.js';
import { LullabyFloat } from './ui/lullabyFloat.js';
import { BlanketMode } from './ui/blanketMode.js';
import { MidiMode } from './ui/midiMode.js';
import { MazeMidiController } from './ui/mazeMidiController.js';
import { VideoMode } from './ui/videoMode.js';
import { DemoPlayer } from './demos/player.js';
import { BackgroundClock } from './ui/backgroundClock.js';
import { setupDetach } from './ui/detach.js';
import { startAutoReload } from './ui/autoReload.js';

function fail(msg) {
  const banner = document.getElementById('error-banner');
  banner.style.display = 'block';
  banner.textContent = msg;
  console.error(msg);
}

/**
 * Sanity-check the MIDI note map against the engine and the known hardware facts.
 * Warns (never throws) — the physical map is the source of truth; a mismatch means the
 * sim layout drifted, not that the map is wrong.
 */
function validateMidiMap(map, engine) {
  for (const w of map.warnings) console.warn(`midi-map: ${w}`);
  const notes = [...map.byNote.keys()].sort((a, b) => a - b);
  if (notes.length !== 86) console.warn(`midi-map: expected 86 panels, got ${notes.length}`);
  const expected = new Set();
  for (let n = 23; n <= 110; n++) if (n !== 83 && n !== 108) expected.add(n);
  for (const n of notes) if (!expected.has(n)) console.warn(`midi-map: unexpected note ${n} (outside 23..110 minus {83,108})`);
  for (const n of expected) if (!map.byNote.has(n)) console.warn(`midi-map: missing expected note ${n}`);
  for (const [note, m] of map.byNote) {
    if (!engine.get(m.x, m.y, m.orient)) {
      console.warn(`midi-map: note ${note} (${m.name}) -> ${m.orient}(${m.x},${m.y}) has no engine panel`);
    }
  }
}

/**
 * Make every sidebar `.section` collapsible: a caret in the header folds the body away.
 * Collapsed state persists in localStorage so the operator's layout survives a reload.
 * Clicks that land on an interactive header control (the mode seg, buttons, inputs) are
 * ignored so they don't also toggle the fold.
 */
function setupCollapsibleSections() {
  const KEY = 'sectionCollapsed.v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  const sections = [...document.querySelectorAll('#sidebar .section')];
  const persist = () => {
    const state = {};
    for (const s of sections) state[s.dataset.key] = s.classList.contains('collapsed');
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
  };
  sections.forEach((section, i) => {
    const h2 = section.querySelector('h2');
    if (!h2) return;
    const key = section.id || `sec-${i}`;
    section.dataset.key = key;
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = '▸';
    h2.prepend(caret);
    if (saved[key]) section.classList.add('collapsed');
    h2.addEventListener('click', (e) => {
      if (e.target.closest('button, input, select, .seg')) return; // header control, not a fold
      section.classList.toggle('collapsed');
      persist();
    });
  });
}

function main() {
  // Reload the tab automatically when a newer build is deployed (runs regardless of
  // whether the 3D view initializes, so a WebGL-failed page still self-updates).
  startAutoReload();

  let config, cells, panels, demos, loops, midiMap;
  try {
    // layout.yaml supplies only the dimensions (room/grid/panel/motion/blink). The panel
    // SET — which walls exist and where — is the physical maze itself, read from
    // midi-mapping.yaml, so the 3D view is the real 86-panel layout (h=south, v=east).
    ({ config } = loadLayout());
    midiMap = loadMidiMapping();
    panels = [...midiMap.byNote.values()].map((m) => ({ x: m.x, y: m.y, orient: m.orient }));
    const seen = new Set();
    cells = [];
    for (const p of panels) {
      const k = `${p.x},${p.y}`;
      if (!seen.has(k)) { seen.add(k); cells.push({ x: p.x, y: p.y }); }
    }
    demos = loadDemos();
    loops = loadLoops();
  } catch (e) {
    fail(`Config error:\n${e.message}`);
    return;
  }

  // Each loops.yaml entry becomes a movement under the "3-Loops 🎤" group, inserted after Prison.
  const loopDemos = loops.map((lp) => ({
    id: lp.id, name: lp.name, desc: lp.desc, group: '3-Loops 🎤',
    generator: lp.generator, params: { groups: lp.groups, ...lp.params },
    uiParams: lp.uiParams,
  }));
  if (loopDemos.length) {
    const lastPrison = [...demos].map((d, i) => d.group === 'prison' ? i : -1).filter((i) => i >= 0).pop();
    const after = lastPrison != null ? lastPrison + 1 : demos.length;
    demos.splice(after, 0, ...loopDemos);
  }

  try {
    const grid = new Grid(config);

    // Background-safe clock: drives the control path (movement ticks + MIDI pacing) from the
    // audio thread so it keeps running when the tab is hidden (rAF pauses / timers throttle).
    const clock = new BackgroundClock();
    const clockTimers = {
      schedule: (fn, ms) => clock.setTimeout(fn, ms),
      unschedule: (id) => clock.clearTimeout(id),
    };
    // Unlock the audio heartbeat on the first user gesture (autoplay policy), and re-check when
    // the tab becomes visible again.
    const unlockClock = () => clock.resume();
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
      window.addEventListener(ev, unlockClock, { once: true }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) clock.resume(); });

    // Transport + tracked belief must exist BEFORE the engine: the engine is state-backed —
    // every movement drives belief -> MIDI -> mirror to 3D — so it needs both. (midiMap was
    // loaded up top; it also drives the engine's panel set.) The transport paces through the
    // background clock so MIDI keeps flowing in a hidden tab.
    const mazeMidi = new MazeMidiController({ ...(config.midi || {}), ...clockTimers });
    const mazeState = new MazeState(midiMap.byNote);
    const engine = new MazeEngine(config, panels, { state: mazeState, midi: mazeMidi });

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

    // Demos — scheduled on the background clock so timeline movements keep firing when hidden.
    const player = new DemoPlayer(engine, clockTimers);

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
    const lullabyFloat = new LullabyFloat(engine);
    const blanket = new BlanketMode(engine, cells);
    const midi = new MidiMode(engine, { player });

    // Mount MIDI as a persistent sidebar section — not a movement.
    document.getElementById('midi-section').appendChild(midi.el);

    // MIDI investigation: sends note messages OUT to the physical maze (transport built above).
    document.getElementById('midi-investigation-section').appendChild(mazeMidi.el);

    // Stateful physical-maze control: note map -> per-panel (z,v) tracker -> HUD (both built above).
    validateMidiMap(midiMap, engine);
    const mazeHud = new MazeHud(document.getElementById('maze-hud-section'), {
      engine, grid, view, state: mazeState, midi: mazeMidi,
      viewport, cells, meshes,
    });

    const demoBank = new DemoBank(document.getElementById('demo-list'), demos, player, {
      onManual: stopCycle,
      onCycle: startCycle,
      searchEl: document.getElementById('move-search'),
      controllers: { prison, 'lullaby-float': lullabyFloat, blanket },
      engine,
      collapseAll: true, // all groups start collapsed; user expands as needed
    });

    // Panic (either panic button routes through mazeMidi.panic) stops ALL movements first —
    // the timeline player, any interactive controller, and the auto-cycle — then kills lights.
    mazeMidi.onPanic = () => { stopCycle(); demoBank.stopAll(); };
    // A bulk "Fix to 0/8" in the maze HUD stops all movements first (so nothing keeps driving).
    mazeHud.onStop = () => { stopCycle(); demoBank.stopAll(); };
    // On load we do NOT auto-play a movement: the sim now mirrors tracked belief (persisted or
    // neutral), and playing "all up" would drive the real maze (state -> MIDI) on every reload.
    // The demo cycle is still available via the "Cycle demos" button.

    // Global movement speed (cruise units/sec) — applies to every movement.
    const speed = document.getElementById('move-speed');
    const speedVal = document.getElementById('move-speed-val');
    speed.value = engine.speed;
    speedVal.value = engine.speed;
    speed.addEventListener('input', () => {
      engine.setSpeed(Number(speed.value));
      speedVal.value = speed.value;
    });
    speedVal.addEventListener('change', () => {
      const v = Math.max(20, Math.min(400, Math.round(Number(speedVal.value) || 0)));
      speedVal.value = v; speed.value = v; engine.setSpeed(v);
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
    fovVal.value = view.camera.fov;
    fov.addEventListener('input', () => {
      view.setFov(Number(fov.value));
      fovVal.value = fov.value;
    });
    fovVal.addEventListener('change', () => {
      const v = Math.max(20, Math.min(120, Math.round(Number(fovVal.value) || 0)));
      fovVal.value = v; fov.value = v; view.setFov(v);
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

    // Fold/unfold sidebar sections (state persisted). Run after every section is mounted.
    setupCollapsibleSections();

    // CONTROL loop — the state simulation + anything that generates MIDI. Runs on the
    // background-safe clock so it keeps advancing (and sending) when the tab is hidden.
    clock.onTick((dt) => {
      engine.tick(dt);       // advance panel motion (positions the movements read back)
      prison.tick(dt);       // drives caged panels; no-op unless its controls are open
      lullabyFloat.tick(dt); // elastic follow; no-op when inactive
      midi.tick(dt);         // re-asserts held brightness; mutes movement LEDs when mute is on
      mazeHud.tick(dt);      // mirror tracked belief onto the sim (sim = physical belief)
    });

    // RENDER loop — drawing only. rAF naturally pauses when the tab is hidden; nothing to draw.
    function frame() {
      meshes.sync();
      gridMap.draw();
      cellBoard.draw();
      mazeHud.draw();          // 2D belief canvas
      controls.refresh();
      view.render();
      mazeHud.updateOverlay(); // reposition virtual chips against the fresh camera
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
