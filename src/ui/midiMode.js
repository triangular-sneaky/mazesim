/**
 * MIDI overlay — drives panel LEDs from a MIDI controller on top of whatever movement
 * is currently playing. Panels still move normally; only brightness is affected here.
 *
 * When enabled, note-on lights the corresponding panel (seeded from velocity), aftertouch
 * sets brightness live, and note-off turns it off. Runs continuously; no movement lifecycle.
 *
 * Mute mode: when `this.muted` is true, every non-held panel's brightness is forced to 0
 * every frame. The movement still moves panels — only its LED effects are suppressed.
 *
 * Brightness mechanism: `panel.brightness` is a plain field that `panel.tick()` only
 * overwrites while a blink envelope is running. We re-assert held brightness each frame
 * in `tick()`, so MIDI always wins after any envelope pass. Mute works the same way.
 */
export class MidiMode {
  constructor(engine, opts = {}) {
    this.engine   = engine;
    this.baseNote = opts.baseNote ?? 36;   // C1

    this.enabled  = false;
    this.muted    = false;                 // suppress movement lights when true

    this._requested = false;
    this.access     = null;

    this.selectedInputId = 'all';

    this.panels      = engine.list();
    this.noteToPanel = new Map();
    this.held        = new Map();   // note -> brightness
    this.heldPanels  = new Set();   // Panel -> fast membership check for mute

    this._buildMap();
    this._buildUI();
  }

  // ---- Note map -------------------------------------------------------------

  _buildMap() {
    this.noteToPanel.clear();
    let mapped = 0;
    this.panels.forEach((p, i) => {
      const note = this.baseNote + i;
      if (note <= 127) { this.noteToPanel.set(note, p); mapped++; }
    });
    this._mapped = mapped;
    if (this._mapEl) {
      const last = this.baseNote + mapped - 1;
      this._mapEl.textContent = mapped
        ? `notes ${this.baseNote}–${last} → ${mapped} panels`
        : 'base note too high — all panels unmapped';
    }
  }

  // ---- UI -------------------------------------------------------------------

  _buildUI() {
    const el = document.createElement('div');

    // Enable toggle
    const enableRow = document.createElement('div');
    enableRow.className = 'row';
    this._enableBtn = document.createElement('button');
    this._enableBtn.textContent = 'Enable MIDI';
    this._enableBtn.style.flex = '1';
    this._enableBtn.addEventListener('click', () => this.enable(!this.enabled));
    enableRow.append(this._enableBtn);

    // Mute movement lights
    const muteRow = document.createElement('div');
    muteRow.className = 'row';
    muteRow.innerHTML = '<label>mute movement lights</label>';
    this._muteCheck = document.createElement('input');
    this._muteCheck.type = 'checkbox';
    this._muteCheck.addEventListener('change', () => {
      this.muted = this._muteCheck.checked;
      if (!this.muted) {
        // Un-muting: let the movement repaint naturally — we just stop zeroing.
        // Nothing to do; next engine.tick() will restore envelope-driven brightness.
      }
    });
    muteRow.append(this._muteCheck);
    const muteHint = document.createElement('span');
    muteHint.style.cssText = 'flex:1;color:var(--text-dim);font-size:11px;margin-left:4px';
    muteHint.textContent = 'movement still moves; only its LEDs suppressed';
    muteRow.append(muteHint);

    // Status
    const statusRow = document.createElement('div');
    statusRow.className = 'row';
    statusRow.innerHTML = '<label>status</label>';
    this._statusEl = document.createElement('span');
    this._statusEl.style.cssText = 'flex:1;color:var(--text-dim)';
    this._statusEl.textContent = 'disabled';
    statusRow.append(this._statusEl);

    // Input device
    const deviceRow = document.createElement('div');
    deviceRow.className = 'row';
    deviceRow.innerHTML = '<label>input</label>';
    this._deviceSel = document.createElement('select');
    this._deviceSel.style.cssText =
      'flex:1;width:auto;background:#0d0f12;color:var(--text);' +
      'border:1px solid var(--border);border-radius:4px;padding:3px 5px;font:inherit';
    this._deviceSel.innerHTML = '<option value="all">All inputs</option>';
    this._deviceSel.addEventListener('change', () => {
      this.selectedInputId = this._deviceSel.value;
    });
    deviceRow.append(this._deviceSel);

    // Base note
    const baseRow = document.createElement('div');
    baseRow.className = 'row';
    baseRow.innerHTML = '<label>base note</label>';
    this._baseInput = document.createElement('input');
    this._baseInput.type = 'number';
    this._baseInput.min = 0; this._baseInput.max = 127; this._baseInput.step = 1;
    this._baseInput.value = this.baseNote;
    this._baseInput.addEventListener('change', () => {
      const n = Math.max(0, Math.min(127, Math.round(Number(this._baseInput.value) || 0)));
      this.baseNote = n;
      this._baseInput.value = n;
      this._allOff();
      this._buildMap();
    });
    baseRow.append(this._baseInput);

    // Map readout
    const mapRow = document.createElement('div');
    mapRow.className = 'row';
    mapRow.innerHTML = '<label>map</label>';
    this._mapEl = document.createElement('span');
    this._mapEl.style.cssText = 'flex:1;color:var(--text-dim);font-size:11px';
    mapRow.append(this._mapEl);

    // Last event activity
    const actRow = document.createElement('div');
    actRow.className = 'row';
    actRow.innerHTML = '<label>last</label>';
    this._activityEl = document.createElement('span');
    this._activityEl.className = 'val';
    this._activityEl.style.width = 'auto';
    this._activityEl.textContent = '—';
    actRow.append(this._activityEl);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent =
      'Overlays on top of any active movement. ' +
      'Aftertouch sets brightness live; note-off turns the panel off. ' +
      'Notes assigned sequentially from base note in panel order.';

    el.append(enableRow, muteRow, statusRow, deviceRow, baseRow, mapRow, actRow, hint);
    this.el = el;
    this._buildMap();
  }

  _setStatus(text, ok = false) {
    if (!this._statusEl) return;
    this._statusEl.textContent = text;
    this._statusEl.style.color = ok ? 'var(--accent)' : 'var(--text-dim)';
  }

  _refreshDevices() {
    if (!this.access || !this._deviceSel) return;
    const prev = this.selectedInputId;
    const items = ['<option value="all">All inputs</option>'];
    for (const input of this.access.inputs.values()) {
      items.push(`<option value="${input.id}">${input.name || input.id}</option>`);
    }
    this._deviceSel.innerHTML = items.join('');
    this._deviceSel.value =
      [...this._deviceSel.options].some((o) => o.value === prev) ? prev : 'all';
    this.selectedInputId = this._deviceSel.value;
    const n = this.access.inputs.size;
    this._setStatus(n ? `ready — ${n} input${n > 1 ? 's' : ''}` : 'no inputs found', n > 0);
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
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (ev) => this._onMessage(ev);
    }
    this.access.onstatechange = () => {
      for (const input of this.access.inputs.values()) {
        if (!input.onmidimessage) input.onmidimessage = (ev) => this._onMessage(ev);
      }
      this._refreshDevices();
    };
    this._refreshDevices();
  }

  // ---- MIDI message handling ------------------------------------------------

  _onMessage(ev) {
    if (!this.enabled) return;
    if (this.selectedInputId !== 'all' && ev.target?.id !== this.selectedInputId) return;
    const [status, d1, d2] = ev.data;
    switch (status & 0xf0) {
      case 0x90: (d2 > 0) ? this._noteOn(d1, d2) : this._noteOff(d1); break;
      case 0x80: this._noteOff(d1); break;
      case 0xa0: this._polyAt(d1, d2);  break;
      case 0xd0: this._channelAt(d1);   break;
    }
  }

  _noteOn(note, vel) {
    const p = this.noteToPanel.get(note);
    if (!p) return;
    const b = vel / 127;
    this.held.set(note, b);
    this.heldPanels.add(p);
    p.brightness = b;
    if (this._activityEl) this._activityEl.textContent = `note ${note}  ${Math.round(b * 100)}%`;
  }

  _noteOff(note) {
    if (!this.held.has(note)) return;
    const p = this.noteToPanel.get(note);
    if (p) { p.brightness = 0; this.heldPanels.delete(p); }
    this.held.delete(note);
  }

  _polyAt(note, pressure) {
    if (!this.held.has(note)) return;
    const b = pressure / 127;
    this.held.set(note, b);
    const p = this.noteToPanel.get(note);
    if (p) p.brightness = b;
    if (this._activityEl) this._activityEl.textContent = `AT poly ${note}  ${Math.round(b * 100)}%`;
  }

  _channelAt(pressure) {
    const b = pressure / 127;
    for (const note of this.held.keys()) {
      this.held.set(note, b);
      const p = this.noteToPanel.get(note);
      if (p) p.brightness = b;
    }
    if (this.held.size && this._activityEl)
      this._activityEl.textContent = `AT ch  ${Math.round(b * 100)}%`;
  }

  _allOff() {
    for (const note of this.held.keys()) {
      const p = this.noteToPanel.get(note);
      if (p) p.brightness = 0;
    }
    this.held.clear();
    this.heldPanels.clear();
  }

  // ---- Enable / disable -----------------------------------------------------

  enable(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    this._enableBtn.textContent = on ? 'Disable MIDI' : 'Enable MIDI';
    this._enableBtn.classList.toggle('primary', on);
    if (on) {
      this._ensureMidi();
    } else {
      this._allOff();
      // Leave movement lights alone — let envelopes resume naturally.
      this._setStatus('disabled', false);
    }
  }

  // ---- Frame tick -----------------------------------------------------------

  tick(_dt) {
    if (!this.enabled) return;

    // Re-assert held brightness after engine.tick() may have overwritten via envelope.
    for (const [note, b] of this.held) {
      const p = this.noteToPanel.get(note);
      if (p) p.brightness = b;
    }

    // Mute: force all non-MIDI-held panels dark.
    if (this.muted) {
      for (const p of this.panels) {
        if (!this.heldPanels.has(p)) p.brightness = 0;
      }
    }
  }
}
