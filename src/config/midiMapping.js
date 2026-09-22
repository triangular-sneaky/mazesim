import yaml from 'js-yaml';

/**
 * Parse the physical maze's note→panel map (config/midi-mapping.yaml).
 *
 * Format: a `grid` of rows (row index = y, North→South). Each row has a `v` and an `h`
 * field listing panels West→East, where token index = x. Tokens are `Name=Number`
 * (e.g. `D5=86`), `-` for "no panel here", and an optional `(!)` suffix seeding the dead
 * flag (`F#2=54(!)`). js-yaml parses the comma-less flow sequences as a ONE-element array
 * holding the whole space-joined string, so we join-if-array then split on whitespace.
 *
 * Pure (no `?raw` import, no DOM), so it can be unit-tested by reading the file directly.
 * Returns lookup maps + a warnings list; validation against the engine happens in main.js.
 * @param {string} text  raw YAML
 * @returns {{ byNote: Map<number,{x:number,y:number,orient:'v'|'h',name:string,deadInit:boolean}>,
 *             byKey: Map<string, number>, warnings: string[] }}
 */
export function parseMidiMapping(text) {
  let doc;
  try {
    doc = yaml.load(text);
  } catch (e) {
    throw new Error(`midi-mapping.yaml is not valid YAML: ${e.message}`);
  }
  const rows = doc && Array.isArray(doc.grid) ? doc.grid : [];
  const byNote = new Map();
  const byKey = new Map();
  const warnings = [];
  const TOKEN = /^([A-G]#?-?\d+)=(\d+)(\(!\))?$/;

  rows.forEach((row, rowIdx) => {
    const y = typeof row.y === 'number' ? row.y : rowIdx;
    for (const orient of ['v', 'h']) {
      const field = row[orient];
      if (field == null) continue;
      const str = Array.isArray(field) ? field.join(' ') : String(field);
      const tokens = str.trim().split(/\s+/).filter(Boolean);
      tokens.forEach((tok, x) => {
        if (tok === '-') return; // no panel at this position
        const m = tok.match(TOKEN);
        if (!m) { warnings.push(`row ${y} ${orient}[${x}]: unparseable token "${tok}"`); return; }
        const note = +m[2];
        const entry = { x, y, orient, name: m[1], deadInit: !!m[3] };
        if (byNote.has(note)) warnings.push(`duplicate note ${note} (${m[1]}) at ${orient}(${x},${y})`);
        byNote.set(note, entry);
        byKey.set(`${x},${y},${orient}`, note);
      });
    }
  });

  return { byNote, byKey, warnings };
}
