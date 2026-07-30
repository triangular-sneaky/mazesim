/**
 * 2D top-down grid map. Doubles as:
 *  - a selector: click an occupied cell to select it
 *  - a live monitor: each cell's fill tracks its panels' height, flashes on blink
 * North is up, West is left — matching the layout matrix.
 */
export class GridMap {
  constructor(canvas, engine, cells, onSelect) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = engine;
    this.onSelect = onSelect;
    this.selected = null; // {x,y}

    this.cols = Math.max(...cells.map((c) => c.x)) + 1;
    this.rows = Math.max(...cells.map((c) => c.y)) + 1;
    this.occupied = new Set(cells.map((c) => `${c.x},${c.y}`));

    this.cell = 26;    // px per cell
    this.pad = 4;
    canvas.width = this.cols * this.cell + this.pad * 2;
    canvas.height = this.rows * this.cell + this.pad * 2;

    canvas.addEventListener('click', (e) => this._onClick(e));
  }

  setSelected(x, y) { this.selected = { x, y }; }

  _onClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (this.canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (this.canvas.height / rect.height);
    const x = Math.floor((px - this.pad) / this.cell);
    const y = Math.floor((py - this.pad) / this.cell);
    if (this.occupied.has(`${x},${y}`)) this.onSelect(x, y);
  }

  /** Average position + max brightness of a cell's pair, for the monitor. */
  _cellState(x, y) {
    const h = this.engine.get(x, y, 'h');
    const v = this.engine.get(x, y, 'v');
    const pos = ((h?.position ?? 0) + (v?.position ?? 0)) / 2;
    const bright = Math.max(h?.brightness ?? 0, v?.brightness ?? 0);
    return { pos, bright };
  }

  draw() {
    const { ctx, cell, pad } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const gx = pad + x * cell, gy = pad + y * cell;
        if (!this.occupied.has(`${x},${y}`)) {
          ctx.fillStyle = '#0d0f12';
          ctx.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);
          continue;
        }
        const { pos, bright } = this._cellState(x, y);
        const shade = Math.round(40 + (pos / 255) * 150); // height -> grey
        ctx.fillStyle = `rgb(${shade},${shade + 6},${shade + 14})`;
        ctx.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);
        if (bright > 0.01) {
          ctx.fillStyle = `rgba(158,197,255,${bright})`;
          ctx.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);
        }
        if (this.selected && this.selected.x === x && this.selected.y === y) {
          ctx.strokeStyle = '#6ea8ff';
          ctx.lineWidth = 2;
          ctx.strokeRect(gx + 1.5, gy + 1.5, cell - 3, cell - 3);
        }
      }
    }
  }
}
