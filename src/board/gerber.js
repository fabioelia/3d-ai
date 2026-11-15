// Fabrication files for a routed two-layer board: Gerber (RS-274X) copper, solder mask, silkscreen
// and outline, and Excellon drill files, named the way KiCad names them so board houses recognise
// them. Silkscreen carries part outlines only (no text).
import { boardPolygon, partPolygon, toBoard, insetPolygon, bodyCenter } from './geometry.js';
import { strokeText } from './font.js';
import { bounds } from '../sketchgeo.js';
import { connectivity, rulesOf } from './route.js';
import { padShape } from './footprints.js';

const MASK = 0.05; // solder mask opening beyond each pad

const c6 = (v) => String(Math.round(v * 1e6));
const f3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);

function gerber(name, fn) {
  const ap = new Map();
  const defs = [];
  const body = [];
  const aperture = (d) => {
    const key = (Math.round(d * 1000) / 1000).toFixed(3);
    if (!ap.has(key)) {
      const code = 10 + ap.size;
      ap.set(key, code);
      defs.push(`%ADD${code}C,${Number(key).toFixed(6)}*%`);
    }
    return ap.get(key);
  };
  let current = null;
  const use = (d) => {
    const code = aperture(d);
    if (current !== code) {
      body.push(`D${code}*`);
      current = code;
    }
  };
  const g = {
    polarity(dark) {
      body.push(dark ? '%LPD*%' : '%LPC*%');
    },
    line(pts, w, closed = false) {
      if (pts.length < 2) return;
      use(w);
      body.push(`X${c6(pts[0][0])}Y${c6(pts[0][1])}D02*`);
      for (const p of pts.slice(1)) body.push(`X${c6(p[0])}Y${c6(p[1])}D01*`);
      if (closed) body.push(`X${c6(pts[0][0])}Y${c6(pts[0][1])}D01*`);
    },
    flash(p, d) {
      use(d);
      body.push(`X${c6(p[0])}Y${c6(p[1])}D03*`);
    },
    region(poly) {
      body.push('G36*', `X${c6(poly[0][0])}Y${c6(poly[0][1])}D02*`);
      for (const p of poly.slice(1)) body.push(`X${c6(p[0])}Y${c6(p[1])}D01*`);
      body.push(`X${c6(poly[0][0])}Y${c6(poly[0][1])}D01*`, 'G37*');
    },
  };
  fn(g);
  return [`G04 ${name}, exported by Caliper*`, '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%', 'G01*', ...defs, ...body, 'M02*', ''].join('\n');
}

function rectPoly(part, pad, grow) {
  const s = padShape(pad);
  const w = s.w / 2 + grow;
  const h = s.h / 2 + grow;
  return [
    [pad[0] - w, pad[1] - h],
    [pad[0] + w, pad[1] - h],
    [pad[0] + w, pad[1] + h],
    [pad[0] - w, pad[1] + h],
  ].map((q) => toBoard(part, q));
}

function drill(name, holes) {
  const tools = new Map();
  for (const h of holes) {
    const k = f3(h.d);
    if (!tools.has(k)) tools.set(k, []);
    tools.get(k).push(h);
  }
  const out = ['M48', `; ${name}, exported by Caliper`, 'FMAT,2', 'METRIC'];
  const order = [...tools.keys()].sort((a, b) => a - b);
  order.forEach((k, i) => out.push(`T${i + 1}C${k}`));
  out.push('%', 'G90', 'G05');
  order.forEach((k, i) => {
    out.push(`T${i + 1}`);
    for (const h of tools.get(k)) out.push(`X${f3(h.x)}Y${f3(h.y)}`);
  });
  out.push('M30', '');
  return out.join('\n');
}

// Returns [{ name, data }] for a board whose expressions are already numbers (numericBoard).
export function fabFiles(b, base = 'board') {
  const outline = boardPolygon(b);
  const parts = (b.parts || []).filter((p) => !p.off);
  const side = (p) => (p.side === 'bottom' ? 'bottom' : 'top');
  // Pours: the board inset from its edge, with room cleared around other nets' copper and the
  // holes (clear polarity), before the copper itself goes down.
  const conn = (b.pours || []).length ? connectivity(b) : null;
  const rules = rulesOf(b);
  const pour = (layer) => (g) => {
    for (const pr of b.pours || []) {
      if (pr.layer !== layer) continue;
      const clear = pr.clearance ?? Math.max(rules.clearance, 0.25);
      g.region(insetPolygon(outline, rules.edge));
      g.polarity(false);
      for (const it of conn.items) {
        if (!it.layers.includes(layer) || it.groupNet === pr.net) continue;
        const s = it.shape;
        if (s.poly) g.region(insetPolygon(s.poly, -clear));
        else if (Math.hypot(s.a[0] - s.b[0], s.a[1] - s.b[1]) < 1e-9) g.flash(s.a, 2 * (s.r + clear));
        else g.line([s.a, s.b], 2 * (s.r + clear));
      }
      for (const h of b.holes || []) g.flash([h.x, h.y], h.d + 2 * clear);
      const grid = conn.pours.find((x) => x.layer === layer && x.net === pr.net)?.grid;
      // Thermal reliefs: a ring of clearance around the pour's own through-hole pads, then spokes.
      for (const it of conn.items) if (grid?.thermals.has(it.id)) g.flash(it.shape.a, 2 * (it.shape.r + clear));
      g.polarity(true);
      for (const sp of grid ? grid.spokes() : []) g.line([sp.a, sp.b], sp.w);
    }
  };
  const copper = (layer, grow) => (g) => {
    if (!grow) pour(layer)(g);
    for (const p of parts)
      for (const pad of Object.values(p.pads || {})) {
        const s = padShape(pad);
        if (s.smd) {
          if (side(p) === layer) g.region(rectPoly(p, pad, grow));
        } else g.flash(toBoard(p, pad), s.w + 2 * grow);
      }
    if (grow) return; // vias stay under the mask (tented)
    for (const t of b.traces || []) if ((t.layer === 'bottom' ? 'bottom' : 'top') === layer) g.line(t.pts, t.w || 0.25);
    for (const v of b.vias || []) g.flash([v.x, v.y], v.d || 0.6);
  };
  // Part outlines and references, the reference along the long side of the part, read from its own
  // side of the board (mirrored on the bottom).
  const silk = (layer) => (g) => {
    for (const p of parts) {
      if (side(p) !== layer) continue;
      const poly = partPolygon(p);
      g.line(poly, 0.15, true);
      const bb = bounds(poly);
      const w = bb.x1 - bb.x0;
      const h = bb.y1 - bb.y0;
      const turn = h > w * 1.2 ? 90 : 0;
      const long = turn ? h : w;
      const short = turn ? w : h;
      const size = Math.max(0.8, Math.min(1.5, (long * 0.85) / (String(p.ref).length * 0.92), short * 0.6));
      const c = bodyCenter(p);
      const t = strokeText(p.ref, c[0], c[1], size, turn);
      for (const line of t.lines) g.line(layer === 'bottom' ? line.map((q) => [2 * c[0] - q[0], q[1]]) : line, Math.max(0.12, size * 0.13));
    }
  };
  const files = [
    { name: `${base}-F_Cu.gtl`, data: gerber('Top copper', copper('top', 0)) },
    { name: `${base}-B_Cu.gbl`, data: gerber('Bottom copper', copper('bottom', 0)) },
    { name: `${base}-F_Mask.gts`, data: gerber('Top solder mask', copper('top', MASK)) },
    { name: `${base}-B_Mask.gbs`, data: gerber('Bottom solder mask', copper('bottom', MASK)) },
    { name: `${base}-F_Silkscreen.gto`, data: gerber('Top silkscreen', silk('top')) },
    { name: `${base}-B_Silkscreen.gbo`, data: gerber('Bottom silkscreen', silk('bottom')) },
    { name: `${base}-Edge_Cuts.gm1`, data: gerber('Board outline', (g) => g.line(outline, 0.1, true)) },
  ];
  const pth = [];
  for (const p of parts) for (const pad of Object.values(p.pads || {})) {
    const s = padShape(pad);
    if (!s.smd) pth.push({ ...xy(toBoard(p, pad)), d: s.drill });
  }
  for (const v of b.vias || []) pth.push({ x: v.x, y: v.y, d: v.drill || 0.3 });
  files.push({ name: `${base}-PTH.drl`, data: drill('Plated holes', pth) });
  if ((b.holes || []).length) files.push({ name: `${base}-NPTH.drl`, data: drill('Unplated holes', b.holes) });
  const bb = outline.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[2], p[0]), Math.max(a[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  files.push({ name: `${base}-bom.csv`, data: bomCSV(b) });
  files.push({ name: `${base}-positions.csv`, data: positionsCSV(b) });
  files.push({
    name: `${base}-README.txt`,
    data: [
      `${base}: two-layer board, ${f3(bb[2] - bb[0])} x ${f3(bb[3] - bb[1])} mm, ${b.thickness ?? 1.6} mm thick, exported by Caliper.`,
      'Files: F_Cu/B_Cu copper (pours with thermal reliefs), F_Mask/B_Mask solder mask (vias tented), F_Silkscreen/B_Silkscreen part outlines and references, Edge_Cuts outline, PTH and NPTH Excellon drills (mm).',
      'bom.csv lists the parts; positions.csv gives each part\'s centre, rotation and side for assembly.',
      'Coordinates are in millimetres, format 4.6. Check the files in a Gerber viewer before ordering.',
      '',
    ].join('\n'),
  });
  return files;
}

const xy = (p) => ({ x: p[0], y: p[1] });

const csv = (rows) => rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\n') + '\n';

// Bill of materials: parts grouped by value and package.
export function bomCSV(b) {
  const groups = new Map();
  for (const p of b.parts || []) {
    const key = `${p.value || ''}|${p.package || ''}`;
    if (!groups.has(key)) groups.set(key, { value: p.value || '', package: p.package || '', refs: [] });
    groups.get(key).refs.push(p.ref);
  }
  const natural = (a, c) => a.localeCompare(c, undefined, { numeric: true });
  const rows = [...groups.values()].map((x) => [x.refs.length, x.value, x.package, x.refs.sort(natural).join(' ')]).sort((a, c) => natural(a[3], c[3]));
  return csv([['Qty', 'Value', 'Package', 'References'], ...rows]);
}

// Where each placed part goes, for assembly (centre of its body, rotation, side).
export function positionsCSV(b) {
  const r3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);
  const rows = (b.parts || []).filter((p) => !p.off).map((p) => {
    const c = bodyCenter(p);
    return [p.ref, p.value || '', p.package || '', r3(c[0]), r3(c[1]), r3(((Number(p.rot) || 0) % 360 + 360) % 360), p.side === 'bottom' ? 'bottom' : 'top'];
  });
  return csv([['Ref', 'Value', 'Package', 'PosX', 'PosY', 'Rot', 'Side'], ...rows]);
}
