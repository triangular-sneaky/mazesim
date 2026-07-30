/**
 * Expanded "all cells" control board — a compact fader grid over every occupied cell,
 * for quick click-around choreography of a dynamic display.
 *
 * Each tile is split into two independent sub-faders:
 *   - LEFT  half  = the cell's `h` panel (wide face E-W)
 *   - RIGHT half  = the cell's `v` panel (wide face N-S)
 * h and v move independently.
 *   - drag on a half (vertical position) = set that panel's height live
 *   - alt-click or right-click a half     = blink that panel
 * Live fill tracks actual panel height; a flash overlays on blink.
 * North is up, West is left — same orientation as the layout matrix.
 */
export class CellBoard {
  constructor(canvas, engine, cells) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = engine;

    this.cols = Math.max(...cells.map((c) => c.x)) + 1;
    this.rows = Math.max(...cells.map((c) => c.y)) + 1;
    this.occupied = new Set(cells.map((c) => `${c.x},${c.y}`));

    this.tile = 44;
    this.pad = 3;
    canvas.width = this.cols * this.tile + this.pad * 2;
    canvas.height = this.rows * this.tile + this.pad * 2;

    this._dragging = false;
    canvas.addEventListener('pointerdown', (e) => this._onDown(e));
    canvas.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerup', () => { this._dragging = false; });
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this._blinkAt(e); });
  }

  /** Resolve pointer -> { x, y, orient, position } or null. Left half = h, right = v. */
  _hit(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (this.canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (this.canvas.height / rect.height);
    const x = Math.floor((px - this.pad) / this.tile);
    const y = Math.floor((py - this.pad) / this.tile);
    if (!this.occupied.has(`${x},${y}`)) return null;
    const tileLeft = this.pad + x * this.tile;
    const tileTop = this.pad + y * this.tile;
    const orient = (px - tileLeft) < this.tile / 2 ? 'h' : 'v';
    const frac = 1 - (py - tileTop) / this.tile;
    const position = Math.round(Math.min(1, Math.max(0, frac)) * 255);
    return { x, y, orient, position };
  }

  _setHeight(hit) {
    // Fast scrub so the board feels responsive.
    this.engine.movePanel(hit.x, hit.y, hit.orient, hit.position, { velocity: 600, curve: 'linear' });
  }

  _blinkAt(e) {
    const hit = this._hit(e);
    if (hit) this.engine.blinkPanel(hit.x, hit.y, hit.orient);
  }

  _onDown(e) {
    if (e.altKey || e.button === 2) { this._blinkAt(e); return; }
    const hit = this._hit(e);
    if (!hit) return;
    this._dragging = true;
    this._setHeight(hit);
  }

  _onMove(e) {
    if (!this._dragging) return;
    const hit = this._hit(e);
    if (hit) this._setHeight(hit);
  }

  _bar(gx, gy, w, panel, color) {
    const { ctx, tile } = this;
    const pos = panel?.position ?? 0;
    const bright = panel?.brightness ?? 0;
    ctx.fillStyle = '#101216';
    ctx.fillRect(gx, gy + 1, w, tile - 2);
    const fillH = (pos / 255) * (tile - 4);
    ctx.fillStyle = color;
    ctx.fillRect(gx + 1, gy + (tile - 2) - fillH, w - 2, fillH);
    if (bright > 0.01) {
      ctx.fillStyle = `rgba(255,241,214,${bright})`;
      ctx.fillRect(gx, gy + 1, w, tile - 2);
    }
  }

  draw() {
    const { ctx, tile, pad } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const half = tile / 2;
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (!this.occupied.has(`${x},${y}`)) continue;
        const gx = pad + x * tile, gy = pad + y * tile;
        this._bar(gx, gy, half - 1, this.engine.get(x, y, 'h'), '#d6a24a');       // h = amber
        this._bar(gx + half, gy, half - 1, this.engine.get(x, y, 'v'), '#6f93c4'); // v = steel
        ctx.fillStyle = '#8b909a';
        ctx.font = '8px ui-monospace, monospace';
        ctx.fillText(`${x},${y}`, gx + 2, gy + 9);
      }
    }
  }
}
