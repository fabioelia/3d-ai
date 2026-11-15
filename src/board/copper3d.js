// The copper of a board as a triangle mesh for the 3D view: pads, traces and vias as thin plates on
// the two faces of the board. Display only (it never takes part in booleans).
import { connectivity } from './route.js';

const T = 0.04; // drawn copper thickness, a little more than the real 35 µm so it shows

export function copperMesh(b, th) {
  const pos = [];
  const idx = [];
  // A convex polygon pushed from z0 to z1.
  const prism = (poly, z0, z1) => {
    const n = poly.length;
    if (n < 3) return;
    const base = pos.length / 3;
    for (const [x, y] of poly) pos.push(x, y, z0);
    for (const [x, y] of poly) pos.push(x, y, z1);
    // Make the outline counter-clockwise.
    let area = 0;
    for (let i = 0; i < n; i++) area += poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1];
    const ccw = area > 0;
    for (let i = 1; i + 1 < n; i++) {
      if (ccw) idx.push(base, base + i + 1, base + i, base + n, base + n + i, base + n + i + 1);
      else idx.push(base, base + i, base + i + 1, base + n, base + n + i + 1, base + n + i);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (ccw) idx.push(base + i, base + j, base + n + j, base + i, base + n + j, base + n + i);
      else idx.push(base + i, base + n + j, base + j, base + i, base + n + i, base + n + j);
    }
  };
  const stadium = (a, c, r, segs = 6) => {
    const dx = c[0] - a[0];
    const dy = c[1] - a[1];
    const len = Math.hypot(dx, dy);
    const ang = len > 1e-9 ? Math.atan2(dy, dx) : 0;
    const out = [];
    const cap = (p, from) => {
      for (let i = 0; i <= segs; i++) {
        const t = from + (Math.PI * i) / segs;
        out.push([p[0] + r * Math.cos(t), p[1] + r * Math.sin(t)]);
      }
    };
    if (len < 1e-9) {
      for (let i = 0; i < segs * 2 + 4; i++) {
        const t = (2 * Math.PI * i) / (segs * 2 + 4);
        out.push([a[0] + r * Math.cos(t), a[1] + r * Math.sin(t)]);
      }
      return out;
    }
    cap(c, ang - Math.PI / 2);
    cap(a, ang + Math.PI / 2);
    return out;
  };
  const conn = connectivity(b);
  for (const pour of conn.pours || []) {
    const st = pour.grid.step / 2;
    for (const [x0, x1, y] of pour.grid.runs()) {
      const poly = [
        [x0, y - st],
        [x1, y - st],
        [x1, y + st],
        [x0, y + st],
      ];
      if (pour.layer === 'top') prism(poly, th, th + T * 0.5);
      else prism(poly, -T * 0.5, 0);
    }
  }
  for (const it of conn.items) {
    const poly = it.shape.poly || stadium(it.shape.a, it.shape.b, it.shape.r);
    for (const layer of it.layers) {
      if (layer === 'top') prism(poly, th, th + T);
      else prism(poly, -T, 0);
    }
    // Plated holes: a ring through the board is not drawn; the pad on each face is enough.
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
