// 3D file formats other than STL. Each one becomes either an exact solid (STEP with real surfaces) or a
// triangle mesh that goes through the same repair and solid/mesh/reference path as STL.
import { parseSTL, weldSoup } from './stl.js';

const text = (bytes) => new TextDecoder().decode(bytes);
const head = (bytes, n = 600) => new TextDecoder().decode(bytes.subarray(0, n));

// Format from the content (names lie, and the kernel only sees bytes); the file name is a tie-breaker.
export function detectFormat(bytes, name = '') {
  const h = head(bytes);
  if (/^\s*ISO-10303-21/.test(h)) return 'step';
  if (/<\s*model[\s>]/.test(h) && /3dmanufacturing|<\s*resources/i.test(text(bytes.subarray(0, 4000)))) return '3mf';
  if (/\.obj$/i.test(name) || (/^\s*(#.*\n\s*)*(v|o|g|mtllib)\s/m.test(h) && !/^\s*solid\s/.test(h) && /^\s*v\s+[-\d.]/m.test(h))) return 'obj';
  return 'stl';
}

export const FORMAT_NAMES = { stl: 'STL', step: 'STEP', obj: 'OBJ', '3mf': '3MF' };

// ---------- OBJ ----------
export function parseOBJ(bytes) {
  const src = text(bytes);
  const v = [];
  const raw = [];
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') v.push([+t[1], +t[2], +t[3]]);
    else if (t[0] === 'f') {
      const idx = t.slice(1).map((s) => {
        const i = parseInt(s.split('/')[0], 10);
        return i < 0 ? v.length + i : i - 1; // negative indices count back from the last vertex
      });
      for (let k = 1; k + 1 < idx.length; k++) for (const i of [idx[0], idx[k], idx[k + 1]]) raw.push(...(v[i] || [NaN, NaN, NaN]));
    }
  }
  return weldSoup(raw, 'OBJ');
}

// ---------- 3MF (the worker unzips it; this reads the model XML) ----------
const UNITS_3MF = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
export function parse3MF(bytes) {
  const xml = text(bytes);
  const unit = UNITS_3MF[(/<\s*model[^>]*\sunit="([a-z]+)"/i.exec(xml) || [])[1]] || 1;
  const attr = (tag, name) => {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
    return m ? m[1] : null;
  };
  const objects = new Map();
  const objRe = /<\s*object\b([^>]*)>([\s\S]*?)<\/\s*object\s*>/g;
  let m;
  while ((m = objRe.exec(xml))) {
    const id = attr(m[1], 'id');
    const body = m[2];
    const verts = [...body.matchAll(/<\s*vertex\b([^>]*)\/?>/g)].map((x) => [+attr(x[1], 'x'), +attr(x[1], 'y'), +attr(x[1], 'z')]);
    const tris = [...body.matchAll(/<\s*triangle\b([^>]*)\/?>/g)].map((x) => [+attr(x[1], 'v1'), +attr(x[1], 'v2'), +attr(x[1], 'v3')]);
    const comps = [...body.matchAll(/<\s*component\b([^>]*)\/?>/g)].map((x) => ({ id: attr(x[1], 'objectid'), transform: attr(x[1], 'transform') }));
    objects.set(id, { verts, tris, comps });
  }
  const mat = (t) => (t ? t.trim().split(/\s+/).map(Number) : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  // 3MF transforms are row vectors: p' = [x y z 1] * M (3 columns, 4 rows).
  const apply = (M, p) => [0, 1, 2].map((c) => p[0] * M[c] + p[1] * M[3 + c] + p[2] * M[6 + c] + M[9 + c]);
  const mul = (A, B) => {
    const out = [];
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 3; c++) out.push((r < 3 ? 0 : B[9 + c]) + A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]);
    return out;
  };
  const raw = [];
  const emit = (id, M, depth = 0) => {
    const o = objects.get(id);
    if (!o || depth > 8) return;
    for (const t of o.tris) for (const i of t) raw.push(...apply(M, o.verts[i] || [NaN, NaN, NaN]).map((x) => x * unit));
    for (const c of o.comps) emit(c.id, mul(mat(c.transform), M), depth + 1);
  };
  const items = [...xml.matchAll(/<\s*item\b([^>]*)\/?>/g)].map((x) => ({ id: attr(x[1], 'objectid'), transform: attr(x[1], 'transform') }));
  if (items.length) for (const it of items) emit(it.id, mat(it.transform));
  else for (const id of objects.keys()) emit(id, mat(null));
  return weldSoup(raw, '3MF');
}

// ---------- STEP ----------
// STEP files with real surfaces (B-rep) go through OpenCascade and become exact solids. Returns null
// when the file holds no B-rep (for example Fusion's "tessellated" STEP, a mesh in a STEP container).
export function readSTEPSolid(r, bytes) {
  const oc = r.getOC();
  const path = `/import-${Math.random().toString(36).slice(2)}.step`;
  oc.FS.writeFile(path, bytes);
  const reader = new oc.STEPControl_Reader();
  try {
    reader.ReadFile(path);
    let shape;
    try {
      reader.TransferRoots(new oc.Message_ProgressRange());
      shape = r.cast(reader.OneShape()); // throws on a null shape (nothing it could transfer)
    } catch {
      return null;
    }
    try {
      if (!shape.faces.length) return null;
      shape.boundingBox.bounds; // throws on an empty shape
    } catch {
      return null;
    }
    return shape;
  } finally {
    oc.FS.unlink(path);
    reader.delete();
  }
}

// A small reader for STEP parameter lists: numbers, #refs, 'strings', $, *, .ENUMS., nested lists.
function parseParams(src) {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const value = () => {
    ws();
    const ch = src[i];
    if (ch === '(') {
      i++;
      const list = [];
      ws();
      if (src[i] === ')') {
        i++;
        return list;
      }
      for (;;) {
        list.push(value());
        ws();
        if (src[i] === ',') i++;
        else if (src[i] === ')') {
          i++;
          return list;
        } else throw new Error('bad list');
      }
    }
    if (ch === "'") {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (src[j] === "'" && src[j + 1] === "'") {
          out += "'";
          j += 2;
        } else if (src[j] === "'") break;
        else out += src[j++];
      }
      i = j + 1;
      return out;
    }
    if (ch === '#') {
      const m = /^#\d+/.exec(src.slice(i, i + 20));
      i += m[0].length;
      return { ref: m[0] };
    }
    if (ch === '$' || ch === '*') {
      i++;
      return null;
    }
    if (ch === '.') {
      const j = src.indexOf('.', i + 1);
      const v = src.slice(i, j + 1);
      i = j + 1;
      return v;
    }
    const m = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i, i + 40));
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    // A typed value such as LENGTH_MEASURE(1.0): keep the inner value.
    const t = /^[A-Z_][A-Z0-9_]*/.exec(src.slice(i, i + 80));
    if (t) {
      i += t[0].length;
      return value();
    }
    throw new Error(`unexpected "${src.slice(i, i + 12)}"`);
  };
  return value();
}

// Mesh from a tessellated STEP (AP242 TRIANGULATED_FACE / COMPLEX_TRIANGULATED_FACE /
// TRIANGULATED_SURFACE_SET / COMPLEX_TRIANGULATED_SURFACE_SET over a COORDINATES_LIST).
export function parseTessellatedSTEP(bytes) {
  const src = text(bytes);
  const data = src.slice(src.indexOf('DATA;'));
  const entities = new Map();
  const re = /(#\d+)\s*=\s*([A-Z_0-9]*)\s*(\([\s\S]*?\))\s*;(?=\s*(#\d+\s*=|ENDSEC))/g;
  let m;
  while ((m = re.exec(data))) entities.set(m[1], { type: m[2], body: m[3] });
  // Length unit: millimetre unless the file says otherwise.
  let scale = 1;
  const lu = /\(\s*LENGTH_UNIT\s*\(\s*\)\s*NAMED_UNIT\s*\([^)]*\)\s*SI_UNIT\s*\(\s*(\.[A-Z]+\.|\$)\s*,\s*\.METRE\.\s*\)/.exec(data);
  if (lu) scale = { '.MILLI.': 1, '.CENTI.': 10, '.DECI.': 100, '.MICRO.': 0.001, $: 1000 }[lu[1]] ?? 1;
  else if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(data)) scale = 25.4;
  else if (/CONVERSION_BASED_UNIT\s*\(\s*'FOOT'/i.test(data)) scale = 304.8;
  const coordCache = new Map();
  const coords = (ref) => {
    if (!coordCache.has(ref)) {
      const e = entities.get(ref);
      if (!e || e.type !== 'COORDINATES_LIST') throw new Error('This STEP file refers to points it does not contain.');
      coordCache.set(ref, parseParams(e.body)[2]);
    }
    return coordCache.get(ref);
  };
  const raw = [];
  let faces = 0;
  for (const e of entities.values()) {
    const kind = e.type;
    if (!/^(COMPLEX_)?TRIANGULATED_(FACE|SURFACE_SET)$/.test(kind)) continue;
    const p = parseParams(e.body);
    const pts = coords(p[1].ref);
    const isFace = kind.endsWith('FACE');
    // FACE has a geometric link before pnindex; SURFACE_SET does not.
    const pn = (isFace ? p[5] : p[4]) || [];
    const at = (i) => pts[(pn.length ? pn[i - 1] : i) - 1];
    const tri = (a, b, c) => {
      if (a === b || b === c || a === c) return;
      for (const v of [at(a), at(b), at(c)]) raw.push(...(v ? v.map((x) => x * scale) : [NaN, NaN, NaN]));
    };
    if (kind.startsWith('COMPLEX')) {
      const strips = (isFace ? p[6] : p[5]) || [];
      const fans = (isFace ? p[7] : p[6]) || [];
      for (const s of strips) for (let k = 2; k < s.length; k++) (k % 2 ? tri(s[k - 1], s[k - 2], s[k]) : tri(s[k - 2], s[k - 1], s[k]));
      for (const f of fans) for (let k = 2; k < f.length; k++) tri(f[0], f[k - 1], f[k]);
    } else for (const t of (isFace ? p[6] : p[5]) || []) tri(t[0], t[1], t[2]);
    faces++;
  }
  if (!faces) throw new Error('This STEP file has neither solid surfaces nor a mesh that Caliper can read.');
  return weldSoup(raw, 'STEP');
}

// Any supported mesh file -> welded mesh.
export function parseMesh(bytes, format) {
  if (format === 'obj') return parseOBJ(bytes);
  if (format === '3mf') return parse3MF(bytes);
  if (format === 'step') return parseTessellatedSTEP(bytes);
  return parseSTL(bytes);
}
