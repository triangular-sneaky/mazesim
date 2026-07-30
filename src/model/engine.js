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

  // ---- ACTION API -----------------------------------------------------------

  /**
   * Move one panel toward a target height.
   * @param {number} x @param {number} y @param {'h'|'v'} orient
   * @param {number} targetPosition 0..255 (required)
   * @param {{velocity?:number, curve?:'linear'|'smooth'}} [opts]
   */
  movePanel(x, y, orient, targetPosition, opts = {}) {
    const p = this.get(x, y, orient);
    if (!p) return false;
    const velocity = opts.velocity ?? this.motionDefaults.velocity;
    const curve = opts.curve ?? this.motionDefaults.curve;
    p.moveTo(targetPosition, velocity, curve);
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
