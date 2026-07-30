/**
 * Auto-reload on new deploy, and self-heal a stale (cached) load.
 *
 * GitHub Pages doesn't refresh open tabs when a new build ships, and a browser/CDN
 * can serve a cached index.html pointing at an old bundle. This fetches the app's
 * own index.html (cache-busted) and compares the hashed main-bundle name to the one
 * currently running (`import.meta.url`):
 *   - checks once immediately, so a stale first load corrects itself right away
 *   - then polls every `intervalMs` to catch deploys while the tab stays open
 * When a newer bundle is live it forces a cache-busting navigation (query string) so
 * the fresh index + bundle are fetched even if the plain document was cached.
 *
 * @param {number} intervalMs how often to re-check (default 60s)
 */
export function startAutoReload(intervalMs = 60000) {
  const currentBundle = (import.meta.url.match(/index-[\w-]+\.js/) || [])[0];
  if (!currentBundle) return; // dev mode (unbundled) — nothing to compare

  const indexUrl = `${location.origin}${location.pathname}`;

  async function check() {
    try {
      const res = await fetch(`${indexUrl}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const html = await res.text();
      const latest = (html.match(/index-[\w-]+\.js/) || [])[0];
      if (latest && latest !== currentBundle) {
        console.log(`mazesim: build ${latest} is live (running ${currentBundle}); reloading.`);
        // Cache-busting navigation forces a fresh document even if it was cached.
        location.replace(`${indexUrl}?v=${encodeURIComponent(latest)}`);
      }
    } catch (_) {
      // offline / transient — try again next tick
    }
  }

  check();                       // immediate: fix a stale first load
  setInterval(check, intervalMs); // ongoing: catch deploys while the tab is open
}
