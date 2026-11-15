// KiCad files to a Caliper board.
//   .kicad_pcb  a board: footprints with their pads, body outlines and nets, where each one sits,
//               tracks and vias, the Edge.Cuts outline and mounting holes.
//   .kicad_sch  a schematic: symbols with their footprint names, and the nets traced through wires,
//               junctions, labels and power symbols. Footprints come from their names (footprints.js).
//   .net        a KiCad netlist: components with footprint names, and the nets.
// KiCad's Y axis points down; Caliper's points up, so every Y is negated on the way in.
import { parseSexpr, all, one, nums, str, prop, isList } from './sexpr.js';
import { footprintFromName, fallbackFootprint, partFamily } from './footprints.js';
import { guessPart, partColor, chainOutline, boundingOutline } from './geometry.js';
import { layoutNewBoard } from './placement.js';

const r3 = (v) => Math.round(v * 1000) / 1000;
const head = (bytes) => new TextDecoder().decode(bytes.subarray(0, 400)).trimStart();
export const isKicad = (bytes) => /^\((kicad_pcb|kicad_sch|export)\b/.test(head(bytes));

export function readKicad(bytes, fileName = 'board') {
  const src = new TextDecoder().decode(bytes);
  let root;
  try {
    root = parseSexpr(src);
  } catch (e) {
    throw new Error(`${fileName} is not a readable KiCad file (${e.message}).`);
  }
  const kind = root?.[0];
  if (kind === 'kicad_pcb') return readPcb(root, fileName);
  if (kind === 'kicad_sch') return readSch(root, fileName);
  if (kind === 'export') return readNetlist(root, fileName);
  throw new Error(`${fileName} is not a KiCad board, schematic or netlist.`);
}

// ---------- shared ----------
const LAYER = { 'F.Cu': 'top', 'B.Cu': 'bottom' };

// Signed sweep (radians, counter-clockwise positive) of the arc through a, m, b; bulge = tan(sweep/4).
function arcBulge(a, m, b) {
  const ax = a[0];
  const ay = a[1];
  const d = 2 * (ax * (m[1] - b[1]) + m[0] * (b[1] - ay) + b[0] * (ay - m[1]));
  if (Math.abs(d) < 1e-12) return 0;
  const ux = ((ax * ax + ay * ay) * (m[1] - b[1]) + (m[0] ** 2 + m[1] ** 2) * (b[1] - ay) + (b[0] ** 2 + b[1] ** 2) * (ay - m[1])) / d;
  const uy = ((ax * ax + ay * ay) * (b[0] - m[0]) + (m[0] ** 2 + m[1] ** 2) * (ax - b[0]) + (b[0] ** 2 + b[1] ** 2) * (m[0] - ax)) / d;
  const ang = (p) => Math.atan2(p[1] - uy, p[0] - ux);
  const norm = (t) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ccwToB = norm(ang(b) - ang(a));
  const ccwToM = norm(ang(m) - ang(a));
  const sweep = ccwToM < ccwToB ? ccwToB : -(2 * Math.PI - ccwToB);
  return Math.tan(sweep / 4);
}

function arcPoints(a, m, b, segs = 8) {
  const bulge = arcBulge(a, m, b);
  if (!bulge) return [a, b];
  const theta = 4 * Math.atan(bulge);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const chord = Math.hypot(dx, dy);
  const radius = chord / (2 * Math.sin(theta / 2));
  const h = radius * Math.cos(theta / 2);
  const cx = (a[0] + b[0]) / 2 - (dy / chord) * h;
  const cy = (a[1] + b[1]) / 2 + (dx / chord) * h;
  const a0 = Math.atan2(a[1] - cy, a[0] - cx);
  const out = [a];
  for (let i = 1; i < segs; i++) out.push([r3(cx + Math.abs(radius) * Math.cos(a0 + (theta * i) / segs)), r3(cy + Math.abs(radius) * Math.sin(a0 + (theta * i) / segs))]);
  out.push(b);
  return out;
}

function finishPart(part, name) {
  const fromName = footprintFromName(name, Object.keys(part.pads || {}).length);
  if (fromName && !fromName.hole) {
    part.family ||= fromName.family;
    if (part.h === undefined) part.h = fromName.h;
    if (part.shape === undefined) part.shape = fromName.shape;
  }
  if (part.h === undefined) {
    const g = guessPart(name, part.value);
    part.h = g.h;
    part.hGuess = true;
  } else if (!fromName) part.hGuess = true;
  part.shape ||= 'box';
  part.family = partFamily(part);
  part.color = partColor(part);
  return part;
}

function finish(out, notes, placed) {
  if (!placed) notes.push(layoutNewBoard(out));
  else if (!out.outline) {
    out.outline = boundingOutline(out.parts.filter((p) => !p.off));
    notes.push('The board has no Edge.Cuts outline, so Caliper drew one around the parts.');
  }
  const guessed = out.parts.filter((p) => p.hGuess).map((p) => p.ref);
  if (guessed.length) notes.push(`Heights for ${guessed.length > 12 ? `${guessed.slice(0, 12).join(', ')} and ${guessed.length - 12} more` : guessed.join(', ')} are estimates; set the real ones in the placement editor.`);
  for (const p of out.parts) delete p.hGuess;
  return { props: out, notes };
}

// ---------- .kicad_pcb ----------
function readPcb(root, fileName) {
  const notes = [];
  const out = { source: fileName, thickness: 1.6, holes: [], parts: [], nets: [], traces: [], vias: [] };
  const th = nums(one(root, 'general'), 'thickness');
  if (th) out.thickness = th[0];
  const netName = new Map(all(root, 'net').map((n) => [n[1], n[2]]));
  const netOf = (node) => {
    const n = one(node, 'net');
    if (!n) return null;
    const name = n.length > 2 ? n[2] : netName.get(n[1]) ?? n[1];
    return name || null;
  };
  const netPads = new Map();
  const addPad = (net, ref, pad) => {
    if (!net) return;
    if (!netPads.has(net)) netPads.set(net, []);
    netPads.get(net).push([ref, pad]);
  };
  const refs = new Set();
  const footprints = [...all(root, 'footprint'), ...all(root, 'module')];
  for (const fp of footprints) {
    const name = fp[1];
    const at = nums(fp, 'at') || [0, 0, 0];
    const fpAng = at[2] || 0;
    const bottom = str(fp, 'layer') === 'B.Cu';
    // KiCad local (y down, already flipped for bottom parts) -> Caliper package coordinates.
    const loc = (x, y) => [r3(bottom ? -x : x), r3(-y)];
    const toBoardXY = (x, y) => {
      const c = Math.cos((fpAng * Math.PI) / 180);
      const s = Math.sin((fpAng * Math.PI) / 180);
      const lx = x;
      const ly = -y;
      return [r3(at[0] + lx * c - ly * s), r3(-at[1] + lx * s + ly * c)];
    };
    let ref = prop(fp, 'Reference') || '?';
    const value = prop(fp, 'Value') || '';
    const pads = {};
    let real = 0;
    for (const pad of all(fp, 'pad')) {
      const type = pad[2];
      const p = nums(pad, 'at') || [0, 0, 0];
      const size = nums(pad, 'size') || [1, 1];
      const drillNode = one(pad, 'drill');
      const drill = drillNode ? drillNode.slice(1).filter((v) => !isList(v) && v !== 'oval').map(Number)[0] || 0 : 0;
      if (type === 'np_thru_hole' || (!pad[1] && drill)) {
        const [hx, hy] = toBoardXY(p[0], p[1]);
        out.holes.push({ x: hx, y: hy, d: r3(drill || size[0]) });
        continue;
      }
      real++;
      const local = (((p[2] || 0) - fpAng) % 180 + 180) % 180;
      const [w, h] = Math.abs(local - 90) < 1 ? [size[1], size[0]] : size;
      const [x, y] = loc(p[0], p[1]);
      const key = pad[1] || String(real);
      if (type === 'smd' || type === 'connect') pads[key] = [x, y, r3(Math.min(w, h)), r3(w), r3(h)];
      else pads[key] = [x, y, r3(Math.max(w, h)), r3(drill || Math.min(w, h) * 0.6)];
      addPad(netOf(pad), ref, key);
    }
    if (!real) continue; // a mounting hole or a logo: holes only
    while (refs.has(ref)) ref = `${ref}_`;
    refs.add(ref);
    // Body: the fabrication outline, else the silkscreen, else the courtyard.
    let body = null;
    let round = false;
    for (const layers of [['F.Fab', 'B.Fab'], ['F.SilkS', 'B.SilkS', 'F.Silkscreen', 'B.Silkscreen'], ['F.CrtYd', 'B.CrtYd', 'F.Courtyard', 'B.Courtyard']]) {
      const pts = [];
      let circles = 0;
      let others = 0;
      const items = fp.filter((g) => isList(g) && /^fp_/.test(g[0]) && g[0] !== 'fp_text' && layers.includes(str(g, 'layer')));
      // Closed shapes describe the body best; lines that run from a pad are leads, not body.
      const closed = items.filter((g) => ['fp_rect', 'fp_circle', 'fp_poly'].includes(g[0]));
      const padAt = all(fp, 'pad').map((pd) => nums(pd, 'at') || [0, 0]);
      const isLead = (g) => g[0] === 'fp_line' && ['start', 'end'].some((k) => {
        const v = nums(g, k);
        return padAt.some((q) => Math.hypot(q[0] - v[0], q[1] - v[1]) < 0.01);
      });
      for (const g of closed.length ? closed : items.filter((x) => !isLead(x))) {
        if (g[0] === 'fp_circle') {
          const c = nums(g, 'center');
          const e = nums(g, 'end');
          const r = Math.hypot(e[0] - c[0], e[1] - c[1]);
          pts.push([c[0] - r, c[1] - r], [c[0] + r, c[1] + r]);
          circles++;
        } else if (g[0] === 'fp_poly') for (const xy of all(one(g, 'pts'), 'xy')) pts.push([+xy[1], +xy[2]]);
        else {
          for (const k of ['start', 'end', 'mid']) {
            const v = nums(g, k);
            if (v) pts.push(v);
          }
          others++;
        }
      }
      if (pts.length) {
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        const c = loc((x0 + x1) / 2, (y0 + y1) / 2);
        body = { cx: c[0], cy: c[1], w: r3(x1 - x0), d: r3(y1 - y0) };
        round = circles > 0 && others <= 2;
        if (body.w > 0.3 && body.d > 0.3) break;
      }
    }
    if (!body || body.w <= 0.3 || body.d <= 0.3) {
      const fb = footprintFromName(name) || fallbackFootprint(Object.keys(pads));
      body = fb.body || { cx: 0, cy: 0, w: 2, d: 2 };
    }
    const part = { ref, value, package: name.split(':').pop(), x: r3(at[0]), y: r3(-at[1]), rot: r3(((fpAng % 360) + 360) % 360), side: bottom ? 'bottom' : 'top', body, pads, ...(round ? { shape: 'cylinder' } : {}) };
    out.parts.push(finishPart(part, name));
  }
  out.nets = [...netPads.entries()].filter(([, pads]) => pads.length > 1).map(([name, pads]) => ({ name, pads }));
  // Copper.
  let inner = 0;
  for (const seg of all(root, 'segment')) {
    const layer = LAYER[str(seg, 'layer')];
    if (!layer) {
      inner++;
      continue;
    }
    const a = nums(seg, 'start');
    const b = nums(seg, 'end');
    out.traces.push({ net: netOf(seg), layer, w: nums(seg, 'width')?.[0] || 0.25, pts: [[r3(a[0]), r3(-a[1])], [r3(b[0]), r3(-b[1])]] });
  }
  for (const arc of all(root, 'arc')) {
    const layer = LAYER[str(arc, 'layer')];
    if (!layer) {
      inner++;
      continue;
    }
    const [a, m, b] = ['start', 'mid', 'end'].map((k) => nums(arc, k)).map((v) => [v[0], -v[1]]);
    out.traces.push({ net: netOf(arc), layer, w: nums(arc, 'width')?.[0] || 0.25, pts: arcPoints(a, m, b).map((q) => [r3(q[0]), r3(q[1])]) });
  }
  for (const via of all(root, 'via')) {
    const a = nums(via, 'at');
    out.vias.push({ x: r3(a[0]), y: r3(-a[1]), d: nums(via, 'size')?.[0] || 0.6, drill: nums(via, 'drill')?.[0] || 0.3, net: netOf(via) });
  }
  if (inner) notes.push(`${inner} track segments on inner layers were left out: Caliper routes two-layer boards.`);
  if (all(root, 'zone').length) notes.push('Copper zones (pours) were left out.');
  // Outline from Edge.Cuts.
  const edge = (g) => str(g, 'layer') === 'Edge.Cuts';
  const circle = all(root, 'gr_circle').find(edge);
  const rect = all(root, 'gr_rect').find(edge);
  if (circle) {
    const c = nums(circle, 'center');
    const e = nums(circle, 'end');
    out.outline = { kind: 'circle', d: r3(2 * Math.hypot(e[0] - c[0], e[1] - c[1])), x: r3(c[0]), y: r3(-c[1]) };
  } else if (rect) {
    const s = nums(rect, 'start');
    const e = nums(rect, 'end');
    out.outline = { kind: 'rect', w: r3(Math.abs(e[0] - s[0])), h: r3(Math.abs(e[1] - s[1])), x: r3((s[0] + e[0]) / 2), y: r3(-(s[1] + e[1]) / 2) };
  } else {
    const segs = [];
    for (const g of all(root, 'gr_line').filter(edge)) {
      const a = nums(g, 'start');
      const b = nums(g, 'end');
      segs.push({ a: [a[0], -a[1]], b: [b[0], -b[1]], bulge: 0 });
    }
    for (const g of all(root, 'gr_arc').filter(edge)) {
      const mid = nums(g, 'mid');
      if (mid) {
        const [a, m, b] = ['start', 'mid', 'end'].map((k) => nums(g, k)).map((v) => [v[0], -v[1]]);
        segs.push({ a, b, bulge: arcBulge(a, m, b) });
      } else {
        // KiCad 5: start is the centre, end the first point, angle the sweep (clockwise on screen).
        const c = nums(g, 'start');
        const e = nums(g, 'end');
        const ang = (nums(g, 'angle')?.[0] || 90) * (Math.PI / 180);
        const a = [e[0], -e[1]];
        const cc = [c[0], -c[1]];
        const t = Math.atan2(a[1] - cc[1], a[0] - cc[0]) - ang;
        const r = Math.hypot(a[0] - cc[0], a[1] - cc[1]);
        segs.push({ a, b: [cc[0] + r * Math.cos(t), cc[1] + r * Math.sin(t)], bulge: Math.tan(-ang / 4) });
      }
    }
    for (const g of all(root, 'gr_poly').filter(edge)) {
      const pts = all(one(g, 'pts'), 'xy').map((xy) => [+xy[1], -xy[2]]);
      for (let i = 0; i < pts.length; i++) segs.push({ a: pts[i], b: pts[(i + 1) % pts.length], bulge: 0 });
    }
    const ol = chainOutline(segs);
    if (ol) out.outline = ol;
  }
  if (!out.parts.length) throw new Error(`${fileName} has no footprints.`);
  if (out.traces.length || out.vias.length) notes.push(`Read ${out.traces.length} track segments and ${out.vias.length} vias.`);
  return finish(out, notes, true);
}

// ---------- .kicad_sch ----------
function readSch(root, fileName) {
  const notes = [];
  // Library symbols: pins per unit (unit 0 is shared by all units), and whether it is a power symbol.
  const lib = new Map();
  for (const sym of all(one(root, 'lib_symbols'), 'symbol')) {
    const entry = { power: !!one(sym, 'power'), units: new Map() };
    const collect = (node, unit) => {
      for (const pin of all(node, 'pin')) {
        const at = nums(pin, 'at') || [0, 0];
        const number = str(pin, 'number') ?? '';
        if (!entry.units.has(unit)) entry.units.set(unit, []);
        entry.units.get(unit).push({ number, x: at[0], y: at[1] });
      }
    };
    collect(sym, 0);
    for (const sub of all(sym, 'symbol')) {
      const m = /_(\d+)_(\d+)$/.exec(sub[1]);
      collect(sub, m ? +m[1] : 0);
    }
    lib.set(sym[1], entry);
  }
  // Points that can connect, and wires.
  const key = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  const wires = all(root, 'wire').map((w) => all(one(w, 'pts'), 'xy').map((xy) => [+xy[1], +xy[2]]));
  const points = new Map(); // key -> { x, y, names: Set, pins: [] }
  const point = (x, y) => {
    const k = key(x, y);
    if (!points.has(k)) points.set(k, { k, x, y, names: new Set(), pins: [] });
    return points.get(k);
  };
  for (const w of wires) for (const p of w) point(p[0], p[1]);
  for (const j of all(root, 'junction')) point(...nums(j, 'at'));
  for (const kind of ['label', 'global_label', 'hierarchical_label']) for (const l of all(root, kind)) point(...nums(l, 'at')).names.add(l[1]);
  if (all(root, 'sheet').length) notes.push('Hierarchical sub-sheets are not read; only this sheet\'s parts and nets came in.');
  // Symbols. Pin positions need the symbol's rotation and mirroring; as KiCad's order of the two is
  // easy to get wrong, each symbol takes whichever reading puts the most pins on wires and labels.
  const anchors = new Set(points.keys());
  const onWire = (x, y) => wires.some((w) => {
    for (let i = 0; i + 1 < w.length; i++) {
      const [a, b] = [w[i], w[i + 1]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
      const cross = Math.abs((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / len;
      const t = ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / (len * len);
      if (cross < 0.01 && t > -1e-6 && t < 1 + 1e-6) return true;
    }
    return false;
  });
  const parts = new Map();
  const placedPins = [];
  for (const sym of all(root, 'symbol')) {
    const libId = str(sym, 'lib_id');
    if (!libId) continue;
    const def = lib.get(libId);
    if (!def) continue;
    const at = nums(sym, 'at') || [0, 0, 0];
    const mirror = str(sym, 'mirror');
    const unit = nums(sym, 'unit')?.[0] || 1;
    const pins = [...(def.units.get(0) || []), ...(def.units.get(unit) || [])];
    const ref = prop(sym, 'Reference') || '?';
    const value = prop(sym, 'Value') || '';
    const t = ((at[2] || 0) * Math.PI) / 180;
    const variants = [0, 1].map((order) =>
      pins.map((pin) => {
        let x = pin.x;
        let y = -pin.y;
        const rot = () => {
          const c = Math.cos(t);
          const s = Math.sin(t);
          [x, y] = [x * c + y * s, -x * s + y * c];
        };
        const mir = () => {
          if (mirror === 'x') y = -y;
          if (mirror === 'y') x = -x;
        };
        if (order === 0) {
          rot();
          mir();
        } else {
          mir();
          rot();
        }
        return { number: pin.number, x: at[0] + x, y: at[1] + y };
      }),
    );
    const score = (v) => v.filter((p) => anchors.has(key(p.x, p.y)) || onWire(p.x, p.y)).length;
    const best = score(variants[1]) > score(variants[0]) ? variants[1] : variants[0];
    if (def.power || ref.startsWith('#')) {
      for (const p of best) if (def.power || ref.startsWith('#PWR')) point(p.x, p.y).names.add(value);
      continue;
    }
    const fpName = prop(sym, 'Footprint') || '';
    if (!parts.has(ref)) parts.set(ref, { ref, value, fpName, pins: new Set() });
    for (const p of best) {
      parts.get(ref).pins.add(p.number);
      placedPins.push({ ref, number: p.number, pt: point(p.x, p.y) });
    }
  }
  // Connectivity: wires join their points and any point lying along them; same names join.
  const parent = new Map();
  const find = (k) => {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)));
      k = parent.get(k);
    }
    return k;
  };
  const join = (a, b) => parent.set(find(a), find(b));
  for (const k of points.keys()) parent.set(k, k);
  for (const w of wires) {
    for (let i = 0; i + 1 < w.length; i++) {
      const [a, b] = [w[i], w[i + 1]];
      const ka = key(...a);
      join(ka, key(...b));
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
      for (const p of points.values()) {
        const cross = Math.abs((b[0] - a[0]) * (p.y - a[1]) - (b[1] - a[1]) * (p.x - a[0])) / len;
        const tt = ((p.x - a[0]) * (b[0] - a[0]) + (p.y - a[1]) * (b[1] - a[1])) / (len * len);
        if (cross < 0.01 && tt > 1e-6 && tt < 1 - 1e-6) join(p.k, ka);
      }
    }
  }
  const byName = new Map();
  for (const p of points.values()) for (const n of p.names) {
    if (byName.has(n)) join(p.k, byName.get(n));
    else byName.set(n, p.k);
  }
  const groups = new Map();
  for (const pp of placedPins) {
    const g = find(pp.pt.k);
    if (!groups.has(g)) groups.set(g, { names: new Set(), pads: [] });
    groups.get(g).pads.push([pp.ref, pp.number]);
  }
  for (const p of points.values()) for (const n of p.names) groups.get(find(p.k))?.names.add(n);
  const nets = [];
  for (const g of groups.values()) {
    const pads = [...new Map(g.pads.map((q) => [q.join('.'), q])).values()];
    if (pads.length < 2) continue;
    const name = [...g.names][0] || `Net-(${pads[0][0]}-Pad${pads[0][1]})`;
    nets.push({ name, pads });
  }
  const unknown = [];
  const out = { source: fileName, thickness: 1.6, holes: [], parts: [], nets, traces: [], vias: [] };
  for (const p of parts.values()) {
    const fp = fromName(p.ref, p.value, p.fpName, [...p.pins], unknown);
    if (fp.hole) continue;
    out.parts.push(fp);
  }
  if (!out.parts.length) throw new Error(`${fileName} has no parts.`);
  if (unknown.length) notes.push(`No footprint Caliper knows for ${unknown.join(', ')}: they are plain blocks with their pins in a row. Set their sizes in the placement editor.`);
  return finish(out, notes, false);
}

function fromName(ref, value, fpName, pins, unknown) {
  const fp = footprintFromName(fpName, pins.length);
  if (fp?.hole) return { hole: true };
  const use = fp && pins.every((n) => fp.pads[n]) ? fp : null;
  if (!use) unknown.push(ref);
  const base = use || fallbackFootprint(pins.sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || String(a).localeCompare(String(b))));
  const part = { ref, value, package: String(fpName || 'unknown').split(':').pop() || 'unknown', x: 0, y: 0, rot: 0, side: 'top', body: base.body, pads: base.pads, shape: base.shape, family: base.family, h: base.h };
  if (!use) part.hGuess = true;
  return finishPart(part, fpName);
}

// ---------- KiCad netlist (.net) ----------
function readNetlist(root, fileName) {
  const notes = [];
  const pinsOf = new Map();
  const nets = [];
  for (const net of all(one(root, 'nets'), 'net')) {
    const name = str(net, 'name') || `Net-${str(net, 'code')}`;
    const pads = all(net, 'node').map((nd) => [str(nd, 'ref'), str(nd, 'pin')]);
    for (const [ref, pin] of pads) {
      if (!pinsOf.has(ref)) pinsOf.set(ref, new Set());
      pinsOf.get(ref).add(pin);
    }
    if (pads.length > 1) nets.push({ name, pads });
  }
  const unknown = [];
  const out = { source: fileName, thickness: 1.6, holes: [], parts: [], nets, traces: [], vias: [] };
  for (const comp of all(one(root, 'components'), 'comp')) {
    const ref = str(comp, 'ref');
    const fp = fromName(ref, str(comp, 'value') || '', str(comp, 'footprint') || '', [...(pinsOf.get(ref) || [])], unknown);
    if (!fp.hole) out.parts.push(fp);
  }
  if (!out.parts.length) throw new Error(`${fileName} has no components.`);
  if (unknown.length) notes.push(`No footprint Caliper knows for ${unknown.join(', ')}: they are plain blocks with their pins in a row. Set their sizes in the placement editor.`);
  return finish(out, notes, false);
}
