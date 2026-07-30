/**
 * Demo bank UI: lists demos with Play buttons and a Stop control.
 * Delegates playback to a DemoPlayer.
 */
export class DemoBank {
  constructor(listEl, demos, player) {
    this.listEl = listEl;
    this.demos = demos;
    this.player = player;
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
      btn.addEventListener('click', () => this.player.play(demo));
      row.append(info, btn);
      this.listEl.append(row);
    }

    const stop = document.createElement('button');
    stop.textContent = 'Stop';
    stop.style.marginTop = '6px';
    stop.addEventListener('click', () => this.player.stop());
    this.listEl.append(stop);
  }
}
