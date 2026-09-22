import { PanelEngine } from './engine.js';
import { planMove, planStay, posToZ, brightToVel } from './mazeState.js';

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
   * Combined MOVE + LIGHT — the single primitive movements call. Snap the raw target to the
   * nearest tracked z, plan the note-ons from current belief, and — if output is on — emit them
   * at velocity = `brightness` (on the real maze a note-on both steps AND sets the light, so
   * move and light are one call). Commit the resulting belief. Does NOT glide the Panel — the
   * HUD tick renders belief. `brightness` is 0..1 (null keeps the current light); `duration` ms
   * schedules an automatic off().
   *
   * The engine NEVER generates a 0-step move: a move is a physical action, always ≥1 note-on.
   * When the target equals the current height, planMove would be 0 steps, so we substitute an
   * in-place STAY — walk to the near wall and back (non-zero; a full 16-step loop at an
   * endpoint). That keeps the light strike on the wire and belief consistent with the maze
   * (light can only ride a note-on, so "light in place" costs a real stay). Dead panels only
   * are skipped.
   */
  move(x, y, orient, target, brightness = null, duration = null) {
    const note = this.noteAt(x, y, orient);
    if (note == null) return false;
    const p = this.state.get(note);
    if (!p || p.dead) return false;
    const key = `${x},${y},${orient}`;
    this._clearOff(key);

    const zT = posToZ(Math.max(0, Math.min(255, target)));
    const onVel = brightness == null ? p.brightness : brightToVel(brightness); // 0..127; null = keep
    let { steps, newState } = planMove(p.z, p.v, zT);
    if (steps === 0) ({ steps, newState } = planStay(p.z, p.v)); // never a 0-step move: stay in place
    if (this.midi?.enabled) {
      this.midi.sendSteps(new Map([[note, { steps, vel: Math.max(1, onVel) }]]));
    }
    this.state.commit(note, newState, onVel);
    if (duration != null && duration > 0) {
      this._offTimers.set(key, this._schedule(() => this.off(x, y, orient), duration));
    }
    return true;
  }

  /** Light off in place — the one standalone light action: a bare note-off (no move) + belief dark. */
  off(x, y, orient) {
    const note = this.noteAt(x, y, orient);
    if (note == null) return false;
    this._clearOff(`${x},${y},${orient}`);
    const p = this.state.get(note);
    if (!p) return false;
    if (!p.dead && p.brightness > 0 && this.midi?.enabled) this.midi.sendOff([note]);
    this.state.setBrightness(note, 0);
    return true;
  }

  /** Manual per-panel move (controls / cell board): a move that keeps the current light. */
  movePanel(x, y, orient, targetPosition, _opts = {}) {
    return this.move(x, y, orient, targetPosition, null);
  }

  /** Manual light preview (controls / cell board): set believed brightness (3D only, no MIDI). */
  blinkPanel(x, y, orient, opts = {}) {
    const note = this.noteAt(x, y, orient);
    if (note == null) return false;
    const p = this.state.get(note);
    if (!p || p.dead) return false;
    const peak = opts.peak ?? this.blinkDefaults.peak ?? 1;
    this.state.setBrightness(note, brightToVel(peak));
    return true;
  }

  /** Synchronized sweep collapses to per-panel combined moves (stagger is moot under
   *  z-quantization + one global glide speed). */
  sweepTo(moves, opts = {}) {
    const brightness = opts.brightness ?? null;
    const duration = opts.duration ?? null;
    for (const m of moves) this.move(m.x, m.y, m.orient, m.target, brightness, duration);
  }

  // `moveAll` / `sweepAll` inherit from PanelEngine — they call this.move / this.sweepTo.

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
