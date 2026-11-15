// Part sizes from a text file (a sizes list, a BOM, notes): any line that names a part reference of
// the board and gives "L x W x H" in millimetres sets that part's height (H). Returns what it found.
const DIMS = /~?(\d+(?:\.\d+)?)\s*(?:mm)?\s*[x×]\s*~?(\d+(?:\.\d+)?)\s*(?:mm)?\s*[x×]\s*~?(\d+(?:\.\d+)?)/i;

export function readSizes(text, refs) {
  const known = new Set(refs);
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = DIMS.exec(line);
    if (!m) continue;
    // References before the size, e.g. "U4 | Seeed XIAO | 21 x 17.8 x ~3.5" or "R1, R2: …".
    const head = line.slice(0, m.index);
    const found = [...head.matchAll(/\b([A-Z]{1,4}\d{1,4})\b/g)].map((x) => x[1]).filter((r) => known.has(r));
    for (const ref of new Set(found)) out.push({ ref, l: +m[1], w: +m[2], h: +m[3], line: line.trim() });
  }
  // The first mention of each part wins (later lines are often alternatives).
  const seen = new Set();
  return out.filter((x) => !seen.has(x.ref) && seen.add(x.ref));
}
