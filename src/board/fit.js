// Fitting a board inside an enclosure: the enclosure's cross-section at a height (the inside wall the
// board must clear), and an outline that follows it with some clearance. Pure, on triangle meshes.

// Cut triangles (vertices Float32Array xyz, triangles index array) with the plane z = h; returns
// closed loops of [x, y] (open fragments are dropped).
export function sliceMesh(vertices, triangles, h) {
  const segs = [];
  const V = (i) => [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]];
  for (let t = 0; t < triangles.length; t += 3) {
    const p = [V(triangles[t]), V(triangles[t + 1]), V(triangles[t + 2])];
    const pts = [];
    for (let k = 0; k < 3; k++) {
      const a = p[k];
      const b = p[(k + 1) % 3];
      const da = a[2] - h;
      const db = b[2] - h;
      if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) {
        const s = da / (da - db);
        pts.push([a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])]);
      }
    }
    if (pts.length === 2) segs.push(pts);
  }
  // Chain segments by shared end points.
  const key = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  const ends = new Map();
  segs.forEach((s, i) => {
    for (const e of [0, 1]) {
      const k = key(s[e]);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push([i, e]);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const loop = [segs[i][0], segs[i][1]];
    for (;;) {
      const k = key(loop[loop.length - 1]);
      const next = (ends.get(k) || []).find(([j]) => !used[j]);
      if (!next) break;
      used[next[0]] = 1;
      loop.push(segs[next[0]][1 - next[1]]);
    }
    if (loop.length > 3 && key(loop[0]) === key(loop[loop.length - 1])) loops.push(loop.slice(0, -1));
  }
  return loops;
}

export const loopArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) a += pts[i][0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * pts[i][1];
  return a / 2;
};

function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// Douglas-Peucker on a closed loop.
function simplify(pts, tol) {
  if (pts.length < 8) return pts;
  const rec = (a, b, out) => {
    let best = -1;
    let bi = -1;
    const [x0, y0] = pts[a];
    const [x1, y1] = pts[b % pts.length];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((x1 - x0) * (y0 - pts[i][1]) - (x0 - pts[i][0]) * (y1 - y0)) / len;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol) {
      rec(a, bi, out);
      rec(bi, b, out);
    } else out.push(pts[a]);
  };
  const half = Math.floor(pts.length / 2);
  const out = [];
  rec(0, half, out);
  rec(half, pts.length, out);
  return out;
}

// The space a board at height h can use: the smallest loop of the section around (cx, cy), shrunk by
// `clearance`. A near-circle comes back as a circle; anything else as a path (board coordinates are
// relative to `origin`). Returns null when nothing surrounds the point.
export function fitOutline(loops, cx, cy, clearance = 1, origin = [0, 0]) {
  const around = loops.filter((l) => inside([cx, cy], l)).sort((a, b) => Math.abs(loopArea(a)) - Math.abs(loopArea(b)));
  const loop = around[0];
  if (!loop) return null;
  // Circle fit (centroid and mean radius); accept it when the wall stays within 0.3 mm of it.
  const n = loop.length;
  const mx = loop.reduce((s, p) => s + p[0], 0) / n;
  const my = loop.reduce((s, p) => s + p[1], 0) / n;
  const radii = loop.map((p) => Math.hypot(p[0] - mx, p[1] - my));
  const rMin = Math.min(...radii);
  const rMax = Math.max(...radii);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  if (rMax - rMin < 0.6) {
    // The board must clear the narrowest point of the wall.
    return { outline: { kind: 'circle', d: r3(2 * (rMin - clearance)), x: r3(mx - origin[0]), y: r3(my - origin[1]) }, wall: { kind: 'circle', d: r3(2 * rMin) } };
  }
  // Shrink the loop: move each vertex inward along the bisector of its neighbouring edges.
  const ccw = loopArea(loop) > 0;
  const pts = simplify(loop, 0.05);
  const m = pts.length;
  const out = [];
  for (let i = 0; i < m; i++) {
    const a = pts[(i - 1 + m) % m];
    const b = pts[i];
    const c = pts[(i + 1) % m];
    const n1 = norm([b[1] - a[1], a[0] - b[0]]);
    const n2 = norm([c[1] - b[1], b[0] - c[0]]);
    // (dy, -dx) points out of a counter-clockwise loop and into a clockwise one; move inward.
    const s = ccw ? -1 : 1;
    const nx = n1[0] + n2[0];
    const ny = n1[1] + n2[1];
    const nl = Math.hypot(nx, ny) || 1;
    const cos = Math.max(0.3, (n1[0] * nx + n1[1] * ny) / nl);
    out.push([r3(b[0] + (s * clearance * nx) / nl / cos - origin[0]), r3(b[1] + (s * clearance * ny) / nl / cos - origin[1]), 0]);
  }
  return { outline: { kind: 'path', pts: out }, wall: null };
}

function norm(v) {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}
