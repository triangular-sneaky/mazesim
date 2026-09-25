import { PanelEngine } from './engine.js';
import { planMove, planStay, applyStep, posToZ, zToPos, brightToVel } from './mazeState.js';
import { logEvent } from '../eventLog.js';

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

    // ---- Wire-synced moves (opt-in per movement) -----------------------------
    // Hardware truth: a panel takes a real note-on burst reliably, but sending it a NEW move while
    // it's still physically travelling corrupts the firmware's step count. When `syncToWire` is on,
    // a move is only committed + animated when the TRANSPORT actually puts its note-ons on the wire
    // (past the token bucket) — the real move-start — so belief/sim track the physical panel, and
    // the next move for that panel waits until move-end (send time + travel). A move to a busy panel
    // is queued FIFO. Off by default (today's immediate behavior).
    this.syncToWire = false;
    this.onPanelDone = null;     // optional (note) => void, fired when a panel's move completes
    // In-place relight strategy (per-movement). Default: a cheap 1-step pulse — but a note-on always
    // steps, so it wobbles the panel one level (floor +1, top −1). Set true to relight via planStay
    // (walk to the near wall and back → z preserved exactly) for precise static shapes; costs up to
    // 16 steps. Set per play() from the movement's `stayLight` param.
    this.stayLight = false;
    this._now = now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._awaitingWire = new Map(); // note -> outcome { newState, onVel, fromZ } (sent, awaiting wire)
    this._busyUntil    = new Map(); // note -> ms timestamp the committed move should finish
    this._moveQueue    = new Map(); // note -> [{ x, y, orient, target, brightness, duration }] FIFO
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

    // Wire-synced: while this panel is still busy (dispatched-awaiting-wire, or committed-travelling),
    // queue this request FIFO — the panel's move-end (tick) dispatches the next in order. A backlog
    // means the movement is over-driving the panel faster than it can travel: warn.
    if (this.syncToWire && this._isBusy(note)) {
      let q = this._moveQueue.get(note);
      if (!q) { q = []; this._moveQueue.set(note, q); }
      q.push({ x, y, orient, target, brightness, duration });
      if (q.length > 1) logEvent('warn', `move gate: note ${note} queue backed up (${q.length}) — over-driving`);
      return true;
    }
    return this._dispatch({ x, y, orient, target, brightness, duration });
  }

  /** True while a wire-synced panel has a move in flight (sent-awaiting-wire or still travelling). */
  _isBusy(note) {
    return this._awaitingWire.has(note) || this._now() < (this._busyUntil.get(note) ?? 0);
  }

  /**
   * Plan + emit one move for a panel (planning lazily from CURRENT belief, so a queued move reflects
   * the prior move's outcome). In wire-synced mode belief is committed on the transport's `onSent`
   * callback (the real move-start), not here — so belief and the sim glide track the physical panel.
   */
  _dispatch(req) {
    const { x, y, orient, target, brightness, duration } = req;
    const note = this.noteAt(x, y, orient);
    if (note == null) return false;
    const p = this.state.get(note);
    if (!p || p.dead) return false;
    const key = `${x},${y},${orient}`;
    this._clearOff(key);

    const fromZ = p.z; // capture before commit — `p` is a live ref the state mutates in place
    const zT = posToZ(Math.max(0, Math.min(255, target)));
    const keepLight = brightness == null;
    const onVel = keepLight ? p.brightness : brightToVel(brightness); // 0..127
    const { steps, newState } = planMove(p.z, p.v, zT);
    const synced = this.syncToWire;

    if (steps > 0) {
      // Real move — the note-ons carry the light (min vel 1 so an off panel can still travel).
      this._send(note, { steps, vel: Math.max(1, onVel) }, synced, fromZ, newState, onVel);
    } else if (!keepLight && onVel !== p.brightness) {
      if (onVel > 0) {
        // Relight in place. pulse (default) = one note-on (±1 wobble); stay = planStay (z-exact).
        const relight = this.stayLight ? planStay(p.z, p.v) : { steps: 1, newState: applyStep({ z: p.z, v: p.v }) };
        this._send(note, { steps: relight.steps, vel: onVel }, synced, fromZ, relight.newState, onVel);
      } else {
        // Turn off in place — a bare note-off, no movement (no travel → not gated, commit now).
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

  /**
   * Emit `spec` steps for a note. Synced: defer the belief commit to the wire `onSent` callback and
   * record the outcome as awaiting-wire. Unsynced: commit immediately (today's behavior).
   */
  _send(note, spec, synced, fromZ, newState, onVel) {
    // Investigation aid: every dispatched move logs its actual belief transition + step count when
    // MIDI logging is on — e.g. "note 60: z1→5 (4 steps)" reveals a move started from z1, not z0.
    if (this.midi?.logging) logEvent('midi', `note ${note}: z${fromZ}→${newState.z} (${spec.steps} step${spec.steps === 1 ? '' : 's'}, vel ${spec.vel})`);
    if (synced) {
      this._awaitingWire.set(note, { newState, onVel, fromZ });
      if (this.midi?.enabled) {
        this.midi.sendSteps(new Map([[note, spec]]), { onSent: (n, when) => this._onWireSent(n, when) });
      } else {
        // No wire to call back — behave as if sent instantly so belief/gate still advance.
        this._onWireSent(note, this._now());
      }
    } else {
      if (this.midi?.enabled) this.midi.sendSteps(new Map([[note, spec]]));
      this.state.commit(note, newState, onVel);
    }
  }

  /** Transport reports a note's steps just hit the wire (real move-start): commit + arm move-end. */
  _onWireSent(note) {
    const out = this._awaitingWire.get(note);
    if (!out) return;
    this._awaitingWire.delete(note);
    this.state.commit(note, out.newState, out.onVel); // sim glides from here → synced to the panel
    const rate = this.speed * (1 - this.ease);        // effective units/sec — same as sweepTo()
    const travelMs = rate > 0 ? (Math.abs(zToPos(out.newState.z) - zToPos(out.fromZ)) / rate) * 1000 : 0;
    this._busyUntil.set(note, this._now() + travelMs);
    if (this.midi?.logging) logEvent('midi', `note ${note} sent → z${out.fromZ}→${out.newState.z}, ~${Math.round(travelMs)}ms`);
  }

  /**
   * Light off in place — the one standalone light action: a bare note-off (no move) + belief dark.
   * A light-off is NEVER gated by the wire-sync move gate and never waits for a move to end (it
   * carries no travel), so e.g. a `duration` auto-off fires immediately even mid-move. It also
   * doesn't disturb the panel's queued moves. If a lit move is still awaiting the wire, cancel its
   * pending re-light (so the deferred commit lands dark) and still emit the note-off, since belief
   * brightness hasn't caught up yet.
   */
  off(x, y, orient) {
    const note = this.noteAt(x, y, orient);
    if (note == null) return false;
    this._clearOff(`${x},${y},${orient}`);

    // Wire-synced: if step unit(s) are still QUEUED for this panel (not yet on the wire), the light
    // off must go AFTER them — append it to the FIFO. Sending it now would land BEFORE the queued
    // move dispatches, and that move would re-light the panel, so the off would "not register". It
    // never splits a unit (its own note-off unit) and doesn't wait for travel — it's emitted right
    // after the preceding unit drains.
    const q = this._moveQueue.get(note);
    if (this.syncToWire && q && q.length) { q.push({ off: true, x, y, orient }); return true; }

    // A move already handed to the wire (awaiting its callback) still lights the panel from its
    // in-flight unit, so emit the note-off (it follows that unit in the transport FIFO — no wait for
    // travel to end) and cancel the pending re-light so belief lands dark.
    const pending = this._awaitingWire.get(note);
    const pendingLit = pending && pending.onVel > 0;
    if (pending) pending.onVel = 0;
    const p = this.state.get(note);
    if (!p) return false;
    const wasLit = p.brightness > 0 || pendingLit;
    if (!p.dead && wasLit && this.midi?.enabled) this.midi.sendOff([note]);
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

  /** Drop all wire-gate bookkeeping — call on Stop, since flushed sends never fire their onSent
   *  callback, which would otherwise leave a panel wrongly marked busy on the next synced run. */
  resetWireGate() {
    this._awaitingWire.clear();
    this._busyUntil.clear();
    this._moveQueue.clear();
  }

  // ---- Clock: advance sim, then complete any panel whose move-end has passed -----

  tick(dt) {
    super.tick(dt);
    if (!this.syncToWire || this._busyUntil.size === 0) return;
    const now = this._now();
    // Snapshot the notes whose committed travel has finished (and aren't still awaiting the wire).
    const done = [];
    for (const [note, until] of this._busyUntil) {
      if (now >= until && !this._awaitingWire.has(note)) done.push(note);
    }
    for (const note of done) {
      this._busyUntil.delete(note);
      if (this.onPanelDone) { try { this.onPanelDone(note); } catch (e) { console.error(e); } }
      const q = this._moveQueue.get(note);          // dispatch this panel's next queued op, in order
      if (q && q.length) {
        const req = q.shift();
        if (!q.length) this._moveQueue.delete(note);
        if (req.off) this.off(req.x, req.y, req.orient); // a queued light-off — now free, emit it
        else this._dispatch(req);
      }
    }
  }
}
