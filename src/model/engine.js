import { Panel } from './panel.js';

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

  /** Convenience: move every panel (used by demos). */
  moveAll(targetPosition, opts = {}) {
    for (const p of this.panels.values()) {
      this.movePanel(p.x, p.y, p.orient, targetPosition, opts);
    }
  }

  // ---- Clock -----------------------------------------------------------------

  tick(dt) {
    for (const p of this.panels.values()) p.tick(dt);
  }
}
