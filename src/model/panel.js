/**
 * A single panel's logical state and per-frame behaviour.
 * Purely logical: position is 0..255; no world coordinates, no three.js.
 * Height mapping and rendering live elsewhere (render layer).
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = (t) => t * t * (3 - 2 * t);

export class Panel {
  /**
   * @param {number} x  cell column (west->east, 0-based)
   * @param {number} y  cell row (north->south, 0-based)
   * @param {'h'|'v'} orient  h = wide face E-W, v = wide face N-S
   * @param {number} position  initial logical position 0..255
   */
  constructor(x, y, orient, position) {
    this.x = x;
    this.y = y;
    this.orient = orient;
    this.key = `${x},${y},${orient}`;

    // Motion state
    this.position = position;      // current logical height 0..255
    this._start = position;        // animation start position
    this._target = position;       // animation target
    this._elapsed = 0;             // s since move began
    this._duration = 0;            // s for current move (0 = idle/snapped)
    this._curve = 'linear';
    this.moving = false;

    // Blink (LED) state — brightness is the 0..1 overlay above the panel's base glow.
    this.brightness = 0;
    this._blink = null;            // { elapsed, attack, sustain, decay, peak }
  }

  /**
   * Begin a move toward a target position.
   * @param {number} target 0..255
   * @param {number} velocity position-units / second (>0)
   * @param {'linear'|'smooth'} curve
   */
  moveTo(target, velocity, curve) {
    this._target = clamp(target, 0, 255);
    this._start = this.position;
    this._curve = curve === 'smooth' ? 'smooth' : 'linear';
    const distance = Math.abs(this._target - this._start);
    if (velocity > 0 && distance > 0) {
      this._duration = distance / velocity;
      this._elapsed = 0;
      this.moving = true;
    } else {
      // Snap immediately.
      this.position = this._target;
      this._duration = 0;
      this.moving = false;
    }
  }

  /**
   * Trigger a blink envelope.
   * @param {{attack:number,sustain:number,decay:number,peak:number}} env  seconds + peak 0..1
   */
  blink(env) {
    this._blink = {
      elapsed: 0,
      attack: Math.max(0, env.attack),
      sustain: Math.max(0, env.sustain),
      decay: Math.max(0, env.decay),
      peak: clamp(env.peak, 0, 1),
    };
  }

  /** Advance state by dt seconds. */
  tick(dt) {
    // Motion
    if (this.moving) {
      this._elapsed += dt;
      const t = this._duration > 0 ? clamp(this._elapsed / this._duration, 0, 1) : 1;
      const eased = this._curve === 'smooth' ? smoothstep(t) : t;
      this.position = this._start + (this._target - this._start) * eased;
      if (t >= 1) {
        this.position = this._target;
        this.moving = false;
      }
    }

    // Blink envelope
    const b = this._blink;
    if (b) {
      b.elapsed += dt;
      const { attack, sustain, decay, peak } = b;
      if (b.elapsed < attack) {
        this.brightness = attack > 0 ? peak * (b.elapsed / attack) : peak;
      } else if (b.elapsed < attack + sustain) {
        this.brightness = peak;
      } else if (b.elapsed < attack + sustain + decay) {
        const d = decay > 0 ? (b.elapsed - attack - sustain) / decay : 1;
        this.brightness = peak * (1 - d);
      } else {
        this.brightness = 0;
        this._blink = null;
      }
    }
  }
}
