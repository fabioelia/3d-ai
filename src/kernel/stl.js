// STL import for the kernel: parsing, turning triangles into an exact solid (small, clean meshes)
// or a Manifold mesh body (anything bigger), and display data for mesh bodies.

// Imports up to this many triangles become exact solids (faces you can sketch on, fillet, shell).
// Above it, booleans on a triangle-per-face solid get slow, so the file becomes a mesh body.
export const SOLID_TRIANGLE_LIMIT = 2500;

// ---------- parsing ----------
function isBinary(bytes) {
  if (bytes.length < 84) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(80, true);
  if (84 + count * 50 === bytes.length) return true;
  // Some exporters write "solid" at the start of binary files; fall back to sniffing for text.
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  return !/^\s*solid[\s\S]*facet/i.test(head);
}

// Returns welded triangles: { positions: Float32Array (xyz per vertex), indices: Uint32Array, triangles }.
export function parseSTL(bytes) {
  const raw = [];
  if (isBinary(bytes)) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = dv.getUint32(80, true);
    if (84 + count * 50 > bytes.length) throw new Error('This STL file is cut short; it holds fewer triangles than its header says.');
    for (let t = 0; t < count; t++) {
      const o = 84 + t * 50 + 12;
      for (let k = 0; k < 9; k++) raw.push(dv.getFloat32(o + k * 4, true));
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m;
    while ((m = re.exec(text))) raw.push(+m[1], +m[2], +m[3]);
    if (raw.length % 9) throw new Error('This text STL has a facet without three vertices.');
  }
  if (!(raw.length / 9)) throw new Error('This STL file has no triangles.');
  return weldSoup(raw, 'STL');
}

// Triangle soup (9 numbers per triangle) -> shared vertices and index triangles. Every mesh format ends
// up here, then goes through the same repair and solid/mesh/reference decision.
export function weldSoup(raw, label = 'mesh') {
  const triangles = raw.length / 9;
  if (!triangles) throw new Error(`This ${label} file has no triangles.`);
  if (!raw.every(Number.isFinite)) throw new Error(`This ${label} file has invalid coordinates.`);
  // Weld identical corners so triangles share vertices.
  const key = new Map();
  const positions = [];
  const indices = new Uint32Array(triangles * 3);
  let dropped = 0;
  let w = 0;
  for (let t = 0; t < triangles; t++) {
    const ids = [];
    for (let c = 0; c < 3; c++) {
      const o = (t * 3 + c) * 3;
      const k = `${Math.round(raw[o] * 1e5)},${Math.round(raw[o + 1] * 1e5)},${Math.round(raw[o + 2] * 1e5)}`;
      let id = key.get(k);
      if (id === undefined) {
        id = positions.length / 3;
        key.set(k, id);
        positions.push(raw[o], raw[o + 1], raw[o + 2]);
      }
      ids.push(id);
    }
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) {
      dropped++;
      continue;
    }
    indices.set(ids, w);
    w += 3;
  }
  return { positions: new Float32Array(positions), indices: indices.subarray(0, w), triangles: w / 3, dropped };
}

// ---------- repair ----------
// Fixes what exporters often get wrong, the way slicers quietly do: zero-area "sliver" triangles,
// T-junctions (a vertex lying on another triangle's edge, so the edges never pair up) and faces that
// appear twice. Returns the repaired mesh plus counts of what changed.
export function repairMesh(m) {
  const P = Array.from(m.positions);
  let T = [];
  for (let i = 0; i < m.indices.length; i += 3) T.push([m.indices[i], m.indices[i + 1], m.indices[i + 2]]);
  const nv = P.length / 3;
  const pt = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], P[i * 3 + k]);
    hi[k] = Math.max(hi[k], P[i * 3 + k]);
  }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const tol = Math.max(1e-5, diag * 2e-6);
  const stats = { slivers: 0, tjunctions: 0, duplicates: 0 };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);

  // 1. Slivers: triangles thinner than the tolerance.
  T = T.filter((t) => {
    const [a, b, c] = t.map(pt);
    const area2 = len(cross(sub(b, a), sub(c, a)));
    const longest = Math.max(len(sub(b, a)), len(sub(c, b)), len(sub(a, c)));
    if (longest > 0 && area2 / longest > tol) return true;
    stats.slivers++;
    return false;
  });

  // 2. T-junctions: split triangles whose unpaired edge has other vertices lying on it.
  const cell = Math.max(diag / 64, tol * 10);
  const grid = new Map();
  const cellOf = (p) => p.map((x, k) => Math.floor((x - lo[k]) / cell));
  for (let i = 0; i < nv; i++) {
    const key = cellOf(pt(i)).join(',');
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }
  const onSegment = (a, b) => {
    const A = pt(a);
    const B = pt(b);
    const d = sub(B, A);
    const L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const c0 = cellOf(A.map((x, k) => Math.min(x, B[k]) - tol));
    const c1 = cellOf(A.map((x, k) => Math.max(x, B[k]) + tol));
    if ((c1[0] - c0[0] + 1) * (c1[1] - c0[1] + 1) * (c1[2] - c0[2] + 1) > 4096) return [];
    const hits = [];
    for (let x = c0[0]; x <= c1[0]; x++)
      for (let y = c0[1]; y <= c1[1]; y++)
        for (let z = c0[2]; z <= c1[2]; z++)
          for (const v of grid.get(`${x},${y},${z}`) || []) {
            if (v === a || v === b) continue;
            const V = pt(v);
            const t = ((V[0] - A[0]) * d[0] + (V[1] - A[1]) * d[1] + (V[2] - A[2]) * d[2]) / L2;
            if (t <= 1e-9 || t >= 1 - 1e-9) continue;
            if (len(sub(V, [A[0] + t * d[0], A[1] + t * d[1], A[2] + t * d[2]])) < tol) hits.push([t, v]);
          }
    return hits.sort((p, q) => p[0] - q[0]).map((h) => h[1]);
  };
  for (let pass = 0; pass < 6; pass++) {
    const uses = new Map();
    T.forEach((t, ti) => {
      for (let c = 0; c < 3; c++) {
        const a = t[c];
        const b = t[(c + 1) % 3];
        const k = a < b ? a * nv + b : b * nv + a;
        if (!uses.has(k)) uses.set(k, []);
        uses.get(k).push([ti, c]);
      }
    });
    const splits = new Map(); // triangle -> [corner, points]
    let open = 0;
    for (const list of uses.values()) {
      if (list.length !== 1) continue;
      if (++open > 20000) break; // a mesh this broken is beyond a quick repair
      const [ti, c] = list[0];
      if (splits.has(ti)) continue;
      const t = T[ti];
      const mid = onSegment(t[c], t[(c + 1) % 3]);
      if (mid.length) splits.set(ti, [c, mid]);
    }
    if (!splits.size) break;
    const next = [];
    T.forEach((t, ti) => {
      const sp = splits.get(ti);
      if (!sp) return next.push(t);
      const [c, mid] = sp;
      const chain = [t[c], ...mid, t[(c + 1) % 3]];
      const o = t[(c + 2) % 3];
      for (let i = 0; i < chain.length - 1; i++) next.push([chain[i], chain[i + 1], o]);
      stats.tjunctions += mid.length;
    });
    T = next;
  }

  // 3. Faces that appear twice: identical copies collapse to one; back-to-back pairs (zero thickness)
  // cancel out.
  const seen = new Map();
  T.forEach((t, i) => {
    const k = [...t].sort((a, b) => a - b).join(',');
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(i);
  });
  const drop = new Set();
  const parity = (t) => {
    const m0 = t.indexOf(Math.min(...t));
    return t[(m0 + 1) % 3] < t[(m0 + 2) % 3];
  };
  for (const list of seen.values()) {
    if (list.length < 2) continue;
    const fwd = list.filter((i) => parity(T[i]));
    const back = list.filter((i) => !parity(T[i]));
    const pairs = Math.min(fwd.length, back.length);
    for (let i = 0; i < pairs; i++) drop.add(fwd[i]).add(back[i]);
    for (const extra of [...fwd.slice(pairs + 1), ...back.slice(pairs + 1)]) drop.add(extra);
    stats.duplicates += list.length - (list.length - pairs * 2 > 0 ? 1 : 0);
  }
  if (drop.size) T = T.filter((_, i) => !drop.has(i));

  const indices = new Uint32Array(T.length * 3);
  T.forEach((t, i) => indices.set(t, i * 3));
  const changed = stats.slivers + stats.tjunctions + stats.duplicates > 0;
  return { positions: m.positions, indices, triangles: T.length, stats, changed };
}

// Merge vertices closer than `dist` (mm). Exporters sometimes leave surfaces a hundredth of a
// millimetre apart where they should meet; far below what a printer resolves, but enough to stop the
// mesh from closing. Triangles that collapse are dropped.
export function weldMesh(m, dist) {
  const P = m.positions;
  const nv = P.length / 3;
  const grid = new Map();
  const map = new Int32Array(nv);
  const reps = [];
  let merged = 0;
  for (let i = 0; i < nv; i++) {
    const x = P[i * 3];
    const y = P[i * 3 + 1];
    const z = P[i * 3 + 2];
    const cx = Math.floor(x / dist);
    const cy = Math.floor(y / dist);
    const cz = Math.floor(z / dist);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++)
          for (const r of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) || []) {
            if (Math.hypot(P[r * 3] - x, P[r * 3 + 1] - y, P[r * 3 + 2] - z) <= dist) {
              found = r;
              break;
            }
          }
    if (found >= 0) {
      map[i] = map[found];
      merged++;
      continue;
    }
    map[i] = reps.length;
    reps.push(i);
    const key = `${cx},${cy},${cz}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }
  const positions = new Float32Array(reps.length * 3);
  reps.forEach((v, i) => positions.set(P.subarray(v * 3, v * 3 + 3), i * 3));
  const out = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = map[m.indices[t]];
    const b = map[m.indices[t + 1]];
    const c = map[m.indices[t + 2]];
    if (a !== b && b !== c && a !== c) out.push(a, b, c);
  }
  return { positions, indices: new Uint32Array(out), triangles: out.length / 3, merged };
}

// Closed and consistently oriented: every edge is used by exactly two triangles, once in each
// direction. Returns the enclosed volume, or null when the mesh is not closed.
export function closedVolume(m) {
  const I = m.indices;
  const P = m.positions;
  const nv = P.length / 3;
  const directed = new Set();
  for (let t = 0; t < I.length; t += 3)
    for (let c = 0; c < 3; c++) {
      const k = I[t + c] * nv + I[t + ((c + 1) % 3)];
      if (directed.has(k)) return null; // same edge twice in one direction
      directed.add(k);
    }
  for (const k of directed) {
    const a = Math.floor(k / nv);
    const b = k - a * nv;
    if (!directed.has(b * nv + a)) return null; // edge with no partner
  }
  let vol = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3;
    const b = I[t + 1] * 3;
    const c = I[t + 2] * 3;
    vol += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  return vol;
}

export function describeRepairs(stats) {
  const out = [];
  if (stats.slivers) out.push(`removed ${stats.slivers} zero-area triangle${stats.slivers === 1 ? '' : 's'}`);
  if (stats.tjunctions) out.push(`joined ${stats.tjunctions} edge${stats.tjunctions === 1 ? '' : 's'} that did not meet`);
  if (stats.duplicates) out.push(`removed ${stats.duplicates} duplicated face${stats.duplicates === 1 ? '' : 's'}`);
  if (stats.welded) out.push(`merged ${stats.merged} vertices that were less than ${stats.welded} mm apart`);
  return out.join(', ');
}

// Binary STL bytes for a mesh (to hand a repaired mesh to OpenCascade's reader).
export function meshToSTL(m) {
  const n = m.indices.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode('Binary STL repaired by Caliper'));
  dv.setUint32(80, n, true);
  let o = 84;
  const Pm = m.positions;
  for (let t = 0; t < n; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => m.indices[t * 3 + k] * 3);
    const ux = Pm[b] - Pm[a];
    const uy = Pm[b + 1] - Pm[a + 1];
    const uz = Pm[b + 2] - Pm[a + 2];
    const vx = Pm[c] - Pm[a];
    const vy = Pm[c + 1] - Pm[a + 1];
    const vz = Pm[c + 2] - Pm[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true);
    dv.setFloat32(o + 4, ny / l, true);
    dv.setFloat32(o + 8, nz / l, true);
    o += 12;
    for (let c = 0; c < 3; c++) {
      const v = m.indices[t * 3 + c] * 3;
      dv.setFloat32(o, m.positions[v], true);
      dv.setFloat32(o + 4, m.positions[v + 1], true);
      dv.setFloat32(o + 8, m.positions[v + 2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

// ---------- solid path ----------
export function stlToSolid(r, bytes) {
  const oc = r.getOC();
  const path = `/import-${Math.random().toString(36).slice(2)}.stl`;
  oc.FS.writeFile(path, bytes);
  const reader = new oc.StlAPI_Reader();
  const faces = new oc.TopoDS_Shell();
  let ok = false;
  try {
    ok = reader.Read(faces, path);
  } finally {
    oc.FS.unlink(path);
    reader.delete();
  }
  if (!ok) throw new Error('This STL file could not be read.');
  const sew = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
  sew.Add(faces);
  sew.Perform(new oc.Message_ProgressRange());
  const sewed = sew.SewedShape();
  const free = sew.NbFreeEdges();
  sew.delete();
  if (free > 0) throw new Error('not watertight');
  const shells = [...r.iterTopo(sewed, 'shell')];
  if (!shells.length) throw new Error('no shell');
  const fixer = new oc.ShapeFix_Solid();
  const solids = shells.map((s) => r.cast(fixer.SolidFromShell(oc.TopoDS.Shell(s))));
  fixer.delete();
  let shape = solids[0];
  // Several closed pieces (parts modelled as overlapping blocks): unite them into one body.
  for (const s of solids.slice(1)) shape = shape.fuse(s);
  // Merge coplanar triangles back into flat faces, so a printed bracket gets its faces back.
  shape = shape.simplify();
  if (!(r.measureVolume(shape) > 0)) throw new Error('inside out');
  return shape;
}

// ---------- mesh path ----------
const NOT_CLOSED = 'This STL is not a closed, watertight mesh, and Caliper could not repair it. Repair it (for example in your slicer, Meshmixer or Windows 3D Builder) and import it again.';

function tryManifold(M, positions, indices) {
  try {
    const mesh = new M.Mesh({ numProp: 3, vertProperties: positions, triVerts: indices });
    mesh.merge();
    const m = new M.Manifold(mesh);
    return m.isEmpty() ? null : m;
  } catch {
    return null;
  }
}

// Returns { shape, dropped } where dropped counts pieces that were not closed and had to be left out.
export function stlToMesh(r, parsed) {
  const M = r.getManifold();
  const whole = tryManifold(M, parsed.positions, parsed.indices);
  if (whole) return { shape: new r.MeshShape(whole), dropped: 0 };
  // Not closed as a whole: split it into connected pieces, keep the ones that are closed, unite them.
  const I = parsed.indices;
  const nt = I.length / 3;
  const parent = new Int32Array(nt).map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const byEdge = new Map();
  for (let t = 0; t < nt; t++)
    for (let c = 0; c < 3; c++) {
      const a = I[t * 3 + c];
      const b = I[t * 3 + ((c + 1) % 3)];
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      const prev = byEdge.get(k);
      if (prev === undefined) byEdge.set(k, t);
      else parent[find(prev)] = find(t);
    }
  const groups = new Map();
  for (let t = 0; t < nt; t++) {
    const g = find(t);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  if (groups.size > 2000) throw new Error(NOT_CLOSED);
  const parts = [];
  let dropped = 0;
  for (const tris of groups.values()) {
    const idx = new Uint32Array(tris.length * 3);
    tris.forEach((t, i) => idx.set(I.subarray(t * 3, t * 3 + 3), i * 3));
    const m = tryManifold(M, parsed.positions, idx);
    if (m) parts.push(m);
    else dropped++;
  }
  if (!parts.length) throw new Error(NOT_CLOSED);
  const shape = parts.length === 1 ? parts[0] : M.Manifold.union(parts);
  return { shape: new r.MeshShape(shape), dropped };
}

// ---------- reference meshes ----------
// A mesh that cannot be made into a closed solid, kept exactly as it came in. It can be shown, moved,
// patterned and exported, but booleans need a closed solid, so it cannot be cut or joined.
export class RawMesh {
  constructor(positions, indices) {
    this.positions = positions; // Float32Array, xyz per vertex
    this.indices = indices; // Uint32Array
    this.raw = true;
  }
  clone() {
    return new RawMesh(this.positions.slice(), this.indices);
  }
  map(fn) {
    const out = new Float32Array(this.positions.length);
    for (let i = 0; i < out.length; i += 3) {
      const p = fn(this.positions[i], this.positions[i + 1], this.positions[i + 2]);
      out[i] = p[0];
      out[i + 1] = p[1];
      out[i + 2] = p[2];
    }
    return new RawMesh(out, this.indices);
  }
  translate(v) {
    return this.map((x, y, z) => [x + v[0], y + v[1], z + v[2]]);
  }
  // R: 3x3 rows, t: translation. A mirror (negative determinant) flips triangle winding.
  transform(R, t) {
    const m = this.map((x, y, z) => [0, 1, 2].map((i) => R[i][0] * x + R[i][1] * y + R[i][2] * z + t[i]));
    const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
    if (det < 0) {
      const idx = m.indices.slice();
      for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
      m.indices = idx;
    }
    return m;
  }
  get boundingBox() {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const P = this.positions;
    for (let i = 0; i < P.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], P[i + k]);
        hi[k] = Math.max(hi[k], P[i + k]);
      }
    return { bounds: [lo, hi] };
  }
  get isEmpty() {
    return this.indices.length === 0;
  }
}

// Display data for a reference mesh: flat-shaded triangles and an outline at sharp creases.
export function rawDisplay(raw) {
  const fake = { wrapped: { getMesh: () => ({ numProp: 3, vertProperties: raw.positions, triVerts: raw.indices }) } };
  const d = meshDisplay(fake);
  d.volume = Math.abs(d.volume);
  return d;
}

// ---------- display data for mesh bodies ----------
// Smooth normals across shallow angles, hard creases (and outline lines) at sharp ones.
export function meshDisplay(meshShape, creaseDeg = 30) {
  const m = meshShape.wrapped.getMesh();
  const np = m.numProp;
  const P = m.vertProperties;
  const T = m.triVerts;
  const nv = P.length / np;
  const nt = T.length / 3;
  const fn = new Float32Array(nt * 3);
  let volume = 0;
  for (let t = 0; t < nt; t++) {
    const a = T[t * 3] * np;
    const b = T[t * 3 + 1] * np;
    const c = T[t * 3 + 2] * np;
    const ux = P[b] - P[a];
    const uy = P[b + 1] - P[a + 1];
    const uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a];
    const vy = P[c + 1] - P[a + 1];
    const vz = P[c + 2] - P[a + 2];
    fn[t * 3] = uy * vz - uz * vy;
    fn[t * 3 + 1] = uz * vx - ux * vz;
    fn[t * 3 + 2] = ux * vy - uy * vx;
    volume += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  const unit = (i) => {
    const x = fn[i * 3];
    const y = fn[i * 3 + 1];
    const z = fn[i * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  // Triangles around each vertex.
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < T.length; i++) start[T[i] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const around = new Uint32Array(T.length);
  for (let i = 0; i < T.length; i++) around[fill[T[i]]++] = (i / 3) | 0;
  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
  const positions = new Float32Array(nt * 9);
  const normals = new Float32Array(nt * 9);
  for (let t = 0; t < nt; t++) {
    const nT = unit(t);
    for (let c = 0; c < 3; c++) {
      const v = T[t * 3 + c];
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let k = start[v]; k < start[v + 1]; k++) {
        const o = around[k];
        const nO = unit(o);
        if (nO[0] * nT[0] + nO[1] * nT[1] + nO[2] * nT[2] >= cosCrease) {
          sx += fn[o * 3];
          sy += fn[o * 3 + 1];
          sz += fn[o * 3 + 2];
        }
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      const o = (t * 3 + c) * 3;
      positions[o] = P[v * np];
      positions[o + 1] = P[v * np + 1];
      positions[o + 2] = P[v * np + 2];
      normals[o] = sx / l;
      normals[o + 1] = sy / l;
      normals[o + 2] = sz / l;
    }
  }
  // Outline: open boundaries, and edges between triangles that meet at a sharp angle.
  const first = new Map(); // edge key -> first triangle
  const pairs = []; // [a, b, t1, t2]
  for (let t = 0; t < nt; t++) {
    for (let c = 0; c < 3; c++) {
      const a = T[t * 3 + c];
      const b = T[t * 3 + ((c + 1) % 3)];
      const k = a < b ? a * nv + b : b * nv + a;
      const t1 = first.get(k);
      if (t1 === undefined) first.set(k, t);
      else {
        pairs.push(a, b, t1, t);
        first.delete(k);
      }
    }
  }
  const lines = [];
  const seg = (a, b) => lines.push(P[a * np], P[a * np + 1], P[a * np + 2], P[b * np], P[b * np + 1], P[b * np + 2]);
  for (let i = 0; i < pairs.length; i += 4) {
    const n1 = unit(pairs[i + 2]);
    const n2 = unit(pairs[i + 3]);
    if (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < cosCrease) seg(pairs[i], pairs[i + 1]);
  }
  for (const [k, t] of first) {
    // Edges seen once are open boundaries; recover their ends from the triangle.
    for (let c = 0; c < 3; c++) {
      const a = T[t * 3 + c];
      const b = T[t * 3 + ((c + 1) % 3)];
      if ((a < b ? a * nv + b : b * nv + a) === k) seg(a, b);
    }
  }
  const indices = new Uint32Array(nt * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, normals, indices, lines: new Float32Array(lines), volume, triangles: nt };
}

// Triangles of a mesh body, for STL export.
export function meshTriangles(meshShape) {
  const m = meshShape.wrapped.getMesh();
  const np = m.numProp;
  const P = m.vertProperties;
  const vertices = new Float32Array((P.length / np) * 3);
  for (let v = 0; v < P.length / np; v++) {
    vertices[v * 3] = P[v * np];
    vertices[v * 3 + 1] = P[v * np + 1];
    vertices[v * 3 + 2] = P[v * np + 2];
  }
  return { vertices, triangles: m.triVerts };
}
