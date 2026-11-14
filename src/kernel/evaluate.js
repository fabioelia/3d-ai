// Turns a Caliper document (parameters + feature timeline) into solid bodies.
// Pure with respect to the DOM: runs in the worker, and in Node for tests.

import { evalExpr, resolveParams } from '../expr.js';
import { BASE_PLANES, frameFromFace, offsetFrame, toWorld, v3, axisVec } from '../frame.js';
import { pathPoints } from '../sketchgeo.js';
import { parseSTL, stlToSolid, stlToMesh, meshDisplay, meshTriangles, SOLID_TRIANGLE_LIMIT } from './stl.js';

const TOL = 1e-4;
const DISPLAY_MESH = { tolerance: 0.04, angularTolerance: 0.25 };
export const QUALITY = {
  draft: { tolerance: 0.1, angularTolerance: 0.5 },
  standard: { tolerance: 0.02, angularTolerance: 0.2 },
  fine: { tolerance: 0.005, angularTolerance: 0.1 },
};

const FAIL_HINT = {
  fillet: 'Fillet failed. The radius is probably too large for the selected edges.',
  chamfer: 'Chamfer failed. The distance is probably too large for the selected edges.',
  shell: 'Shell failed. A wall thicker than a fillet or chamfer on the body cannot be hollowed. Use a thinner wall, or add the fillet after the shell.',
  extrude: 'Extrude failed. Check that the sketch shapes are closed and do not overlap themselves.',
  revolve: 'Revolve failed. The profile must sit entirely on one side of the axis.',
};

class FeatureError extends Error {}
const fail = (msg) => {
  throw new FeatureError(msg);
};

export function createKernel(r) {
  let cache = [];
  let lastBodies = [];
  let lastState = { bodies: [], count: 0 };
  let lastScope = {};
  const meshCache = new WeakMap();
  const rawMeshCache = new WeakMap();
  const topoCache = new WeakMap();
  const files = new Map(); // imported file id -> bytes
  const importCache = new Map(); // `${file}:${mode}` -> { shape, kind, triangles } or { error }
  const isMesh = (s) => s instanceof r.MeshShape;

  // Triangulation at display quality, shared by topology stats and the viewport mesh.
  function rawMesh(shape) {
    let m = rawMeshCache.get(shape);
    if (!m) {
      m = shape.mesh(DISPLAY_MESH);
      rawMeshCache.set(shape, m);
    }
    return m;
  }

  // Circle through three points (radius of an arc or circle edge).
  function circumradius(a, b, c) {
    const ab = v3.dist(a, b);
    const bc = v3.dist(b, c);
    const ca = v3.dist(c, a);
    const area2 = v3.len(v3.cross(v3.sub(b, a), v3.sub(c, a)));
    return area2 > 1e-12 ? (ab * bc * ca) / (2 * area2) : null;
  }

  // ---------- topology descriptors ----------
  const tup = (v) => {
    const t = [v.x, v.y, v.z];
    return t.map((c) => (Math.abs(c) < 1e-9 ? 0 : c));
  };

  function topo(shape) {
    let t = topoCache.get(shape);
    if (t) return t;
    if (isMesh(shape)) {
      // Mesh bodies (large imported STLs) have no faces or edges to select.
      const bb = shape.boundingBox.bounds;
      t = { faces: [], edges: [], fd: [], ed: [], min: bb[0], max: bb[1], mesh: true };
      topoCache.set(shape, t);
      return t;
    }
    const faces = shape.faces;
    const edges = shape.edges;
    // Exact area and centre per face are slow for solids made of thousands of triangles (imported
    // STLs); measure those from the display triangulation instead.
    let stats = null;
    if (faces.length > 300) {
      try {
        const m = rawMesh(shape);
        const order = new Map(faces.map((fc, i) => [fc.hashCode, i]));
        stats = { a: new Float64Array(faces.length), c: faces.map(() => [0, 0, 0]) };
        const V = m.vertices;
        const T = m.triangles;
        for (const g of m.faceGroups) {
          const i = order.get(g.faceId);
          if (i === undefined) continue;
          let area = 0;
          const c = [0, 0, 0];
          for (let k = g.start; k < g.start + g.count; k += 3) {
            const a = [V[T[k] * 3], V[T[k] * 3 + 1], V[T[k] * 3 + 2]];
            const b = [V[T[k + 1] * 3], V[T[k + 1] * 3 + 1], V[T[k + 1] * 3 + 2]];
            const d = [V[T[k + 2] * 3], V[T[k + 2] * 3 + 1], V[T[k + 2] * 3 + 2]];
            const w = v3.len(v3.cross(v3.sub(b, a), v3.sub(d, a))) / 2;
            area += w;
            for (let q = 0; q < 3; q++) c[q] += ((a[q] + b[q] + d[q]) / 3) * w;
          }
          stats.a[i] = area;
          stats.c[i] = area > 0 ? c.map((x) => Math.round((x / area) * 1e6) / 1e6) : c;
        }
      } catch {
        stats = null;
      }
    }
    const fd = faces.map((f, i) => {
      const type = f.geomType === 'CYLINDRE' ? 'CYLINDER' : f.geomType; // replicad spells it the French way
      let n = null;
      let c = [0, 0, 0];
      let a = 0;
      try {
        if (type === 'PLANE') n = tup(f.normalAt());
        if (stats) {
          c = stats.c[i];
          a = stats.a[i];
        } else {
          c = tup(f.center);
          a = r.measureArea(f);
        }
      } catch {
        /* keep defaults */
      }
      return { c, n, t: type, a };
    });
    const ed = edges.map((e) => {
      try {
        const s = tup(e.startPoint);
        const en = tup(e.endPoint);
        const type = e.geomType;
        const l = type === 'LINE' ? v3.dist(s, en) : e.length;
        const m = tup(e.pointAt(0.5));
        const out = { s, e: en, m, l, t: type, d: type === 'LINE' && l > 1e-9 ? v3.norm(v3.sub(en, s)) : null };
        if (type === 'CIRCLE') {
          const rad = circumradius(tup(e.pointAt(0)), tup(e.pointAt(1 / 3)), tup(e.pointAt(2 / 3)));
          if (rad) out.r = Math.round(rad * 1e6) / 1e6;
        }
        return out;
      } catch {
        return { s: [0, 0, 0], e: [0, 0, 0], m: [0, 0, 0], l: 0, t: 'OTHER' };
      }
    });
    // Which faces meet at each edge. An edge with a single face on both sides is a seam (the line
    // where a cylinder's surface closes on itself): not a real edge, so it is never selectable.
    try {
      const owners = new Map();
      faces.forEach((f, fi) => {
        for (const e of f.edges) {
          const hc = e.hashCode;
          if (!owners.has(hc)) owners.set(hc, new Set());
          owners.get(hc).add(fi);
        }
      });
      edges.forEach((e, i) => {
        ed[i].f = [...(owners.get(e.hashCode) || [])];
        if (ed[i].f.length < 2) ed[i].seam = true;
      });
      // Edges between two almost coplanar flat faces (the facets of an imported mesh) are "soft": the
      // viewport neither draws nor picks them, though selectors still see them.
      const cosSoft = Math.cos((20 * Math.PI) / 180);
      ed.forEach((d) => {
        if (d.f.length === 2) {
          const a = fd[d.f[0]];
          const b = fd[d.f[1]];
          if (a?.n && b?.n && v3.dot(a.n, b.n) > cosSoft) d.soft = true;
        }
      });
      // A round face's radius, read from a circular edge on its boundary.
      ed.forEach((d) => {
        if (d.r && !d.seam) for (const fi of d.f) if (fd[fi] && fd[fi].t !== 'PLANE' && !fd[fi].r) fd[fi].r = d.r;
      });
    } catch {
      /* adjacency is a nicety; selection still works without it */
    }
    const bb = shape.boundingBox.bounds;
    t = { faces, edges, fd, ed, min: bb[0], max: bb[1] };
    topoCache.set(shape, t);
    return t;
  }

  // ---------- selectors ----------
  const SIDE = {
    top: [2, 1],
    bottom: [2, -1],
    right: [0, 1],
    left: [0, -1],
    back: [1, 1],
    front: [1, -1],
  };
  const AX = { x: 0, y: 1, z: 2 };

  function resolvePick(descs, pick, kind) {
    const same = (d) =>
      kind === 'edge'
        ? v3.dist(d.m, pick.m || [1e9, 0, 0]) < 1e-3 && Math.abs(d.l - (pick.l ?? -1)) < 1e-3
        : v3.dist(d.c, pick.c || [1e9, 0, 0]) < 1e-3 && (!pick.n || !d.n || v3.dot(d.n, pick.n) > 0.999);
    if (descs[pick.i] && same(descs[pick.i])) return pick.i;
    const hits = descs.map((d, i) => (same(d) ? i : -1)).filter((i) => i >= 0);
    if (hits.length) return hits[0];
    // Dimensions changed upstream: fall back to the same slot if it still holds the same kind of thing.
    const d = descs[pick.i];
    if (!d) return -1;
    if (pick.t && d.t !== pick.t) return -1;
    if (kind === 'edge' && pick.d && d.d && Math.abs(v3.dot(d.d, pick.d)) < 0.999) return -1;
    if (kind === 'face' && pick.n && d.n && v3.dot(d.n, pick.n) < 0.999) return -1;
    return pick.i;
  }

  function inPlane(d, axis, at, kind) {
    if (kind === 'edge') return Math.abs(d.s[axis] - at) < TOL && Math.abs(d.e[axis] - at) < TOL && Math.abs(d.m[axis] - at) < TOL;
    return d.n && Math.abs(Math.abs(d.n[axis]) - 1) < 1e-6 && Math.abs(d.c[axis] - at) < TOL;
  }

  // One selector clause -> indices into the body's edges/faces.
  function matchClause(body, clause, kind, n) {
    const t = topo(body.shape);
    const descs = kind === 'edge' ? t.ed : t.fd;
    if (clause.body !== undefined && clause.body !== body.id && clause.body !== body.name) return [];
    let idx = descs.map((_, i) => i).filter((i) => !descs[i].seam);
    let used = false;
    const keep = (fn) => {
      used = true;
      idx = idx.filter((i) => fn(descs[i], i));
    };
    if (clause.all) used = true;
    if (clause.on) {
      const side = SIDE[String(clause.on).toLowerCase()];
      if (!side) fail(`Unknown side "${clause.on}". Use top, bottom, left, right, front or back.`);
      const at = side[1] > 0 ? t.max[side[0]] : t.min[side[0]];
      keep((d) => inPlane(d, side[0], at, kind) && (kind === 'edge' || d.n[side[0]] * side[1] > 0));
    }
    if (clause.at) {
      for (const k of Object.keys(clause.at)) {
        const axis = AX[k.toLowerCase()];
        if (axis === undefined) fail(`"at" uses x, y or z, not "${k}".`);
        const at = n(clause.at[k]);
        keep((d) => inPlane(d, axis, at, kind));
      }
    }
    if (clause.parallel) {
      const dir = axisVec(clause.parallel, null);
      if (!dir) fail(`"parallel" uses x, y or z.`);
      if (kind === 'edge') keep((d) => d.t === 'LINE' && d.l > 1e-9 && Math.abs(v3.dot(v3.norm(v3.sub(d.e, d.s)), dir)) > 1 - 1e-6);
      else keep((d) => d.n && Math.abs(v3.dot(d.n, dir)) < 1e-6);
    }
    if (clause.normal) {
      const dir = axisVec(clause.normal, null);
      if (!dir) fail(`"normal" uses +x, -x, +y, -y, +z or -z.`);
      keep((d) => (kind === 'face' ? d.n && v3.dot(d.n, dir) > 1 - 1e-6 : false));
    }
    if (clause.kind) {
      const want = String(clause.kind).toLowerCase();
      keep((d) => {
        const ty = d.t.toLowerCase();
        if (want === 'line' || want === 'plane' || want === 'circle' || want === 'cylinder') return ty === want;
        if (want === 'curve') return ty !== 'line';
        return ty === want;
      });
    }
    if (clause.box) {
      const lo = clause.box[0].map(n);
      const hi = clause.box[1].map(n);
      const inside = (p) => p.every((c, k) => c >= Math.min(lo[k], hi[k]) - TOL && c <= Math.max(lo[k], hi[k]) + TOL);
      keep((d) => (kind === 'edge' ? inside(d.s) && inside(d.e) && inside(d.m) : inside(d.c)));
    }
    if (clause.face !== undefined && kind === 'edge') {
      const fc = typeof clause.face === 'string' ? (clause.face === 'all' ? { all: true } : { on: clause.face }) : clause.face;
      const hit = matchClause(body, { ...fc, body: undefined }, 'face', n);
      const faces = new Set(hit.map((x) => (typeof x === 'object' ? x.i : x)));
      keep((d) => (d.f || []).some((fi) => faces.has(fi)));
    }
    if (clause.near) {
      const p = clause.near.map(n);
      used = true;
      let best = -1;
      let bd = Infinity;
      const els = kind === 'edge' ? t.edges : t.faces;
      let vtx = null;
      try {
        vtx = r.makeVertex(p);
      } catch {
        vtx = null;
      }
      for (const i of idx) {
        const ref = kind === 'edge' ? descs[i].m : descs[i].c;
        let d = v3.dist(ref, p);
        if (vtx) {
          try {
            // True distance to the edge or face; ties go to the one whose middle is closest.
            d = Math.round(r.measureDistanceBetween(vtx, els[i]) * 1e5) / 1e5 + d * 1e-7;
          } catch {
            /* fall back to the distance to its middle */
          }
        }
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      idx = best >= 0 ? [{ i: best, d: bd }] : [];
      return idx; // resolved across bodies by the caller
    }
    if (clause.pick) {
      used = true;
      const out = [];
      let missing = 0;
      for (const p of clause.pick) {
        if (p.b !== body.id) continue;
        const i = resolvePick(descs, p, kind);
        if (i >= 0 && idx.includes(i)) {
          out.push(i);
          const d = descs[i];
          Object.assign(p, kind === 'edge' ? { i, m: d.m, l: d.l, t: d.t, d: d.d } : { i, c: d.c, n: d.n, t: d.t });
        } else if (i < 0) missing++;
      }
      idx = out;
      if (missing) fail(`${missing === 1 ? `A picked ${kind} no longer exists` : `${missing} picked ${kind}s no longer exist`} after an earlier change. Pick again.`);
    }
    if (!used) fail('Selection is empty. Pick something or describe it (for example "all" or {"on":"top"}).');
    return idx;
  }

  // Resolve a selector against all bodies -> Map(bodyIndex -> Set(elementIndex)).
  function select(state, sel, kind, n) {
    if (sel === undefined || sel === null) fail(`Pick the ${kind}s this applies to.`);
    let clauses = Array.isArray(sel) ? sel : [sel];
    clauses = clauses.map((c) => {
      if (typeof c !== 'string') return c;
      const ref = /^(.+):([FE])(\d+)$/.exec(c);
      if (ref) {
        if ((ref[2] === 'F') !== (kind === 'face')) fail(`"${c}" is ${ref[2] === 'F' ? 'a face' : 'an edge'}, but this needs ${kind}s.`);
        if (!state.bodies.some((b) => b.id === ref[1])) fail(`"${c}" refers to body "${ref[1]}", which does not exist at this point in the timeline.`);
        return { pick: [{ b: ref[1], i: Number(ref[3]) }] };
      }
      return c === 'all' ? { all: true } : { on: c };
    });
    const result = new Map();
    const add = (bi, i) => {
      if (!result.has(bi)) result.set(bi, new Set());
      result.get(bi).add(i);
    };
    for (const clause of clauses) {
      if (!clause || typeof clause !== 'object') continue;
      if (clause.near) {
        let best = null;
        state.bodies.forEach((b, bi) => {
          const m = matchClause(b, clause, kind, n);
          if (m.length && (!best || m[0].d < best.d)) best = { bi, i: m[0].i, d: m[0].d };
        });
        if (best) add(best.bi, best.i);
      } else {
        state.bodies.forEach((b, bi) => matchClause(b, clause, kind, n).forEach((i) => add(bi, i)));
      }
    }
    return result;
  }

  // ---------- geometry helpers ----------
  const planeOf = (frame) => new r.Plane(frame.origin, frame.x, frame.normal);
  const boxesTouch = (a, b) => [0, 1, 2].every((k) => a.min[k] <= b.max[k] + TOL && b.min[k] <= a.max[k] + TOL);
  // Transforms that work on both exact solids and mesh bodies. (replicad's own mesh rotate, scale
  // and offset mirror are unreliable, so mesh bodies go through Manifold's matrix transform.)
  function meshXf(s, R, t) {
    const m = [R[0][0], R[1][0], R[2][0], 0, R[0][1], R[1][1], R[2][1], 0, R[0][2], R[1][2], R[2][2], 0, t[0], t[1], t[2], 1];
    return new r.MeshShape(s.wrapped.transform(m));
  }
  const matVec = (R, p) => [0, 1, 2].map((i) => R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2]);
  const xf = {
    rotate(s, angle, center = [0, 0, 0], axis = [0, 0, 1]) {
      if (!isMesh(s)) return s.rotate(angle, center, axis);
      const [x, y, z] = v3.norm(axis);
      const a = (angle * Math.PI) / 180;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const C = 1 - c;
      const R = [
        [c + x * x * C, x * y * C - z * sn, x * z * C + y * sn],
        [y * x * C + z * sn, c + y * y * C, y * z * C - x * sn],
        [z * x * C - y * sn, z * y * C + x * sn, c + z * z * C],
      ];
      return meshXf(s, R, v3.sub(center, matVec(R, center)));
    },
    mirror(s, normal, origin = [0, 0, 0]) {
      if (!isMesh(s)) return s.mirror(normal, origin);
      const nn = v3.norm(normal);
      const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) - 2 * nn[i] * nn[j]));
      return meshXf(s, R, v3.mul(nn, 2 * v3.dot(nn, origin)));
    },
    scale(s, k) {
      return isMesh(s) ? new r.MeshShape(s.wrapped.scale(k)) : s.scale(k, [0, 0, 0]);
    },
  };

  // Booleans between an exact solid and a mesh body run as mesh booleans (Manifold).
  const asMesh = (s) => (isMesh(s) ? s : s.meshShape({ tolerance: 0.01, angularTolerance: 0.15 }));
  function boolean(a, b, op) {
    if (isMesh(a) || isMesh(b)) {
      const A = asMesh(a);
      const B = asMesh(b);
      return op === 'join' ? A.fuse(B) : op === 'cut' ? A.cut(B) : A.intersect(B);
    }
    return op === 'join' ? a.fuse(b) : op === 'cut' ? a.cut(b) : a.intersect(b);
  }
  const isEmpty = (shape) => {
    try {
      if (isMesh(shape)) return shape.isEmpty;
      return !shape || shape.isNull || shape.faces.length === 0;
    } catch {
      return true;
    }
  };

  function shapeDrawing(s, n) {
    let d;
    switch (s.kind) {
      case 'rect': {
        const w = n(s.w);
        const h = n(s.h);
        if (!(w > 0 && h > 0)) fail('Rectangle width and height must be greater than 0.');
        const rr = Math.min(Math.max(0, n(s.r ?? 0)), w / 2 - 1e-6, h / 2 - 1e-6);
        d = rr > 1e-6 ? r.drawRoundedRectangle(w, h, rr) : r.drawRoundedRectangle(w, h);
        break;
      }
      case 'circle': {
        const dia = n(s.d);
        if (!(dia > 0)) fail('Circle diameter must be greater than 0.');
        d = r.drawCircle(dia / 2);
        break;
      }
      case 'ellipse': {
        const w = n(s.w);
        const h = n(s.h);
        if (!(w > 0 && h > 0)) fail('Ellipse width and height must be greater than 0.');
        d = w >= h ? r.drawEllipse(w / 2, h / 2) : r.drawEllipse(h / 2, w / 2).rotate(90, [0, 0]);
        break;
      }
      case 'polygon': {
        const k = Math.max(3, Math.round(n(s.sides ?? 6)));
        const rad = n(s.d) / 2;
        if (!(rad > 0)) fail('Polygon diameter must be greater than 0.');
        const pts = [];
        for (let i = 0; i < k; i++) pts.push([rad * Math.cos((i / k) * 2 * Math.PI), rad * Math.sin((i / k) * 2 * Math.PI)]);
        let pen = r.draw(pts[0]);
        for (let i = 1; i < k; i++) pen = pen.lineTo(pts[i]);
        d = pen.close();
        break;
      }
      case 'slot': {
        const w = n(s.w);
        const l = n(s.l);
        if (!(w > 0 && l > w)) fail('Slot length must be greater than its width.');
        const a = (l - w) / 2;
        d = r
          .draw([-a, -w / 2])
          .lineTo([a, -w / 2])
          .threePointsArcTo([a, w / 2], [a + w / 2, 0])
          .lineTo([-a, w / 2])
          .threePointsArcTo([-a, -w / 2], [-a - w / 2, 0])
          .close();
        break;
      }
      case 'path': {
        const pts = pathPoints(s, n);
        if (pts.length < 3) fail('A path needs at least 3 points.');
        let pen = r.draw([pts[0][0], pts[0][1]]);
        for (let i = 1; i < pts.length; i++) {
          pen = pts[i][2] ? pen.bulgeArcTo([pts[i][0], pts[i][1]], pts[i][2]) : pen.lineTo([pts[i][0], pts[i][1]]);
        }
        if (pts[0][2]) pen = pen.bulgeArcTo([pts[0][0], pts[0][1]], pts[0][2]);
        d = pen.close();
        const cr = n(s.r ?? 0);
        if (cr > 1e-6) d = d.fillet(cr);
        return d;
      }
      case 'text': {
        if (!r.getFont?.()) fail('Text needs the font file, which has not loaded.');
        const size = n(s.size ?? 10);
        if (!String(s.text ?? '').trim()) fail('Text is empty.');
        d = r.drawText(String(s.text), { fontSize: size });
        break;
      }
      default:
        fail(`Unknown sketch shape "${s.kind}".`);
    }
    const rot = n(s.rot ?? 0);
    if (rot) d = d.rotate(rot, [0, 0]);
    const x = n(s.x ?? 0);
    const y = n(s.y ?? 0);
    if (x || y) d = d.translate(x, y);
    return d;
  }

  // Build a solid from a sketch: `make(drawing)` turns one 2D region into a solid.
  function solidFromSketch(sk, n, make) {
    const shapes = sk.shapes || [];
    const adds = shapes.filter((s) => !s.hole);
    const holes = shapes.filter((s) => s.hole);
    if (!adds.length) fail('The sketch has no solid shapes to use. Draw a rectangle, circle or path first.');
    try {
      let region = adds.map((s) => shapeDrawing(s, n)).reduce((a, b) => a.fuse(b));
      if (holes.length) region = region.cut(holes.map((s) => shapeDrawing(s, n)).reduce((a, b) => a.fuse(b)));
      return make(region);
    } catch (e) {
      if (e instanceof FeatureError) throw e;
      // 2D boolean trouble: fall back to combining solids.
      let solid = adds.map((s) => make(shapeDrawing(s, n))).reduce((a, b) => a.fuse(b));
      for (const h of holes) solid = solid.cut(make(shapeDrawing(h, n)));
      return solid;
    }
  }

  function allBounds(state) {
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const b of state.bodies) {
      const t = topo(b.shape);
      min = min.map((c, k) => Math.min(c, t.min[k]));
      max = max.map((c, k) => Math.max(c, t.max[k]));
    }
    return state.bodies.length ? { min, max } : null;
  }

  // Apply a tool solid to the bodies with a boolean operation.
  function applyOp(state, tool, f, hintBody) {
    const op = f.op || (state.bodies.length ? 'join' : 'new');
    const bodies = state.bodies.slice();
    const tb = { min: tool.boundingBox.bounds[0], max: tool.boundingBox.bounds[1] };
    const wanted = f.target !== undefined ? [].concat(f.target) : null;
    let targets = bodies.map((_, i) => i).filter((i) => (wanted ? wanted.includes(bodies[i].id) || wanted.includes(bodies[i].name) : true));
    if (wanted && !targets.length) fail(`No body named "${wanted.join(', ')}".`);
    if (!wanted) {
      if (hintBody !== undefined && op === 'join' && bodies[hintBody]) targets = [hintBody];
      else targets = targets.filter((i) => boxesTouch(topo(bodies[i].shape), tb));
    }
    if (op === 'new' || (op === 'join' && !targets.length)) {
      bodies.push({ id: f.id, name: f.bodyName || `Body ${state.count + 1}`, shape: tool });
      return { ...state, bodies, count: state.count + 1 };
    }
    if (!targets.length) {
      if (!bodies.length) fail(op === 'cut' ? 'There is nothing to cut yet. Use "new body" or "join" for the first solid.' : 'There is no body to intersect with.');
      return state; // tool misses every body: nothing to do
    }
    if (op === 'join') {
      let shape = bodies[targets[0]].shape;
      shape = boolean(shape, tool, 'join');
      for (const i of targets.slice(1)) shape = boolean(shape, bodies[i].shape, 'join');
      bodies[targets[0]] = { ...bodies[targets[0]], shape };
      const drop = new Set(targets.slice(1));
      return { ...state, bodies: bodies.filter((_, i) => !drop.has(i)) };
    }
    if (op === 'cut' || op === 'intersect') {
      const drop = new Set();
      for (const i of targets) {
        const shape = boolean(bodies[i].shape, tool, op);
        if (isEmpty(shape)) drop.add(i);
        else bodies[i] = { ...bodies[i], shape };
      }
      return { ...state, bodies: bodies.filter((_, i) => !drop.has(i)) };
    }
    fail(`Unknown operation "${op}". Use new, join, cut or intersect.`);
    return state;
  }

  function place(shape, f, n) {
    const rot = (f.rot || [0, 0, 0]).map(n);
    if (rot[0]) shape = xf.rotate(shape, rot[0], [0, 0, 0], [1, 0, 0]);
    if (rot[1]) shape = xf.rotate(shape, rot[1], [0, 0, 0], [0, 1, 0]);
    if (rot[2]) shape = xf.rotate(shape, rot[2], [0, 0, 0], [0, 0, 1]);
    const at = (f.at || [0, 0, 0]).map(n);
    if (at[0] || at[1] || at[2]) shape = shape.translate(at);
    return shape;
  }

  const XZ = () => new r.Plane([0, 0, 0], [1, 0, 0], [0, -1, 0]);

  function primitive(f, n) {
    const pos = (v, label) => {
      const x = n(v);
      if (!(x > 0)) fail(`${label} must be greater than 0.`);
      return x;
    };
    switch (f.type) {
      case 'box': {
        const h = pos(f.h, 'Height');
        let s = r.makeBaseBox(pos(f.w, 'Width'), pos(f.d, 'Depth'), h);
        if (f.centered) s = s.translate([0, 0, -h / 2]);
        return s;
      }
      case 'cylinder': {
        const h = pos(f.h, 'Height');
        let s = r.makeCylinder(pos(f.d, 'Diameter') / 2, h);
        if (f.centered) s = s.translate([0, 0, -h / 2]);
        const ax = String(f.axis || 'z').toLowerCase();
        if (ax === 'x') s = xf.rotate(s, 90, [0, 0, 0], [0, 1, 0]);
        else if (ax === 'y') s = xf.rotate(s, -90, [0, 0, 0], [1, 0, 0]);
        return s;
      }
      case 'sphere':
        return r.makeSphere(pos(f.d, 'Diameter') / 2);
      case 'cone': {
        const r1 = n(f.d1) / 2;
        const r2 = n(f.d2 ?? 0) / 2;
        const h = pos(f.h, 'Height');
        if (!(r1 >= 0 && r2 >= 0 && r1 + r2 > 0)) fail('Cone diameters must be 0 or more, and not both 0.');
        const pts = [[0, 0]];
        if (r1 > 0) pts.push([r1, 0]);
        if (r2 > 0) pts.push([r2, h]);
        pts.push([0, h]);
        let pen = r.draw(pts[0]);
        for (const p of pts.slice(1)) pen = pen.lineTo(p);
        return pen.close().sketchOnPlane(XZ()).revolve([0, 0, 1], { origin: [0, 0, 0] });
      }
      case 'torus': {
        const R = pos(f.d, 'Ring diameter') / 2;
        const t = pos(f.tube, 'Tube diameter') / 2;
        if (t >= R) fail('Tube diameter must be smaller than the ring diameter.');
        return r.drawCircle(t).translate(R, 0).sketchOnPlane(XZ()).revolve([0, 0, 1], { origin: [0, 0, 0] });
      }
      default:
        return null;
    }
  }

  // ---------- features ----------
  function applyFeature(f, state, ctx) {
    const n = (v) => {
      try {
        return evalExpr(v, ctx.scope);
      } catch (e) {
        return fail(e.message);
      }
    };
    const rec = {};

    switch (f.type) {
      case 'sketch': {
        let frame;
        const pl = f.plane ?? 'XY';
        if (typeof pl === 'string') {
          const side = SIDE[pl.toLowerCase()];
          if (BASE_PLANES[pl.toUpperCase()]) frame = BASE_PLANES[pl.toUpperCase()];
          else if (side) frame = faceFrame(state, pl, n, rec);
          else fail(`Unknown plane "${pl}". Use XY, XZ, YZ or a face.`);
        } else if (pl && pl.face !== undefined) frame = faceFrame(state, pl.face, n, rec);
        else fail('Choose a plane or a flat face for this sketch.');
        frame = offsetFrame(frame, n(f.offset ?? 0));
        rec.frame = frame;
        rec.sketch = { frame, shapes: f.shapes || [] };
        for (const s of f.shapes || []) shapeDrawing(s, n); // validate dimensions early
        return { state, rec };
      }

      case 'extrude': {
        let tool;
        let hint;
        let frame;
        let make;
        if (f.face !== undefined) {
          const sel = select(state, f.face, 'face', n);
          const [bi, set] = [...sel.entries()][0] || [];
          if (bi === undefined) fail('Pick a flat face to push or pull.');
          const t = topo(state.bodies[bi].shape);
          const i = [...set][0];
          if (!t.fd[i].n) fail('Only flat faces can be pushed or pulled.');
          hint = bi;
          frame = frameFromFace(t.fd[i].n, t.fd[i].c);
          make = (vec) => r.basicFaceExtrusion(t.faces[i].clone(), new r.Vector(vec));
        } else {
          const sk = ctx.sketches[f.sketch];
          if (!sk) fail(f.sketch ? `Sketch "${f.sketch}" was not found (it may be suppressed or have an error).` : 'Choose the sketch to extrude.');
          frame = sk.frame;
          hint = sk.body !== undefined ? state.bodies.findIndex((b) => b.id === sk.body) : undefined;
          if (hint === -1) hint = undefined;
          make = (vec, origin) =>
            solidFromSketch(sk, n, (region) =>
              region.sketchOnPlane(planeOf({ ...frame, origin })).extrude(v3.len(vec), { extrusionDirection: v3.norm(vec) }),
            );
        }
        const through = f.extent === 'through' || f.distance === 'through';
        let dist = through ? 0 : n(f.distance);
        if (!through && Math.abs(dist) < 1e-6) fail('Distance must not be 0.');
        let origin = frame.origin;
        let vec;
        if (through) {
          const bb = allBounds(state);
          if (!bb) fail('There is nothing to cut through yet.');
          const L = v3.dist(bb.min, bb.max) + v3.dist(origin, v3.mul(v3.add(bb.min, bb.max), 0.5)) + 1;
          origin = v3.add(origin, v3.mul(frame.dir, -L));
          vec = v3.mul(frame.dir, 2 * L);
        } else if (f.side === 'both') {
          origin = v3.add(origin, v3.mul(frame.dir, -dist / 2));
          vec = v3.mul(frame.dir, dist);
        } else vec = v3.mul(frame.dir, dist);
        if (f.face !== undefined && (through || f.side === 'both')) fail('Push/pull uses a plain distance.');
        tool = make(vec, origin);
        rec.tool = { shape: tool, f, hint: hint !== undefined ? state.bodies[hint]?.id : undefined };
        return { state: applyOp(state, tool, through && !f.op ? { ...f, op: 'cut' } : f, hint), rec };
      }

      case 'revolve': {
        const sk = ctx.sketches[f.sketch];
        if (!sk) fail(f.sketch ? `Sketch "${f.sketch}" was not found.` : 'Choose the sketch to revolve.');
        const frame = sk.frame;
        const ax = String(f.axis || 'y').toLowerCase();
        const off = n(f.axisOffset ?? 0);
        const dir = ax === 'x' ? frame.x : frame.y;
        const origin = toWorld(frame, ax === 'x' ? [0, off] : [off, 0]);
        const angle = n(f.angle ?? 360);
        if (!(Math.abs(angle) > 1e-6 && Math.abs(angle) <= 360)) fail('Angle must be between 0 and 360 degrees.');
        const tool = solidFromSketch(sk, n, (region) => region.sketchOnPlane(planeOf(frame)).revolve(dir, { origin, angle }));
        let hint = sk.body !== undefined ? state.bodies.findIndex((b) => b.id === sk.body) : undefined;
        if (hint === -1) hint = undefined;
        rec.tool = { shape: tool, f, hint: hint !== undefined ? state.bodies[hint]?.id : undefined };
        return { state: applyOp(state, tool, f, hint), rec };
      }

      case 'box':
      case 'cylinder':
      case 'sphere':
      case 'cone':
      case 'torus': {
        const tool = place(primitive(f, n), f, n);
        rec.tool = { shape: tool, f };
        return { state: applyOp(state, tool, f), rec };
      }

      case 'import': {
        if (!f.file) fail('Choose an STL file to import.');
        const bytes = files.get(f.file);
        if (!bytes) fail(`The file for this import${f.fileName ? ` (${f.fileName})` : ''} is not loaded. Import it again, or open the project file that contains it.`);
        const want = f.mode === 'solid' || f.mode === 'mesh' ? f.mode : 'auto';
        const key = `${f.file}:${want}`;
        let imp = importCache.get(key);
        if (!imp) {
          try {
            const parsed = parseSTL(bytes);
            let shape = null;
            let kind = 'mesh';
            if (want === 'solid' || (want === 'auto' && parsed.triangles <= SOLID_TRIANGLE_LIMIT)) {
              try {
                shape = stlToSolid(r, bytes);
                kind = 'solid';
              } catch (e) {
                if (want === 'solid') throw new Error(e.message === 'not watertight' ? 'This STL has gaps, so it cannot become an exact solid. Try "Mesh" mode.' : 'This STL could not be turned into an exact solid. Try "Mesh" mode.');
              }
            }
            if (!shape) shape = stlToMesh(r, parsed);
            imp = { shape, kind, triangles: parsed.triangles };
          } catch (e) {
            imp = { error: e.message || 'This STL file could not be read.' };
          }
          importCache.set(key, imp);
        }
        if (imp.error) fail(imp.error);
        const units = { mm: 1, cm: 10, m: 1000, in: 25.4 }[f.units || 'mm'] || 1;
        const k = units * n(f.scale ?? 1);
        if (!(k > 0)) fail('Scale must be greater than 0.');
        let shape = imp.shape.clone();
        if (Math.abs(k - 1) > 1e-12) shape = xf.scale(shape, k);
        const rot = (f.rot || [0, 0, 0]).map(n);
        if (rot[0]) shape = xf.rotate(shape, rot[0], [0, 0, 0], [1, 0, 0]);
        if (rot[1]) shape = xf.rotate(shape, rot[1], [0, 0, 0], [0, 1, 0]);
        if (rot[2]) shape = xf.rotate(shape, rot[2], [0, 0, 0], [0, 0, 1]);
        if ((f.align || 'bed') === 'bed') {
          // Centre it on the origin and sit it on the bed.
          const [lo, hi] = shape.boundingBox.bounds;
          shape = shape.translate([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]]);
        }
        const at = (f.at || [0, 0, 0]).map(n);
        if (at[0] || at[1] || at[2]) shape = shape.translate(at);
        const [lo, hi] = shape.boundingBox.bounds;
        const size = hi.map((v, i) => Math.round((v - lo[i]) * 100) / 100).join(' × ');
        rec.note =
          imp.kind === 'solid'
            ? `Imported as an exact solid (${imp.triangles.toLocaleString()} triangles merged into ${topo(shape).faces.length.toLocaleString()} faces), ${size} mm. You can sketch on its flat faces, fillet, shell and cut it.`
            : `Imported as a mesh body (${imp.triangles.toLocaleString()} triangles), ${size} mm. It can be moved, joined, cut and patterned, but not filleted, chamfered or shelled.`;
        rec.tool = { shape, f };
        return { state: applyOp(state, shape, { ...f, op: f.op || 'new', bodyName: f.bodyName || f.name }), rec };
      }

      case 'fillet':
      case 'chamfer': {
        const size = n(f.type === 'fillet' ? f.radius : f.distance);
        if (!(size > 0)) fail(`${f.type === 'fillet' ? 'Radius' : 'Distance'} must be greater than 0.`);
        const sel = select(state, f.edges, 'edge', n);
        if (!sel.size) fail(state.bodies.some((b) => isMesh(b.shape)) ? 'No edges matched. Mesh bodies (large imported STLs) have no edges to round or bevel.' : 'No edges matched the selection.');
        const bodies = state.bodies.slice();
        for (const [bi, set] of sel) {
          const t = topo(bodies[bi].shape);
          const list = [...set].map((i) => t.edges[i].clone());
          const shape = f.type === 'fillet' ? bodies[bi].shape.fillet(size, (e) => e.inList(list)) : bodies[bi].shape.chamfer(size, (e) => e.inList(list));
          if (isEmpty(shape)) fail(FAIL_HINT[f.type]);
          bodies[bi] = { ...bodies[bi], shape };
        }
        return { state: { ...state, bodies }, rec };
      }

      case 'shell': {
        const th = n(f.thickness);
        if (!(th > 0)) fail('Wall thickness must be greater than 0.');
        const sel = select(state, f.faces, 'face', n);
        if (!sel.size) fail(state.bodies.some((b) => isMesh(b.shape)) ? 'No faces matched. Mesh bodies (large imported STLs) cannot be shelled.' : 'No faces matched. Pick the face to open up.');
        const bodies = state.bodies.slice();
        for (const [bi, set] of sel) {
          const t = topo(bodies[bi].shape);
          const list = [...set].map((i) => t.faces[i].clone());
          const shape = bodies[bi].shape.shell(th, (fc) => fc.inList(list));
          if (isEmpty(shape)) fail(FAIL_HINT.shell);
          bodies[bi] = { ...bodies[bi], shape };
        }
        return { state: { ...state, bodies }, rec };
      }

      case 'pattern': {
        const ids = [].concat(f.features || []);
        if (!ids.length) fail('Choose the feature to repeat.');
        const tools = ids.map((id) => ctx.tools[id] || fail(`"${id}" cannot be patterned. Patterns repeat extrudes, revolves and primitives.`));
        const moves = [];
        if ((f.kind || 'linear') === 'circular') {
          const count = Math.round(n(f.count ?? 2));
          const total = n(f.angle ?? 360);
          if (!(count >= 2)) fail('Count must be 2 or more.');
          const axis = axisVec(f.axis ?? 'z');
          const center = (f.center || [0, 0, 0]).map(n);
          const step = Math.abs(Math.abs(total) - 360) < 1e-6 ? total / count : total / (count - 1);
          for (let i = 1; i < count; i++) moves.push((s) => xf.rotate(s, step * i, center, axis));
        } else {
          const c1 = Math.round(n(f.count ?? 2));
          const c2 = Math.round(n(f.count2 ?? 1));
          if (!(c1 >= 1 && c2 >= 1 && c1 * c2 >= 2)) fail('Count must be 2 or more.');
          if (c1 * c2 > 400) fail('That is more than 400 copies.');
          const d1 = v3.mul(axisVec(f.dir ?? 'x'), n(f.spacing ?? 10));
          const d2 = v3.mul(axisVec(f.dir2 ?? 'y'), n(f.spacing2 ?? 10));
          for (let i = 0; i < c1; i++) for (let j = 0; j < c2; j++) if (i || j) moves.push((s) => s.translate(v3.add(v3.mul(d1, i), v3.mul(d2, j))));
        }
        for (const t of tools) {
          for (const mv of moves) {
            const hint = t.hint !== undefined ? state.bodies.findIndex((b) => b.id === t.hint) : -1;
            state = applyOp(state, mv(t.shape.clone()), { ...t.f, op: t.f.op === 'new' ? 'join' : t.f.op, id: `${f.id}_${state.count}` }, hint >= 0 ? hint : undefined);
          }
        }
        return { state, rec };
      }

      case 'mirror': {
        const base = BASE_PLANES[String(f.plane || 'YZ').toUpperCase()];
        if (!base) fail('Mirror plane must be XY, XZ or YZ.');
        const origin = v3.mul(base.dir, n(f.offset ?? 0));
        const ids = [].concat(f.features || []);
        if (ids.length) {
          for (const id of ids) {
            const t = ctx.tools[id] || fail(`"${id}" cannot be mirrored on its own. Leave "features" empty to mirror whole bodies.`);
            const hint = t.hint !== undefined ? state.bodies.findIndex((b) => b.id === t.hint) : -1;
            state = applyOp(state, xf.mirror(t.shape.clone(), base.dir, origin), { ...t.f, op: t.f.op === 'new' ? 'join' : t.f.op, id: `${f.id}_${id}` }, hint >= 0 ? hint : undefined);
          }
          return { state, rec };
        }
        if (!state.bodies.length) fail('There is nothing to mirror yet.');
        const bodies = state.bodies.map((b) => {
          if (f.body !== undefined && f.body !== b.id && f.body !== b.name) return b;
          return { ...b, shape: boolean(b.shape, xf.mirror(b.shape.clone(), base.dir, origin), 'join') };
        });
        return { state: { ...state, bodies }, rec };
      }

      case 'move': {
        if (!state.bodies.length) fail('There is nothing to move yet.');
        const wanted = f.bodies ? [].concat(f.bodies) : null;
        const by = (f.by || [0, 0, 0]).map(n);
        const rot = (f.rot || [0, 0, 0]).map(n);
        const out = [];
        let count = state.count;
        for (const b of state.bodies) {
          if (wanted && !wanted.includes(b.id) && !wanted.includes(b.name)) {
            out.push(b);
            continue;
          }
          const t = topo(b.shape);
          const about = Array.isArray(f.about) ? f.about.map(n) : v3.mul(v3.add(t.min, t.max), 0.5);
          let s = b.shape.clone();
          if (rot[0]) s = xf.rotate(s, rot[0], about, [1, 0, 0]);
          if (rot[1]) s = xf.rotate(s, rot[1], about, [0, 1, 0]);
          if (rot[2]) s = xf.rotate(s, rot[2], about, [0, 0, 1]);
          if (by[0] || by[1] || by[2]) s = s.translate(by);
          if (f.copy) {
            out.push(b, { id: `${f.id}_${b.id}`, name: `Body ${++count}`, shape: s });
          } else out.push({ ...b, shape: s });
        }
        return { state: { ...state, bodies: out, count }, rec };
      }

      default:
        return fail(`Unknown feature type "${f.type}".`);
    }
  }

  function faceFrame(state, sel, n, rec) {
    const hit = select(state, sel, 'face', n);
    for (const [bi, set] of hit) {
      const t = topo(state.bodies[bi].shape);
      for (const i of set) {
        if (t.fd[i].n) {
          rec.sketchBody = state.bodies[bi].id;
          return frameFromFace(t.fd[i].n, t.fd[i].c);
        }
      }
    }
    return fail(hit.size ? 'Sketches need a flat face. Pick a planar face or a base plane.' : 'The face for this sketch was not found.');
  }

  // ---------- evaluation ----------
  function evaluate(doc) {
    const { scope, errors: paramErrors } = resolveParams(doc.params);
    const scopeKey = JSON.stringify(scope);
    const features = (doc.features || []).filter((f) => f && !f.suppressed);
    const next = [];
    const ctx = { scope, sketches: {}, tools: {} };
    let state = { bodies: [], count: 0 };
    let prevKey = scopeKey;
    const info = {};
    const picks = {};
    let valid = true;

    features.forEach((f, idx) => {
      const before = JSON.stringify(f);
      const key = `${prevKey}\n${before}`;
      let entry = valid && cache[idx] && cache[idx].key === key ? cache[idx] : null;
      if (!entry) {
        valid = false;
        entry = { key, state, rec: {}, error: null };
        const work = JSON.parse(before);
        try {
          const res = applyFeature(work, state, ctx);
          entry.state = res.state;
          entry.rec = res.rec;
          const after = JSON.stringify(work);
          if (after !== before) entry.picks = work;
        } catch (e) {
          entry.error = e instanceof FeatureError ? e.message : FAIL_HINT[f.type] || `This ${f.type} could not be built. Try different dimensions.`;
          if (!(e instanceof FeatureError) && e && e.message && !(typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception)) entry.detail = String(e.message);
        }
      }
      next.push(entry);
      state = entry.state;
      prevKey = hashKey(key);
      entry.key = key;
      if (entry.rec.sketch) ctx.sketches[f.id] = { ...entry.rec.sketch, body: entry.rec.sketchBody };
      if (entry.rec.tool) ctx.tools[f.id] = entry.rec.tool;
      info[f.id] = {};
      if (entry.error) info[f.id].error = entry.error;
      if (entry.detail) info[f.id].detail = entry.detail;
      if (entry.rec.frame) info[f.id].frame = entry.rec.frame;
      if (entry.rec.note) info[f.id].note = entry.rec.note;
      if (entry.picks) picks[f.id] = entry.picks;
    });
    cache = next;
    lastBodies = state.bodies;
    lastState = state;
    lastScope = scope;

    const transfer = [];
    const bodies = state.bodies.map((b) => {
      const t = topo(b.shape);
      let m = meshCache.get(b.shape);
      if (!m && isMesh(b.shape)) {
        const d = meshDisplay(b.shape);
        m = { positions: d.positions, normals: d.normals, indices: d.indices, faceGroups: [], lines: d.lines, edgeGroups: [], volume: d.volume, isMesh: true, triangles: d.triangles };
        meshCache.set(b.shape, m);
      }
      if (!m) {
        const tri = rawMesh(b.shape);
        const ed = b.shape.meshEdges(DISPLAY_MESH);
        let volume = 0;
        try {
          volume = r.measureVolume(b.shape);
        } catch {
          /* open shells have no volume */
        }
        const order = new Map(t.faces.map((fc, i) => [fc.hashCode, i]));
        const eorder = new Map(t.edges.map((e, i) => [e.hashCode, i]));
        m = {
          positions: tri.vertices,
          normals: tri.normals,
          indices: tri.triangles,
          faceGroups: tri.faceGroups.map((g, i) => ({ start: g.start, count: g.count, i: order.get(g.faceId) ?? i })),
          lines: ed.lines,
          edgeGroups: ed.edgeGroups.map((g, i) => ({ start: g.start, count: g.count, i: eorder.get(g.edgeId) ?? i })),
          volume,
        };
        meshCache.set(b.shape, m);
      }
      const out = {
        id: b.id,
        name: b.name,
        positions: new Float32Array(m.positions),
        normals: new Float32Array(m.normals),
        indices: new Uint32Array(m.indices),
        faceGroups: m.faceGroups,
        lines: new Float32Array(m.lines),
        edgeGroups: m.edgeGroups,
        faces: t.fd,
        edges: t.ed,
        min: t.min,
        max: t.max,
        volume: m.volume,
        ...(m.isMesh ? { isMesh: true, triangles: m.triangles } : {}),
      };
      transfer.push(out.positions.buffer, out.normals.buffer, out.indices.buffer, out.lines.buffer);
      return out;
    });
    const bb = allBounds(state);
    return {
      result: {
        bodies,
        features: info,
        picks,
        params: scope,
        paramErrors,
        min: bb ? bb.min : null,
        max: bb ? bb.max : null,
        volume: bodies.reduce((s, b) => s + (b.volume || 0), 0),
      },
      transfer,
    };
  }

  function hashKey(s) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${s.length}`;
  }

  // ---------- export ----------
  function pickBodies(ids) {
    const list = ids && ids.length ? lastBodies.filter((b) => ids.includes(b.id)) : lastBodies;
    if (!list.length) throw new Error('There is nothing to export yet.');
    return list;
  }

  function exportSTL(ids, quality = 'standard') {
    const meshes = pickBodies(ids).map((b) => (isMesh(b.shape) ? meshTriangles(b.shape) : b.shape.mesh(QUALITY[quality] || QUALITY.standard)));
    const count = meshes.reduce((s, m) => s + m.triangles.length / 3, 0);
    const buf = new ArrayBuffer(84 + count * 50);
    const dv = new DataView(buf);
    const head = 'Binary STL exported by Caliper (millimetres)';
    for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
    dv.setUint32(80, count, true);
    let o = 84;
    for (const m of meshes) {
      const v = m.vertices;
      const t = m.triangles;
      for (let i = 0; i < t.length; i += 3) {
        const a = t[i] * 3;
        const b = t[i + 1] * 3;
        const c = t[i + 2] * 3;
        const ux = v[b] - v[a];
        const uy = v[b + 1] - v[a + 1];
        const uz = v[b + 2] - v[a + 2];
        const wx = v[c] - v[a];
        const wy = v[c + 1] - v[a + 1];
        const wz = v[c + 2] - v[a + 2];
        let nx = uy * wz - uz * wy;
        let ny = uz * wx - ux * wz;
        let nz = ux * wy - uy * wx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        dv.setFloat32(o, nx, true);
        dv.setFloat32(o + 4, ny, true);
        dv.setFloat32(o + 8, nz, true);
        o += 12;
        for (const k of [a, b, c]) {
          dv.setFloat32(o, v[k], true);
          dv.setFloat32(o + 4, v[k + 1], true);
          dv.setFloat32(o + 8, v[k + 2], true);
          o += 12;
        }
        o += 2;
      }
    }
    return { buffer: buf, triangles: count };
  }

  async function exportSTEP(ids) {
    const all = pickBodies(ids);
    const solids = all.filter((b) => !isMesh(b.shape));
    if (!solids.length) throw new Error('STEP holds exact solids, and every body here is a mesh (an imported STL). Export STL instead.');
    const blob = r.exportSTEP(solids.map((b) => ({ shape: b.shape, name: b.name })));
    return { buffer: await blob.arrayBuffer(), skipped: all.filter((b) => isMesh(b.shape)).map((b) => b.name) };
  }

  // ---------- files ----------
  function addFile(id, bytes) {
    files.set(id, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    for (const k of importCache.keys()) if (k.startsWith(`${id}:`)) importCache.delete(k);
  }

  // ---------- questions about the last built model (for agents) ----------
  const refOf = (bodyId, kind, i) => `${bodyId}:${kind === 'face' ? 'F' : 'E'}${i}`;
  function bodyIndex(id) {
    const i = lastState.bodies.findIndex((b) => b.id === id || b.name === id);
    if (i < 0) throw new Error(`There is no body "${id}". Bodies: ${lastState.bodies.map((b) => `${b.id} (${b.name})`).join(', ') || 'none'}.`);
    return i;
  }

  // Resolve a selector (or refs) to elements: [{ ref, b, i }].
  function query(sel, kind) {
    const n = (v) => evalExpr(v, lastScope);
    const res = select(lastState, JSON.parse(JSON.stringify(sel)), kind, n);
    const out = [];
    for (const [bi, set] of res) for (const i of set) out.push({ ref: refOf(lastState.bodies[bi].id, kind, i), b: lastState.bodies[bi].id, i });
    return out;
  }

  function element(ref) {
    const m = /^(.+):([FE])(\d+)$/.exec(String(ref));
    if (!m) {
      const bi = bodyIndex(ref);
      return { kind: 'body', body: lastState.bodies[bi] };
    }
    const body = lastState.bodies[bodyIndex(m[1])];
    if (isMesh(body.shape)) throw new Error(`${body.name} is a mesh body; it has no individual faces or edges.`);
    const t = topo(body.shape);
    const i = Number(m[3]);
    const kind = m[2] === 'F' ? 'face' : 'edge';
    const shape = (kind === 'face' ? t.faces : t.edges)[i];
    if (!shape) throw new Error(`${ref} does not exist (the body has ${t.faces.length} faces and ${t.edges.length} edges).`);
    return { kind, body, i, shape, d: (kind === 'face' ? t.fd : t.ed)[i] };
  }

  const r3 = (p) => p.map((x) => Math.round(x * 1000) / 1000);
  function describe(el) {
    if (el.kind === 'body') {
      const t = topo(el.body.shape);
      const out = { ref: el.body.id, name: el.body.name, kind: isMesh(el.body.shape) ? 'mesh body' : 'solid body', min: r3(t.min), max: r3(t.max), size: r3(t.max.map((v, k) => v - t.min[k])) };
      try {
        if (isMesh(el.body.shape)) {
          out.volume = Math.round(el.body.shape.volume() * 1000) / 1000;
          out.surface_area = Math.round(el.body.shape.surfaceArea() * 1000) / 1000;
        } else {
          const vp = r.measureShapeVolumeProperties(el.body.shape);
          out.volume = Math.round(vp.volume * 1000) / 1000;
          out.center_of_mass = r3(vp.centerOfMass);
          out.surface_area = Math.round(r.measureArea(el.body.shape) * 1000) / 1000;
          out.faces = t.faces.length;
          out.edges = t.ed.filter((e) => !e.seam).length;
        }
      } catch {
        /* partial info is still useful */
      }
      return out;
    }
    const d = el.d;
    const ref = refOf(el.body.id, el.kind, el.i);
    if (el.kind === 'face') return { ref, kind: 'face', type: d.t.toLowerCase(), area: Math.round(d.a * 1000) / 1000, center: r3(d.c), ...(d.n ? { normal: r3(d.n) } : {}), ...(d.r ? { radius: d.r } : {}) };
    return { ref, kind: 'edge', type: d.t.toLowerCase(), length: Math.round(d.l * 1000) / 1000, start: r3(d.s), end: r3(d.e), mid: r3(d.m), ...(d.r ? { radius: d.r, diameter: Math.round(d.r * 2000) / 1000 } : {}), ...(d.d ? { direction: r3(d.d) } : {}) };
  }

  const angleDeg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, v3.dot(v3.norm(a), v3.norm(b))))) * 180) / Math.PI;
  function measure(a, b) {
    const A = element(a);
    const out = { a: describe(A) };
    if (b === undefined || b === null || b === '') return out;
    const B = element(b);
    out.b = describe(B);
    if (A.kind === 'body' || B.kind === 'body') {
      if (isMesh(A.body.shape) || isMesh(B.body.shape)) return out;
    }
    try {
      const sa = A.kind === 'body' ? A.body.shape : A.shape;
      const sb = B.kind === 'body' ? B.body.shape : B.shape;
      out.min_distance = Math.round(r.measureDistanceBetween(sa, sb) * 1e5) / 1e5;
    } catch {
      /* not every pair has a distance */
    }
    const dir = (el) => (el.kind === 'face' ? el.d.n : el.kind === 'edge' ? el.d.d : null);
    const da = dir(A);
    const db = dir(B);
    if (da && db) {
      const ang = angleDeg(da, db);
      if (A.kind === B.kind) out.angle_deg = Math.round(Math.min(ang, 180 - ang) * 1000) / 1000;
      else out.angle_to_plane_deg = Math.round(Math.abs(90 - ang) * 1000) / 1000;
      if (A.kind === 'face' && B.kind === 'face' && Math.abs(Math.abs(v3.dot(da, db)) - 1) < 1e-6) out.gap_between_planes = Math.round(Math.abs(v3.dot(da, v3.sub(B.d.c, A.d.c))) * 1e5) / 1e5;
    }
    return out;
  }

  function listElements(kind, sel, limit = 200) {
    const els = sel ? query(sel, kind) : lastState.bodies.flatMap((body) => (isMesh(body.shape) ? [] : (kind === 'face' ? topo(body.shape).fd : topo(body.shape).ed).map((d, i) => ({ ref: refOf(body.id, kind, i), b: body.id, i, seam: d.seam })).filter((x) => !x.seam)));
    const items = els.slice(0, limit).map((x) => describe(element(x.ref)));
    return { total: els.length, items };
  }

  return { evaluate, exportSTL, exportSTEP, addFile, query, measure, listElements };
}
