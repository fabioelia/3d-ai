// Board checks: Eagle schematic and board import, placement geometry, airwires, auto-arrange, the
// board feature in the kernel (PCB, holes, part bodies), interference with an enclosure, exports.
import fs from 'node:fs';
import { loadKernel } from './kernel-node.mjs';
import { readEagle, parseRot, isEagle } from '../src/board/eagle.js';
import { checkBoard, airwires, autoPlace, partPolygon, footprintPolygon, padPositions, boardPolygon } from '../src/board/geometry.js';
import { eagleScript } from '../src/board/script.js';

let failed = 0;
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${m}`);
  if (!c) failed++;
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const fixture = (name) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const byRef = (b, ref) => b.parts.find((p) => p.ref === ref);

// ---------- rotation codes ----------
ok(JSON.stringify(parseRot('R90')) === '{"rot":90,"side":"top"}', 'R90 is a top part turned 90°');
ok(JSON.stringify(parseRot('MR180')) === '{"rot":180,"side":"bottom"}', 'MR180 is a bottom part turned 180°');
ok(JSON.stringify(parseRot('')) === '{"rot":0,"side":"top"}', 'no rotation is R0');

// ---------- schematic ----------
ok(isEagle(fixture('demo.sch')) && !isEagle(new TextEncoder().encode('solid x')), 'Eagle files are recognised by content');
const sch = readEagle(fixture('demo.sch'), 'demo.sch');
const S = sch.props;
ok(S.parts.length === 4, `schematic: 4 parts with footprints, supply symbols left out (${S.parts.map((p) => p.ref)})`);
ok(S.nets.length === 3, `schematic: 3 nets (${S.nets.map((n) => n.name)})`);
const sig = S.nets.find((n) => n.name === 'SIG');
ok(sig && sig.pads.length === 4 && sig.pads.some(([r, p]) => r === 'Q1' && p === '3'), 'net segments merge and pins map to pads through the device');
const u1 = byRef(S, 'U1');
ok(u1.h === 3 && near(u1.body.w, 20) && near(u1.body.d, 15), `module size and height come from the outline and "20x15x3" (${JSON.stringify(u1.body)} h ${u1.h})`);
const c1 = byRef(S, 'C1');
ok(c1.shape === 'cylinder' && near(c1.body.w, 5.2), `a round outline makes a cylinder (${c1.shape} ${c1.body.w})`);
const r1 = byRef(S, 'R1');
ok(near(r1.body.w, 5.08) && near(r1.body.d, 2.5), 'the documentation layer wins over the silkscreen for the body');
const q1 = byRef(S, 'Q1');
ok(Object.keys(q1.pads).length === 3 && q1.pads['3'][2] === 0.6, 'SMD pads are read with their size');
ok(S.parts.every((p) => !p.off) && checkBoard(S).length === 0, `parts are arranged on a board sized for them, with no clashes (${JSON.stringify(checkBoard(S))})`);
ok(/estimates/.test(sch.notes.join(' ')), 'estimated heights are called out');

// ---------- board ----------
const brd = readEagle(fixture('demo.brd'), 'demo.brd');
const B = brd.props;
ok(B.outline.kind === 'path' && B.outline.pts.length === 5 && B.outline.pts.some((p) => p[2]), `outline wires chain into a path with an arc (${JSON.stringify(B.outline.pts)})`);
const poly = boardPolygon(B);
const xs = poly.map((p) => p[0]);
const ys = poly.map((p) => p[1]);
ok(near(Math.min(...xs), 0) && near(Math.max(...xs), 50) && near(Math.max(...ys), 40), 'outline spans the board');
ok(B.holes.length === 2 && B.holes[0].d === 3.2, 'holes are read');
ok(byRef(B, 'C1').side === 'bottom' && byRef(B, 'R1').rot === 90 && byRef(B, 'U1').x === 8, 'positions, sides and rotations are read');
ok(B.nets.length === 3, 'one-pad signals are left out');
const pads = padPositions(B);
ok(near(pads['R1.2'][0], 40) && near(pads['R1.2'][1], 20.16), `pads turn with their part (${pads['R1.2']})`);
ok(near(pads['C1.2'][0], 32.5), `bottom parts are mirrored (${pads['C1.2']})`);
const aw = airwires(B);
ok(aw.length === 2 + 2 + 3, `airwires join every net as a tree (${aw.length})`);
ok(checkBoard(B).length === 0, `the board as drawn has no placement problems (${JSON.stringify(checkBoard(B))})`);

// ---------- checks ----------
const T = structuredClone(B);
byRef(T, 'Q1').x = 10;
byRef(T, 'Q1').y = 30; // under the sensor module
ok(checkBoard(T).some((i) => i.kind === 'overlap' && i.refs.includes('Q1') && i.refs.includes('U1')), 'overlapping parts are reported');
byRef(T, 'Q1').lift = 0;
byRef(T, 'U1').lift = 5; // a module up on headers clears the small part under it
ok(!checkBoard(T).some((i) => i.kind === 'overlap'), 'a lifted module clears a low part under it');
byRef(T, 'R1').x = 49;
ok(checkBoard(T).some((i) => i.kind === 'outside' && i.refs[0] === 'R1'), 'a part over the edge is reported');
byRef(T, 'R1').x = 4;
byRef(T, 'R1').y = 1;
ok(checkBoard(T).some((i) => i.kind === 'hole' && i.refs[0] === 'R1'), 'a part over a mounting hole is reported');
byRef(T, 'R1').off = true;
ok(checkBoard(T).some((i) => i.kind === 'unplaced' && i.refs[0] === 'R1'), 'parts beside the board are listed as not placed');
ok(footprintPolygon(byRef(B, 'R1')).length === 4 && partPolygon(byRef(B, 'R1')).length === 4, 'footprints and bodies are polygons');

// ---------- auto-arrange ----------
const A = structuredClone(S);
A.outline = { kind: 'circle', d: 34 };
A.holes = [{ x: 0, y: 12, d: 3 }];
const res = autoPlace(A, Number, { sides: ['top'] });
ok(res.placed >= 2 && checkBoard(A).every((i) => i.kind === 'unplaced'), `auto-arrange keeps parts apart, inside a round board and off its holes (${res.placed} placed, ${JSON.stringify(checkBoard(A).map((i) => i.message))})`);
const both = autoPlace(A, Number, { sides: ['top', 'bottom'] });
ok(both.placed === 4 && checkBoard(A).length === 0, `with both sides everything fits (${both.placed}, ${JSON.stringify(checkBoard(A))})`);

// ---------- script back to Eagle ----------
const scr = eagleScript(B, Number, { name: 'demo' });
ok(/MOVE U1 \(8 34\);/.test(scr) && /ROTATE =MR0 C1;/.test(scr) && /HOLE 3.2 \(4 4\);/.test(scr) && /^WIRE 0 /m.test(scr), 'the Eagle script moves, turns and flips parts and draws outline and holes');
ok(/CIRCLE 0 \(0 0\) \(17 0\);/.test(eagleScript(A)), 'a round board is drawn as a circle');

// ---------- kernel ----------
const k = await loadKernel();
const board = { id: 'pcb', type: 'board', name: 'Board', thickness: 1.6, at: [0, 0, 10], ...structuredClone(B) };
let out = k.evaluate({ features: [board] }).result;
ok(!out.features.pcb.error, `board builds ${out.features.pcb.error || ''}`);
ok(out.bodies.length === 5 && out.bodies[0].kind === 'board' && out.bodies.slice(1).every((b) => b.kind === 'part' && b.color), `one body for the board and one per part (${out.bodies.map((b) => b.id)})`);
const pcb = out.bodies[0];
const outlineArea = (() => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
})();
const holeArea = 2 * Math.PI * 1.6 * 1.6;
ok(near(pcb.volume, (outlineArea - holeArea) * 1.6, 2), `board volume is outline × thickness minus holes (${pcb.volume.toFixed(1)} vs ${((outlineArea - holeArea) * 1.6).toFixed(1)})`);
ok(near(pcb.min[2], 10) && near(pcb.max[2], 11.6), 'the board sits where "at" puts it');
const U1 = out.bodies.find((b) => b.ref === 'U1');
ok(near(U1.min[2], 11.6) && near(U1.max[2], 14.6), `top parts stand on the top face (${U1.min[2]}..${U1.max[2]})`);
const C1 = out.bodies.find((b) => b.ref === 'C1');
ok(near(C1.max[2], 10) && C1.min[2] < 10, `bottom parts hang under the board (${C1.min[2]}..${C1.max[2]})`);
const R1 = out.bodies.find((b) => b.ref === 'R1');
ok(near(R1.max[0] - R1.min[0], 2.5) && near(R1.max[1] - R1.min[1], 5.08), 'turned parts are turned in 3D');

// An enclosure that a part runs into.
const lid = { id: 'lid', type: 'box', w: 60, d: 50, h: 2, at: [25, 20, 13.5], op: 'new' };
out = k.evaluate({ features: [board, lid] }).result;
ok(out.bodies.length === 6, 'later solids do not merge into the board or its parts');
let hits = k.interference({ clearance: 0.5 });
ok(hits.issues.some((i) => i.part === 'U1' && i.kind === 'collides' && i.volume > 0), `interference finds the module running into the lid (${JSON.stringify(hits.issues)})`);
lid.at = [25, 20, 14.8];
k.evaluate({ features: [board, lid] });
hits = k.interference({ clearance: 0.5 });
ok(hits.issues.some((i) => i.part === 'U1' && i.kind === 'close' && near(i.distance, 0.2, 0.01)), `and parts that come closer than the clearance (${JSON.stringify(hits.issues)})`);

// STL export leaves the electronics out; STEP keeps them.
const stl = k.exportSTL(null, 'draft');
ok(stl.triangles === 12, `STL export takes only the printable bodies (${stl.triangles} triangles)`);
const step = await k.exportSTEP(null);
ok(new TextDecoder().decode(step.buffer).includes('U1'), 'STEP export includes the board and parts');
k.evaluate({ features: [board] });
let threw = '';
try {
  k.exportSTL(null);
} catch (e) {
  threw = e.message;
}
ok(/not printed/.test(threw), 'exporting STL with only a board explains why');
ok(k.exportSTL(['pcb'], 'draft').triangles > 0, 'naming the board exports it');

// Round board from a parameter.
out = k.evaluate({ params: [{ name: 'dia', value: '58' }], features: [{ id: 'b2', type: 'board', outline: { kind: 'circle', d: 'dia' }, parts: [], nets: [] }] }).result;
ok(near(out.bodies[0].max[0] - out.bodies[0].min[0], 58, 0.05), 'board sizes can use parameters');

console.log(failed ? `\n${failed} board check(s) failed` : '\nAll board checks passed');
process.exit(failed ? 1 : 0);
