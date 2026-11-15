// PCB checks: KiCad board / schematic / netlist import, footprints from names, connectivity and
// airwires through copper, design-rule checks, the autorouter, Gerber and drill export, part models.
import fs from 'node:fs';
import { loadKernel } from './kernel-node.mjs';
import { readKicad, isKicad } from '../src/board/kicad.js';
import { readEagle } from '../src/board/eagle.js';
import { footprintFromName, partFamily } from '../src/board/footprints.js';
import { padPositions, boardPolygon } from '../src/board/geometry.js';
import { airwires, connectivity, drc, autorouteBest, numericBoard } from '../src/board/route.js';
import { fabFiles } from '../src/board/gerber.js';
import { parseSexpr } from '../src/board/sexpr.js';

let failed = 0;
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${m}`);
  if (!c) failed++;
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const fixture = (name) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const byRef = (b, ref) => b.parts.find((p) => p.ref === ref);
const netPads = (b, name) => (b.nets.find((n) => n.name === name)?.pads || []).map((p) => p.join('.')).sort().join(' ');

// ---------- S-expressions ----------
const sx = parseSexpr('(a "b c" (d 1.5 -2) (e "q\\"x"))');
ok(sx[0] === 'a' && sx[1] === 'b c' && sx[2][2] === '-2' && sx[3][1] === 'q"x', 'S-expressions: strings, numbers, escapes, nesting');

// ---------- footprints from KiCad names ----------
const r = footprintFromName('Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal');
ok(r && r.pads['2'][0] === 10.16 && r.body.w === 6.3 && r.family === 'axial', 'axial resistor: pitch, body and family from the name');
const hdr = footprintFromName('Connector_PinHeader_2.54mm:PinHeader_2x05_P2.54mm_Vertical');
ok(hdr && Object.keys(hdr.pads).length === 10 && near(hdr.pads['2'][0], 2.54) && near(hdr.pads['3'][1], -2.54), '2x5 header: ten pads, odd/even columns, rows going down');
ok(footprintFromName('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm')?.pads['8'] && footprintFromName('Package_DFN_QFN:QFN-32_5x5mm_P0.5mm')?.pads['32'], 'SOIC-8 and QFN-32 get all their pads');
ok(footprintFromName('Capacitor_SMD:C_0805_2012Metric')?.pads['1'].length === 5, 'chip capacitor pads are surface mount');
ok(footprintFromName('MountingHole:MountingHole_3.2mm_M3')?.hole === 3.2, 'mounting holes are recognised');
ok(footprintFromName('MyLib:Something_Odd') === null, 'unknown names say so');
ok(partFamily({ package: 'MOD_U1', body: { w: 17, d: 29 }, pads: {} }) === 'module' && partFamily({ package: 'HDR_1X4', body: { w: 10, d: 2.5 }, pads: {} }) === 'header', 'families for 3D models');

// ---------- KiCad board ----------
ok(isKicad(fixture('demo.kicad_pcb')) && isKicad(fixture('demo.kicad_sch')) && isKicad(fixture('demo.net')), 'KiCad files are recognised by content');
const pcb = readKicad(fixture('demo.kicad_pcb'), 'demo.kicad_pcb');
const P = pcb.props;
ok(P.parts.length === 3 && P.holes.length === 1 && near(P.holes[0].x, 92) && near(P.holes[0].y, -93), `footprints become parts; a mounting-hole footprint becomes a hole (${P.parts.map((p) => p.ref)})`);
ok(byRef(P, 'C1').side === 'bottom' && byRef(P, 'C1').rot === 90 && byRef(P, 'R1').x === 105 && byRef(P, 'R1').y === -100, 'positions (Y flipped), sides and rotations');
ok(near(byRef(P, 'R1').body.w, 6.3) && near(byRef(P, 'R1').body.d, 2.5), 'the body comes from the fabrication outline, without the leads');
const pp = padPositions(P);
ok(near(pp['C1.1'][0], 120) && near(pp['C1.1'][1], -105.95) && near(pp['C1.2'][1], -104.05), `bottom pads land where KiCad puts them (${pp['C1.1']}, ${pp['C1.2']})`);
ok(netPads(P, 'SIG') === 'C1.1 R1.2' && netPads(P, 'GND') === 'C1.2 J1.2', 'nets from the pads');
ok(P.traces.length === 4 && P.vias.length === 1 && P.traces.every((t) => t.net) && /inner layers/.test(pcb.notes.join(' ')), 'tracks and vias on the two outer layers; inner layers noted');
ok(P.outline.kind === 'path' && P.outline.pts.some((p) => p[2]) && near(Math.min(...boardPolygon(P).map((p) => p[1])), -110), 'Edge.Cuts lines and arc chain into the outline');
let conn = connectivity(P);
const sigGroup = conn.items.find((i) => i.id === 'R1.2').group;
ok(conn.items.find((i) => i.id === 'C1.1').group === sigGroup, 'connectivity follows a trace, a via and a bottom trace from R1 to C1');
let res = drc(P);
ok(res.unrouted === 1 && res.airwires[0].net === 'GND' && res.issues.length === 0, `only GND is left to route, and the copper passes the rules (${JSON.stringify(res.issues)})`);

// ---------- KiCad schematic and netlist ----------
const sch = readKicad(fixture('demo.kicad_sch'), 'demo.kicad_sch').props;
ok(sch.parts.length === 3 && !sch.parts.some((p) => p.ref.startsWith('#')), `schematic symbols with footprints become parts; power symbols do not (${sch.parts.map((p) => p.ref)})`);
ok(netPads(sch, 'VCC') === 'J1.1 R1.1' && netPads(sch, 'SIG') === 'C1.1 R1.2' && netPads(sch, 'GND') === 'C1.2 J1.2', `nets traced through wires, labels and power symbols (${JSON.stringify(sch.nets)})`);
ok(sch.nets.length === 3, 'a wire crossing others without touching their ends joins nothing');
ok(byRef(sch, 'R1').family === 'axial' && Object.keys(byRef(sch, 'J1').pads).length === 2, 'footprints from the footprint names');
const net = readKicad(fixture('demo.net'), 'demo.net');
ok(net.props.parts.length === 4 && netPads(net.props, 'SIG') === 'C1.1 R1.2 U1.1' && /U1/.test(net.notes.join(' ')), 'netlists: parts and nets; an unknown footprint is a plain block, and noted');

// ---------- design rules ----------
const T = numericBoard(readEagle(fixture('demo.brd'), 'demo.brd').props);
T.traces = [{ net: 'VCC', layer: 'top', w: 0.25, pts: [padPositions(T)['U1.1'], padPositions(T)['R1.1']] }];
conn = connectivity(T);
ok(conn.items.find((i) => i.id === 'U1.1').group === conn.items.find((i) => i.id === 'R1.1').group, 'a hand trace joins two pads');
ok(drc(T).issues.length === 0 && drc(T).unrouted === airwires(numericBoard(readEagle(fixture('demo.brd'), 'demo.brd').props)).length - 1, 'and that connection is no longer an airwire');
T.traces.push({ net: 'VCC', layer: 'top', w: 0.25, pts: [padPositions(T)['U1.1'], padPositions(T)['U1.2']] });
res = drc(T);
ok(res.issues.some((i) => i.kind === 'short' && i.nets.includes('GND') && i.nets.includes('VCC')), `a trace joining VCC to a GND pad is a short (${res.issues.map((i) => i.message)})`);
T.traces = [{ net: 'SIG', layer: 'top', w: 0.25, pts: [[padPositions(T)['U1.2'][0] + 1.2, padPositions(T)['U1.2'][1] - 3], [padPositions(T)['U1.2'][0] + 1.2, padPositions(T)['U1.2'][1] + 3]] }];
res = drc(T);
ok(res.issues.some((i) => i.kind === 'clearance'), `a trace passing too close to a pad of another net breaks the clearance rule (${res.issues.map((i) => i.message)})`);
T.traces = [{ net: 'SIG', layer: 'top', w: 0.1, pts: [[60, 10], [70, 10]] }];
res = drc(T);
ok(res.issues.some((i) => i.kind === 'edge') && res.issues.some((i) => i.kind === 'width'), 'copper off the board and too thin a trace are caught');

// ---------- autorouter ----------
const A = numericBoard(readEagle(fixture('demo.brd'), 'demo.brd').props);
let t0 = performance.now();
let routed = autorouteBest(A);
A.traces = routed.traces;
A.vias = routed.vias;
res = drc(A);
ok(routed.routed === routed.total && routed.total === 7 && res.unrouted === 0 && res.issues.length === 0, `the autorouter routes every connection within the rules (${routed.routed}/${routed.total}, ${routed.vias.length} vias, ${Math.round(performance.now() - t0)} ms, ${res.issues.length} errors)`);
ok(A.traces.every((t) => t.pts.every((p, i) => i < 2 || i === t.pts.length - 1 || (() => {
  const dx = Math.abs(p[0] - t.pts[i - 1][0]);
  const dy = Math.abs(p[1] - t.pts[i - 1][1]);
  return dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 0.6;
})())), 'traces run at 0, 45 and 90 degrees (apart from the last bit into a pad)');
const K = numericBoard(P);
routed = autorouteBest(K);
K.traces = [...K.traces, ...routed.traces];
K.vias = [...K.vias, ...routed.vias];
res = drc(K);
ok(routed.routed === 1 && res.unrouted === 0 && res.issues.length === 0, `existing copper is kept and the rest routed around it (${JSON.stringify(res.issues.map((i) => i.message))})`);

// ---------- fabrication files ----------
const files = fabFiles(A, 'demo');
const names = files.map((f) => f.name);
ok(['demo-F_Cu.gtl', 'demo-B_Cu.gbl', 'demo-F_Mask.gts', 'demo-B_Mask.gbs', 'demo-Edge_Cuts.gm1', 'demo-PTH.drl', 'demo-NPTH.drl'].every((n) => names.includes(n)), `Gerber and drill files (${names.join(', ')})`);
const top = files.find((f) => f.name.endsWith('F_Cu.gtl')).data;
ok(/%FSLAX46Y46\*%/.test(top) && /%MOMM\*%/.test(top) && /D03\*/.test(top) && /D01\*/.test(top) && /G36\*/.test(top) && top.trim().endsWith('M02*'), 'copper: format, flashed pads, traces, SMD pads as regions, end of file');
const pth = files.find((f) => f.name.endsWith('PTH.drl')).data;
const holes = (pth.match(/^X/gm) || []).length;
const expected = A.parts.reduce((s, p) => s + Object.values(p.pads).filter((q) => q.length < 5).length, 0) + A.vias.length;
ok(/^M48/.test(pth) && /METRIC/.test(pth) && holes === expected, `plated drill file: a hit per through-hole pad and via (${holes} of ${expected})`);
ok(/X4\.000Y4\.000/.test(files.find((f) => f.name.endsWith('NPTH.drl')).data), 'unplated drill file: the mounting holes');

// ---------- 3D models ----------
const k = await loadKernel();
const brd = { id: 'pcb', type: 'board', ...readEagle(fixture('demo.brd'), 'demo.brd').props, traces: A.traces, vias: A.vias };
t0 = performance.now();
let out = k.evaluate({ features: [brd] }).result;
ok(!out.features.pcb.error, `routed board builds (${Math.round(performance.now() - t0)} ms) ${out.features.pcb.error || ''}`);
const ids = out.bodies.map((b) => b.id);
ok(ids.includes('pcb.R1.pins') && ids.includes('pcb.U1.pins') && ids.includes('pcb.copper'), `parts get leads and pins, the board its copper (${ids.join(', ')})`);
const cu = out.bodies.find((b) => b.id === 'pcb.copper');
ok(cu.min[2] < 0 && cu.max[2] > 1.6, 'copper on both faces of the board');
const pins = out.bodies.find((b) => b.id === 'pcb.R1.pins');
ok(pins.min[2] < -1, `through-hole leads come out under the board (${pins.min[2]})`);
// A STEP file as a part's model.
k.evaluate({ features: [{ id: 'm', type: 'box', w: 10, d: 4, h: 7 }] });
const step = new Uint8Array((await k.exportSTEP(null)).buffer);
k.addFile('step1', step);
brd.parts.find((p) => p.ref === 'U1').model = { file: 'step1', fileName: 'u1.step' };
out = k.evaluate({ features: [brd] }).result;
const U1 = out.bodies.find((b) => b.id === 'pcb.U1');
ok(near(U1.max[0] - U1.min[0], 10) && near(U1.max[2] - U1.min[2], 7) && !ids.includes('x') && !out.bodies.some((b) => b.id === 'pcb.U1.pins'), `a STEP model replaces the drawn one, centred on the body (${U1.min}..${U1.max})`);
brd.parts.find((p) => p.ref === 'U1').model = 'box';
out = k.evaluate({ features: [brd] }).result;
ok(out.bodies.find((b) => b.id === 'pcb.U1') && !out.bodies.some((b) => b.id === 'pcb.U1.dark'), 'or a plain block');

console.log(failed ? `\n${failed} PCB check(s) failed` : '\nAll PCB checks passed');
process.exit(failed ? 1 : 0);
