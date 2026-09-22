import { Panel } from './panel.js';

const clamp01 = (b) => Math.max(0, Math.min(1, Number(b) || 0));

/**
 * PanelEngine — owns all panels, advances them each tick, and exposes the single
 * ACTION API that every input source (manual UI, demos now; MIDI later) calls.
 *
 * Deliberately free of any three.js / DOM reference so the visible/invisible split
 * holds: a future MIDI/Max adapter just calls movePanel()/blinkPanel().
 */
export class PanelEngine {
  /**
   * @param {object} config  parsed layout config (room/grid/panel/motion/blink)
   * @param {{x:number,y:number,orient:'h'|'v'}[]} panelDefs
   */
  constructor(config, panelDefs) {
    this.config = config;
    this.motionDefaults = config.motion;
    this.blinkDefaults = config.blink;

    // Global cruise speed (position-units/sec) applied to ALL movement unless a
    // call passes an explicit override (e.g. live scrubbing). Set live from the UI.
    this.speed = config.motion.velocity ?? 55;
    this.ease = config.motion.ease ?? 0.15;
    // Tempo anchor: movement generators author their intervals/durations assuming this
    // speed. Scaling those timings by (baseSpeed / speed) keeps a movement's SHAPE fixed
    // (heights/amplitude unchanged) while its PERIOD tracks the live speed control.
    this.baseSpeed = config.motion.tempoReference ?? 120;

    /** @type {Map<string, Panel>} */
    this.panels = new Map();
    const rest = config.motion.restPosition ?? 128;
    for (const d of panelDefs) {
      const p = new Panel(d.x, d.y, d.orient, rest);
      this.panels.set(p.key, p);
    }

    // Pending auto-off timers (panel key -> timer id), for move()'s `duration`.
    this._offTimers  = new Map();
    this._schedule   = (fn, ms) => setTimeout(fn, ms);
    this._unschedule = (id) => clearTimeout(id);
  }

  /** Cancel a pending auto-off for a panel (a fresh move/off supersedes it). */
  _clearOff(key) {
    const id = this._offTimers.get(key);
    if (id != null) { this._unschedule(id); this._offTimers.delete(key); }
  }

  key(x, y, orient) { return `${x},${y},${orient}`; }

  get(x, y, orient) { return this.panels.get(this.key(x, y, orient)); }

  list() { return [...this.panels.values()]; }

  /** Set the global cruise speed (position-units/sec) for all movement. */
  setSpeed(v) { this.speed = Math.max(1, v); }

  // ---- ACTION API -----------------------------------------------------------

  /**
   * Move one panel toward a target height. Uses the global cruise speed and the
   * shared trapezoidal ease; pass `velocity` only for special interactive cases
   * (e.g. live scrubbing) that must not follow the global speed.
   * @param {number} x @param {number} y @param {'h'|'v'} orient
   * @param {number} targetPosition 0..255 (required)
   * @param {{velocity?:number}} [opts]
   */
  movePanel(x, y, orient, targetPosition, opts = {}) {
    const p = this.get(x, y, orient);
    if (!p) return false;
    const velocity = opts.velocity ?? this.speed;
    p.moveTo(targetPosition, velocity, this.ease);
    return true;
  }

  /**
   * Trigger a panel's LED blink. All params optional (fall back to config defaults).
   * @param {{attack?:number,sustain?:number,decay?:number,peak?:number}} [opts]
   */
  blinkPanel(x, y, orient, opts = {}) {
    const p = this.get(x, y, orient);
    if (!p) return false;
    p.blink({
      attack: opts.attack ?? this.blinkDefaults.attack,
      sustain: opts.sustain ?? this.blinkDefaults.sustain,
      decay: opts.decay ?? this.blinkDefaults.decay,
      peak: opts.peak ?? this.blinkDefaults.peak,
    });
    return true;
  }

  /**
   * Combined MOVE + LIGHT — the single primitive movements call. Move the panel toward
   * `target` at the global cruise speed and set its light to `brightness` (0..1) for the
   * move; a note-on on the real maze both steps and sets brightness, so the two are one
   * call. If `duration` ms is given, the light auto-turns-off that long after this call
   * (replacing the old blink sustain). Pass `brightness = null` to leave the light as-is.
   * Light ENVELOPES are retired — a panel is simply on at a level or off.
   * @param {number} target 0..255
   * @param {number|null} [brightness] 0..1, or null to keep the current light
   * @param {number|null} [duration] ms until an automatic light-off, or null for none
   */
  move(x, y, orient, target, brightness = null, duration = null) {
    const p = this.get(x, y, orient);
    if (!p) return false;
    this._clearOff(p.key);
    p.moveTo(target, this.speed, this.ease);
    if (brightness != null) p.brightness = clamp01(brightness);
    if (duration != null && duration > 0) {
      this._offTimers.set(p.key, this._schedule(() => this.off(x, y, orient), duration));
    }
    return true;
  }

  /** Turn a panel's light off in place — the one light action that stands alone (no move). */
  off(x, y, orient) {
    const p = this.get(x, y, orient);
    if (!p) return false;
    this._clearOff(p.key);
    p.brightness = 0;
    return true;
  }

  /** Convenience: move every panel to one target with one light level (used by demos). */
  moveAll(target, brightness = null, duration = null) {
    for (const p of this.panels.values()) {
      this.move(p.x, p.y, p.orient, target, brightness, duration);
    }
  }

  /**
   * Synchronized "sweep": move a set of panels so they ALL ARRIVE at the same instant,
   * each traveling at the single global speed. Panels with less distance to cover start
   * later (a staggered delay) and "join in", so the group levels together — without any
   * panel ever moving at a non-global speed (only the start times differ). `brightness`
   * and `duration` apply the combined-light rule to every swept panel (see move()).
   * @param {{x:number,y:number,orient:'h'|'v',target:number}[]} moves
   * @param {{brightness?:number|null, duration?:number|null, ease?:number}} [opts]
   */
  sweepTo(moves, opts = {}) {
    const ease = opts.ease ?? this.ease;
    const brightness = opts.brightness ?? null;
    const duration = opts.duration ?? null;
    const rate = this.speed * (1 - ease); // effective units/sec used for the duration
    const plan = [];
    let maxDur = 0;
    for (const m of moves) {
      const p = this.get(m.x, m.y, m.orient);
      if (!p) continue;
      const target = Math.min(255, Math.max(0, m.target));
      const dur = rate > 0 ? Math.abs(target - p.position) / rate : 0;
      plan.push({ p, target, dur });
      if (dur > maxDur) maxDur = dur;
    }
    // Delay each move so every panel finishes at maxDur (the longest single move).
    for (const { p, target, dur } of plan) {
      this._clearOff(p.key);
      p.moveTo(target, this.speed, ease, maxDur - dur);
      if (brightness != null) p.brightness = clamp01(brightness);
      if (duration != null && duration > 0) {
        this._offTimers.set(p.key, this._schedule(() => this.off(p.x, p.y, p.orient), duration));
      }
    }
  }

  /** Sweep every panel to one target, all arriving together (see sweepTo). */
  sweepAll(target, opts = {}) {
    this.sweepTo(this.list().map((p) => ({ x: p.x, y: p.y, orient: p.orient, target })), opts);
  }

  // ---- Clock -----------------------------------------------------------------

  tick(dt) {
    for (const p of this.panels.values()) p.tick(dt);
  }
}
