// Eagle / Fusion Electronics files (.sch schematics, .brd boards, both XML) to a Caliper board:
// the parts with their footprints (pads and body outline), the nets that join their pads and, for a
// .brd, the board outline, holes and where every part sits.
import { parseXML, kids, kid, path, walk } from './xml.js';
import { guessPart, partColor, chainOutline, boundingOutline } from './geometry.js';
import { layoutNewBoard } from './placement.js';

const BODY_LAYERS = { 51: 2, 21: 1, 39: 0 }; // tDocu (real body) beats tPlace (silkscreen) beats keepout
const num = (v, d = 0) => (v === undefined || v === '' || Number.isNaN(+v) ? d : +v);
const round = (v, k = 1000) => Math.round(v * k) / k;

export const isEagle = (bytes) => {
  const h = new TextDecoder().decode(bytes.subarray(0, 2000));
  return /<\s*eagle[\s>]/.test(h) || (/<!DOCTYPE\s+eagle/i.test(h));
};

// "R90" -> { rot: 90, side: 'top' }, "MR180" -> { rot: 180, side: 'bottom' }.
export function parseRot(s = '') {
  const m = /^(S?)(M?)(S?)R(-?[\d.]+)$/.exec(String(s).trim());
  if (!m) return { rot: 0, side: 'top' };
  return { rot: ((+m[4] % 360) + 360) % 360, side: m[2] ? 'bottom' : 'top' };
}

// A package's pads and body outline, in its own coordinates.
function readPackage(pkg) {
  const pads = {};
  const pts = [];
  let smd = false;
  for (const p of kids(pkg, 'pad')) {
    const drill = num(p.attrs.drill, 0.8);
    const d = num(p.attrs.diameter) || drill * 1.6 + 0.2;
    pads[p.attrs.name] = [round(num(p.attrs.x)), round(num(p.attrs.y)), round(d, 100), round(drill, 100)];
    pts.push([num(p.attrs.x) - d / 2, num(p.attrs.y) - d / 2], [num(p.attrs.x) + d / 2, num(p.attrs.y) + d / 2]);
  }
  for (const p of kids(pkg, 'smd')) {
    smd = true;
    const dx = num(p.attrs.dx);
    const dy = num(p.attrs.dy);
    const turned = /R(90|270)/.test(p.attrs.rot || '');
    const w = turned ? dy : dx;
    const hgt = turned ? dx : dy;
    pads[p.attrs.name] = [round(num(p.attrs.x)), round(num(p.attrs.y)), round(Math.min(w, hgt), 100), round(w, 100), round(hgt, 100)];
    pts.push([num(p.attrs.x) - w / 2, num(p.attrs.y) - hgt / 2], [num(p.attrs.x) + w / 2, num(p.attrs.y) + hgt / 2]);
  }
  // Body: the outline drawn on the documentation layer (or the silkscreen), as a bounding box.
  let best = -1;
  let box = null;
  let round_ = false;
  for (const [layer, rank] of Object.entries(BODY_LAYERS)) {
    const b = [];
    let circles = 0;
    let other = 0;
    for (const el of pkg.children) {
      if (el.attrs.layer !== layer) continue;
      const a = el.attrs;
      if (el.tag === 'wire') {
        b.push([num(a.x1), num(a.y1)], [num(a.x2), num(a.y2)]);
        other++;
      } else if (el.tag === 'rectangle') {
        b.push([num(a.x1), num(a.y1)], [num(a.x2), num(a.y2)]);
        other++;
      } else if (el.tag === 'circle') {
        const r = num(a.radius) + num(a.width) / 2;
        b.push([num(a.x) - r, num(a.y) - r], [num(a.x) + r, num(a.y) + r]);
        circles++;
      } else if (el.tag === 'polygon') {
        for (const v of kids(el, 'vertex')) b.push([num(v.attrs.x), num(v.attrs.y)]);
        other++;
      }
    }
    if (b.length && rank > best) {
      best = rank;
      box = b;
      round_ = circles > 0 && circles >= other / 4;
    }
  }
  const src = box || pts;
  let body = { cx: 0, cy: 0, w: 2, d: 2 };
  if (src.length) {
    const xs = src.map((p) => p[0]);
    const ys = src.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = box ? 0 : 0.3;
    body = { cx: round((x0 + x1) / 2), cy: round((y0 + y1) / 2), w: round(x1 - x0 + 2 * pad, 100), d: round(y1 - y0 + 2 * pad, 100) };
    // A body drawn as a single line (a TO-92's flat side, say) has no depth: take it from the pads.
    if (box && pts.length && (body.w < 0.5 || body.d < 0.5)) {
      const px = pts.map((p) => p[0]);
      const py = pts.map((p) => p[1]);
      if (body.w < 0.5) Object.assign(body, { cx: round((Math.min(...px) + Math.max(...px)) / 2), w: round(Math.max(...px) - Math.min(...px), 100) });
      if (body.d < 0.5) Object.assign(body, { cy: round((Math.min(...py) + Math.max(...py)) / 2), d: round(Math.max(...py) - Math.min(...py), 100) });
    }
  }
  return { pads, body, round: round_, smd };
}

// The description element's text is not kept by the small XML reader, so read it from the source.
function descriptions(src) {
  const out = new Map();
  const re = /<package\b[^>]*\bname="([^"]*)"[^>]*>\s*<description[^>]*>([\s\S]*?)<\/description>/g;
  let m;
  while ((m = re.exec(src))) out.set(m[1], m[2].replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim());
  return out;
}

// Height from a description such as "TP4056 29x17.3x4.3" (L x W x H in mm).
function heightFromText(s = '') {
  const m = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*[x×]\s*~?(\d+(?:\.\d+)?)/i.exec(s);
  return m ? +m[3] : null;
}

function libraries(root) {
  const libs = new Map();
  for (const lib of walk(root, 'library')) {
    const name = lib.attrs.name;
    const pk = new Map();
    for (const p of kids(kid(lib, 'packages'), 'package')) pk.set(p.attrs.name, p);
    const ds = new Map();
    for (const d of kids(kid(lib, 'devicesets'), 'deviceset')) ds.set(d.attrs.name, d);
    // Eagle 9 names libraries by URN as well; keep the last one seen under each name.
    libs.set(name, { packages: pk, devicesets: ds });
    if (lib.attrs.urn) libs.set(lib.attrs.urn, { packages: pk, devicesets: ds });
  }
  return libs;
}

function makePart(ref, pkgName, pkgEl, value, descs, extra = {}) {
  const pk = readPackage(pkgEl);
  const desc = descs.get(pkgName) || '';
  const guess = guessPart(pkgName, value);
  const h = heightFromText(desc) ?? guess.h;
  const shape = pk.round ? 'cylinder' : guess.shape === 'cylinder' && !/AXIAL|0207|0204/i.test(pkgName) ? 'cylinder' : 'box';
  const part = { ref, value: value || '', package: pkgName, x: 0, y: 0, rot: 0, side: 'top', h: round(h, 100), body: pk.body, shape, pads: pk.pads, ...extra };
  if (heightFromText(desc) === null) part.hGuess = true;
  part.color = partColor(part);
  return part;
}

// Board outline from the Dimension layer (20): one circle, or wires chained into a closed path.
function boardOutline(plain) {
  const circle = kids(plain, 'circle').find((c) => c.attrs.layer === '20');
  if (circle) return { outline: { kind: 'circle', d: round(num(circle.attrs.radius) * 2, 100), x: round(num(circle.attrs.x)), y: round(num(circle.attrs.y)) } };
  const segs = kids(plain, 'wire')
    .filter((w) => w.attrs.layer === '20')
    .map((w) => ({ a: [num(w.attrs.x1), num(w.attrs.y1)], b: [num(w.attrs.x2), num(w.attrs.y2)], bulge: num(w.attrs.curve) ? Math.tan((num(w.attrs.curve) * Math.PI) / 180 / 4) : 0 }));
  const outline = chainOutline(segs);
  return outline ? { outline } : null;
}

// Parse an Eagle .sch or .brd. Returns the props of a board feature plus notes for the person.
export function readEagle(bytes, fileName = 'board') {
  const src = new TextDecoder().decode(bytes);
  const root = parseXML(src);
  const drawing = path(root, 'eagle', 'drawing');
  if (!drawing) throw new Error(`${fileName} is not an Eagle / Fusion Electronics file.`);
  const descs = descriptions(src);
  const libs = libraries(drawing);
  const board = kid(drawing, 'board');
  const schematic = kid(drawing, 'schematic');
  const notes = [];
  const parts = [];
  const nets = [];
  const out = { source: fileName, thickness: 1.6, holes: [] };

  if (board) {
    for (const el of kids(kid(board, 'elements'), 'element')) {
      const a = el.attrs;
      const lib = libs.get(a.library_urn) || libs.get(a.library);
      const pkgEl = lib?.packages.get(a.package);
      if (!pkgEl) {
        notes.push(`${a.name}: package ${a.package} is not in the file, so it was left out.`);
        continue;
      }
      const { rot, side } = parseRot(a.rot);
      parts.push(makePart(a.name, a.package, pkgEl, a.value, descs, { x: round(num(a.x)), y: round(num(a.y)), rot, side }));
    }
    for (const s of kids(kid(board, 'signals'), 'signal')) {
      const pads = kids(s, 'contactref').map((c) => [c.attrs.element, c.attrs.pad]);
      if (pads.length > 1) nets.push({ name: s.attrs.name, pads });
    }
    const plain = kid(board, 'plain');
    const ol = plain && boardOutline(plain);
    if (ol) Object.assign(out, ol);
    for (const hole of kids(plain, 'hole')) out.holes.push({ x: round(num(hole.attrs.x)), y: round(num(hole.attrs.y)), d: round(num(hole.attrs.drill), 100) });
    if (!ol) notes.push('The board has no outline on the Dimension layer, so Caliper drew one around the parts.');
  } else if (schematic) {
    const partsEl = kid(schematic, 'parts');
    const devOf = new Map();
    for (const p of kids(partsEl, 'part')) {
      const a = p.attrs;
      const lib = libs.get(a.library_urn) || libs.get(a.library);
      const ds = lib?.devicesets.get(a.deviceset);
      const dev = kids(kid(ds, 'devices'), 'device').find((d) => (d.attrs.name || '') === (a.device || ''));
      if (!dev || !dev.attrs.package) continue; // supply symbols, frames and other parts with no footprint
      const pkgEl = lib.packages.get(dev.attrs.package);
      if (!pkgEl) {
        notes.push(`${a.name}: package ${dev.attrs.package} is not in the file, so it was left out.`);
        continue;
      }
      const pins = new Map();
      for (const c of kids(kid(dev, 'connects'), 'connect')) pins.set(`${c.attrs.gate}|${c.attrs.pin}`, c.attrs.pad.split(/\s+/));
      devOf.set(a.name, pins);
      parts.push(makePart(a.name, dev.attrs.package, pkgEl, a.value, descs));
    }
    const byName = new Map();
    for (const net of walk(schematic, 'net')) {
      const list = byName.get(net.attrs.name) || [];
      for (const pr of walk(net, 'pinref')) {
        const pads = devOf.get(pr.attrs.part)?.get(`${pr.attrs.gate}|${pr.attrs.pin}`) || [];
        for (const pad of pads) list.push([pr.attrs.part, pad]);
      }
      byName.set(net.attrs.name, list);
    }
    for (const [name, pads] of byName) {
      const uniq = [...new Map(pads.map((p) => [p.join('.'), p])).values()];
      if (uniq.length > 1) nets.push({ name, pads: uniq });
    }
  } else throw new Error(`${fileName} has neither a schematic nor a board in it.`);

  if (!parts.length) throw new Error(`${fileName} has no parts with footprints.`);
  out.parts = parts;
  out.nets = nets;
  if (!board) notes.push(layoutNewBoard(out));
  else if (!out.outline) out.outline = boundingOutline(parts);
  const guessed = parts.filter((p) => p.hGuess).map((p) => p.ref);
  if (guessed.length) notes.push(`Heights for ${guessed.join(', ')} are estimates from the package type; set the real ones in the placement editor.`);
  for (const p of parts) delete p.hGuess;
  return { props: out, notes };
}
