import { defineConfig } from 'vite';

// Config YAML is imported as raw text (see src/config/loader.js) via Vite's
// `?raw` suffix, so it works in both dev and build with no static-copy step.
// Editing a layout/demo file just needs a browser reload.
//
// `base` is set to the GitHub Pages project sub-path for production builds
// (site served at https://triangular-sneaky.github.io/mazesim/), and left at
// root for local dev so `npm run dev` stays at http://localhost:5173/.
export default defineConfig(({ command }) => ({
  root: '.',
  base: command === 'build' ? '/mazesim/' : '/',
  server: { open: true },
}));
