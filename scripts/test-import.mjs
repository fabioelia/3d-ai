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
ok(/watertight/.test(res.features.i.error || ''), `open mesh explained (${res.features.i.error})`);
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
