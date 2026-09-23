/**
 * Background-safe clock.
 *
 * Browsers PAUSE requestAnimationFrame and THROTTLE setTimeout/setInterval to >=1s in a
 * hidden/background tab. That freezes the maze's control path — the movement ticks and the
 * MIDI pacing — so nothing reaches the physical maze once you switch away from the tab.
 *
 * The audio thread is exempt: an AudioContext keeps running at real-time priority regardless
 * of tab visibility. So we drive the control path from an AudioWorklet heartbeat (it posts a
 * message to the main thread every few audio quanta, ~3-6ms). That heartbeat both fires the
 * timers scheduled against this clock (used by the transport + demo player instead of the
 * native, throttled timers) and runs the control-loop tick.
 *
 * A plain setInterval runs as a BASE driver too: it works in the foreground before the
 * AudioContext is unlocked (audio needs a user gesture) and if audio init fails — audio only
 * adds the survives-backgrounding property on top. Both drivers call _beat(); it self-throttles
 * the control tick and fires each due timer once, so double-driving is harmless.
 *
 * Note: MIDI `output.send(msg, when)` timestamps are honored by the browser's MIDI backend
 * even when the tab is hidden — the only thing that had stopped was the JS generating them.
 */

// AudioWorklet processor source (loaded via a blob URL — no separate file needed).
const WORKLET_SRC = `
class HeartbeatProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._n = 0; }
  process() {
    // ~128 samples/call (~2.9ms @44.1kHz). Post every 2 quanta (~6ms) to wake the main thread.
    if ((this._n++ & 1) === 0) this.port.postMessage(0);
    return true; // keep the node alive
  }
}
registerProcessor('heartbeat', HeartbeatProcessor);
`;

export class BackgroundClock {
  constructor({ tickMs = 16 } = {}) {
    this._tickMs = tickMs;
    this._handlers = new Set();
    this._timers = new Map();        // id -> { at, fn }
    this._seq = 1;
    this._lastTick = performance.now();
    this._ctx = null;
    this._audioReady = false;

    // Base driver — foreground-reliable; throttled in the background until audio takes over.
    this._interval = setInterval(() => this._beat(), tickMs);
  }

  /** Register a control-loop callback (fired ~tickMs, receives dt in seconds). Returns an off(). */
  onTick(fn) { this._handlers.add(fn); return () => this._handlers.delete(fn); }

  /** setTimeout-compatible, fired from the heartbeat so it survives a hidden tab. */
  setTimeout(fn, ms) {
    const id = this._seq++;
    this._timers.set(id, { at: performance.now() + Math.max(0, ms || 0), fn });
    return id;
  }

  clearTimeout(id) { this._timers.delete(id); }

  _beat() {
    const now = performance.now();
    // Fire due timers (fine granularity — every heartbeat), earliest first.
    if (this._timers.size) {
      const due = [];
      for (const [id, t] of this._timers) if (t.at <= now) { due.push(t); this._timers.delete(id); }
      due.sort((a, b) => a.at - b.at);
      for (const t of due) { try { t.fn(); } catch (e) { console.error(e); } }
    }
    // Control tick, throttled to ~tickMs regardless of how often _beat is called.
    if (now - this._lastTick >= this._tickMs) {
      const dt = Math.min((now - this._lastTick) / 1000, 0.1);
      this._lastTick = now;
      for (const fn of this._handlers) { try { fn(dt); } catch (e) { console.error(e); } }
    }
  }

  /**
   * Unlock the audio-thread heartbeat. Must be called from (or after) a user gesture because
   * of the browser autoplay policy. Idempotent and safe to call repeatedly (e.g. on
   * visibilitychange). Falls back to a ScriptProcessor, then to setInterval-only.
   */
  async resume() {
    try {
      if (!this._ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this._ctx = new AC();
      }
      if (this._ctx.state === 'suspended') await this._ctx.resume();
      if (this._audioReady) return;

      let node;
      if (this._ctx.audioWorklet) {
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        try { await this._ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        node = new AudioWorkletNode(this._ctx, 'heartbeat');
        node.port.onmessage = () => this._beat();
      } else {
        // Deprecated but universally supported fallback: onaudioprocess fires on the audio pull.
        node = this._ctx.createScriptProcessor(512, 1, 1);
        node.onaudioprocess = () => this._beat();
      }
      // A muted gain keeps the graph "playing" (no sound) so the node keeps being pulled.
      const gain = this._ctx.createGain();
      gain.gain.value = 0;
      node.connect(gain);
      gain.connect(this._ctx.destination);
      this._node = node;
      this._gain = gain;
      this._audioReady = true;
    } catch (e) {
      console.warn('background clock: audio heartbeat unavailable — using setInterval only', e);
    }
  }

  /** True once the audio-thread heartbeat is live (i.e. background-safe). */
  get backgroundSafe() { return this._audioReady; }
}
