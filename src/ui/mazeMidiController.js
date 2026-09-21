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
 */
export class MazeMidiController {
  constructor(opts = {}) {
    this.delayMs   = opts.delayMs ?? 2;  // wire gap between consecutive messages
    this.pairs     = opts.pairs ?? 16;   // (note-off, note-on) pairs per note; 16 = one full move cycle
    this.interleave = opts.interleave ?? false; // true: round-robin notes; false: one note fully, then next
    this.enabled   = false;

    this._requested = false;
    this.access     = null;
    this.selectedOutputId = null;

    this._buildUI();
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
   * Set brightness on a set of panels while holding them in place.
   * @param {Map<number, number>} levels  note number → level (1=off … 127=max)
   */
  setLight(levels) {
    const out = this._output();
    if (!out) { this._setStatus('no MIDI output selected', false); return false; }

    const entries = [...levels.entries()]
      .filter(([n]) => n >= 0 && n <= 127)
      .map(([n, v]) => [n | 0, Math.max(1, Math.min(127, v | 0))]);
    if (!entries.length) { this._setStatus('no notes to send', false); return false; }

    const pairs  = Math.max(1, this.pairs | 0);
    const rounds = pairs * 2;                      // pair = (off, on)
    const step   = Math.max(0, this.delayMs);
    const msgOf  = (note, vel, r) =>
      ((r % 2) === 1) ? [0x90, note, vel] : [0x80, note, 0]; // even round = note-off, odd = note-on

    // Build the ordered message list, then schedule it.
    const msgs = [];
    if (this.interleave) {
      // round-robin: message r of every note before advancing to r+1
      for (let r = 0; r < rounds; r++)
        for (const [note, vel] of entries) msgs.push(msgOf(note, vel, r));
    } else {
      // sequential: all 2*pairs messages of one note, then the next note
      for (const [note, vel] of entries)
        for (let r = 0; r < rounds; r++) msgs.push(msgOf(note, vel, r));
    }

    let when = performance.now() + 1;              // tiny lead so all sends are scheduled
    for (const m of msgs) { out.send(m, when); when += step; }
    const count = msgs.length;

    const lo = Math.min(...entries.map(([n]) => n));
    const hi = Math.max(...entries.map(([n]) => n));
    const dur = (count * step).toFixed(0);
    const mode = this.interleave ? 'interleaved' : 'sequential';
    this._setStatus(`sent ${count} msgs · notes ${lo}–${hi} · ${pairs} pairs · ${mode} · ~${dur}ms`, true);
    if (this._activityEl) this._activityEl.textContent = `${entries.length} notes → ${count} msgs`;
    return true;
  }

  /** Kill every light: one note-off (0x80) per note 0–127. No movement. */
  panic() {
    const out = this._output();
    if (!out) { this._setStatus('no MIDI output selected', false); return false; }
    const step = Math.max(0, this.delayMs);
    let when = performance.now() + 1;
    for (let n = 0; n <= 127; n++) { out.send([0x80, n, 0], when); when += step; }
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
    const ids = [...this.access.outputs.keys()];
    this.selectedOutputId = ids.includes(prev) ? prev : (ids[0] ?? null);
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

    el.append(enableRow, outRow, rangeRow, brightRow, delayRow, pairsRow, interRow, fireRow, statusRow, actRow, hint);
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
    this.setLight(levels);
  }

  _setStatus(text, ok = false) {
    if (!this._statusEl) return;
    this._statusEl.textContent = text;
    this._statusEl.style.color = ok ? 'var(--accent)' : 'var(--text-dim)';
  }
}
