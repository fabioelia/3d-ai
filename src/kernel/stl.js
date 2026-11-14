// STL import for the kernel: parsing, turning triangles into an exact solid (small, clean meshes)
// or a Manifold mesh body (anything bigger), and display data for mesh bodies.

// Imports up to this many triangles become exact solids (faces you can sketch on, fillet, shell).
// Above it, booleans on a triangle-per-face solid get slow, so the file becomes a mesh body.
export const SOLID_TRIANGLE_LIMIT = 6000;

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
  const triangles = raw.length / 9;
  if (!triangles) throw new Error('This STL file has no triangles.');
  if (!raw.every(Number.isFinite)) throw new Error('This STL file has invalid coordinates.');
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
  let shape = solids.length === 1 ? solids[0] : r.makeCompound(solids);
  // Merge coplanar triangles back into flat faces, so a printed bracket gets its faces back.
  shape = shape.simplify();
  if (!(r.measureVolume(shape) > 0)) throw new Error('inside out');
  return shape;
}

// ---------- mesh path ----------
export function stlToMesh(r, parsed) {
  const M = r.getManifold();
  const mesh = new M.Mesh({ numProp: 3, vertProperties: parsed.positions, triVerts: parsed.indices });
  mesh.merge();
  let manifold;
  try {
    manifold = new M.Manifold(mesh);
  } catch {
    throw new Error('This STL is not a closed, watertight mesh, so Caliper cannot treat it as a solid. Repair it (for example in your slicer or Meshmixer) and import it again.');
  }
  if (manifold.isEmpty()) throw new Error('This STL is not a closed, watertight mesh, so Caliper cannot treat it as a solid. Repair it and import it again.');
  return new r.MeshShape(manifold);
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
