// Board geometry shared by the kernel, the placement editor and the checks. Everything here is in the
// board's own 2D coordinates (millimetres, seen from the top, origin at the board origin).
import { outline as shapeOutline, pointInPolygon, distToPolyline, bounds } from '../sketchgeo.js';
import { padShape } from './footprints.js';

const rad = (d) => (d * Math.PI) / 180;
export const rot2 = (p, deg) => {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
};
const r3 = (v) => Math.round(v * 1000) / 1000;

// A part's own point (package coordinates) to board coordinates. Bottom-side parts are mirrored in X,
// as in Eagle and Fusion, so the board always reads as seen from the top.
export function toBoard(part, p) {
  const q = rot2([part.side === 'bottom' ? -p[0] : p[0], p[1]], part.rot || 0);
  return [q[0] + (part.x || 0), q[1] + (part.y || 0)];
}

// Centre of the part's body on the board.
export const bodyCenter = (part) => toBoard(part, [part.body?.cx || 0, part.body?.cy || 0]);

// Footprint of the part's body on the board, as a polygon (counter-clockwise).
export function partPolygon(part) {
  const b = part.body || { cx: 0, cy: 0, w: 2, d: 2 };
  let pts;
  if (part.shape === 'cylinder') {
    const r = Math.max(b.w, b.d) / 2;
    pts = Array.from({ length: 24 }, (_, i) => [b.cx + r * Math.cos((i / 24) * 2 * Math.PI), b.cy + r * Math.sin((i / 24) * 2 * Math.PI)]);
  } else {
    pts = [
      [b.cx - b.w / 2, b.cy - b.d / 2],
      [b.cx + b.w / 2, b.cy - b.d / 2],
      [b.cx + b.w / 2, b.cy + b.d / 2],
      [b.cx - b.w / 2, b.cy + b.d / 2],
    ];
  }
  const out = pts.map((p) => toBoard(part, p));
  return part.side === 'bottom' ? out.reverse() : out;
}

// What a part occupies on the board for placement: its body plus its pads (the leads of an axial
// resistor stick out past its body, for instance). In package coordinates: { x0, y0, x1, y1 }.
export function footprintBox(part) {
  const b = part.body || { cx: 0, cy: 0, w: 2, d: 2 };
  let x0 = b.cx - b.w / 2;
  let x1 = b.cx + b.w / 2;
  let y0 = b.cy - b.d / 2;
  let y1 = b.cy + b.d / 2;
  for (const pad of Object.values(part.pads || {})) {
    const ps = padShape(pad);
    const hw = ps.w / 2;
    const hh = ps.h / 2;
    x0 = Math.min(x0, pad[0] - hw);
    x1 = Math.max(x1, pad[0] + hw);
    y0 = Math.min(y0, pad[1] - hh);
    y1 = Math.max(y1, pad[1] + hh);
  }
  return { x0, y0, x1, y1 };
}

// Footprint on the board as a polygon: the body's own shape when the pads sit inside it, otherwise
// the rectangle around body and pads.
export function footprintPolygon(part) {
  const f = footprintBox(part);
  const b = part.body || { cx: 0, cy: 0, w: 2, d: 2 };
  const inside = f.x0 >= b.cx - b.w / 2 - 1e-6 && f.x1 <= b.cx + b.w / 2 + 1e-6 && f.y0 >= b.cy - b.d / 2 - 1e-6 && f.y1 <= b.cy + b.d / 2 + 1e-6;
  if (inside && b.w > 0.5 && b.d > 0.5) return partPolygon(part);
  return partPolygon({ ...part, shape: 'box', body: { cx: (f.x0 + f.x1) / 2, cy: (f.y0 + f.y1) / 2, w: f.x1 - f.x0, d: f.y1 - f.y0 } });
}

export function boardPolygon(board, n = Number) {
  return shapeOutline(board.outline || { kind: 'rect', w: 60, h: 40 }, n);
}

// Height range a part takes up on its side, measured away from the board surface.
export const zRange = (p, n = Number) => [n(p.lift ?? 0), n(p.lift ?? 0) + n(p.h ?? 1)];

// Where each pad is on the board: { 'U4.1': [x, y], ... }.
export function padPositions(board) {
  const out = {};
  for (const p of board.parts || []) for (const [pad, xy] of Object.entries(p.pads || {})) out[`${p.ref}.${pad}`] = toBoard(p, xy);
  return out;
}

// Airwires: for each net, the shortest straight connections that join its pads (a minimum spanning
// tree), the way an unrouted board shows what still has to be connected.
export function airwires(board) {
  const pads = padPositions(board);
  const off = new Set((board.parts || []).filter((p) => p.off).map((p) => p.ref));
  const out = [];
  for (const net of board.nets || []) {
    const keys = [...new Set((net.pads || []).map(([ref, pad]) => `${ref}.${pad}`))].filter((k) => pads[k]);
    const pts = keys.map((k) => pads[k]);
    if (pts.length < 2) continue;
    const inTree = [0];
    const rest = pts.map((_, i) => i).slice(1);
    while (rest.length) {
      let best = null;
      for (const a of inTree)
        for (const b of rest) {
          const d = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
          if (!best || d < best.d) best = { a, b, d };
        }
      const offBoard = off.has(keys[best.a].split('.')[0]) || off.has(keys[best.b].split('.')[0]);
      out.push({ net: net.name, from: pts[best.a], to: pts[best.b], length: best.d, a: keys[best.a], b: keys[best.b], ...(offBoard ? { offBoard: true } : {}) });
      inTree.push(best.b);
      rest.splice(rest.indexOf(best.b), 1);
    }
  }
  return out;
}

// Separating-axis test for two convex polygons.
function overlap(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = q[1] - p[1];
      const ny = p[0] - q[0];
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const v of a) {
        const t = v[0] * nx + v[1] * ny;
        minA = Math.min(minA, t);
        maxA = Math.max(maxA, t);
      }
      for (const v of b) {
        const t = v[0] * nx + v[1] * ny;
        minB = Math.min(minB, t);
        maxB = Math.max(maxB, t);
      }
      const eps = 1e-6 * (Math.hypot(nx, ny) || 1);
      if (maxA <= minB + eps || maxB <= minA + eps) return false;
    }
  }
  return true;
}

// Boxes of a part's through-hole pads on the board, grown by `grow`.
export function pinBoxes(part, grow = 0) {
  const out = [];
  for (const pad of Object.values(part.pads || {})) {
    if (pad.length >= 5) continue;
    const c = toBoard(part, pad);
    const r = (pad[2] || 1.6) / 2 + grow;
    out.push([c[0] - r, c[1] - r, c[0] + r, c[1] + r]);
  }
  return out;
}

// Placement checks: parts that collide (same side, footprints overlap and heights overlap), parts off
// the edge or too close to it, parts over mounting holes, parts not on the board yet.
// Returns [{ kind, refs, message }].
export function checkBoard(board, n = Number, { edge = 0.5, holeClearance = 0.5 } = {}) {
  const issues = [];
  const outline = boardPolygon(board, n);
  const all = board.parts || [];
  const parts = all.filter((p) => !p.off);
  const polys = parts.map((p) => footprintPolygon(p));
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i];
      const b = parts[j];
      if ((a.side || 'top') !== (b.side || 'top')) continue;
      const za = zRange(a, n);
      const zb = zRange(b, n);
      if (za[1] <= zb[0] + 1e-6 || zb[1] <= za[0] + 1e-6) continue; // one sits above the other
      if (overlap(polys[i], polys[j])) issues.push({ kind: 'overlap', refs: [a.ref, b.ref], message: `${a.ref} and ${b.ref} overlap on the ${a.side || 'top'} side.` });
    }
  // Through-hole pins come out on the other side of the board.
  for (let i = 0; i < parts.length; i++)
    for (let j = 0; j < parts.length; j++) {
      const a = parts[i];
      const b = parts[j];
      if (i === j || (a.side || 'top') === (b.side || 'top') || n(b.lift ?? 0) >= 3) continue;
      const pb = polys[j];
      if (pinBoxes(a).some((bx) => {
        const c = [(bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2];
        return pointInPolygon(c, pb) || distToPolyline(c, pb) < (bx[2] - bx[0]) / 2;
      }))
        issues.push({ kind: 'pins', refs: [a.ref, b.ref], message: `${a.ref}'s through-hole pins come out under ${b.ref} on the ${b.side || 'top'} side.` });
    }
  parts.forEach((p, i) => {
    if (polys[i].some((v) => !pointInPolygon(v, outline))) issues.push({ kind: 'outside', refs: [p.ref], message: `${p.ref} hangs over the edge of the board.` });
    else if (polys[i].some((v) => distToPolyline(v, outline) < edge)) issues.push({ kind: 'edge', refs: [p.ref], message: `${p.ref} is closer than ${edge} mm to the board edge.` });
    for (const h of board.holes || []) {
      const c = [n(h.x), n(h.y)];
      if (pointInPolygon(c, polys[i]) || distToPolyline(c, polys[i]) < n(h.d) / 2 + holeClearance) issues.push({ kind: 'hole', refs: [p.ref], message: `${p.ref} is over or too close to the hole at (${r3(c[0])}, ${r3(c[1])}).` });
    }
  });
  const off = all.filter((p) => p.off).map((p) => p.ref);
  if (off.length) issues.push({ kind: 'unplaced', refs: off, message: `${off.length === 1 ? `${off[0]} is` : `${off.length} parts are`} not on the board yet: ${off.join(', ')}.` });
  return issues;
}

// Set a part so the centre of its footprint lands on (tx, ty).
export function centerPartAt(part, tx, ty) {
  const f = footprintBox(part);
  const c = [(f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2];
  const off = rot2([part.side === 'bottom' ? -c[0] : c[0], c[1]], part.rot || 0);
  part.x = r3(tx - off[0]);
  part.y = r3(ty - off[1]);
}

// Turn a part about the centre of its body, or flip it to the other side of the board, leaving the
// body where it is.
export function turnPart(part, deg) {
  const c = bodyCenter(part);
  part.rot = (((Number(part.rot) || 0) + deg) % 360 + 360) % 360;
  const now = bodyCenter(part);
  part.x = r3((Number(part.x) || 0) + c[0] - now[0]);
  part.y = r3((Number(part.y) || 0) + c[1] - now[1]);
}
export function flipPart(part) {
  const c = bodyCenter(part);
  part.side = part.side === 'bottom' ? 'top' : 'bottom';
  const now = bodyCenter(part);
  part.x = r3((Number(part.x) || 0) + c[0] - now[0]);
  part.y = r3((Number(part.y) || 0) + c[1] - now[1]);
}

// Everything worth seeing: the outline and every part, on or beside the board.
export function boardExtent(board, n = Number) {
  const pts = boardPolygon(board, n).slice();
  for (const p of board.parts || []) pts.push(...footprintPolygon(p));
  return bounds(pts);
}

// Is any of the part's footprint over the board? (Parts dragged clear of it count as not placed.)
export function overBoard(part, board, n = Number) {
  const outline = boardPolygon(board, n);
  const poly = footprintPolygon(part);
  const b = bounds(poly);
  return poly.some((v) => pointInPolygon(v, outline)) || pointInPolygon([b.cx, b.cy], outline) || outline.some((v) => pointInPolygon(v, poly));
}

const aabb = (poly) => {
  const b = bounds(poly);
  return [b.x0, b.y0, b.x1, b.y1];
};

// Arrange parts on the board, biggest first, each in the highest then leftmost free spot (turned
// 90 degrees when that fits better), clear of the edge, the holes and each other. `which` picks the
// parts to arrange (default: all); `sides` the sides to fill, in order. Parts that do not fit wait
// beside the board with `off: true`. Mutates `board`; returns { placed, off }.
export function autoPlace(board, n = Number, opts = {}) {
  const { which = null, sides = ['top'], gap = 1, margin = 1, step = 0.5 } = opts;
  const outline = boardPolygon(board, n);
  const bb = bounds(outline);
  const moving = (board.parts || []).filter((p) => !which || which.includes(p.ref));
  const fixed = (board.parts || []).filter((p) => !moving.includes(p) && !p.off);
  const holes = (board.holes || []).map((h) => ({ c: [n(h.x), n(h.y)], r: n(h.d) / 2 + gap }));
  const size = (p) => {
    const f = footprintBox(p);
    return [f.x1 - f.x0, f.y1 - f.y0];
  };
  const order = moving.slice().sort((a, b) => {
    const [aw, ad] = size(a);
    const [bw, bd] = size(b);
    return Math.max(bw, bd) - Math.max(aw, ad) || bw * bd - aw * ad;
  });
  const inside = ([x0, y0, x1, y1]) =>
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
      [(x0 + x1) / 2, y0],
      [(x0 + x1) / 2, y1],
      [x0, (y0 + y1) / 2],
      [x1, (y0 + y1) / 2],
    ].every((v) => pointInPolygon(v, outline) && distToPolyline(v, outline) >= margin - 1e-9);
  const nearHole = ([x0, y0, x1, y1]) => holes.some((h) => Math.hypot(Math.max(x0 - h.c[0], 0, h.c[0] - x1), Math.max(y0 - h.c[1], 0, h.c[1] - y1)) < h.r);
  // With `connect`, each part goes to the free spot closest to the parts it connects to that are
  // already down, kept snug against its neighbours or the edge; otherwise rows, top left first.
  const placedRefs = new Set(fixed.map((p) => p.ref));
  const padsOf = (ref) => {
    const q = (board.parts || []).find((x) => x.ref === ref);
    return q ? Object.values(q.pads || {}).map((pd) => toBoard(q, pd)) : [];
  };
  const pullOf = (ref) => {
    const pts = [];
    for (const net of board.nets || []) {
      if (!(net.pads || []).some(([r]) => r === ref)) continue;
      for (const [r, pad] of net.pads) {
        if (r === ref || !placedRefs.has(r)) continue;
        const q = (board.parts || []).find((x) => x.ref === r);
        if (q?.pads?.[pad]) pts.push(toBoard(q, q.pads[pad]));
      }
    }
    return pts;
  };
  const nearConnections = (p, w0, d0, taken, clash, nearHole, inside, pinsClash) => {
    const pull = pullOf(p.ref);
    const cstep = Math.max(step, 1);
    const hasNeighbours = taken.length > 0;
    let best = null;
    for (const turn of [0, 90]) {
      const w = turn ? d0 : w0;
      const d = turn ? w0 : d0;
      for (let y = bb.y0 + margin; y + d <= bb.y1 - margin + 1e-9; y += cstep)
        for (let x = bb.x0 + margin; x + w <= bb.x1 - margin + 1e-9; x += cstep) {
          const r = [x, y, x + w, y + d];
          if (clash(r) || nearHole(r) || !inside(r) || pinsClash(p, r, turn)) continue;
          const c = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
          let wire = 0;
          for (const q of pull) wire += Math.abs(q[0] - c[0]) + Math.abs(q[1] - c[1]);
          // Snug against the parts already down (leaving the routing channel), starting at the centre.
          let snug = hasNeighbours ? Infinity : 0;
          for (const t of taken) snug = Math.min(snug, Math.max(t[0] - r[2], r[0] - t[2], t[1] - r[3], r[1] - t[3], 0) - chan);
          const cost = wire + 2 * Math.max(0, snug) + Math.hypot(c[0] - bb.cx, c[1] - bb.cy) * (hasNeighbours || pull.length ? 0.05 : 1);
          if (!best || cost < best.cost) best = { cost, r, turn, top: r[3] };
        }
    }
    return best || false;
  };
  const connect = !!opts.connect && (board.nets || []).length > 0;
  // Placed by connections, parts keep a wider gap: a channel for traces between them.
  const chan = connect ? Math.max(gap, opts.channel ?? 2) : gap;
  let left = order;
  let placed = 0;
  for (const side of sides) {
    const taken = fixed.filter((p) => (p.side || 'top') === side).map((p) => aabb(footprintPolygon(p)));
    // Through-hole pins go through the board: nothing on the other side may sit on them, and this
    // part's own pins must not come through under a part on the other side.
    const other = (board.parts || []).filter((p) => !p.off && (p.side || 'top') !== side && (fixed.includes(p) || placedRefs.has(p.ref)));
    const otherPins = other.flatMap((p) => pinBoxes(p));
    const otherBoxes = other.map((p) => aabb(footprintPolygon(p)));
    const hit = (a, t, g) => a[0] < t[2] + g && t[0] < a[2] + g && a[1] < t[3] + g && t[1] < a[3] + g;
    const clash = (r) => taken.some((t) => hit(r, t, chan - 1e-9)) || otherPins.some((t) => hit(r, t, 0.3));
    const pinsClash = (p, r, turn) => {
      if (!otherBoxes.length || !Object.values(p.pads || {}).some((pd) => pd.length < 5)) return false;
      const keep = { x: p.x, y: p.y, rot: p.rot, side: p.side };
      p.side = side;
      p.rot = turn;
      centerPartAt(p, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2);
      const bad = pinBoxes(p).some((b) => otherBoxes.some((t) => hit(b, t, 0.3)));
      Object.assign(p, keep);
      return bad;
    };
    const rest = [];
    for (const p of left) {
      const [w0, d0] = size(p);
      let best = connect ? nearConnections(p, w0, d0, taken, clash, nearHole, inside, pinsClash) : null;
      if (best === false) best = null;
      for (const turn of best ? [] : w0 >= d0 ? [0, 90] : [90, 0]) {
        const w = turn ? d0 : w0;
        const d = turn ? w0 : d0;
        // Highest free row first, then leftmost; stop at the first row with room.
        for (let top = bb.y1 - margin; top - d >= bb.y0 + margin - 1e-9 && !(best && top < best.top - 1e-9); top -= step) {
          let hit = null;
          for (let x = bb.x0 + margin; x + w <= bb.x1 - margin + 1e-9; x += step) {
            const r = [x, top - d, x + w, top];
            if (!clash(r) && !nearHole(r) && inside(r) && !pinsClash(p, r, turn)) {
              hit = r;
              break;
            }
          }
          if (hit) {
            if (!best || top > best.top + 1e-9 || hit[0] < best.r[0] - 1e-9) best = { top, r: hit, turn };
            break;
          }
        }
      }
      if (!best) {
        rest.push(p);
        continue;
      }
      p.side = side;
      p.rot = best.turn;
      centerPartAt(p, (best.r[0] + best.r[2]) / 2, (best.r[1] + best.r[3]) / 2);
      taken.push(best.r);
      delete p.off;
      placedRefs.add(p.ref);
      placed++;
    }
    left = rest;
  }
  // Whatever does not fit waits beside the board, on the left, in columns.
  let y = bb.y1;
  let col = bb.x0 - 6;
  let colW = 0;
  for (const p of left) {
    p.side = 'top';
    p.rot = 0;
    p.off = true;
    const [w, d] = size(p);
    if (y - d < bb.y0 - 20 && colW) {
      col -= colW + 4;
      colW = 0;
      y = bb.y1;
    }
    colW = Math.max(colW, w);
    centerPartAt(p, col - w / 2, y - d / 2);
    y -= d + 3;
  }
  return { placed, off: left.map((p) => p.ref) };
}

// Default 3D size of a part from its package name, when the file has no height. Always an estimate.
export function guessPart(pkg = '', value = '') {
  const s = `${pkg} ${value}`.toUpperCase();
  if (/CPOL|ELKO|ELECTROLYTIC/.test(s)) {
    const m = /_(\d+(?:\.\d+)?)\s*$/.exec(pkg.toUpperCase());
    const d = m ? +m[1] : 6.3;
    return { shape: 'cylinder', h: Math.round(Math.max(5, d * 1.5) * 10) / 10 };
  }
  if (/HDR|HEADER|PINHD|PIN_?HEAD|(^|[_ -])[1-4]X\d{1,2}\b/.test(s)) return { shape: 'box', h: 8.5 };
  if (/JST|CONN|USB|TERMINAL/.test(s)) return { shape: 'box', h: 6 };
  if (/TO-?92/.test(s)) return { shape: 'box', h: 5 };
  if (/TO-?220/.test(s)) return { shape: 'box', h: 15 };
  if (/AXIAL|0207|0204|DO-?41|DO-?35/.test(s)) return { shape: 'box', h: 2.5 };
  if (/\bSMA\b|DIODE_SMA|SMB|SOD|SOT|0402|0603|0805|1206|1210|QFN|SOIC|TSSOP/.test(s)) return { shape: 'box', h: 2.3 };
  if (/C_RAD|CAP|CER/.test(s)) return { shape: 'box', h: 5 };
  return { shape: 'box', h: 3.5 }; // modules and the rest: a small board with parts on it
}

// A colour that says what kind of part it is, the way a rendered board would look.
export function partColor(part) {
  const s = `${part.package || ''} ${part.value || ''}`.toUpperCase();
  if (/CPOL|ELKO|ELECTROLYTIC/.test(s)) return '#2b3f86';
  if (/C_RAD|CER|\bCAP/.test(s)) return '#c58a2a';
  if (/AXIAL|0207|0204|\bRES\b|^R_/.test(s)) return '#c9b48c';
  if (/HDR|HEADER|PINHD|JST|CONN|(^|[_ -])[1-4]X\d{1,2}\b/.test(s)) return '#2d2d30';
  const b = part.body || { w: 0, d: 0 };
  if (b.w * b.d > 120) return '#2f5b8f'; // a module: its own little blue board
  return '#3a3d44';
}

// Closed board outline from loose edge segments ({ a, b, bulge } with the bulge of the arc from a to b),
// as Eagle's Dimension layer and KiCad's Edge.Cuts hold them. A circle or rectangle is recognised.
export function chainOutline(segs) {
  const round = (v, k = 1000) => Math.round(v * k) / k;
  const left = segs.slice();
  if (left.length < 2) return null;
  const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01;
  const chain = [left.shift()];
  while (left.length) {
    const end = chain[chain.length - 1].b;
    const i = left.findIndex((w) => same(w.a, end) || same(w.b, end));
    if (i < 0) break;
    const w = left.splice(i, 1)[0];
    chain.push(same(w.a, end) ? w : { a: w.b, b: w.a, bulge: -(w.bulge || 0) });
  }
  // Each point carries the bulge of the segment that ends at it (as Caliper paths do); the last
  // segment ends where the first starts, so it goes first.
  const pts = chain.map((w) => [round(w.b[0]), round(w.b[1]), w.bulge ? round(w.bulge, 10000) : 0]);
  pts.unshift(pts.pop());
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const hgt = Math.max(...ys) - Math.min(...ys);
  const rectish = pts.length === 4 && pts.every((p) => !p[2]) && pts.every((p, i) => {
    const q = pts[(i + 1) % 4];
    return Math.abs(p[0] - q[0]) < 1e-3 || Math.abs(p[1] - q[1]) < 1e-3;
  });
  if (rectish) return { kind: 'rect', w: round(w, 100), h: round(hgt, 100), x: round(Math.min(...xs) + w / 2), y: round(Math.min(...ys) + hgt / 2) };
  return { kind: 'path', pts };
}

// A rectangle around every part, 1 mm clear (for a board file with no outline).
export function boundingOutline(parts) {
  const pts = parts.flatMap((p) => footprintPolygon(p));
  const b = bounds(pts.length ? pts : [[-20, -15], [20, 15]]);
  return { kind: 'rect', w: Math.ceil(b.x1 - b.x0 + 2), h: Math.ceil(b.y1 - b.y0 + 2), r: 2, x: r3(b.cx), y: r3(b.cy) };
}

// A closed polygon moved inward by d (each corner along the bisector of its edges); for smooth or
// convex outlines, which board outlines are. A negative d grows it.
export function insetPolygon(poly, d) {
  let area = 0;
  for (let i = 0; i < poly.length; i++) area += poly[i][0] * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * poly[i][1];
  const s = area > 0 ? -1 : 1;
  const m = poly.length;
  const unit = (v) => {
    const l = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / l, v[1] / l];
  };
  return poly.map((b, i) => {
    const a = poly[(i - 1 + m) % m];
    const c = poly[(i + 1) % m];
    const n1 = unit([b[1] - a[1], a[0] - b[0]]);
    const n2 = unit([c[1] - b[1], b[0] - c[0]]);
    const n = unit([n1[0] + n2[0], n1[1] + n2[1]]);
    const cos = Math.max(0.3, n1[0] * n[0] + n1[1] * n[1]);
    return [b[0] + (s * d * n[0]) / cos, b[1] + (s * d * n[1]) / cos];
  });
}
