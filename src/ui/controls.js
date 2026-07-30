/**
 * Per-panel control surface for the two interaction types:
 *   - move: target position (required) + optional velocity, curve
 *   - blink: optional attack / sustain / decay
 * Technical/manual controls; the same engine action API will later be driven by MIDI.
 */
export class Controls {
  constructor(bodyEl, labelEl, engine, config, onSelectionChange) {
    this.body = bodyEl;
    this.label = labelEl;
    this.engine = engine;
    this.config = config;
    this.onSelectionChange = onSelectionChange;
    this.sel = null; // {x,y,orient}
    this._renderEmpty();
  }

  _renderEmpty() {
    this.label.textContent = 'none';
    this.body.innerHTML = '<div class="hint">Select a cell in the grid map above.</div>';
  }

  select(x, y, orient = 'h') {
    this.sel = { x, y, orient };
    this._render();
    this.onSelectionChange?.(this.sel);
  }

  _render() {
    const { x, y, orient } = this.sel;
    const m = this.config.motion, b = this.config.blink;
    const panel = this.engine.get(x, y, orient);
    this.label.textContent = `(${x}, ${y}) ${orient.toUpperCase()}`;

    this.body.innerHTML = `
      <div class="row">
        <label>orient</label>
        <button data-orient="h" class="${orient === 'h' ? 'primary' : ''}">h · E-W</button>
        <button data-orient="v" class="${orient === 'v' ? 'primary' : ''}">v · N-S</button>
      </div>
      <div class="row">
        <label>target</label>
        <input type="range" id="c-target" min="0" max="255" step="1" value="${Math.round(panel?.position ?? 128)}">
        <span class="val" id="c-target-val">${Math.round(panel?.position ?? 128)}</span>
      </div>
      <div class="row">
        <label>velocity</label>
        <input type="number" id="c-vel" min="1" max="1000" step="1" value="${m.velocity}">
        <label style="width:auto">curve</label>
        <select id="c-curve">
          <option value="linear" ${m.curve === 'linear' ? 'selected' : ''}>linear</option>
          <option value="smooth" ${m.curve === 'smooth' ? 'selected' : ''}>smooth</option>
        </select>
      </div>
      <div class="row"><button class="primary" id="c-move">Move</button>
        <span class="hint">(slider moves live)</span></div>
      <hr style="border-color:var(--border);margin:10px 0">
      <div class="row">
        <label>attack</label><input type="number" id="c-atk" min="0" step="0.01" value="${b.attack}">
        <label style="width:auto">sustain</label><input type="number" id="c-sus" min="0" step="0.01" value="${b.sustain}">
      </div>
      <div class="row">
        <label>decay</label><input type="number" id="c-dec" min="0" step="0.01" value="${b.decay}">
        <button class="primary" id="c-blink">Blink</button>
      </div>
    `;

    // Orient toggle
    this.body.querySelectorAll('[data-orient]').forEach((btn) => {
      btn.addEventListener('click', () => this.select(x, y, btn.dataset.orient));
    });

    // Move controls
    const target = this.body.querySelector('#c-target');
    const targetVal = this.body.querySelector('#c-target-val');
    const vel = this.body.querySelector('#c-vel');
    const curve = this.body.querySelector('#c-curve');
    const doMove = () => this.engine.movePanel(x, y, orient, Number(target.value), {
      velocity: Number(vel.value), curve: curve.value,
    });
    target.addEventListener('input', () => {
      targetVal.textContent = target.value;
      doMove(); // live feedback
    });
    this.body.querySelector('#c-move').addEventListener('click', doMove);

    // Blink controls
    this.body.querySelector('#c-blink').addEventListener('click', () => {
      this.engine.blinkPanel(x, y, orient, {
        attack: Number(this.body.querySelector('#c-atk').value),
        sustain: Number(this.body.querySelector('#c-sus').value),
        decay: Number(this.body.querySelector('#c-dec').value),
      });
    });
  }

  /** Keep the live position readout in sync when demos/animation move this panel. */
  refresh() {
    if (!this.sel) return;
    const panel = this.engine.get(this.sel.x, this.sel.y, this.sel.orient);
    const slider = this.body.querySelector('#c-target');
    const val = this.body.querySelector('#c-target-val');
    // Only reflect when the user isn't dragging (slider not focused).
    if (panel && slider && document.activeElement !== slider) {
      const p = Math.round(panel.position);
      slider.value = p;
      val.textContent = p;
    }
  }
}
