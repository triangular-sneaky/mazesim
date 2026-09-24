import { PanelEngine } from './engine.js';
import { planMove, planStay, applyStep, posToZ, zToPos, brightToVel } from './mazeState.js';

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
  constructor(config, panelDefs, { state, midi, now }) {
    super(config, panelDefs);
    this.state = state;
    this.midi = midi;
    // key "x,y,orient" -> note number, so the sim-facing action API can reach the belief.
    this._noteOf = new Map(state.list().map((p) => [`${p.x},${p.y},${p.orient}`, p.note]));

    // ---- Per-panel move gate (opt-in) ----------------------------------------
    // Hardware truth: a panel takes a real note-on burst reliably, but sending it a NEW move while
    // it's still physically travelling corrupts the firmware's step count. When `serializeMoves` is
    // on, at most one move is in flight per panel: a move to a busy panel is DEFERRED (latest-wins)
    // and dispatched by tick() once the panel's travel finishes. Off by default (today's behavior).
    this.serializeMoves = false;
    // In-place relight strategy (per-movement). Default: a cheap 1-step pulse — but a note-on always
    // steps, so it wobbles the panel one level (floor +1, top −1). Set true to relight via planStay
    // (walk to the near wall and back → z preserved exactly) for precise static shapes; costs up to
    // 16 steps. Set per play() from the movement's `stayLight` param.
    this.stayLight = false;
    this._now = now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._busyUntil = new Map(); // note -> ms timestamp the current move should finish
    this._pending   = new Map(); // note -> latest deferred { x, y, orient, target, brightness, duration }
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
   * A move never generates a POINTLESS operation, but any real change costs a step. Cases:
   *  - height changes  → send those note-ons (min vel 1 so an off panel can still travel); the
   *                      light rides along at `brightness`.
   *  - same height, light must turn ON or change level → a cheap 1-step PULSE (a single note-on):
   *                      light can only ride a note-on, so lighting in place advances one step (a
   *                      1-level wobble). Far cheaper than the old walk-to-the-wall stay.
   *  - same height, light must turn OFF (currently lit) → a bare note-off, no movement.
   *  - same height, no light change — keeping brightness, or already off and staying off → a
   *                      GENUINE no-op: send nothing, don't reinforce "off" with a velocity-1 step.
   * Dead panels are skipped.
   */
  move(x, y, orient, target, brightness = null, duration = null) {
    const note = this.noteAt(x, y, orient);
    if (note == null) return false;
    const p = this.state.get(note);
    if (!p || p.dead) return false;

    // Gate: if this panel's previous move is still travelling, defer (latest target wins). tick()
    // re-dispatches it once the panel is free — so we never send a panel a step mid-motion.
    if (this.serializeMoves && this._now() < (this._busyUntil.get(note) ?? 0)) {
      this._pending.set(note, { x, y, orient, target, brightness, duration });
      return true;
    }

    const key = `${x},${y},${orient}`;
    this._clearOff(key);

    const fromZ = p.z; // capture before commit — `p` is a live ref the state mutates in place
    const zT = posToZ(Math.max(0, Math.min(255, target)));
    const keepLight = brightness == null;
    const onVel = keepLight ? p.brightness : brightToVel(brightness); // 0..127
    const { steps, newState } = planMove(p.z, p.v, zT);

    if (steps > 0) {
      // Real move — the note-ons carry the light (min vel 1 so an off panel can still travel).
      if (this.midi?.enabled) this.midi.sendSteps(new Map([[note, { steps, vel: Math.max(1, onVel) }]]));
      this.state.commit(note, newState, onVel);
      this._markBusy(note, fromZ, newState.z);
    } else if (!keepLight && onVel !== p.brightness) {
      // Same height, but the light must change.
      if (onVel > 0) {
        // Turn on / change level in place, since light can only ride a note-on. Two strategies:
        //  - pulse (default): one note-on — cheap, but wobbles the panel a level (floor +1, top −1).
        //  - stay: walk to the near wall and back (planStay) → same z exactly, up to 16 steps — for
        //    precise static shapes (e.g. Flowie Diagonal) where the ±1 wobble is wrong.
        const relight = this.stayLight ? planStay(p.z, p.v) : { steps: 1, newState: applyStep({ z: p.z, v: p.v }) };
        if (this.midi?.enabled) this.midi.sendSteps(new Map([[note, { steps: relight.steps, vel: onVel }]]));
        this.state.commit(note, relight.newState, onVel);
        this._markBusy(note, fromZ, relight.newState.z);
      } else {
        // Turn off in place — a bare note-off, no movement (no travel → no busy).
        if (this.midi?.enabled) this.midi.sendOff([note]);
        this.state.setBrightness(note, 0);
      }
    }
    // else: genuine no-op (same height, keeping light or already off) — send nothing.

    if (duration != null && duration > 0) {
      this._offTimers.set(key, this._schedule(() => this.off(x, y, orient), duration));
    }
    return true;
  }

  /** Mark a panel busy for the net-displacement glide time (only matters while serializing). */
  _markBusy(note, fromZ, toZ) {
    if (!this.serializeMoves) return;
    const rate = this.speed * (1 - this.ease); // effective units/sec — same as sweepTo()
    const travelMs = rate > 0 ? (Math.abs(zToPos(toZ) - zToPos(fromZ)) / rate) * 1000 : 0;
    this._busyUntil.set(note, this._now() + travelMs);
  }

  /** Light off in place — the one standalone light action: a bare note-off (no move) + belief dark. */
  off(x, y, orient) {
    const note = this.noteAt(x, y, orient);
    if (note == null) return false;
    this._clearOff(`${x},${y},${orient}`);
    this._pending.delete(note); // a deliberate light-off supersedes any queued move
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

  // ---- Clock: advance sim, then drain any panels whose move has finished ------

  tick(dt) {
    super.tick(dt);
    if (!this.serializeMoves || this._pending.size === 0) return;
    const now = this._now();
    // Snapshot the drainable notes first — re-dispatching sets a fresh busyUntil / may re-defer.
    const ready = [];
    for (const [note, req] of this._pending) {
      if (now >= (this._busyUntil.get(note) ?? 0)) ready.push([note, req]);
    }
    for (const [note, req] of ready) {
      this._pending.delete(note);
      this.move(req.x, req.y, req.orient, req.target, req.brightness, req.duration);
    }
  }
}
