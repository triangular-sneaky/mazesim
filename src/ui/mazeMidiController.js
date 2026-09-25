/**
 * Maze MIDI controller — sends note messages OUT to the physical maze (Web MIDI
 * output), for reverse-engineering / investigation. Separate from MidiMode, which
 * listens to an incoming controller.
 *
 * Firmware model (empirically established):
 *   note-on  (0x90, note, vel>0)  → advances the panel's target position by one step
 *                                    (in a 16-step cycle) + brightness := vel
 *   note-off (0x80, note, 0)      → light off, no movement
 * Note-on is NOT idempotent: each one moves the target. Exactly 16 note-ons walk the
 * cycle all the way back to the origin, so firing 16 in quick succession leaves the
 * panel where it started while the light ends up set.
 *
 * The firmware counts a step only on an OFF→ON transition (a bare run of note-ons counts
 * as ONE; the note-off re-arms it), and it honors 0x80 note-off, not 0x90 velocity-0.
 *
 * Send order is switchable (this.interleave):
 *   interleaved — round 0 = the first message of every note, round 1 = the second
 *                 of every note, … spreading each note's own off/on messages far
 *                 apart in the stream.
 *   sequential  — all 2*pairs messages of one note, then the next note.
 *
 * Messages are scheduled with explicit timestamps (output.send(data, when)) rather
 * than setTimeout, so the browser's MIDI clock spaces them — far tighter than JS
 * timers. `delayMs` is the gap between consecutive messages on the wire.
 *
 * Value convention (per note in the levels map): 1 = off … 127 = max. 0 is reserved
 * (it would read as a note-off), so the dimmest usable "on" level is 1.
 *
 * Primitives:
 *   sendSteps(Map<note,{steps,vel}>) — emit EXACTLY `steps` (off,on@vel) pairs per note (the
 *                                      planner decides the count); the maze HUD's drive path.
 *   sendOff(notes)                   — one bare note-off per note (light off, no move).
 *   driveTest({...})                 — manual investigation bench: drive N steps per note with a
 *                                      chosen step template + independent on/off hold times, to
 *                                      find the sequencing/timing the firmware counts reliably.
 * `sendSteps`/`sendOff` are paced through the shared token bucket; `driveTest` uses exact
 * timestamps (bypasses the bucket). `deadNotes` is a hard send-ban kept in sync with dead panels.
 */
import { logEvent } from '../eventLog.js';

const MIDI_SETTINGS_KEY = 'mazeMidi.settings.v1';

export class MazeMidiController {
  constructor(opts = {}) {
    this.delayMs   = opts.delayMs ?? 3;  // wire gap between consecutive messages (intra-note)
    this.pairs     = opts.pairs ?? 16;   // (note-off, note-on) pairs per note; 16 = one full move cycle
    this.interleave = opts.interleave ?? false; // true: round-robin notes; false: one note fully, then next
    this.rateHz    = opts.rateHz ?? 300; // token-bucket refill: sustained avg msgs/sec (long-run ceiling)
    this.burst     = opts.burst ?? 64;   // token-bucket capacity: max msgs in a burst before throttling
    this.enabled   = false;

    this._requested = false;
    this.access     = null;
    this.selectedOutputId = null;

    // Persisted global transport settings (rate/burst/delay + the chosen output) override the
    // config defaults above. Saved to localStorage on change; the maze belief lives separately.
    this._settingsTimer = null;
    this._loadSettings();

    // Persistent paced-send queue: every send APPENDS units to one FIFO drained by a single
    // long-lived pump under ONE token bucket, so the rate/burst guards hold across all callers
    // (movements, HUD, sweeps) no matter how sends arrive. Normal sends never cancel prior work
    // — only panic()/_cancel() flush the queue. (The inverted drive fires many small sends;
    // a per-send bucket would reset the budget each time and defeat the ceiling.)
    this._queue      = [];     // FIFO of units (each = messages sent contiguously, never split)
    this._draining   = false;  // is the drain pump active?
    this._pumpTimer  = null;   // the single in-flight drain timer id
    this._tokens     = this.burst; // token-bucket level (persists across enqueues)
    this._lastRefill = null;   // last token refill timestamp (set on first pump)
    this._out        = null;   // output resolved at enqueue time
    this._nextWhen   = 0;      // monotonic wire timestamp — guarantees delayMs between ALL messages
                               // (across units too), independent of when the pump code actually runs

    // Logging mode: when on, every message actually put on the wire is recorded per-note so
    // the HUD can show a panel's recent MIDI. Bounded per note to avoid unbounded growth.
    this.logging = false;
    this.log = new Map();      // note -> [{ t, on, vel }] (most-recent last)
    this._logCap = 400;        // messages kept per note

    // Optional "stop everything" callback invoked at the start of panic() — wired by main.js
    // to halt all movements (timeline + controllers + auto-cycle) so nothing re-drives after.
    this.onPanic = null;

    // Hard guard: notes here are never sent (belt-and-suspenders with the HUD's own
    // dead filter). The HUD keeps this in sync with tracked `dead` panels.
    this.deadNotes = new Set();

    // Clock + timer are injectable so the token-bucket guards can be driven by a virtual
    // clock in tests; they default to the real browser globals (identical behavior).
    this._now       = opts.now       ?? (() => performance.now());
    this._schedule  = opts.schedule  ?? ((fn, ms) => setTimeout(fn, ms));
    this._unschedule = opts.unschedule ?? ((id) => clearTimeout(id));

    // Skip DOM construction in a headless (test) context — everything below the wire
    // (pacing, guards, sends) works without the UI, which `_setStatus` no-ops against.
    // Output is ON by default in the browser (auto-requests MIDI + selects UM-ONE); headless
    // stays disabled so tests never touch navigator.requestMIDIAccess.
    if (typeof document !== 'undefined') {
      this._buildUI();
      this.enable(true);
    }
  }

  // ---- Sending --------------------------------------------------------------

  _output() {
    if (!this.access) return null;
    if (this.selectedOutputId && this.access.outputs.has(this.selectedOutputId)) {
      return this.access.outputs.get(this.selectedOutputId);
    }
    // fall back to the first available output
    const first = this.access.outputs.values().next().value;
    return first ?? null;
  }

  /**
   * Drive a set of panels: for each note, emit `pairs` (note-off, note-on) pairs so
   * the panel walks its move cycle and lands with the light at the requested level.
   * @param {Map<number, number>} levels  note number → level (1=off … 127=max)
   */
  move(levels) {
    const out = this._output();
    if (!out) { this._setStatus('no MIDI output selected', false); return false; }

    const entries = [...levels.entries()]
      .filter(([n]) => n >= 0 && n <= 127)
      .map(([n, v]) => [n | 0, Math.max(1, Math.min(127, v | 0))]);
    if (!entries.length) { this._setStatus('no notes to send', false); return false; }

    const pairs  = Math.max(1, this.pairs | 0);
    const rounds = pairs * 2;                      // pair = (off, on)
    const msgOf  = (note, vel, r) =>
      ((r % 2) === 1) ? [0x90, note, vel] : [0x80, note, 0]; // even round = note-off, odd = note-on

    // Units = message groups that must be sent contiguously (never split mid-note,
    // since a note's note-ons must arrive in one run). Sequential: one unit per note.
    // Interleaved: the whole round-robin stream is one indivisible unit.
    const units = [];
    if (this.interleave) {
      const all = [];
      for (let r = 0; r < rounds; r++)
        for (const [note, vel] of entries) all.push(msgOf(note, vel, r));
      units.push({ msgs: all });
    } else {
      for (const [note, vel] of entries) {
        const u = [];
        for (let r = 0; r < rounds; r++) u.push(msgOf(note, vel, r));
        units.push({ msgs: u, note });
      }
    }

    const lo = Math.min(...entries.map(([n]) => n));
    const hi = Math.max(...entries.map(([n]) => n));
    const mode = this.interleave ? 'interleaved' : 'sequential';
    return this._enqueue(out, units, `notes ${lo}–${hi} · ${pairs} pairs · ${mode}`, entries.length);
  }

  /**
   * Send exact per-panel step counts. For each note, emit `steps` (note-off, note-on@vel)
   * PAIRS sequentially — the panel walks `steps` positions along its 16-step cycle and
   * the light lands at `vel`. This is the primary drive path for the stateful HUD; the
   * planner (mazeState.js) decides `steps`, this just puts them on the wire under the
   * same guards as `move()`.
   * @param {Map<number, {steps:number, vel:number}>} plan  note → {steps, vel (1..127)}
   * @param {{onSent?: (note:number, whenMs:number) => void}} [opts]  onSent fires when a note's unit
   *        is actually put on the wire (post-throttle) — the real move-start (wire-synced moves).
   */
  sendSteps(plan, opts = {}) {
    const out = this._output();
    if (!out) { this._setStatus('no MIDI output selected', false); return false; }
    const onSent = opts.onSent;

    const units = [];
    let lo = Infinity, hi = -Infinity, noteCount = 0, totalSteps = 0;
    for (const [rawNote, spec] of plan.entries()) {
      const note = rawNote | 0;
      if (note < 0 || note > 127) continue;
      if (this.deadNotes.has(note)) continue;      // hard guard: never drive a dead panel
      const steps = Math.max(0, (spec?.steps | 0));
      if (steps <= 0) continue;                    // no movement requested
      const vel = Math.max(1, Math.min(127, spec?.vel | 0));
      const u = [];
      for (let s = 0; s < steps; s++) { u.push([0x80, note, 0]); u.push([0x90, note, vel]); }
      units.push({ msgs: u, note, onSent });
      lo = Math.min(lo, note); hi = Math.max(hi, note);
      noteCount++; totalSteps += steps;
    }
    if (!units.length) { this._setStatus('nothing to send (0 steps / all dead)', false); return false; }
    return this._enqueue(out, units, `${noteCount} notes · ${totalSteps} steps · notes ${lo}–${hi}`, noteCount);
  }

  /**
   * Turn lights off in place: one bare note-off per note, NO movement. The cheap path
   * for "light off without a stay loop". Dead panels are skipped.
   * @param {Iterable<number>} notes
   */
  sendOff(notes) {
    const out = this._output();
    if (!out) { this._setStatus('no MIDI output selected', false); return false; }
    const units = [];
    for (const raw of notes) {
      const note = raw | 0;
      if (note < 0 || note > 127 || this.deadNotes.has(note)) continue;
      units.push({ msgs: [[0x80, note, 0]], note });
    }
    if (!units.length) { this._setStatus('nothing to turn off', false); return false; }
    return this._enqueue(out, units, `${units.length} notes off (no move)`, units.length);
  }

  /**
   * Append message `units` to the shared paced queue (shared by move/sendSteps/sendOff).
   * Units are message groups sent contiguously (never split). ONE long-lived pump drains
   * the queue under a single token bucket — refill `rateHz` msgs/sec (sustained ceiling),
   * capacity `burst` msgs — so the guards hold across every caller and every send, however
   * they arrive. Appending never cancels prior work; only panic()/_cancel() flush.
   */
  _enqueue(out, units, label, noteCount) {
    this._out = out;                               // most recent output wins for the drain
    for (const u of units) this._queue.push(u);
    const added = units.reduce((n, u) => n + u.msgs.length, 0);
    this._setStatus(`queued ${this._queue.length} units · ${label}…`, true);
    if (this._activityEl) this._activityEl.textContent = `${noteCount} notes → +${added} msgs`;
    if (!this._draining) { this._draining = true; this._pump(); }
    return true;
  }

  /**
   * Drain one unit from the queue front under the persistent token bucket, then reschedule
   * itself. Intra-unit messages are timestamp-scheduled `delayMs` apart; unit-to-unit cadence
   * uses real setTimeout so it holds even if the browser ignores send timestamps. Idle time
   * between drains refills the bucket (capped), so a burst after a lull is still allowed.
   */
  _pump() {
    if (!this._queue.length) {                     // drained: park until the next enqueue
      this._draining = false;
      this._pumpTimer = null;
      this._setStatus('idle — queue drained', true);
      return;
    }
    const out  = this._out;
    const rate = Math.max(1, this.rateHz);
    const cap  = Math.max(1, this.burst | 0);
    const step = Math.max(0, this.delayMs);

    const now = this._now();
    if (this._lastRefill == null) this._lastRefill = now;
    this._tokens = Math.min(cap, this._tokens + (now - this._lastRefill) / 1000 * rate);
    this._lastRefill = now;

    const unit = this._queue[0];
    const cost = unit.msgs.length;
    const need = Math.min(cost, cap);              // waiting past a full bucket never helps
    if (this._tokens < need) {
      const waitMs = Math.ceil((need - this._tokens) / rate * 1000);
      this._pumpTimer = this._schedule(() => this._pump(), waitMs);
      return;
    }

    this._queue.shift();
    // Monotonic timestamp: at least `step` (delayMs) after the previous message on the wire, even
    // if the pump drained several units in a burst. This makes delayMs authoritative for the wire
    // spacing of EVERY message (note-ons, note-offs, all of it), not just messages within a unit.
    let when = Math.max(now + 1, this._nextWhen);
    let whenLast = when;
    for (const m of unit.msgs) { this._emit(out, m, when); whenLast = when; when += step; }
    this._nextWhen = when;                         // next message waits delayMs past this unit's last
    this._tokens -= cost;
    // Report the real send time (post-throttle) so the engine can sync belief/animation to it.
    if (unit.onSent) { try { unit.onSent(unit.note, whenLast); } catch (e) { console.error(e); } }

    const unitDur = Math.max(1, cost * step);      // wall time this unit occupies the wire
    this._pumpTimer = this._schedule(() => this._pump(), unitDur);
  }

  /** Put one message on the wire, recording it per-note when logging is on. */
  _emit(out, msg, when) {
    out.send(msg, when);
    if (!this.logging) return;
    const [status, note, vel] = msg;
    let arr = this.log.get(note);
    if (!arr) { arr = []; this.log.set(note, arr); }
    arr.push({ t: Date.now(), on: (status & 0xf0) === 0x90 && vel > 0, vel });
    if (arr.length > this._logCap) arr.splice(0, arr.length - this._logCap);
  }

  /** Drop everything queued and stop the pump (e.g. on Stop / switching movements). Already-
   *  dispatched messages can't be unsent, but no further queued movement reaches the wire. */
  flush() { this._cancel(); }

  /** Recorded messages for a note (most-recent last), or an empty array. */
  logFor(note) { return this.log.get(note) || []; }

  /** Clear the whole MIDI log. */
  clearLog() { this.log.clear(); }

  /** Flush the paced queue: drop all pending units and stop the pump. Used by panic() (and
   *  any explicit "stop everything" path); already-dispatched messages can't be unsent. */
  _cancel() {
    if (this._pumpTimer != null) this._unschedule(this._pumpTimer);
    this._pumpTimer = null;
    this._queue = [];
    this._draining = false;
    this._nextWhen = 0;   // fresh sends after a flush start from "now" again
  }

  /** Kill every light: one note-off (0x80) per note 0–127. No movement. First stops all
   *  movements (via onPanic) so nothing re-drives the maze right after. */
  panic() {
    logEvent('warn', 'PANIC — all lights off (note-off 0–127)');
    if (this.onPanic) { try { this.onPanic(); } catch (e) { console.error(e); } }
    this._cancel();                                // stop any in-flight move
    const out = this._output();
    if (!out) { this._setStatus('no MIDI output selected', false); return false; }
    const step = Math.max(0, this.delayMs);
    let when = this._now() + 1;
    for (let n = 0; n <= 127; n++) { this._emit(out, [0x80, n, 0], when); when += step; }
    this._setStatus('panic — all notes 0–127 off', true);
    if (this._activityEl) this._activityEl.textContent = 'panic (128 note-offs)';
    return true;
  }

  /**
   * MIDI-investigation test bench: drive each note in [lo..hi] `steps` steps, building each step
   * from `mode` with independent on/off hold times, and put it on the wire with computed
   * timestamps via `_emit` (so "log MIDI" records exactly what was sent). Deterministic: it
   * flushes the live queue and bypasses the token bucket — the point is exact chosen timing.
   *
   * Step templates ({ msg, hold } — hold = ms the state is held before the next message):
   *   pairs      — off (offHold), on@vel (onHold)   [the working default]
   *   on-first   — on@vel (onHold), off (offHold)   [order sensitivity]
   *   ons-only   — on@vel (onHold+offHold)          [no off to re-arm → should count as 1]
   *   double-off — off, off, on@vel                 [redundant re-arm; tests the lost-note-off idea]
   *   sandwich   — pairs, plus ONE trailing off      [ends dark; tests whether a closing off matters]
   *
   * @param {{lo:number,hi:number,steps:number,onHold:number,offHold:number,mode:string,vel:number,interleave:boolean}} opts
   */
  driveTest({ lo, hi, steps, onHold, offHold, mode = 'pairs', vel = 100, interleave = false }) {
    const out = this._output();
    if (!out) { this._setStatus('no MIDI output selected', false); return false; }
    const a = Math.min(lo, hi), b = Math.max(lo, hi);
    const notes = [];
    for (let n = a; n <= b; n++) if (n >= 0 && n <= 127) notes.push(n);
    if (!notes.length || steps <= 0) { this._setStatus('nothing to drive', false); return false; }

    this._cancel(); // clear any live backlog so the test timing is clean

    const OFF = (n) => [0x80, n, 0];
    const ON = (n) => [0x90, n, vel];
    const stepMsgs = (n) => {
      switch (mode) {
        case 'on-first':   return [{ msg: ON(n), hold: onHold }, { msg: OFF(n), hold: offHold }];
        case 'ons-only':   return [{ msg: ON(n), hold: onHold + offHold }];
        case 'double-off': return [
          { msg: OFF(n), hold: Math.max(1, Math.round(offHold / 2)) },
          { msg: OFF(n), hold: Math.max(1, Math.round(offHold / 2)) },
          { msg: ON(n), hold: onHold },
        ];
        case 'sandwich':   // pairs; the trailing off is appended once after all steps (below)
        case 'pairs':
        default:           return [{ msg: OFF(n), hold: offHold }, { msg: ON(n), hold: onHold }];
      }
    };
    const trailingOff = mode === 'sandwich';

    const t0 = this._now() + 1;
    let when = t0;
    let count = 0;
    if (!interleave) {
      // One note fully, then the next.
      for (const n of notes) {
        for (let s = 0; s < steps; s++) {
          for (const { msg, hold } of stepMsgs(n)) { this._emit(out, msg, when); when += Math.max(0, hold); count++; }
        }
        if (trailingOff) { this._emit(out, OFF(n), when); when += Math.max(0, offHold); count++; }
      }
    } else {
      // Interleave: each note runs its OWN correctly-timed step sequence (a step is a unit — off
      // held offHold, then on held onHold; steps back-to-back), so every note keeps its own on/off
      // hold. The notes are staggered by one wire gap so their messages pipeline and the wire stays
      // busy — the next note's step starts right after the previous note's, not after a group hold.
      const wire = Math.max(1, this.delayMs);
      const events = [];
      notes.forEach((n, i) => {
        let t = t0 + i * wire;
        for (let s = 0; s < steps; s++) {
          for (const { msg, hold } of stepMsgs(n)) { events.push({ when: t, msg }); t += Math.max(0, hold); }
        }
        if (trailingOff) events.push({ when: t, msg: OFF(n) });
      });
      events.sort((e1, e2) => e1.when - e2.when);
      for (const e of events) { this._emit(out, e.msg, e.when); count++; }
      when = events.length ? events[events.length - 1].when + 1 : t0;
    }

    const dur = Math.round(when - t0);
    this._setStatus(`drive ${notes.length}×${steps} · ${mode} · on ${onHold}/off ${offHold}ms · ~${dur}ms`, true);
    if (this._activityEl) this._activityEl.textContent = `${count} msgs${interleave ? ' · interleave' : ''}`;
    return true;
  }

  // ---- Web MIDI lifecycle ---------------------------------------------------

  async _ensureMidi() {
    if (this.access || this._requested) return;
    this._requested = true;
    if (!navigator.requestMIDIAccess) {
      this._setStatus('Web MIDI not supported in this browser');
      return;
    }
    this._setStatus('requesting MIDI access…');
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      this._setStatus('MIDI access denied — needs https or localhost');
      this._requested = false;
      return;
    }
    this.access.onstatechange = () => this._refreshOutputs();
    this._refreshOutputs();
  }

  _refreshOutputs() {
    if (!this.access || !this._outputSel) return;
    const prev = this.selectedOutputId;
    const opts = [];
    for (const out of this.access.outputs.values()) {
      opts.push(`<option value="${out.id}">${out.name || out.id}</option>`);
    }
    this._outputSel.innerHTML = opts.join('') || '<option value="">no outputs found</option>';
    const outs = [...this.access.outputs.values()];
    const ids = outs.map((o) => o.id);
    // Keep the operator's manual pick if still present; otherwise auto-select the maze's
    // UM-ONE interface when it's there, falling back to the first available output.
    const umOne = outs.find((o) => /um[-\s]?one/i.test(o.name || ''));
    this.selectedOutputId = ids.includes(prev) ? prev : (umOne?.id ?? ids[0] ?? null);
    if (this.selectedOutputId) this._outputSel.value = this.selectedOutputId;
    const n = this.access.outputs.size;
    this._setStatus(n ? `ready — ${n} output${n > 1 ? 's' : ''}` : 'no MIDI outputs found', n > 0);
  }

  enable(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    logEvent('info', on ? 'MIDI output enabled' : 'MIDI output disabled');
    this._enableBtn.textContent = on ? 'Disable output' : 'Enable output';
    this._enableBtn.classList.toggle('primary', on);
    if (on) this._ensureMidi();
    else this._setStatus('disabled', false);
  }

  // ---- Global settings persistence (rate/burst/delay + chosen output) -------

  /** Overlay persisted transport settings onto the config defaults (called once, in the ctor). */
  _loadSettings() {
    if (typeof localStorage === 'undefined') return;
    let blob;
    try { const raw = localStorage.getItem(MIDI_SETTINGS_KEY); blob = raw ? JSON.parse(raw) : null; }
    catch { blob = null; }
    if (!blob) return;
    if (Number.isFinite(blob.delayMs)) this.delayMs = Math.max(0, Math.min(50, blob.delayMs));
    if (Number.isFinite(blob.rateHz))  this.rateHz  = Math.max(1, Math.min(2000, Math.round(blob.rateHz)));
    if (Number.isFinite(blob.burst))   this.burst   = Math.max(1, Math.min(512, Math.round(blob.burst)));
    if (typeof blob.selectedOutputId === 'string') this.selectedOutputId = blob.selectedOutputId;
  }

  /** Debounced write of the global transport settings to localStorage. */
  _saveSettings() {
    if (typeof localStorage === 'undefined') return;
    if (this._settingsTimer) clearTimeout(this._settingsTimer);
    this._settingsTimer = setTimeout(() => {
      try {
        localStorage.setItem(MIDI_SETTINGS_KEY, JSON.stringify({
          delayMs: this.delayMs, rateHz: this.rateHz, burst: this.burst,
          selectedOutputId: this.selectedOutputId,
        }));
      } catch { /* quota / disabled — best effort */ }
    }, 300);
  }

  // ---- UI -------------------------------------------------------------------

  _buildUI() {
    const el = document.createElement('div');
    const numInput = (min, max, val) => {
      const i = document.createElement('input');
      i.type = 'number'; i.min = min; i.max = max; i.step = 1; i.value = val;
      i.className = 'val'; i.style.width = '52px';
      return i;
    };

    // Enable
    const enableRow = document.createElement('div');
    enableRow.className = 'row';
    this._enableBtn = document.createElement('button');
    this._enableBtn.textContent = 'Enable output';
    this._enableBtn.style.flex = '1';
    this._enableBtn.addEventListener('click', () => this.enable(!this.enabled));
    enableRow.append(this._enableBtn);

    // Output device
    const outRow = document.createElement('div');
    outRow.className = 'row';
    outRow.innerHTML = '<label>output</label>';
    this._outputSel = document.createElement('select');
    this._outputSel.style.cssText = 'flex:1;width:auto';
    this._outputSel.innerHTML = '<option value="">enable to list outputs</option>';
    this._outputSel.addEventListener('change', () => { this.selectedOutputId = this._outputSel.value; this._saveSettings(); });
    outRow.append(this._outputSel);

    // Sweep range
    const rangeRow = document.createElement('div');
    rangeRow.className = 'row';
    rangeRow.innerHTML = '<label>notes</label>';
    this._startInput = numInput(0, 127, 23);
    this._endInput   = numInput(0, 127, 110);
    const dash = document.createElement('span');
    dash.textContent = '–'; dash.style.color = 'var(--text-dim)';
    rangeRow.append(this._startInput, dash, this._endInput);

    // Brightness
    const brightRow = document.createElement('div');
    brightRow.className = 'row';
    brightRow.innerHTML = '<label>brightness</label>';
    this._brightInput = document.createElement('input');
    this._brightInput.type = 'range';
    this._brightInput.min = 1; this._brightInput.max = 127; this._brightInput.step = 1;
    this._brightInput.value = 100;
    this._brightVal = numInput(1, 127, 100);
    this._brightInput.addEventListener('input', () => { this._brightVal.value = this._brightInput.value; });
    this._brightVal.addEventListener('change', () => {
      const v = Math.max(1, Math.min(127, Math.round(Number(this._brightVal.value) || 1)));
      this._brightVal.value = v; this._brightInput.value = v;
    });
    brightRow.append(this._brightInput, this._brightVal);

    // Delay (controller property)
    const delayRow = document.createElement('div');
    delayRow.className = 'row';
    delayRow.innerHTML = '<label>delay (ms)</label>';
    this._delayInput = numInput(0, 50, this.delayMs);
    this._delayInput.addEventListener('change', () => {
      const v = Math.max(0, Math.min(50, Number(this._delayInput.value) || 0));
      this._delayInput.value = v; this.delayMs = v; this._saveSettings();
    });
    const delayHint = document.createElement('span');
    delayHint.className = 'hint'; delayHint.style.margin = '0';
    delayHint.textContent = 'wire gap between messages';
    delayRow.append(this._delayInput, delayHint);

    // Rate limit (token-bucket refill: sustained avg msgs/sec ceiling) — a hard guard.
    const rateRow = document.createElement('div');
    rateRow.className = 'row';
    rateRow.innerHTML = '<label>rate (msg/s)</label>';
    this._rateInput = numInput(1, 2000, this.rateHz);
    this._rateInput.addEventListener('change', () => {
      const v = Math.max(1, Math.min(2000, Math.round(Number(this._rateInput.value) || 1)));
      this._rateInput.value = v; this.rateHz = v; this._saveSettings();
    });
    const rateHint = document.createElement('span');
    rateHint.className = 'hint'; rateHint.style.margin = '0';
    rateHint.textContent = 'sustained ceiling (long-run avg)';
    rateRow.append(this._rateInput, rateHint);

    // Burst (token-bucket capacity: max msgs in a burst before throttling) — a hard guard.
    const burstRow = document.createElement('div');
    burstRow.className = 'row';
    burstRow.innerHTML = '<label>burst</label>';
    this._burstInput = numInput(1, 512, this.burst);
    this._burstInput.addEventListener('change', () => {
      const v = Math.max(1, Math.min(512, Math.round(Number(this._burstInput.value) || 1)));
      this._burstInput.value = v; this.burst = v; this._saveSettings();
    });
    const burstHint = document.createElement('span');
    burstHint.className = 'hint'; burstHint.style.margin = '0';
    burstHint.textContent = 'max msgs before throttling kicks in';
    burstRow.append(this._burstInput, burstHint);

    // ---- Sequencing test bench --------------------------------------------
    // Drive N steps per note with a chosen step template + independent on/off hold times, to
    // find the sequencing/timing the firmware counts reliably (its step counter drifts).
    const MODE_DESC = {
      pairs:        'off→on per step — the working default.',
      'on-first':   'on→off per step — reversed order (tests order sensitivity).',
      'ons-only':   'note-ons only, no off — should count as 1 (nothing re-arms it).',
      'double-off': 'off, off, on per step — a redundant re-arm (tests a lost note-off).',
      sandwich:     'off→on per step, then ONE extra off at the end — leaves it dark (tests a trailing off).',
    };
    const modeRow = document.createElement('div');
    modeRow.className = 'row';
    modeRow.innerHTML = '<label>mode</label>';
    this._modeSel = document.createElement('select');
    this._modeSel.style.cssText = 'flex:1;width:auto';
    for (const [v, label] of [
      ['pairs', 'pairs (off→on)'], ['on-first', 'on→off'], ['ons-only', 'ons only'],
      ['double-off', 'double-off'], ['sandwich', 'sandwich (off→on…off)'],
    ]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      this._modeSel.append(o);
    }
    modeRow.append(this._modeSel);

    // Per-mode explanation, updated on selection.
    const modeHint = document.createElement('div');
    modeHint.className = 'hint';
    modeHint.style.margin = '2px 0 0';
    modeHint.textContent = MODE_DESC.pairs;
    this._modeSel.addEventListener('change', () => { modeHint.textContent = MODE_DESC[this._modeSel.value] || ''; });

    const stepsRow = document.createElement('div');
    stepsRow.className = 'row';
    stepsRow.innerHTML = '<label>steps</label>';
    this._stepsInput = numInput(1, 64, 8);
    const stepsHint = document.createElement('span');
    stepsHint.className = 'hint'; stepsHint.style.margin = '0';
    stepsHint.textContent = 'steps to drive each note';
    stepsRow.append(this._stepsInput, stepsHint);

    const onHoldRow = document.createElement('div');
    onHoldRow.className = 'row';
    onHoldRow.innerHTML = '<label>on hold (ms)</label>';
    this._onHoldInput = numInput(0, 1000, 50);
    const onHoldHint = document.createElement('span');
    onHoldHint.className = 'hint'; onHoldHint.style.margin = '0';
    onHoldHint.textContent = 'note held ON before its off';
    onHoldRow.append(this._onHoldInput, onHoldHint);

    const offHoldRow = document.createElement('div');
    offHoldRow.className = 'row';
    offHoldRow.innerHTML = '<label>off hold (ms)</label>';
    this._offHoldInput = numInput(0, 1000, 50);
    const offHoldHint = document.createElement('span');
    offHoldHint.className = 'hint'; offHoldHint.style.margin = '0';
    offHoldHint.textContent = 'note held OFF before its on (re-arm)';
    offHoldRow.append(this._offHoldInput, offHoldHint);

    // Interleave toggle
    const interRow = document.createElement('div');
    interRow.className = 'row';
    interRow.innerHTML = '<label>interleave</label>';
    this._interCheck = document.createElement('input');
    this._interCheck.type = 'checkbox';
    this._interCheck.checked = this.interleave;
    this._interCheck.addEventListener('change', () => { this.interleave = this._interCheck.checked; });
    const interHint = document.createElement('span');
    interHint.className = 'hint'; interHint.style.margin = '0';
    interHint.textContent = 'off: one note fully, then next · on: notes pipelined (each keeps its own hold)';
    interRow.append(this._interCheck, interHint);

    // Fire
    const fireRow = document.createElement('div');
    fireRow.className = 'row';
    this._fireBtn = document.createElement('button');
    this._fireBtn.textContent = 'Drive';
    this._fireBtn.style.flex = '1';
    this._fireBtn.addEventListener('click', () => this._fireDrive());
    this._panicBtn = document.createElement('button');
    this._panicBtn.textContent = 'panic';
    this._panicBtn.title = 'All lights off (note-off 0–127, no movement)';
    this._panicBtn.addEventListener('click', () => { if (this.enabled) this.panic(); });
    fireRow.append(this._fireBtn, this._panicBtn);

    // Status
    const statusRow = document.createElement('div');
    statusRow.className = 'row';
    statusRow.innerHTML = '<label>status</label>';
    this._statusEl = document.createElement('span');
    this._statusEl.style.cssText = 'flex:1;color:var(--text-dim);font-size:11px';
    this._statusEl.textContent = 'disabled';
    statusRow.append(this._statusEl);

    // Activity
    const actRow = document.createElement('div');
    actRow.className = 'row';
    actRow.innerHTML = '<label>last</label>';
    this._activityEl = document.createElement('span');
    this._activityEl.className = 'val'; this._activityEl.style.width = 'auto';
    this._activityEl.textContent = '—';
    actRow.append(this._activityEl);

    // Light-blue = transport-wide: these apply to EVERY movement (output routing + the token-bucket
    // guards), not just this test bench. The unhighlighted fields below only drive this test.
    const markUniversal = (row) => {
      row.style.background   = 'rgba(110, 184, 255, 0.13)';
      row.style.borderLeft   = '3px solid #6db8ff';
      row.style.paddingLeft  = '6px';
      row.style.borderRadius = '3px';
      row.title = 'Transport-wide — affects every movement, not just this test';
    };
    [enableRow, outRow, delayRow, rateRow, burstRow].forEach(markUniversal);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.innerHTML =
      '<b style="color:#6db8ff">Light-blue</b> fields are transport-wide — they shape every ' +
      'movement’s MIDI. The rest drive only this test.<br>' +
      'Sequencing test: drive the note range `steps` steps using the chosen mode, holding each ' +
      'note ON/OFF for the given ms (velocity = brightness). Turn on “log MIDI” in the maze HUD ' +
      'and count what the panels register vs. what was sent. Interleave = pipelined per-note steps (multi-panel).';

    el.append(enableRow, outRow, rangeRow, brightRow, delayRow, rateRow, burstRow,
      modeRow, modeHint, stepsRow, onHoldRow, offHoldRow, interRow, fireRow, statusRow, actRow, hint);
    this.el = el;
  }

  /** Read the test-bench UI and run driveTest. */
  _fireDrive() {
    if (!this.enabled) { this._setStatus('enable output first', false); return; }
    const lo = Math.max(0, Math.min(127, Math.round(Number(this._startInput.value) || 0)));
    const hi = Math.max(0, Math.min(127, Math.round(Number(this._endInput.value) || 0)));
    const steps = Math.max(1, Math.round(Number(this._stepsInput.value) || 1));
    const onHold = Math.max(0, Math.round(Number(this._onHoldInput.value) || 0));
    const offHold = Math.max(0, Math.round(Number(this._offHoldInput.value) || 0));
    const vel = Math.max(1, Math.min(127, Math.round(Number(this._brightVal.value) || 1)));
    this.driveTest({ lo, hi, steps, onHold, offHold, mode: this._modeSel.value, vel, interleave: this.interleave });
  }

  _setStatus(text, ok = false) {
    if (!this._statusEl) return;
    this._statusEl.textContent = text;
    this._statusEl.style.color = ok ? 'var(--accent)' : 'var(--text-dim)';
  }
}
