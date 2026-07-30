/**
 * Auto-reload on new deploy.
 *
 * GitHub Pages doesn't refresh open tabs when a new build ships. This polls the
 * app's own index.html (cache-busted) and compares the hashed main bundle name to
 * the one currently running (`import.meta.url`). When they differ — i.e. a newer
 * build is live — it reloads the page so viewers pick up the update automatically.
 *
 * @param {number} intervalMs how often to check (default 60s)
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
        console.log(`mazesim: new build ${latest} detected (was ${currentBundle}); reloading.`);
        location.reload();
      }
    } catch (_) {
      // offline / transient — try again next tick
    }
  }

  setInterval(check, intervalMs);
}
