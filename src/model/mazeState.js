/**
 * Maze state + incremental-motion planner for the PHYSICAL maze.
 *
 * The real panels cannot be commanded to an absolute height — they only step. Each
 * note-on advances a panel one step along a bounce cycle between z=0 and z=N; at the
 * ends the direction reverses. We model that bounce as motion around a circle of
 * `CYCLE = 2N` discrete steps, so every note-on is simply "+1 step" counter-clockwise:
 *
 *   a(z, v) = z            when v = +1  (going up),   range 0..N
 *           = CYCLE - z     when v = -1  (going down),  range N..CYCLE
 *
 * The turning points z=0 (a=0) and z=N (a=N) are each a SINGLE position shared by both
 * directions — the source of the edge cases handled below. Exactly CYCLE note-ons walk
 * all the way around and return to the identical (z, v) — matching the hardware fact
 * that 16 note-ons net zero movement.
 *
 * This module is pure logic: no DOM, no MIDI, no three.js. The state transition lives
 * in ONE place (`applyStep`); the planners return the resulting `newState` by simulating
 * that transition, so tracked belief can never drift from what the emitted steps do.
 * (Persistence + the note-map-backed MazeState class live at the bottom.)
 */

export const N = 8;
export const CYCLE = 2 * N; // 16 steps = one full bounce (up then back down)

// Mirror mapping between tracked belief and the sim (kept here, in the pure model, so both
// the HUD and the state-backed engine adapter share one definition):
//   z 0..N  <-> sim position 0..255   (posToZ IS the "snap to nearest z" quantization)
//   brightness 0..1 -> MIDI velocity 1..127 (0 below a small dead-zone = light off)
export const zToPos = (z) => Math.round((z / N) * 255);
export const posToZ = (pos) => Math.round((pos / 255) * N);
export const brightToVel = (b01) => (b01 > 0.01 ? Math.max(1, Math.min(127, Math.round(b01 * 127))) : 0);

/** Step-index on the circle for a logical state. */
export const aOf = (z, v) => (v === 1 ? z : CYCLE - z) % CYCLE;

/** Decode a circle step-index back to logical (z, v). Turning points normalize to v=+1. */
export const fromA = (a) => (a <= N ? { z: a, v: 1 } : { z: CYCLE - a, v: -1 });

/** Apply one note-on: advance the circle by one step and decode. */
export const applyStep = ({ z, v }) => fromA((aOf(z, v) + 1) % CYCLE);

/** Apply n note-ons in sequence. */
export const applyN = (s, n) => {
  let out = s;
  for (let i = 0; i < n; i++) out = applyStep(out);
  return out;
};

/**
 * Minimal note-ons to bring a panel from (z, v) to logical height `zT`. The panel can
 * arrive going up (ending v=+1) or going down (ending v=-1); we take whichever is fewer
 * steps. Returns the step count and the resulting state (which fixes the ending v).
 * `planMove(z, v, z)` returns steps:0 — already there, no movement.
 * @returns {{steps:number, newState:{z:number,v:number}}}
 */
export function planMove(z, v, zT) {
  const a = aOf(z, v);
  const up = (zT - a + CYCLE) % CYCLE;              // arrive going up   -> (zT, +1)
  const dn = ((CYCLE - zT) - a + CYCLE) % CYCLE;    // arrive going down -> (zT, -1)
  const steps = Math.min(up, dn);
  return { steps, newState: applyN({ z, v }, steps) };
}

/**
 * Keep the panel at its current height but emit a light trigger (a note-on): walk to
 * the near wall in the current direction and back, which returns to the same z and
 * flips v. At a turning point this would be 0 steps (no note-on, no light), so we
 * substitute a full CYCLE loop to guarantee at least one note-on.
 * @returns {{steps:number, newState:{z:number,v:number}}}
 */
export function planStay(z, v) {
  const a = aOf(z, v);
  const b = aOf(z, -v);
  let steps = (b - a + CYCLE) % CYCLE;
  if (steps === 0) steps = CYCLE; // endpoint degeneracy -> full loop
  return { steps, newState: applyN({ z, v }, steps) };
}

// ---- Stateful per-panel tracker -------------------------------------------

const STORAGE_KEY = 'mazeState.v1';
const SAVE_DEBOUNCE_MS = 400;

/**
 * @typedef {Object} PanelState
 * @property {number} note      MIDI note number (the panel's address)
 * @property {number} x         column (West->East)
 * @property {number} y         row (North->South)
 * @property {'v'|'h'} orient   wall orientation
 * @property {string} name      note name (e.g. "D5")
 * @property {number} z         tracked logical height 0..N
 * @property {1|-1} v           tracked direction (+1 up, -1 down)
 * @property {boolean} dead     banned from all sends (greyed in HUD)
 * @property {number} brightness tracked light level (0 = off, 1..127 = on)
 */

/**
 * Optimistic per-panel state tracker for the PHYSICAL maze. Built from the note map,
 * seeded with a neutral belief (z=0, v=+1), then overlaid with persisted state from
 * localStorage. MIDI has no ACK, so callers commit tracked state on dispatch (via the
 * plan's `newState`) and repair drift through the HUD "correct" ops.
 *
 * This class holds ONLY state + persistence. It never sends MIDI and never touches the
 * DOM or the sim engine — the HUD orchestrates planning, sending, and mirroring.
 */
export class MazeState {
  /**
   * @param {Map<number,{x,y,orient,name,deadInit}>} byNote  from loadMidiMapping()
   * @param {object} [persisted]  parsed persisted blob (or null); overrides seeds
   */
  constructor(byNote, persisted = MazeState.loadRaw()) {
    /** @type {Map<number, PanelState>} */
    this.panels = new Map();
    this._saveTimer = null;
    this._byNote = byNote;   // kept for resetFromMap() (full reload from the YAML map)

    const saved = persisted && persisted.panels ? persisted.panels : {};
    for (const [note, m] of byNote.entries()) {
      const s = saved[note];
      this.panels.set(note, {
        note, x: m.x, y: m.y, orient: m.orient, name: m.name,
        z: s ? clampZ(s.z) : 0,
        v: s && s.v === -1 ? -1 : 1,
        dead: s ? !!s.dead : !!m.deadInit,
        brightness: s ? clampBright(s.brightness) : 0,
      });
    }
  }

  get(note) { return this.panels.get(note); }
  list() { return [...this.panels.values()]; }

  /**
   * Full reset: discard ALL tracked belief (and, once saved, the persisted blob) and
   * re-seed every panel from the note map — neutral 0+ (z=0, v=+1), light off, and the
   * dead flag straight from the YAML `(!)` markers. This is the "reload everything from
   * yaml" path; the caller re-syncs dead guards and the 3D mirror afterwards.
   */
  resetFromMap() {
    for (const [note, m] of this._byNote.entries()) {
      const p = this.panels.get(note);
      if (!p) continue;
      p.z = 0; p.v = 1; p.brightness = 0; p.dead = !!m.deadInit;
    }
    this.save();
  }

  /** Advance one panel's tracked state by one note-on (send-less; caller sends). */
  stepOne(note) {
    const p = this.panels.get(note);
    if (!p) return;
    const ns = applyStep({ z: p.z, v: p.v });
    p.z = ns.z; p.v = ns.v;
    this.save();
  }

  /** Commit an arbitrary planned outcome (from planMove/planStay). */
  commit(note, newState, brightness) {
    const p = this.panels.get(note);
    if (!p) return;
    p.z = clampZ(newState.z);
    p.v = newState.v === -1 ? -1 : 1;
    if (brightness != null) p.brightness = clampBright(brightness);
    this.save();
  }

  /** "correct": flip tracked v with NO send (repair a desync). */
  flipTracked(note) {
    const p = this.panels.get(note);
    if (!p) return;
    p.v = p.v === 1 ? -1 : 1;
    this.save();
  }

  /** Override tracked height directly (HUD correct-to-z). */
  setZ(note, z) {
    const p = this.panels.get(note);
    if (!p) return;
    p.z = clampZ(z);
    this.save();
  }

  setBrightness(note, brightness) {
    const p = this.panels.get(note);
    if (!p) return;
    p.brightness = clampBright(brightness);
    this.save();
  }

  setDead(note, dead) {
    const p = this.panels.get(note);
    if (!p) return;
    p.dead = !!dead;
    this.save();
  }

  // ---- persistence --------------------------------------------------------

  /** Serializable snapshot: only the mutable belief (z, v, dead, brightness) per note. */
  toJSON() {
    const panels = {};
    for (const p of this.panels.values()) {
      panels[p.note] = { z: p.z, v: p.v, dead: p.dead, brightness: p.brightness };
    }
    return { version: 1, panels };
  }

  exportJSON() { return JSON.stringify(this.toJSON(), null, 2); }

  /** Merge a persisted/exported blob onto the current panels (by note). */
  importJSON(str) {
    let blob;
    try { blob = JSON.parse(str); } catch { return false; }
    if (!blob || !blob.panels) return false;
    for (const [note, s] of Object.entries(blob.panels)) {
      const p = this.panels.get(+note);
      if (!p) continue;
      p.z = clampZ(s.z);
      p.v = s.v === -1 ? -1 : 1;
      p.dead = !!s.dead;
      p.brightness = clampBright(s.brightness);
    }
    this.save();
    return true;
  }

  /** Debounced write to localStorage (safe under Node — no-ops without storage). */
  save() {
    if (typeof localStorage === 'undefined') return;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON())); }
      catch { /* quota / disabled — best effort */ }
    }, SAVE_DEBOUNCE_MS);
  }

  /** Read the raw persisted blob (or null). */
  static loadRaw() {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
}

const clampZ = (z) => Math.max(0, Math.min(N, Math.round(Number(z) || 0)));
const clampBright = (b) => Math.max(0, Math.min(127, Math.round(Number(b) || 0)));
