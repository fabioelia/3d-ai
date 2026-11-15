// A small stroke font for silkscreen text (Gerber has no text): each glyph is polylines on a grid 4
// wide and 6 tall, baseline at 0. Covers part references: letters, digits and a few signs.
const G = {
  A: '0,0 0,4 2,6 4,4 4,0|0,3 4,3',
  B: '0,0 0,6 3,6 4,5 4,4 3,3 0,3|3,3 4,2 4,1 3,0 0,0',
  C: '4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5',
  D: '0,0 0,6 2,6 4,4 4,2 2,0 0,0',
  E: '4,0 0,0 0,6 4,6|0,3 3,3',
  F: '0,0 0,6 4,6|0,3 3,3',
  G: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,3 2,3',
  H: '0,0 0,6|4,0 4,6|0,3 4,3',
  I: '1,0 3,0|2,0 2,6|1,6 3,6',
  J: '0,1 1,0 2,0 3,1 3,6|2,6 4,6',
  K: '0,0 0,6|4,6 0,2|1,3 4,0',
  L: '0,6 0,0 4,0',
  M: '0,0 0,6 2,3 4,6 4,0',
  N: '0,0 0,6 4,0 4,6',
  O: '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0',
  P: '0,0 0,6 3,6 4,5 4,4 3,3 0,3',
  Q: '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0|2,2 4,0',
  R: '0,0 0,6 3,6 4,5 4,4 3,3 0,3|2,3 4,0',
  S: '0,1 1,0 3,0 4,1 4,2 3,3 1,3 0,4 0,5 1,6 3,6 4,5',
  T: '0,6 4,6|2,6 2,0',
  U: '0,6 0,1 1,0 3,0 4,1 4,6',
  V: '0,6 2,0 4,6',
  W: '0,6 1,0 2,3 3,0 4,6',
  X: '0,0 4,6|0,6 4,0',
  Y: '0,6 2,3 4,6|2,3 2,0',
  Z: '0,6 4,6 0,0 4,0',
  0: '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0|0,1 4,5',
  1: '1,5 2,6 2,0|1,0 3,0',
  2: '0,5 1,6 3,6 4,5 4,4 0,0 4,0',
  3: '0,5 1,6 3,6 4,5 4,4 3,3 4,2 4,1 3,0 1,0 0,1|1,3 3,3',
  4: '3,0 3,6 0,2 4,2',
  5: '4,6 0,6 0,3 3,3 4,2 4,1 3,0 0,0',
  6: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,2 3,3 0,3',
  7: '0,6 4,6 1,0',
  8: '1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3 1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3',
  9: '0,1 1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,4 1,3 4,3',
  '-': '1,3 3,3',
  '+': '1,3 3,3|2,2 2,4',
  _: '0,0 4,0',
  '.': '2,0 2,0.4',
  '/': '0,0 4,6',
  '$': '4,5 3,5.5 1,5.5 0,4.5 1,3 3,3 4,1.5 3,0.5 1,0.5 0,1|2,0 2,6',
  '#': '1,0 1,6|3,0 3,6|0,2 4,2|0,4 4,4',
};
const PARSED = Object.fromEntries(Object.entries(G).map(([k, v]) => [k, v.split('|').map((s) => s.split(' ').map((p) => p.split(',').map(Number)))]));

// Polylines for `text`, `size` mm tall, centred on (cx, cy), turned by `rot` degrees.
export function strokeText(text, cx, cy, size = 1, rot = 0) {
  const k = size / 6;
  const adv = 5.5;
  const chars = String(text).toUpperCase().split('');
  const width = (chars.length * adv - 1.5) * k;
  const c = Math.cos((rot * Math.PI) / 180);
  const s = Math.sin((rot * Math.PI) / 180);
  const out = [];
  chars.forEach((ch, i) => {
    for (const line of PARSED[ch] || []) {
      out.push(
        line.map(([x, y]) => {
          const lx = (i * adv + x) * k - width / 2;
          const ly = y * k - size / 2;
          return [cx + lx * c - ly * s, cy + lx * s + ly * c];
        }),
      );
    }
  });
  return { lines: out, width, height: size };
}
