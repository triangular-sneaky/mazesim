/**
 * LullabyFloat — center cell bounces lo↔hi at global speed.
 * Elastic field: each tick reads center's actual position and commands every
 * surrounding panel to topPos + (centerPos - topPos) * falloff * elasticity.
 * Because panels are commanded toward the center's CURRENT position (not final
 * target), the center naturally leads and others chase behind proportionally —
 * closer panels follow more tightly, far ones barely move.
 *
 * All movement goes through engine.movePanel / engine.sweepTo (global speed only).
 * Brightness is written directly to panel.brightness each tick, after engine.tick().
 *
 * Direction reversal only triggers once the center panels report moving===false,
 * preventing the ease-in/ease-out from restarting mid-travel (jerk).
 */
import { panelCenter, cellEdgeList, edgeKey } from '../model/layout.js';

export class LullabyFloat {
  constructor(engine) {
    this.engine = engine;
    this._active = false;
    this._going  = null; // 'down' | 'up'
    this._timer  = null;
    this._dwelling = false;

    this.lo          = 80;
    this.hi          = 170;
    this.topPos      = 255;
    this.dwell       = 0.5;  // pause at each extreme (seconds)
    this.elastic     = true;
    this.elasticity  = 0.9;

    this._fadeIn  = 0;      // 0..1 brightness ramp on activation
    this._fadeDur = 1.2;    // seconds for fade-in

    this._setupGeometry();
    this._buildUI();
  }

  // ---- Geometry -------------------------------------------------------------

  _setupGeometry() {
    const panels = this.engine.list();
    const seen = new Map();
    for (const p of panels) seen.set(`${p.x},${p.y}`, { x: p.x, y: p.y });
    const cells = [...seen.values()];
    const cx = cells.reduce((s, c) => s + c.x, 0) / cells.length;
    const cy = cells.reduce((s, c) => s + c.y, 0) / cells.length;
    const centerX = Math.round(cx);
    const centerY = Math.round(cy);

    this._centerKeys = new Set(cellEdgeList(centerX, centerY).map(edgeKey));

    const ccx = centerX + 0.5, ccy = centerY + 0.5;
    this._panelData = panels.map((p) => {
      const { px, py } = panelCenter(p.x, p.y, p.orient);
      const dist     = Math.hypot(px - ccx, py - ccy);
      const isCenter = this._centerKeys.has(`${p.x},${p.y},${p.orient}`);
      return { p, dist, isCenter };
    });

    this._maxDist      = Math.max(1, ...this._panelData.map((pd) => pd.dist));
    this._centerPanels = this._panelData.filter((pd) => pd.isCenter).map((pd) => pd.p);
  }

  _readCenterPos() {
    if (!this._centerPanels.length) return this.topPos;
    return this._centerPanels.reduce((s, p) => s + p.position, 0) / this._centerPanels.length;
  }

  // ---- Lifecycle ------------------------------------------------------------

  setActive(on) {
    if (this._active === on) return; // idempotent — DemoBank calls this on every render
    this._active = on;
    if (this._timer !== null) { clearTimeout(this._timer); this._timer = null; }
    this._dwelling = false;
    if (on) {
      this._fadeIn = 0; // reset fade-in ramp
      this._startDown();
    } else {
      this._going = null;
      this.engine.moveAll(this.topPos);
      const fadeOut = { attack: 0, sustain: 0, decay: 1.5, peak: 0 };
      for (const { p } of this._panelData) {
        this.engine.blinkPanel(p.x, p.y, p.orient, fadeOut);
      }
    }
  }

  // ---- Oscillation state machine --------------------------------------------
  // Only the center is commanded here. Elastic panels are driven every tick
  // from the center's actual current position, so they chase the center naturally.
  // Reversal fires only once p.moving===false (detected in tick), so sweepTo is
  // never restarted while the ease profile is still in progress.

  _startDown() {
    if (!this._active) return;
    this._going    = 'down';
    this._dwelling = false;
    this.engine.sweepTo(this._centerPanels.map((p) => ({ ...p, target: this.lo })));
  }

  _startUp() {
    if (!this._active) return;
    this._going    = 'up';
    this._dwelling = false;
    this.engine.sweepTo(this._centerPanels.map((p) => ({ ...p, target: this.hi })));
  }

  // ---- Tick — arrival detection + elastic field + brightness ----------------

  tick(dt) {
    if (!this._active) return;

    // Advance fade-in ramp (brightness 0→1 over _fadeDur seconds after activation).
    if (this._fadeIn < 1) this._fadeIn = Math.min(1, this._fadeIn + dt / this._fadeDur);

    // Arrival detection: trigger dwell only after center has fully stopped.
    // p.moving===false means moveTo completed (position===target), so restarting
    // sweepTo is guaranteed to be a clean start from rest — no ease-profile restart jerk.
    if (this._going !== null && !this._dwelling && this._centerPanels.length > 0) {
      const allStopped = this._centerPanels.every((p) => !p.moving);
      if (allStopped) {
        this._dwelling = true;
        if (this.dwell > 0) {
          this._timer = setTimeout(() => {
            this._dwelling = false;
            this._timer    = null;
            if (this._going === 'down') this._startUp();
            else this._startDown();
          }, this.dwell * 1000);
        } else {
          // Zero dwell: reverse on the next frame (not synchronously, to avoid
          // calling sweepTo and then re-detecting allStopped in the same tick).
          this._timer = setTimeout(() => {
            this._dwelling = false;
            this._timer    = null;
            if (this._going === 'down') this._startUp();
            else this._startDown();
          }, 0);
        }
      }
    }

    const centerPos = this._readCenterPos();
    const topPos    = this.topPos;
    const range     = Math.max(1, topPos - this.lo);
    // How far down the center currently is (0 = at topPos, 1 = at lo).
    const pull = Math.max(0, (topPos - centerPos) / range);

    for (const { p, dist, isCenter } of this._panelData) {
      const falloff = Math.max(0, 1 - dist / this._maxDist);

      if (isCenter) {
        p.brightness = this._fadeIn;
      } else if (this.elastic) {
        // Chase center's current actual position — creates natural lead/lag cascade.
        const target = Math.round(topPos + (centerPos - topPos) * falloff * this.elasticity);
        this.engine.movePanel(p.x, p.y, p.orient, target);
        p.brightness = falloff * pull * this._fadeIn;
      } else {
        p.brightness = 0;
      }
    }
  }

  // ---- UI -------------------------------------------------------------------

  _buildUI() {
    const el = document.createElement('div');

    const sliderRow = (label, key, min, max, step) => {
      const r   = document.createElement('div');
      r.className = 'row';
      const lbl = document.createElement('label');
      lbl.textContent = label;
      const sl  = document.createElement('input');
      sl.type = 'range'; sl.min = min; sl.max = max; sl.step = step; sl.value = this[key];
      const num = document.createElement('input');
      num.type = 'number'; num.className = 'val';
      num.min = min; num.max = max; num.step = step; num.value = this[key];
      sl.addEventListener('input', () => {
        this[key] = parseFloat(sl.value); num.value = sl.value;
      });
      num.addEventListener('change', () => {
        const v = Math.max(+min, Math.min(+max, parseFloat(num.value) || +min));
        this[key] = v; num.value = v; sl.value = v;
      });
      r.append(lbl, sl, num);
      return r;
    };

    el.append(
      sliderRow('low',         'lo',         0, 255, 5  ),
      sliderRow('high',        'hi',         0, 255, 5  ),
      sliderRow('rest',        'topPos',     0, 255, 5  ),
      sliderRow('dwell (s)',   'dwell',      0, 5,   0.1),
      sliderRow('elasticity',  'elasticity', 0, 1,   0.05),
    );

    const eRow = document.createElement('div');
    eRow.className = 'row';
    eRow.innerHTML = '<label>elastic field</label>';
    const check = document.createElement('input');
    check.type = 'checkbox'; check.checked = this.elastic;
    check.addEventListener('change', () => { this.elastic = check.checked; });
    eRow.append(check);
    el.append(eRow);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Center bounces lo↔hi; elastic field chases center position — closer panels follow deeper, periphery stays near rest.';
    el.append(hint);

    this.el = el;
  }
}
