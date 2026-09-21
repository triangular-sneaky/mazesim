/**
 * MIDI overlay — drives panel LEDs (and optionally movement triggers) from a MIDI
 * controller on top of whatever movement is currently playing.
 *
 * Effects:
 *   'lights'  — note-on lights the panel (seeded from velocity), aftertouch sets
 *               brightness live, note-off turns it off. The classic overlay.
 *   'trigger' — any note-on fires one particle burst on the currently-playing
 *               triggerable movement (Particles). Note-off/aftertouch ignored.
 *               The movement's auto-loop is suppressed while this is armed.
 */
export class MidiMode {
  constructor(engine, opts = {}) {
    this.engine   = engine;
    this.player   = opts.player ?? null;
    this.baseNote = opts.baseNote ?? 36;   // C1

    this.enabled  = false;
    this.muted    = false;
    this.effect   = 'lights';              // 'lights' | 'trigger'
    this.channel  = 'all';                // 'all' or 0-15 (MIDI channel index)

    this._requested = false;
    this.access     = null;

    this.selectedInputId = 'all';

    this.panels      = engine.list();
    this.noteToPanel = new Map();
    this.held        = new Map();   // note -> brightness
    this.heldPanels  = new Set();

    this._buildMap();
    this._buildUI();
  }

  // ---- Note map ---------------------------------------------------------------

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
    const sel = (css = '') =>
      Object.assign(document.createElement('select'), { style: {
        cssText: `flex:1;width:auto;background:#0d0f12;color:var(--text);` +
                 `border:1px solid var(--border);border-radius:4px;padding:3px 5px;font:inherit;${css}`,
      }});

    // Enable toggle
    const enableRow = document.createElement('div');
    enableRow.className = 'row';
    this._enableBtn = document.createElement('button');
    this._enableBtn.textContent = 'Enable MIDI';
    this._enableBtn.style.flex = '1';
    this._enableBtn.addEventListener('click', () => this.enable(!this.enabled));
    enableRow.append(this._enableBtn);

    // Effect
    const effectRow = document.createElement('div');
    effectRow.className = 'row';
    effectRow.innerHTML = '<label>effect</label>';
    this._effectSel = sel();
    this._effectSel.innerHTML =
      '<option value="lights">Horizontal lights</option>' +
      '<option value="trigger">Trigger</option>';
    this._effectSel.value = this.effect;
    this._effectSel.addEventListener('change', () => this._setEffect(this._effectSel.value));
    effectRow.append(this._effectSel);

    // Channel filter
    const chanRow = document.createElement('div');
    chanRow.className = 'row';
    chanRow.innerHTML = '<label>channel</label>';
    this._channelSel = sel();
    this._channelSel.innerHTML =
      '<option value="all">All channels</option>' +
      Array.from({ length: 16 }, (_, i) => `<option value="${i}">Ch ${i + 1}</option>`).join('');
    this._channelSel.value = this.channel;
    this._channelSel.addEventListener('change', () => {
      const v = this._channelSel.value;
      this.channel = v === 'all' ? 'all' : parseInt(v, 10);
    });
    chanRow.append(this._channelSel);

    // Mute movement lights
    const muteRow = document.createElement('div');
    muteRow.className = 'row';
    muteRow.innerHTML = '<label>mute movement lights</label>';
    this._muteCheck = document.createElement('input');
    this._muteCheck.type = 'checkbox';
    this._muteCheck.addEventListener('change', () => { this.muted = this._muteCheck.checked; });
    const muteHint = document.createElement('span');
    muteHint.style.cssText = 'flex:1;color:var(--text-dim);font-size:11px;margin-left:4px';
    muteHint.textContent = 'movement still moves; only its LEDs suppressed';
    muteRow.append(this._muteCheck, muteHint);

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
    this._deviceSel = sel();
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
      'Lights: notes light panels from base note; aftertouch sets brightness; note-off turns off. ' +
      'Trigger: each note fires a particle burst on the active Particles movement (loop suppressed).';

    el.append(enableRow, effectRow, chanRow, muteRow, statusRow, deviceRow, baseRow, mapRow, actRow, hint);
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

  // ---- Effect / arm wiring ---------------------------------------------------

  _setEffect(name) {
    if (this.effect === name) return;
    if (this.effect === 'lights') this._allOff();
    this.effect = name;
    this._updateArm();
  }

  _updateArm() {
    this.player?.armTrigger(this.enabled && this.effect === 'trigger');
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

    // Channel filter: MIDI channel is the low nibble of the status byte (0-indexed).
    const chan = status & 0x0f;
    if (this.channel !== 'all' && chan !== this.channel) return;

    if (this.effect === 'lights') {
      switch (status & 0xf0) {
        case 0x90: (d2 > 0) ? this._noteOn(d1, d2) : this._noteOff(d1); break;
        case 0x80: this._noteOff(d1); break;
        case 0xa0: this._polyAt(d1, d2);  break;
        case 0xd0: this._channelAt(d1);   break;
      }
    } else if (this.effect === 'trigger') {
      if ((status & 0xf0) === 0x90 && d2 > 0) {
        const ok = this.player?.fireTrigger();
        if (ok === false) {
          this._setStatus('no triggerable movement playing');
        } else if (ok) {
          if (this._activityEl) this._activityEl.textContent = `trigger  note ${d1}`;
        }
      }
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
      this._setStatus('disabled', false);
    }
    this._updateArm();
  }

  // ---- Frame tick -----------------------------------------------------------

  tick(_dt) {
    if (!this.enabled) return;

    // Lights effect: re-assert held brightness after engine.tick() envelope pass.
    if (this.effect === 'lights') {
      for (const [note, b] of this.held) {
        const p = this.noteToPanel.get(note);
        if (p) p.brightness = b;
      }
      if (this.muted) {
        for (const p of this.panels) {
          if (!this.heldPanels.has(p)) p.brightness = 0;
        }
      }
    }
  }
}
