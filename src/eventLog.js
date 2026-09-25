/**
 * Shared event log — notable maze events, written to the browser console (the "log file": the dev
 * console persists across the session and can be saved/exported). A small ring buffer is also kept
 * so a future UI panel or download can read history, but the console is the primary sink.
 *
 * Levels:
 *   info  — big events, always logged (movement play/stop, output enable/disable)
 *   warn  — problems, always logged (gate backlog, panic)
 *   midi  — fine-grained MIDI/engine events (sends, wire callbacks, belief commits); callers only
 *           emit these when the MIDI log is on, so this module doesn't gate them itself.
 */
const CAP = 600;
const _buf = [];
const _subs = new Set();

const _sink = (level, line) =>
  (level === 'warn' ? console.warn : level === 'midi' ? console.debug : console.info)(line);

export function logEvent(level, msg) {
  const e = { t: Date.now(), level, msg };
  _buf.push(e);
  if (_buf.length > CAP) _buf.splice(0, _buf.length - CAP);
  _sink(level, `[maze ${new Date(e.t).toLocaleTimeString([], { hour12: false })}] ${msg}`);
  for (const fn of _subs) { try { fn(e); } catch (err) { console.error(err); } }
  return e;
}

/** Current buffer (most-recent last) — e.g. to dump/download. */
export function eventLogEntries() { return _buf.slice(); }

/** Subscribe to new events; fn(entry) on each log, fn(null) on clear. Returns an unsubscribe fn. */
export function subscribeEventLog(fn) { _subs.add(fn); return () => _subs.delete(fn); }

export function clearEventLog() {
  _buf.length = 0;
  for (const fn of _subs) { try { fn(null); } catch (err) { console.error(err); } }
}
