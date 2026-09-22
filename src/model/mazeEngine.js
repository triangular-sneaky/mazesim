import { PanelEngine } from './engine.js';
import { planMove, posToZ, brightToVel } from './mazeState.js';

/**
 * MazeEngine — the state-backed engine adapter.
 *
 * PanelEngine's docstring anticipates this: "a future MIDI/Max adapter just calls
 * movePanel()/blinkPanel()." This is that adapter, and it is the SINGLE engine every
 * movement source drives (demos, loops, prison, lullaby, MIDI mode, manual controls).
 *
 * The inversion: a movement no longer paints the sim directly. Instead every intent-bearing
 * action routes through the tracked physical-maze BELIEF (mazeState):
 *
 *     movement  ->  plan steps (planMove)  ->  commit belief  ->  emit MIDI  ->  (mirror to 3D)
 *
 * The 3D mirror is not this class's job — the HUD's tick reads belief every frame and drives
 * the sim to it via `renderMove` (the raw glide primitive below), so the sim is a READOUT of
 * what we believe the physical maze is doing, not the thing movements paint.
 *
 * Key rule the design leans on: one `movePanel(target)` call = ONE planned move. Generators
 * already issue a single move per continuous motion (wave rises, later falls), so each becomes
 * exactly one `planMove` burst — no per-frame sampling of smooth motion, no second engine.
 */
export class MazeEngine extends PanelEngine {
  /**
   * @param {object} config      parsed layout config (as PanelEngine)
   * @param {{x,y,orient}[]} panelDefs
   * @param {object} deps
   * @param {import('./mazeState.js').MazeState} deps.state  tracked belief (source of truth)
   * @param {import('../ui/mazeMidiController.js').MazeMidiController} deps.midi  transport
   */
  constructor(config, panelDefs, { state, midi }) {
    super(config, panelDefs);
    this.state = state;
    this.midi = midi;
    // key "x,y,orient" -> note number, so the sim-facing action API can reach the belief.
    this._noteOf = new Map(state.list().map((p) => [`${p.x},${p.y},${p.orient}`, p.note]));
  }

  noteAt(x, y, orient) { return this._noteOf.get(`${x},${y},${orient}`); }

  // ---- Intent-bearing action API (routed through belief + MIDI) --------------

  /**
   * Move a panel toward a target height. Snaps the raw sim target to the nearest tracked z,
   * plans the minimal note-ons from current belief to reach it, emits them (if output is on),
   * and commits the resulting belief. Does NOT glide the Panel — the HUD tick renders belief.
   * `opts` (e.g. an explicit scrub velocity) is ignored: rendering is belief-driven at the
   * single global speed. Dead panels and no-op moves send nothing.
   */
  movePanel(x, y, orient, targetPosition, _opts = {}) {
    const note = this.noteAt(x, y, orient);
    if (note == null) return false;
    const p = this.state.get(note);
    if (!p || p.dead) return false;

    const zT = posToZ(Math.max(0, Math.min(255, targetPosition)));
    const { steps, newState } = planMove(p.z, p.v, zT);
    if (steps > 0 && this.midi?.enabled) {
      const vel = Math.max(1, p.brightness || 1); // light rides the move; min 1 so a move is visible
      this.midi.sendSteps(new Map([[note, { steps, vel }]]));
    }
    this.state.commit(note, newState, p.brightness);
    return true;
  }

  /**
   * Trigger a panel's LED. Translates the blink envelope's peak to a tracked velocity so the
   * belief (and thus the 3D glow) reflects it. Emits NO MIDI on its own: on the real maze light
   * is coupled to motion (a note-on), so the light rides the next movement. A blink on a
   * STATIONARY panel (e.g. sparkle) therefore only affects the 3D readout for now — the
   * deferred "light + 1-step move" mode will close that gap.
   */
  blinkPanel(x, y, orient, opts = {}) {
    const note = this.noteAt(x, y, orient);
    if (note == null) return false;
    const p = this.state.get(note);
    if (!p || p.dead) return false;
    const peak = opts.peak ?? this.blinkDefaults.peak ?? 1;
    this.state.setBrightness(note, brightToVel(peak));
    return true;
  }

  /** Synchronized sweep collapses to per-panel planned moves (arrival stagger is moot under
   *  z-quantization + one global glide speed). Routes each move through movePanel above. */
  sweepTo(moves, _opts = {}) {
    for (const m of moves) this.movePanel(m.x, m.y, m.orient, m.target);
  }

  // `moveAll` / `sweepAll` inherit from PanelEngine — they call this.movePanel / this.sweepTo.

  // ---- Render primitive (belief -> sim, no state/MIDI) -----------------------

  /**
   * Plain trapezoidal glide of the sim Panel — PanelEngine's original movePanel. The HUD tick
   * uses THIS to drive the sim to tracked belief every frame, so rendering never re-enters the
   * state/MIDI path above.
   */
  renderMove(x, y, orient, targetPosition, opts = {}) {
    return super.movePanel(x, y, orient, targetPosition, opts);
  }
}
