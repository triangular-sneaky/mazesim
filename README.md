# mazesim

A browser-based 3D simulator of a kinetic panel-grid installation: **88 acrylic panels**
hanging from a ceiling grid, each on a motor + counterweight, moving only vertically.
Panels blink (LED glow) and move to 256 discrete heights. Built with Vite + three.js.

## Requirements

- Node.js 18+ and npm
- A Chromium-based browser (Chrome/Edge) with hardware acceleration enabled (WebGL required)

## Run locally

```bash
npm install      # first time only
npm run dev
```

Then open the printed URL (default **http://localhost:5173/**).

## Other commands

```bash
npm run build    # production build -> dist/
npm run preview  # serve the built dist/ locally
```

> Note: `npm run preview` may serve JS with the wrong MIME type in some setups. For local
> development use `npm run dev`; for a true production check, use the deployed GitHub Pages
> site.

## Using it

- **Orbit** the view by dragging; **camera presets** (top-left): audience / top-down / inside.
- **walls** checkbox toggles the two white back walls.
- **Grid map** (sidebar): click a cell to select a panel. N is up, W is left.
- **Panel controls**: `single` mode = per-panel target height + blink; `all cells` mode =
  a compact fader board (drag a tile up/down to set height; alt/right-click to blink).
  Left bar = `h` (E–W, amber), right bar = `v` (N–S, blue) — independent.
- **Movements**: grouped, searchable list of coordinated behaviours. `Play` one, `Cycle demos`
  to loop wave/ripple, `Stop` to halt; on load it auto-cycles until you trigger one manually.
- **speed**: one global cruise speed (position-units/sec) for *all* motion. It acts as a
  **tempo** — raising it shortens each movement's period while keeping its shape/heights
  fixed (per-panel travel and cascade timing scale together). Motion is constant-speed with
  a slight ease in/out at the ends.
- **Video overlay**: pick a camera and enable to composite the maze over a live feed — the
  solid walls/floor drop to a wireframe cage so you can register it against a real room.
  Requires camera permission and a secure context (`localhost` or the deployed https site).
- **⇗ pop out**: detach the controls into a separate window.
- On mobile the sidebar collapses; use the **☰ controls** button.

## Configuration

Layout and behaviour are data-driven — no code changes needed:

- **`config/layout.yaml`** — room dimensions, grid spacing, panel/motion/blink defaults,
  counterweight sizing, and the occupied-cell ASCII matrix. Each `X` (any non-space,
  non-`.`) marks a cell that holds a **pair** of panels (one `h` + one `v`). Every occupied
  square is framed on all 4 sides, with shared interior walls drawn once.
- **`config/demos.yaml`** — the demo bank (named timelines of movements/blinks).

Edit either file and reload. Malformed YAML surfaces a clear error banner/console message.

## Panel addressing

Panels are addressed as `(x, y, orient)`:

- `x, y` — 0-based logical cell indices (north on top, west on left)
- `orient` — `h` (East–West face) or `v` (North–South face)

## Architecture

The work splits into **visible** (the 3D model and what it does — this repo) and
**invisible** (external MIDI control, deferred). The engine exposes a decoupled action API
(`movePanel`, `blinkPanel`, `moveAll`) with zero three.js dependency, so a future MIDI feed
(e.g. from a Max patch via Web MIDI or an OSC/WebSocket bridge) drives the same surface.

```
config/            layout.yaml, demos.yaml
src/
  main.js          bootstrap
  config/loader.js YAML parse + matrix -> panel list (edge-union)
  model/           grid.js, panel.js, engine.js (action API, no three.js)
  render/          scene.js, panelMesh.js
  ui/              gridMap, controls, cellBoard, demoBank, videoMode, detach, autoReload
  demos/player.js  runs demo timelines against the action API
```

## Deployment

Pushes to `main` deploy to GitHub Pages via `.github/workflows/deploy.yml`. Open tabs
auto-reload when a new build ships (`src/ui/autoReload.js`).
