/**
 * Demo bank UI: lists demos with Play buttons, plus Stop and Cycle controls.
 * Delegates playback to a DemoPlayer.
 *
 * @param {object} [opts]
 * @param {() => void} [opts.onManual]  called when the user manually plays or stops
 *   a demo (used to cancel the auto-cycle).
 * @param {() => void} [opts.onCycle]  called when the user clicks "Cycle demos".
 */
export class DemoBank {
  constructor(listEl, demos, player, opts = {}) {
    this.listEl = listEl;
    this.demos = demos;
    this.player = player;
    this.onManual = opts.onManual;
    this.onCycle = opts.onCycle;
    this._render();
  }

  _render() {
    this.listEl.innerHTML = '';

    for (const demo of this.demos) {
      const row = document.createElement('div');
      row.className = 'demo';
      const info = document.createElement('div');
      info.innerHTML = `<div class="name">${demo.name}</div><div class="desc">${demo.desc || ''}</div>`;
      const btn = document.createElement('button');
      btn.textContent = 'Play';
      btn.addEventListener('click', () => { this.onManual?.(); this.player.play(demo); });
      row.append(info, btn);
      this.listEl.append(row);
    }

    // Transport row: Stop halts everything (including the cycle); Cycle (re)starts it.
    const transport = document.createElement('div');
    transport.className = 'demo';
    transport.style.marginTop = '6px';

    const stop = document.createElement('button');
    stop.textContent = 'Stop';
    stop.addEventListener('click', () => { this.onManual?.(); this.player.stop(); });

    const cycle = document.createElement('button');
    cycle.textContent = 'Cycle demos';
    cycle.addEventListener('click', () => this.onCycle?.());

    transport.append(cycle, stop);
    this.listEl.append(transport);
  }
}
