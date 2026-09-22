/**
 * Maze HUD — the operator's control surface for the PHYSICAL maze.
 *
 * Bridges the virtual sim to reality: it owns nothing about MIDI timing (that's the
 * MazeMidiController's job) and nothing about the bounce math (that's mazeState.js) —
 * it plans per-panel step counts, dispatches them through the transport, commits the
 * optimistic tracked belief, and lets the operator repair drift by eye.
 *
 * Two always-live views of the same tracked state (both shown at once):
 *   2D      — a top-down canvas: every panel edge tinted by tracked z, an arrow for v,
 *             an amber overlay for brightness; dead panels greyed. Click to select.
 *   virtual — compact chips floating over the 3D view at each panel's believed height
 *             (projected via SceneView.worldToScreen). Click a chip to select.
 * Selecting a panel opens a shared control card (flip / correct / step×1 / set-z /
 * mark-dead) — one card instead of 86×5 live buttons.
 *
 * "Mirror→3D" (on by default) re-asserts tracked belief back onto the sim so the 3D view
 * reflects the physical maze (state) rather than the design pose; turn it off to let the
 * demos drive the sim freely. Dead panels are parked at the top, unlit and greyed.
 */
import { N, CYCLE, aOf, applyN, planMove, planStay, zToPos, posToZ, brightToVel } from '../model/mazeState.js';

// Re-exported for callers (and tests) that historically imported them from the HUD; the
// definitions now live in the pure model so the engine adapter can share them.
export { zToPos, posToZ, brightToVel };

/**
 * Pure scene planner: given tracked panels and a sim-pose lookup, decide the per-panel
 * step plan + tracked-state commits needed to drive reality to a target sim pose.
 * Kept free of DOM/MIDI so it's unit-testable; a caller wires it to the transport.
 *
 * Per non-dead panel with a resolvable sim pose:
 *   - target height differs   → planMove (light at vel, min 1 so any move is visible)
 *   - already at height, lit   → planStay (re-trigger the light in place)
 *   - already at height, dark  → skip (use panic / sendOff to darken)
 *
 * @param {Array<{note:number,x:number,y:number,orient:string,z:number,v:number,dead:boolean}>} panels
 * @param {(p:object) => ({position:number, brightness:number}|null)} simOf
 * @returns {{ plan: Map<number,{steps:number,vel:number}>, commits: [number, object, number][] }}
 */
export function computeScenePlan(panels, simOf) {
  const plan = new Map();
  const commits = [];
  for (const p of panels) {
    if (p.dead) continue;
    const sim = simOf(p);
    if (!sim) continue;
    const zT = posToZ(sim.position);
    const vel = brightToVel(sim.brightness);
    if (zT !== p.z) {
      const mv = planMove(p.z, p.v, zT);
      plan.set(p.note, { steps: mv.steps, vel: vel > 0 ? vel : 1 });
      commits.push([p.note, mv.newState, vel]);
    } else if (vel > 0) {
      const st = planStay(p.z, p.v);
      plan.set(p.note, { steps: st.steps, vel });
      commits.push([p.note, st.newState, vel]);
    }
  }
  return { plan, commits };
}

export class MazeHud {
  /**
   * @param {HTMLElement} container   sidebar section body to mount the panel UI into
   * @param {object} opts
   * @param {import('../model/mazeEngine.js').MazeEngine} opts.engine
   * @param {import('../model/grid.js').Grid} opts.grid
   * @param {import('../render/scene.js').SceneView} opts.view
   * @param {import('../model/mazeState.js').MazeState} opts.state
   * @param {import('./mazeMidiController.js').MazeMidiController} opts.midi
   * @param {HTMLElement} opts.viewport   the #viewport element (for the overlay layer)
   * @param {{x:number,y:number}[]} opts.cells
   */
  constructor(container, { engine, grid, view, state, midi, viewport, cells, meshes }) {
    this.engine = engine;
    this.grid = grid;
    this.view = view;
    this.state = state;
    this.midi = midi;
    this.meshes = meshes;       // 3D panel meshes (for greying dead panels); may be absent
    this.viewport = viewport;

    // Both views are always live: the 2D top-down canvas AND the virtual chips over the 3D
    // scene. The 3D sim always mirrors tracked belief — with the movement→state inversion the
    // sim is a READOUT of the physical maze, not something the demos paint, so there is no
    // longer anything to toggle: this.tick() drives the sim to belief every frame.
    this.selectedNote = null;
    this._lastMirroredPos = new Map();  // note -> last sim position we drove (change-detect)
    this._fastReset = new Set();        // notes whose NEXT mirror drive is a belief-only
                                        // reset (Fix / Reset-at-0) → glide at 10x, not real
    this._RESET_SPEEDUP = 10;           // mirror-render speed multiplier for belief resets
    // Initial-load sync: the FIRST mirror drive of each panel snaps instantly to tracked
    // belief (no glide) — the 3D view opens already showing the physical state, it doesn't
    // slide into it. Consumed once per note; later moves glide at the global speed.
    this._snapInit = new Set(this.state.list().map((p) => p.note));
    this._chips = new Map();    // note -> chip element (virtual overlay)

    this.cols = Math.max(...cells.map((c) => c.x)) + 2; // +2: edges live one past the last cell
    this.rows = Math.max(...cells.map((c) => c.y)) + 2;

    this._syncDead();
    this._buildUI(container);
    this._buildOverlay();
  }

  // ---- dead-note guard sync -------------------------------------------------

  _syncDead() {
    const dead = this.state.list().filter((p) => p.dead);
    this.midi.deadNotes = new Set(dead.map((p) => p.note));      // hard MIDI send-ban
    if (this.meshes) this.meshes.setDead(dead.map((p) => `${p.x},${p.y},${p.orient}`)); // grey in 3D
  }

  // ---- UI --------------------------------------------------------------------

  _buildUI(container) {
    // Header: both views are always live (2D canvas below + virtual chips over the 3D), and
    // the 3D sim always mirrors tracked belief — nothing to toggle.
    const head = document.createElement('div');
    head.className = 'row';
    const viewsNote = document.createElement('span');
    viewsNote.className = 'hint';
    viewsNote.style.margin = '0';
    viewsNote.textContent = '2D + virtual — both live, 3D mirrors belief';
    head.append(viewsNote);

    // Global actions.
    const g1 = document.createElement('div');
    g1.className = 'row';
    const stepAllBtn = mkBtn('1 step all', () => this.reset());
    stepAllBtn.title = 'Send one step to every panel so you can verify each one moves as tracked';
    const zeroBtn = mkBtn('Fix to 0', () => this.resetAtZero());
    zeroBtn.classList.add('danger');
    zeroBtn.title = 'Assume every panel is home: fix tracked belief to 0+ (no MIDI, no movement)';
    const topBtn = mkBtn('Fix to 8-', () => this.resetAtTop());
    topBtn.classList.add('danger');
    topBtn.title = 'Assume every panel is at the top: fix tracked belief to 8- (no MIDI, no movement)';
    const panicBtn = mkBtn('panic', () => { if (this.midi.enabled) this.midi.panic(); });
    panicBtn.title = 'All lights off (no movement)';
    g1.append(stepAllBtn, zeroBtn, topBtn, panicBtn);

    const g2 = document.createElement('div');
    g2.className = 'row';
    const reloadBtn = mkBtn('Reset from YAML', () => this.resetFromYaml());
    reloadBtn.classList.add('danger');
    reloadBtn.title = 'Discard all tracked + saved state; reload panels and dead markers from midi-mapping.yaml';
    g2.append(
      mkBtn('Export state', () => this._export()),
      mkBtn('Import state', () => this._import()),
      reloadBtn,
    );

    // 2D canvas. Larger internal resolution for crisp labels; the display width fills
    // the section (width:100% / height:auto preserves the intrinsic aspect ratio).
    this._canvas = document.createElement('canvas');
    this.cellPx = 26; this.padPx = 8;
    this._canvas.width = this.cols * this.cellPx + this.padPx * 2;
    this._canvas.height = this.rows * this.cellPx + this.padPx * 2;
    this._canvas.style.width = '100%';
    this._canvas.style.height = 'auto';
    this._canvas.style.cursor = 'pointer';
    this._ctx = this._canvas.getContext('2d');
    this._canvas.addEventListener('click', (e) => this._onCanvasClick(e));

    // Selected-panel control card.
    this._card = document.createElement('div');
    this._card.className = 'maze-hud-card';

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent =
      '2D + virtual view of tracked belief. Click a panel to select. Move = send MIDI + ' +
      'update belief (real movement); Fix = correct belief only, no MIDI. The 3D maze ' +
      'mirrors this tracked state.';

    container.append(head, g1, g2, this._canvas, this._card, hint);
    this._refreshCard();
  }

  // ---- virtual overlay -------------------------------------------------------

  _buildOverlay() {
    const layer = document.createElement('div');
    layer.id = 'maze-hud-overlay';
    for (const p of this.state.list()) {
      const chip = document.createElement('button');
      chip.className = 'maze-chip';
      chip.dataset.note = p.note;
      chip.addEventListener('click', () => this.selectNote(p.note));
      layer.appendChild(chip);
      this._chips.set(p.note, chip);
    }
    this.viewport.appendChild(layer);
    this._overlay = layer;
  }

  /** Reposition + relabel chips over the 3D view (call after view.render()). */
  updateOverlay() {
    for (const p of this.state.list()) {
      const chip = this._chips.get(p.note);
      const world = this._panelWorld(p);
      const s = this.view.worldToScreen(world);
      if (!s.visible) { chip.style.display = 'none'; continue; }
      chip.style.display = '';
      chip.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
      this._styleChip(chip, p);
    }
  }

  _panelWorld(p) {
    const nw = this.grid.cellNW(p.x, p.y);
    const y = this.grid.heightFor(zToPos(p.z));
    // Match grid.placement: h = south edge, v = east edge of the cell.
    return p.orient === 'h'
      ? { x: nw.x + this.grid.cellWidth / 2, y, z: nw.z + this.grid.cellDepth }
      : { x: nw.x + this.grid.cellWidth, y, z: nw.z + this.grid.cellDepth / 2 };
  }

  _styleChip(chip, p) {
    chip.textContent = `${p.note} ${normZv(p.z, p.v).v === 1 ? '↑' : '↓'}${p.z}`;
    chip.classList.toggle('dead', p.dead);
    chip.classList.toggle('sel', p.note === this.selectedNote);
    const on = p.brightness > 0;
    chip.style.borderColor = p.note === this.selectedNote ? 'var(--accent)'
      : on ? 'rgba(255,214,140,0.9)' : 'var(--border)';
  }

  // ---- selection + card ------------------------------------------------------

  selectNote(note) {
    this.selectedNote = note;
    this._refreshCard();
  }

  _refreshCard() {
    const card = this._card;
    card.textContent = '';
    const p = this.selectedNote != null ? this.state.get(this.selectedNote) : null;
    if (!p) {
      const empty = document.createElement('div');
      empty.className = 'hint'; empty.style.margin = '0';
      empty.textContent = 'No panel selected — click one above.';
      card.append(empty);
      return;
    }

    // A plain block so the inline text + <b> values flow naturally. (Using the flex
    // `.row` class here shatters the sentence into gap-spaced items — the layout bug.)
    // Each segment is a nowrap unit, so the line wraps only at the `·` separators —
    // (z,v) never splits across lines.
    const arrow = normZv(p.z, p.v).v === 1 ? '↑' : '↓';
    const title = document.createElement('div');
    title.className = 'hud-card-title';
    title.innerHTML =
      `<span class="nw"><b>${p.name}</b></span> · <span class="nw">note ${p.note}</span> · ` +
      `<span class="nw">(${p.x},${p.y},${p.orient})</span> · ` +
      `<span class="nw">(z,v)=<b>(${p.z},${arrow})</b></span>` +
      (p.dead ? ' · <span class="nw" style="color:#e07a7a">DEAD</span>' : '') +
      (p.brightness > 0 ? ` · <span class="nw">light ${p.brightness}</span>` : '');
    card.append(title);

    const acts = document.createElement('div');
    acts.className = 'row';
    acts.append(
      mkBtn('step ×1', () => this._step(p.note)),
      mkBtn(p.dead ? 'revive' : 'mark dead', () => this._toggleDead(p.note)),
    );
    card.append(acts);

    // A "zv" edit is one field holding `<height><dir>` — e.g. `3+` (z=3, up) or
    // `5-` (z=5, down); `+`=↑, `-`=↓. Editing marks the field dirty (zv*); `go` applies,
    // `dismiss` reverts to the known state. One field replaces the old z-input + flip.
    const zvRow = (rowLabel, danger, apply) => {
      const known = zvStr(p.z, p.v);
      const row = document.createElement('div');
      row.className = 'row zv-row';
      const rl = document.createElement('label');
      rl.textContent = rowLabel;
      if (danger) rl.style.color = '#e07a7a';

      const flab = document.createElement('span');
      flab.className = 'zvlab';
      flab.textContent = 'zv';

      const input = document.createElement('input');
      input.type = 'text'; input.className = 'val'; input.style.width = '46px';
      input.value = known;
      input.title = 'height + direction, e.g. 3+ (up) or 5- (down)';

      const refreshDirty = () => {
        const dirty = input.value.trim() !== known;
        flab.textContent = dirty ? 'zv*' : 'zv';
        flab.style.color = dirty ? 'var(--accent)' : '';
      };
      input.addEventListener('input', refreshDirty);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });

      const go = mkBtn('go', () => {
        const parsed = parseZv(input.value, p.v);
        if (!parsed) { input.value = known; refreshDirty(); return; } // unparseable → snap back
        apply(parsed.z, parsed.v);
      });
      const dismiss = mkBtn('dismiss', () => { input.value = known; refreshDirty(); });
      if (danger) { go.classList.add('danger'); dismiss.classList.add('danger'); }

      row.append(rl, flab, input, go, dismiss);
      return row;
    };

    card.append(
      // Move — real movement: walk to (z,v), SEND midi, commit tracked state.
      zvRow('Move', false, (z, v) => this._moveTo(p.note, z, v)),
      // Fix — belief correction: set tracked (z,v) only, NO midi. The real panel doesn't
      // move, so the 3D mirror snaps there fast (it's a reset, not a movement).
      zvRow('Fix', true, (z, v) => {
        this.state.commit(p.note, normZv(z, v), p.brightness);
        this._fastReset.add(p.note);
        this._afterChange();
      }),
    );
  }

  // ---- per-panel actions -----------------------------------------------------

  _guard() {
    if (!this.midi.enabled) { this.midi._setStatus('enable output first', false); return false; }
    return true;
  }

  /**
   * Real movement: walk the panel to exactly (zT,vT) on the bounce circle, SEND the
   * note-ons, and commit the physically-correct resulting state. Directed (not min-path)
   * so the operator picks the arrival direction via the zv sign; endpoints normalize v.
   */
  _moveTo(note, zT, vT) {
    const p = this.state.get(note);
    if (!p || p.dead) return;
    const steps = (aOf(zT, vT) - aOf(p.z, p.v) + CYCLE) % CYCLE;
    const newState = applyN({ z: p.z, v: p.v }, steps);
    if (steps > 0 && this._guard()) {
      const vel = Math.max(1, p.brightness || 1);
      this.midi.sendSteps(new Map([[note, { steps, vel }]]));
    }
    this.state.commit(note, newState, p.brightness);
    this._afterChange();
  }

  _step(note) {
    const p = this.state.get(note);
    if (!p || p.dead) return;
    const vel = Math.max(1, p.brightness || 1);
    if (this._guard()) this.midi.sendSteps(new Map([[note, { steps: 1, vel }]]));
    this.state.stepOne(note);
    this._afterChange();
  }

  _toggleDead(note) {
    const p = this.state.get(note);
    if (!p) return;
    this.state.setDead(note, !p.dead);
    this._syncDead();
    this._afterChange();
  }

  _afterChange() {
    this._refreshCard();
    this._lastMirroredPos.delete(this.selectedNote); // re-drive this panel next tick
  }

  // ---- scene / reset ---------------------------------------------------------

  /**
   * Send exactly one step to every non-dead panel (paced by the transport's guards),
   * advancing tracked belief one step each. The operator watches each panel take one
   * clean step and repairs any mismatch with per-panel "correct".
   */
  reset() {
    if (!this._guard()) return;
    const plan = new Map();
    for (const p of this.state.list()) {
      if (p.dead) continue;
      plan.set(p.note, { steps: 1, vel: Math.max(1, p.brightness || 1) });
    }
    if (!plan.size) return;
    this.midi.sendSteps(plan);
    for (const note of plan.keys()) this.state.stepOne(note);
    this._lastMirroredPos.clear();
    this._refreshCard();
  }

  /**
   * Assume every panel is home at 0+ (z=0, v=+1): fix tracked belief only, NO midi — a
   * bulk "Fix". Nothing physically moves; the 3D mirror glides home fast (belief reset).
   */
  resetAtZero() {
    for (const p of this.state.list()) {
      if (p.dead) continue;
      this.state.commit(p.note, { z: 0, v: 1 }, p.brightness);
      this._fastReset.add(p.note);
    }
    this._lastMirroredPos.clear();
    this._refreshCard();
  }

  /**
   * Assume every panel is at the top at 8- (z=N, v=-1): fix tracked belief only, NO midi — a
   * bulk "Fix" (the natural post-arrival state at the top, ready to descend). Nothing
   * physically moves; the 3D mirror glides up fast (belief reset).
   */
  resetAtTop() {
    for (const p of this.state.list()) {
      if (p.dead) continue;
      this.state.commit(p.note, { z: N, v: -1 }, p.brightness);
      this._fastReset.add(p.note);
    }
    this._lastMirroredPos.clear();
    this._refreshCard();
  }

  /**
   * Full reset: discard ALL tracked + persisted belief and reload every panel from
   * midi-mapping.yaml — neutral 0+, light off, dead flags from the `(!)` markers.
   * Destructive (wipes the saved state), so it's confirmed first. No MIDI; the 3D
   * mirror glides everything home fast (belief reset).
   */
  resetFromYaml() {
    if (typeof confirm === 'function' &&
        !confirm('Discard all tracked and saved state, and reload panels (including dead markers) from the YAML map? This cannot be undone.')) {
      return;
    }
    this.state.resetFromMap();
    this._syncDead();
    for (const p of this.state.list()) this._fastReset.add(p.note);
    this._lastMirroredPos.clear();
    this.selectedNote = null;
    this._refreshCard();
  }

  // ---- export / import -------------------------------------------------------

  _export() {
    const blob = new Blob([this.state.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'maze-state.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  _import() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      file.text().then((txt) => {
        if (this.state.importJSON(txt)) {
          this._syncDead();
          this._lastMirroredPos.clear();
          this._refreshCard();
        }
      });
    });
    input.click();
  }

  // ---- frame hooks -----------------------------------------------------------

  /** Mirror tracked belief onto the sim (brightness every frame; position on change). This is
   *  the SOLE renderer of belief -> sim; it uses engine.renderMove (a raw glide) so it never
   *  re-enters the state/MIDI path that the engine's movePanel now routes through. */
  tick(_dt) {
    for (const p of this.state.list()) {
      const sim = this.engine.get(p.x, p.y, p.orient);
      if (!sim) continue;
      // Dead panels are parked at the top (pos 255) and dark — they take no part in
      // scenes; the mesh greys them (via meshes.setDead). Live panels mirror belief.
      const pos = p.dead ? 255 : zToPos(p.z);
      sim.brightness = p.dead ? 0 : p.brightness / 127;
      if (this._lastMirroredPos.get(p.note) !== pos) {
        // Choose the drive speed for this render-side re-sync:
        //  - initial load  → snap instantly (velocity 0): open already showing belief.
        //  - belief reset (Fix / Reset-at-0) → glide at 10x: no MIDI, panel isn't moving.
        //  - real move → fall through to the global cruise speed (the one-true-speed rule).
        let opts;
        if (this._snapInit.delete(p.note)) opts = { velocity: 0 };
        else if (this._fastReset.delete(p.note)) opts = { velocity: this.engine.speed * this._RESET_SPEEDUP };
        else opts = {};
        this.engine.renderMove(p.x, p.y, p.orient, pos, opts);
        this._lastMirroredPos.set(p.note, pos);
      }
    }
  }

  /** 2D canvas repaint (call each frame). */
  draw() {
    const { _ctx: ctx, cellPx: cell, padPx: pad } = this;
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    ctx.lineCap = 'round';
    ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    for (const p of this.state.list()) {
      const seg = this._seg2d(p);
      const shade = Math.round(45 + (p.z / N) * 150);
      const stroke = (style, w) => {
        ctx.strokeStyle = style; ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(seg.x0, seg.y0); ctx.lineTo(seg.x1, seg.y1); ctx.stroke();
      };
      if (p.dead) { stroke('#332', 4); continue; }
      stroke(`rgb(${shade},${shade + 6},${shade + 14})`, 4);
      if (p.brightness > 0) stroke(`rgba(255,214,140,${Math.min(1, p.brightness / 127)})`, 5);
      if (p.note === this.selectedNote) stroke('#6ea8ff', 2);
      // direction arrow at the midpoint
      ctx.fillStyle = '#9aa4b2';
      ctx.fillText(normZv(p.z, p.v).v === 1 ? '▲' : '▼', (seg.x0 + seg.x1) / 2, (seg.y0 + seg.y1) / 2);
    }
  }

  _seg2d(p) {
    const x0 = this.padPx + p.x * this.cellPx, y0 = this.padPx + p.y * this.cellPx;
    const c = this.cellPx;
    // h = the cell's SOUTH edge (bottom, horizontal); v = its EAST edge (right, vertical).
    return p.orient === 'h'
      ? { x0: x0 + 3, y0: y0 + c, x1: x0 + c - 3, y1: y0 + c }
      : { x0: x0 + c, y0: y0 + 3, x1: x0 + c, y1: y0 + c - 3 };
  }

  _onCanvasClick(e) {
    const rect = this._canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (this._canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (this._canvas.height / rect.height);
    let best = null, bestD = 12 * 12; // px^2 threshold
    for (const p of this.state.list()) {
      const seg = this._seg2d(p);
      const mx = (seg.x0 + seg.x1) / 2, my = (seg.y0 + seg.y1) / 2;
      const d = (mx - px) ** 2 + (my - py) ** 2;
      if (d < bestD) { bestD = d; best = p.note; }
    }
    if (best != null) this.selectNote(best);
  }
}

function mkBtn(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Endpoint convention: the two turning points have only one physical direction, so we
 * always canonicalize them — at the bottom (z=0) the panel can only head up (`0+`), at
 * the top (z=N) it can only head down (`N-`). So `0-` is treated as `0+` and `N+`/`8+`
 * as `N-`/`8-`. Interior heights keep whatever direction was given.
 */
function normZv(z, v) {
  if (z <= 0) return { z: 0, v: 1 };
  if (z >= N) return { z: N, v: -1 };
  return { z, v };
}

/** Format tracked (z,v) as the compact zv string: `3+` (up) / `5-` (down). */
function zvStr(z, v) {
  const n = normZv(z, v);
  return `${n.z}${n.v === 1 ? '+' : '-'}`;
}

/**
 * Parse a zv edit `<height>[+-]` → {z, v}. `+`=up (v=1), `-`=down (v=-1); a missing
 * sign keeps the current direction. z is clamped to [0..N] and endpoints are normalized
 * (0→up, N→down). Returns null if unparseable.
 */
function parseZv(str, curV) {
  const m = String(str).trim().match(/^(\d+)\s*([+-])?$/);
  if (!m) return null;
  const z = Math.max(0, Math.min(N, Number(m[1])));
  const v = m[2] === '-' ? -1 : m[2] === '+' ? 1 : curV;
  return normZv(z, v);
}
