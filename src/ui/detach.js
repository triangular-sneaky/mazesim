/**
 * Detach the controls sidebar into a separate browser window and re-dock it.
 * The sidebar DOM node is moved across documents (event listeners and canvas
 * contexts survive the move), and the page's <style> is cloned into the popup.
 * Docked by default; re-docks automatically if the popup is closed.
 *
 * Pop-out state is persisted to localStorage so a page reload reconnects the
 * existing popup window (via its named-window identity) rather than closing it.
 *
 * @param {HTMLElement} sidebar  the #sidebar element
 * @param {() => void} onLayoutChange  called after dock/detach so the 3D view can resize
 */

const STORAGE_KEY = 'mazesim-detached';
const POPUP_NAME  = 'mazesim-controls';

export function setupDetach(sidebar, onLayoutChange) {
  const btn = sidebar.querySelector('#detach-btn');
  const app = document.getElementById('app');
  let popup = null;

  const placeholder = document.createElement('aside');
  placeholder.id = 'sidebar-placeholder';
  placeholder.style.cssText =
    'width:320px;flex:none;height:100%;background:#16181c;border-left:1px solid #2a2d33;' +
    'padding:12px;color:#8b909a;font:13px ui-monospace,monospace';
  placeholder.innerHTML =
    'Controls detached to a separate window.<br><br><button id="redock-btn">⇘ dock back</button>';

  function dock() {
    if (!popup) return;
    localStorage.removeItem(STORAGE_KEY);
    app.appendChild(sidebar);
    placeholder.remove();
    const p = popup; popup = null;
    try { p.close(); } catch (_) {}
    btn.textContent = '⇗ pop out';
    onLayoutChange?.();
  }

  function detach() {
    popup = window.open('', POPUP_NAME, 'width=380,height=860');
    if (!popup) {
      alert('Popup blocked — allow popups for this site to detach the controls.');
      popup = null;
      return;
    }
    const doc = popup.document;
    doc.title = 'mazesim — Controls';
    doc.head.innerHTML = '';
    const style = document.querySelector('style');
    if (style) doc.head.appendChild(style.cloneNode(true));
    doc.body.style.margin = '0';
    doc.body.classList.add('detached-window');

    // Remove the previous session's pagehide listener (stale closure from before
    // reload) before registering a fresh one, so only one handler is live at a time.
    if (popup._pagehideHandler) {
      popup.removeEventListener('pagehide', popup._pagehideHandler);
    }
    // Clear any content left over from before the reload, then inject fresh sidebar.
    doc.body.replaceChildren();
    doc.body.appendChild(sidebar);

    localStorage.setItem(STORAGE_KEY, '1');
    app.appendChild(placeholder);
    placeholder.querySelector('#redock-btn').addEventListener('click', dock);

    popup._pagehideHandler = dock;
    popup.addEventListener('pagehide', popup._pagehideHandler);
    btn.textContent = '⇘ dock';
    onLayoutChange?.();
  }

  btn.addEventListener('click', () => (popup ? dock() : detach()));

  // On reload, leave the popup open — the new page will reconnect via localStorage.
  // (The old close-on-pagehide handler is intentionally removed.)

  // Reconnect to an existing popup if the controls were detached before the reload.
  if (localStorage.getItem(STORAGE_KEY)) {
    setTimeout(detach, 0);
  }
}
