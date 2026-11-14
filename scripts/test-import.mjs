// Kernel checks for STL import: exact-solid and mesh paths, booleans across both, queries, measure.
import fs from 'node:fs';
import { loadKernel } from './kernel-node.mjs';

const k = await loadKernel();
let failed = 0;
let last = performance.now();
const ok = (c, m) => {
  const now = performance.now();
  m += ` [${Math.round(now - last)} ms]`;
  last = now;
  console.log(`${c ? 'PASS' : 'FAIL'} ${m}`);
  if (!c) failed++;
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const errs = (res) => Object.entries(res.features).filter(([, v]) => v.error).map(([id, v]) => `${id}: ${v.error}${v.detail ? ` [${v.detail}]` : ''}`);
const stl = (features, quality = 'standard') => {
  k.evaluate({ features });
  return new Uint8Array(k.exportSTL(null, quality).buffer);
};
const ascii = (bytes) => {
  const dv = new DataView(bytes.buffer);
  const n = dv.getUint32(80, true);
  let out = 'solid test\n';
  for (let t = 0; t < n; t++) {
    out += ' facet normal 0 0 0\n  outer loop\n';
    for (let c = 0; c < 3; c++) {
      const o = 84 + t * 50 + 12 + c * 12;
      out += `   vertex ${dv.getFloat32(o, true)} ${dv.getFloat32(o + 4, true)} ${dv.getFloat32(o + 8, true)}\n`;
    }
    out += '  endloop\n endfacet\n';
  }
  return new TextEncoder().encode(out + 'endsolid test\n');
};

// Fixtures, made by the kernel itself.
const bracket = stl([{ id: 'b', type: 'box', w: 40, d: 20, h: 10 }, { id: 'c', type: 'cylinder', d: 6, h: 20, at: [10, 0, -5], op: 'cut' }]);
const ball = stl([{ id: 's', type: 'sphere', d: 30, at: [100, 100, 50] }], 'fine'); // off-origin on purpose
k.addFile('bracket', bracket);
k.addFile('bracketAscii', ascii(bracket));
k.addFile('ball', ball);
k.addFile('junk', new TextEncoder().encode('hello'));
const open = bracket.slice(0, 84 + 50 * 10);
new DataView(open.buffer).setUint32(80, 10, true);
k.addFile('open', open);
const volBracket = 40 * 20 * 10 - Math.PI * 9 * 10;

let res = k.evaluate({ features: [{ id: 'i', type: 'import', file: 'bracket' }] }).result;
ok(!errs(res).length && res.bodies.length === 1 && !res.bodies[0].isMesh, `small STL becomes an exact solid (${errs(res)})`);
const top = res.bodies[0].faces.filter((f) => f.n && f.n[2] > 0.999);
ok(near(res.volume, volBracket, 0.02) && top.length === 1 && near(top[0].a, 800 - Math.PI * 9, 0.02), `coplanar triangles merged into one top face (${top.length} top faces, ${res.bodies[0].faces.length} in all), vol ${res.volume.toFixed(1)}`);
ok(near(res.min[2], 0) && near(res.min[0], -20), 'placed on the bed, centred');
ok(/exact solid/.test(res.features.i.note), `note: ${res.features.i.note}`);

res = k.evaluate({ features: [
  { id: 'i', type: 'import', file: 'bracket' },
  { id: 's', type: 'sketch', plane: 'top', shapes: [{ id: 'c', kind: 'circle', x: -10, y: 0, d: 5 }] },
  { id: 'e', type: 'extrude', sketch: 's', distance: -10, op: 'cut' },
  { id: 'f', type: 'fillet', edges: { parallel: 'z', on: 'right' }, radius: 3 },
] }).result;
ok(!errs(res).length && res.volume < volBracket - 150, `sketch on imported face, cut, fillet (${errs(res)}; vol ${res.volume.toFixed(1)})`);

res = k.evaluate({ features: [{ id: 'i', type: 'import', file: 'bracketAscii', scale: 2 }] }).result;
ok(!errs(res).length && near(res.volume, volBracket * 8, 0.02), `text STL and scale (${errs(res)}; vol ${res.volume.toFixed(0)})`);

res = k.evaluate({ features: [{ id: 'i', type: 'import', file: 'ball', units: 'cm', align: 'original' }] }).result;
ok(res.bodies[0]?.isMesh && near(res.min[2], 350, 0.01), `large STL becomes a mesh body, cm units and original placement kept (z ${res.min?.[2]})`);
const t0 = performance.now();
res = k.evaluate({ features: [
  { id: 'i', type: 'import', file: 'ball' },
  { id: 'h', type: 'cylinder', d: 10, h: 50, at: [0, 0, -5], op: 'cut' },
  { id: 'p', type: 'box', w: 60, d: 10, h: 4, op: 'join' },
  { id: 'm', type: 'move', by: [0, 0, 2] },
] }).result;
const ms = performance.now() - t0;
const vBall = (4 / 3) * Math.PI * 15 ** 3;
ok(!errs(res).length && res.bodies.length === 1 && res.bodies[0].isMesh, `mesh body: cut with a cylinder, join a box, move (${errs(res)})`);
ok(res.volume > vBall * 0.8 && res.volume < vBall + 60 * 10 * 4, `mesh boolean volume plausible (${res.volume.toFixed(0)}), ${Math.round(ms)} ms`);
ok(res.bodies[0].lines.length > 0 && res.bodies[0].faceGroups.length === 0, 'mesh body has outline lines and no pickable faces');

res = k.evaluate({ features: [{ id: 'i', type: 'import', file: 'ball' }, { id: 'f', type: 'fillet', edges: 'all', radius: 1 }] }).result;
ok(/Mesh bodies/.test(res.features.f.error || ''), `fillet on a mesh explains why (${res.features.f.error})`);
k.addFile('pebble', stl([{ id: 's', type: 'sphere', d: 30 }], 'draft'));
res = k.evaluate({ features: [{ id: 'i', type: 'import', file: 'pebble', mode: 'mesh' }] }).result;
ok(!errs(res).length && res.bodies[0].isMesh, `forcing mesh mode on a small file (${errs(res)})`);
res = k.evaluate({ features: [{ id: 'i', type: 'import', file: 'junk' }] }).result;
ok(/no triangles|cut short|could not/.test(res.features.i.error || ''), `junk file explained (${res.features.i.error})`);
res = k.evaluate({ features: [{ id: 'i', type: 'import', file: 'open' }] }).result;
ok(!errs(res).length && res.bodies[0]?.isReference && /reference mesh/.test(res.features.i.note), `an open mesh comes in as a reference mesh (${res.features.i.note?.slice(0, 80)})`);

// Defects seen in real downloads (SketchUp-style exports).
const tri = (P, T) => {
  const buf = new ArrayBuffer(84 + T.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, T.length, true);
  T.forEach((t, i) => t.forEach((v, c) => P[v].forEach((x, q) => dv.setFloat32(84 + i * 50 + 12 + c * 12 + q * 4, x, true))));
  return new Uint8Array(buf);
};
const cubeP = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
const cubeT = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
// A T-junction patched with a zero-area sliver: vertex 8 sits on edge 1-5, which the side face 1-2-6
// still uses whole.
const slivP = [...cubeP, [10, 0, 5]];
const slivT = cubeT.filter((t) => t.join() !== '0,1,5').concat([[0, 1, 8], [0, 8, 5], [1, 5, 8]]);
k.addFile('sliver', tri(slivP, slivT));
res = k.evaluate({ features: [{ id: 'i', type: 'import', file: 'sliver' }] }).result;
ok(!errs(res).length && !res.bodies[0].isMesh && near(res.volume, 1000, 0.01) && /zero-area/.test(res.features.i.note), `sliver and T-junction repaired into a solid (${res.features.i.note?.slice(0, 110)})`);
// Two blocks stacked in one shell with the face between them left in (an internal face).
const stackP = [...cubeP, [0, 0, 20], [10, 0, 20], [10, 10, 20], [0, 10, 20]];
const stackT = [[0, 2, 1], [0, 3, 2], [8, 9, 10], [8, 10, 11], [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  [4, 5, 9], [4, 9, 8], [5, 6, 10], [5, 10, 9], [6, 7, 11], [6, 11, 10], [7, 4, 8], [7, 8, 11]];
k.addFile('stack', tri(stackP, stackT));
res = k.evaluate({ features: [{ id: 'i', type: 'import', file: 'stack' }] }).result;
ok(!errs(res).length && near(res.max[2] - res.min[2], 20) && res.bodies[0].isReference, `two blocks with the face between them left in come in as a reference mesh, never as a wrong solid (${res.bodies[0]?.isReference ? 'reference' : res.bodies[0]?.isMesh ? 'mesh' : 'solid'}, vol ${res.volume.toFixed(0)}; ${errs(res)})`);
// Reference meshes (the open fixture cannot be closed).
res = k.evaluate({ features: [
  { id: 'i', type: 'import', file: 'open', at: [0, 0, 0] },
  { id: 'b', type: 'box', w: 60, d: 30, h: 2 },
  { id: 'm', type: 'mirror', plane: 'YZ', offset: 30 },
  { id: 'p', type: 'pattern', features: ['i'], kind: 'linear', dir: 'x', count: 2, spacing: 45 },
] }).result;
ok(!errs(res).length && res.bodies.length === 3 && res.bodies.filter((b) => b.isReference).length === 2, `boxes next to a reference mesh do not try to merge with it; mirror and pattern work (${res.bodies.length} bodies; ${errs(res)})`);
res = k.evaluate({ features: [{ id: 'i', type: 'import', file: 'open' }, { id: 'c', type: 'cylinder', d: 4, h: 30, op: 'cut', target: 'i' }] }).result;
ok(/reference mesh/.test(res.features.c.error || ''), `cutting a reference mesh explains why not (${res.features.c.error?.slice(0, 70)})`);
k.evaluate({ features: [{ id: 'i', type: 'import', file: 'open' }] });
ok(k.exportSTL(null, 'standard').triangles === 10, 'a reference mesh exports exactly as it came in');
ok(/reference mesh/.test(k.measure('i').a.kind), 'measure knows it is a reference mesh');

// Zips, as model sites deliver them.
const { readZip, stlEntry, isZip } = await import('../src/zip.js');
const zlib = await import('node:zlib');
const zipOf = (files) => {
  const parts = [];
  const central = [];
  let off = 0;
  for (const [name, data, deflate] of files) {
    const body = deflate ? zlib.deflateRawSync(data) : Buffer.from(data);
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(deflate ? 8 : 0, 8);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    parts.push(h, n, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(off, 42);
    central.push(c, n);
    off += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(files.length, 8);
  e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, e]));
};
const zip = zipOf([['files/a.stl', bracket, true], ['files/b.stl', tri(cubeP, cubeT), false], ['images/a.png', new Uint8Array(10), true], ['__MACOSX/files/._a.stl', new Uint8Array(5), false], ['README.txt', new TextEncoder().encode('hi'), true]]);
const entries = await readZip(zip, async (d) => new Uint8Array(zlib.inflateRawSync(d)), { accept: stlEntry });
ok(isZip(zip) && entries.map((e) => e.name).join() === 'a.stl,b.stl' && entries[0].bytes.length === bracket.length && entries[0].bytes.every((b, i) => b === bracket[i]), `zip: finds the STLs, skips images and metadata (${entries.map((e) => e.path)})`);
export { zipOf };
res = k.evaluate({ features: [{ id: 'i', type: 'import', file: 'missing', fileName: 'gone.stl' }] }).result;
ok(/gone\.stl/.test(res.features.i.error || ''), 'missing file explained');

// mesh transforms: rotate about a point, mirror at an offset, circular pattern
res = k.evaluate({ features: [
  { id: 'i', type: 'import', file: 'ball', at: [40, 0, 0] },
  { id: 'm', type: 'mirror', plane: 'YZ', offset: 10, features: ['i'] },
] }).result;
ok(!errs(res).length && res.bodies.length === 2 && near(res.bodies[1].min[0], -35, 0.02) && near(res.bodies[1].max[0], -5, 0.02), `mirror a mesh import across x = 10 (${res.bodies.map((b) => b.min[0].toFixed(1) + '..' + b.max[0].toFixed(1))}; ${errs(res)})`);
res = k.evaluate({ features: [
  { id: 'i', type: 'import', file: 'ball', at: [40, 0, 0] },
  { id: 'p', type: 'pattern', features: ['i'], kind: 'circular', axis: 'z', count: 4 },
  { id: 'r', type: 'move', rot: [0, 0, 90], about: [0, 0, 0] },
] }).result;
ok(!errs(res).length && res.bodies.length === 4 && near(res.max[0], 55, 0.02) && near(res.min[1], -55, 0.02), `circular pattern and rotate of mesh bodies (${res.bodies.length} bodies, ${res.min?.map((x) => x.toFixed(1))} .. ${res.max?.map((x) => x.toFixed(1))}; ${errs(res)})`);
ok(near(res.volume, 4 * (4 / 3) * Math.PI * 15 ** 3, 0.02), `mirrored/patterned meshes keep positive volume (${res.volume.toFixed(0)})`);

// STL round trip and STEP with a mesh body present
k.evaluate({ features: [{ id: 'i', type: 'import', file: 'ball' }, { id: 'b', type: 'box', w: 10, d: 10, h: 10, at: [40, 0, 0], op: 'new' }] });
const out = k.exportSTL(null, 'standard');
ok(out.triangles > 10000, `STL export includes mesh triangles (${out.triangles})`);
const step = await k.exportSTEP();
ok(step.skipped.length === 1 && step.buffer.byteLength > 1000, `STEP skips the mesh body (${step.skipped})`);

// queries and measure on a plain part
k.evaluate({ features: [{ id: 'b', type: 'box', w: 40, d: 20, h: 10 }, { id: 'c', type: 'cylinder', d: 6, h: 20, at: [10, 0, -5], op: 'cut' }] });
const tops = k.query({ on: 'top' }, 'face');
ok(tops.length === 1 && tops[0].ref === 'b:F' + tops[0].i, `query top face -> ${JSON.stringify(tops)}`);
const holes = k.listElements('edge', { kind: 'circle' });
ok(holes.total === 2 && holes.items.every((e) => near(e.diameter, 6)), `hole edges carry their diameter (${holes.items.map((e) => e.diameter)})`);
const faces = k.listElements('face');
const bore = faces.items.find((f) => f.type === 'cylinder');
ok(k.query({ kind: 'cylinder' }, 'face').length === 1, 'kind: cylinder selector matches the bore');
ok(bore && near(bore.radius, 3), `cylindrical face radius ${bore?.radius}`);
const bottom = k.query('bottom', 'face')[0].ref;
const m = k.measure(tops[0].ref, bottom);
ok(near(m.gap_between_planes, 10) && near(m.angle_deg, 0), `measure top to bottom: ${JSON.stringify(m).slice(0, 160)}`);
const body = k.measure('b');
ok(near(body.a.volume, volBracket, 0.01) && body.a.faces > 6, `body info: ${JSON.stringify(body.a)}`);
let threw = '';
try { k.measure('b:F999'); } catch (e) { threw = e.message; }
ok(/does not exist/.test(threw), 'bad refs explained');

console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
