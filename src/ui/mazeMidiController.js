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
 * setLight(levels) drives brightness while holding position: for each note it emits
 * PAIRS (=16) of (note-off, note-on) — 16 note-ons net zero movement, and the final
 * message per note is the note-on, so the light lands at the requested level. Losing
 * or reordering a message breaks the balance (panel drifts, or light ends off), so
 * exactly 16 pairs are sent — no re-sends, no extra note-ons.
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
 * Beyond the fixed-`pairs` investigation sweep (`move`), this also exposes the stateful
 * drive primitives used by the maze HUD, both paced through the same token bucket:
 *   sendSteps(Map<note,{steps,vel}>) — emit EXACTLY `steps` (off,on@vel) pairs per note
 *                                      (the planner decides the count); sequential.
 *   sendOff(notes)                   — one bare note-off per note (light off, no move).
 * `deadNotes` is a hard send-ban set kept in sync with the HUD's dead panels.
 */
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

    // Logging mode: when on, every message actually put on the wire is recorded per-note so
    // the HUD can show a panel's recent MIDI. Bounded per note to avoid unbounded growth.
    this.logging = false;
    this.log = new Map();      // note -> [{ t, on, vel }] (most-recent last)
    this._logCap = 400;        // messages kept per note

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
      units.push(all);
    } else {
      for (const [note, vel] of entries) {
        const u = [];
        for (let r = 0; r < rounds; r++) u.push(msgOf(note, vel, r));
        units.push(u);
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
   */
  sendSteps(plan) {
    const out = this._output();
    if (!out) { this._setStatus('no MIDI output selected', false); return false; }

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
      units.push(u);
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
      units.push([[0x80, note, 0]]);
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
    const added = units.reduce((n, u) => n + u.length, 0);
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
    const cost = unit.length;
    const need = Math.min(cost, cap);              // waiting past a full bucket never helps
    if (this._tokens < need) {
      const waitMs = Math.ceil((need - this._tokens) / rate * 1000);
      this._pumpTimer = this._schedule(() => this._pump(), waitMs);
      return;
    }

    this._queue.shift();
    let when = now + 1;                            // tiny lead so all sends are scheduled
    for (const m of unit) { this._emit(out, m, when); when += step; }
    this._tokens -= cost;

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
  }

  /** Kill every light: one note-off (0x80) per note 0–127. No movement. */
  panic() {
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
    this._enableBtn.textContent = on ? 'Disable output' : 'Enable output';
    this._enableBtn.classList.toggle('primary', on);
    if (on) this._ensureMidi();
    else this._setStatus('disabled', false);
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
    this._outputSel.addEventListener('change', () => { this.selectedOutputId = this._outputSel.value; });
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
      this._delayInput.value = v; this.delayMs = v;
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
      this._rateInput.value = v; this.rateHz = v;
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
      this._burstInput.value = v; this.burst = v;
    });
    const burstHint = document.createElement('span');
    burstHint.className = 'hint'; burstHint.style.margin = '0';
    burstHint.textContent = 'max msgs before throttling kicks in';
    burstRow.append(this._burstInput, burstHint);

    // Pairs (controller property) — (note-off, note-on) pairs per note
    const pairsRow = document.createElement('div');
    pairsRow.className = 'row';
    pairsRow.innerHTML = '<label>pairs</label>';
    this._pairsInput = numInput(1, 64, this.pairs);
    this._pairsInput.addEventListener('change', () => {
      const v = Math.max(1, Math.min(64, Math.round(Number(this._pairsInput.value) || 1)));
      this._pairsInput.value = v; this.pairs = v;
    });
    const pairsHint = document.createElement('span');
    pairsHint.className = 'hint'; pairsHint.style.margin = '0';
    pairsHint.textContent = 'off/on pairs per note (16 = full cycle)';
    pairsRow.append(this._pairsInput, pairsHint);

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
    interHint.textContent = 'off: one note fully, then next';
    interRow.append(this._interCheck, interHint);

    // Fire
    const fireRow = document.createElement('div');
    fireRow.className = 'row';
    this._fireBtn = document.createElement('button');
    this._fireBtn.textContent = 'setLight';
    this._fireBtn.style.flex = '1';
    this._fireBtn.addEventListener('click', () => this._fireSweep());
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

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent =
      'Sends 16 (note-off, note-on) pairs per note, interleaved across the sweep, to ' +
      'set brightness while holding panels in place. 1 = off, 127 = max.';

    el.append(enableRow, outRow, rangeRow, brightRow, delayRow, rateRow, burstRow, pairsRow, interRow, fireRow, statusRow, actRow, hint);
    this.el = el;
  }

  _fireSweep() {
    if (!this.enabled) { this._setStatus('enable output first', false); return; }
    let a = Math.max(0, Math.min(127, Math.round(Number(this._startInput.value) || 0)));
    let b = Math.max(0, Math.min(127, Math.round(Number(this._endInput.value) || 0)));
    if (a > b) [a, b] = [b, a];
    const level = Math.max(1, Math.min(127, Math.round(Number(this._brightVal.value) || 1)));
    const levels = new Map();
    for (let n = a; n <= b; n++) levels.set(n, level);
    this.move(levels);
  }

  _setStatus(text, ok = false) {
    if (!this._statusEl) return;
    this._statusEl.textContent = text;
    this._statusEl.style.color = ok ? 'var(--accent)' : 'var(--text-dim)';
  }
}
