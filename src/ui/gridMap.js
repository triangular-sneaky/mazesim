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

  draw() {
    const { ctx, cell, pad } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 1) Cell squares: just context/footprint + click targets. A cell is the region
    //    ENCLOSED by 4 panels, not a panel itself, so it stays dim — the lit state lives
    //    on the walls (drawn next).
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const gx = pad + x * cell, gy = pad + y * cell;
        ctx.fillStyle = this.occupied.has(`${x},${y}`) ? '#15181c' : '#0b0d10';
        ctx.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);
      }
    }

    // 2) Every PANEL is a wall = an edge segment. h(x,y) is the north edge of cell (x,y),
    //    v(x,y) the west edge — each shared with the adjacent cell, drawn once. Colour by
    //    that panel's OWN state: grey by height, warm amber by brightness (the LED glow),
    //    so a "dim going up" panel fades from amber to dark as it rises.
    ctx.lineCap = 'round';
    for (const p of this.engine.list()) {
      const x0 = pad + p.x * cell, y0 = pad + p.y * cell;
      const seg = p.orient === 'h'
        ? [x0 + 3, y0, x0 + cell - 3, y0]     // north wall — horizontal
        : [x0, y0 + 3, x0, y0 + cell - 3];    // west wall — vertical
      const shade = Math.round(45 + (p.position / 255) * 120); // height -> grey
      const stroke = (style, w) => {
        ctx.strokeStyle = style; ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); ctx.stroke();
      };
      stroke(`rgb(${shade},${shade + 6},${shade + 14})`, 4);
      if (p.brightness > 0.01) stroke(`rgba(255,214,140,${Math.min(1, p.brightness)})`, 5);
    }

    // 3) Selection outline on the chosen cell.
    if (this.selected) {
      const gx = pad + this.selected.x * cell, gy = pad + this.selected.y * cell;
      ctx.strokeStyle = '#6ea8ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(gx + 1.5, gy + 1.5, cell - 3, cell - 3);
    }
  }
}
