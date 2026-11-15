// Placement that knows the circuit: parts that connect pull together. Starting from wherever the
// parts are, it tries moving each part toward the parts it connects to, turning it, and swapping it
// with a part of about the same size, and keeps every change that shortens the connections
// (half-perimeter wire length per net) while staying on the board, clear of the edge, the holes and
// the other parts. Parts beside the board (off) and the ones in `fixed` stay put.
import { toBoard, boardPolygon, footprintPolygon, bodyCenter, rot2, pinBoxes, autoPlace, footprintBox, boundingOutline } from './geometry.js';
import { pointInPolygon, distToPolyline, bounds } from '../sketchgeo.js';

const r3 = (v) => Math.round(v * 1000) / 1000;

export function improvePlacement(board, n = Number, { fixed = [], gap = 1, margin = 1, rounds = 10, step = 0.5 } = {}) {
  const outline = boardPolygon(board, n);
  const parts = (board.parts || []).filter((p) => !p.off);
  const movable = parts.filter((p) => !fixed.includes(p.ref));
  const holes = (board.holes || []).map((h) => ({ c: [n(h.x), n(h.y)], r: n(h.d) / 2 + gap }));
  const nets = (board.nets || []).map((net) => (net.pads || []).map(([ref, pad]) => ({ ref, pad })));
  const byRef = new Map(parts.map((p) => [p.ref, p]));
  const netsOf = new Map(parts.map((p) => [p.ref, []]));
  nets.forEach((list, i) => {
    for (const { ref } of list) if (netsOf.has(ref) && !netsOf.get(ref).includes(i)) netsOf.get(ref).push(i);
  });
  const padAt = (p, pad) => toBoard(p, p.pads?.[pad] || [0, 0]);
  const netLen = (i) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let k = 0;
    for (const { ref, pad } of nets[i]) {
      const p = byRef.get(ref);
      if (!p) continue;
      const q = padAt(p, pad);
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
      k++;
    }
    return k > 1 ? x1 - x0 + (y1 - y0) : 0;
  };
  const costOf = (refs) => {
    const ids = new Set();
    for (const r of refs) for (const i of netsOf.get(r) || []) ids.add(i);
    let c = 0;
    for (const i of ids) c += netLen(i);
    return c;
  };
  const total = () => nets.reduce((s, _, i) => s + netLen(i), 0);
  // Room each part takes (its footprint box, grown by half the gap) and whether a part fits.
  const boxOf = (p) => {
    const b = bounds(footprintPolygon(p));
    return [b.x0 - gap / 2, b.y0 - gap / 2, b.x1 + gap / 2, b.y1 + gap / 2];
  };
  const boxes = new Map(parts.map((p) => [p.ref, boxOf(p)]));
  const zr = (p) => [n(p.lift ?? 0), n(p.lift ?? 0) + n(p.h ?? 1)];
  const fits = (p, ignore = []) => {
    const poly = footprintPolygon(p);
    if (poly.some((v) => !pointInPolygon(v, outline) || distToPolyline(v, outline) < margin - 1e-9)) return false;
    const b = boxOf(p);
    for (const h of holes) if (Math.hypot(Math.max(b[0] - h.c[0], 0, h.c[0] - b[2]), Math.max(b[1] - h.c[1], 0, h.c[1] - b[3])) < h.r - gap / 2) return false;
    const za = zr(p);
    const ov = (a, c, g = 0) => a[0] < c[2] + g && c[0] < a[2] + g && a[1] < c[3] + g && c[1] < a[3] + g;
    const myPins = pinBoxes(p);
    for (const q of parts) {
      if (q === p || ignore.includes(q)) continue;
      if ((q.side || 'top') !== (p.side || 'top')) {
        // Pins through the board, either way.
        const c = boxes.get(q.ref);
        if (n(q.lift ?? 0) < 3 && myPins.some((x) => ov(x, c, 0.3))) return false;
        if (n(p.lift ?? 0) < 3 && pinBoxes(q).some((x) => ov(x, b, 0.3))) return false;
        continue;
      }
      const zb = zr(q);
      if (za[1] <= zb[0] || zb[1] <= za[0]) continue;
      const c = boxes.get(q.ref);
      if (b[0] < c[2] && c[0] < b[2] && b[1] < c[3] && c[1] < b[3]) return false;
    }
    return true;
  };
  const snapshot = (p) => ({ x: p.x, y: p.y, rot: p.rot });
  const restore = (p, s) => Object.assign(p, s);
  // Put the centre of a part's body at (x, y).
  const centreAt = (p, x, y) => {
    const c = bodyCenter(p);
    p.x = r3(n(p.x) + x - c[0]);
    p.y = r3(n(p.y) + y - c[1]);
  };
  const start = total();
  let moves = 0;
  for (let round = 0; round < rounds; round++) {
    let improved = 0;
    for (const p of movable) {
      // 1. Toward where its connections pull it, in shrinking steps.
      const pulls = [];
      for (const i of netsOf.get(p.ref)) {
        const others = nets[i].filter((x) => x.ref !== p.ref && byRef.has(x.ref)).map((x) => padAt(byRef.get(x.ref), x.pad));
        if (!others.length) continue;
        pulls.push([others.reduce((s, q) => s + q[0], 0) / others.length, others.reduce((s, q) => s + q[1], 0) / others.length]);
      }
      if (pulls.length) {
        const target = [pulls.reduce((s, q) => s + q[0], 0) / pulls.length, pulls.reduce((s, q) => s + q[1], 0) / pulls.length];
        const c0 = bodyCenter(p);
        for (const f of [1, 0.6, 0.35, 0.2, 0.1]) {
          const before = costOf([p.ref]);
          const s = snapshot(p);
          const x = Math.round((c0[0] + (target[0] - c0[0]) * f) / step) * step;
          const y = Math.round((c0[1] + (target[1] - c0[1]) * f) / step) * step;
          centreAt(p, x, y);
          if (fits(p) && costOf([p.ref]) < before - 0.05) {
            boxes.set(p.ref, boxOf(p));
            improved++;
            moves++;
            break;
          }
          restore(p, s);
        }
      }
      // 2. Turned a quarter, a half or three quarters, about its centre.
      for (const turn of [90, 180, 270]) {
        const before = costOf([p.ref]);
        const s = snapshot(p);
        const c = bodyCenter(p);
        p.rot = (((n(p.rot) || 0) + turn) % 360 + 360) % 360;
        centreAt(p, c[0], c[1]);
        if (fits(p) && costOf([p.ref]) < before - 0.05) {
          boxes.set(p.ref, boxOf(p));
          improved++;
          moves++;
          break;
        }
        restore(p, s);
      }
      // 3. Swapped with a part of about the same size on the same side.
      const bp = boxes.get(p.ref);
      const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
      for (const q of movable) {
        if (q === p || (q.side || 'top') !== (p.side || 'top')) continue;
        const bq = boxes.get(q.ref);
        if (Math.abs(area(bq) - area(bp)) > 0.8 * Math.max(area(bp), area(bq))) continue;
        const before = costOf([p.ref, q.ref]);
        const sp = snapshot(p);
        const sq = snapshot(q);
        const cp = bodyCenter(p);
        const cq = bodyCenter(q);
        let good = false;
        for (const [tp, tq] of [[0, 0], [90, 0], [0, 90], [90, 90]]) {
          restore(p, sp);
          restore(q, sq);
          if (tp) p.rot = (((n(p.rot) || 0) + tp) % 360 + 360) % 360;
          if (tq) q.rot = (((n(q.rot) || 0) + tq) % 360 + 360) % 360;
          centreAt(p, cq[0], cq[1]);
          centreAt(q, cp[0], cp[1]);
          if (fits(p, [q]) && fits(q, [p])) {
            good = true;
            break;
          }
        }
        if (good && costOf([p.ref, q.ref]) < before - 0.05) {
          boxes.set(p.ref, boxOf(p));
          boxes.set(q.ref, boxOf(q));
          // Both moved: make sure they do not overlap each other.
          const a = boxes.get(p.ref);
          const b = boxes.get(q.ref);
          if (!(a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3])) {
            improved++;
            moves++;
            break;
          }
        }
        restore(p, sp);
        restore(q, sq);
        boxes.set(p.ref, boxOf(p));
        boxes.set(q.ref, boxOf(q));
      }
    }
    if (!improved) break;
  }
  return { before: Math.round(start), after: Math.round(total()), moves };
}

// Arrange parts automatically, the better of two ways: rows (packs the most) or each part next to
// what it connects to; then shorten the connections further. Same options as autoPlace.
export function arrangeBoard(board, n = Number, opts = {}) {
  const wire = (b) => {
    let len = 0;
    for (const net of b.nets || []) {
      const pts = (net.pads || []).map(([ref, pad]) => b.parts.find((p) => p.ref === ref && !p.off)).map((p, i) => (p ? toBoard(p, p.pads?.[net.pads[i][1]] || [0, 0]) : null)).filter(Boolean);
      if (pts.length > 1) len += Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0])) + Math.max(...pts.map((q) => q[1])) - Math.min(...pts.map((q) => q[1]));
    }
    return len;
  };
  const tries = [false, true].map((connect) => {
    const b = structuredClone(board);
    const res = autoPlace(b, n, { ...opts, connect });
    improvePlacement(b, n, { gap: Math.max(opts.gap ?? 1, connect ? 2 : opts.gap ?? 1), margin: opts.margin ?? 1 });
    return { b, res, len: wire(b) };
  });
  const best = tries.sort((x, y) => y.res.placed - x.res.placed || x.len - y.len)[0];
  board.parts = best.b.parts;
  return { ...best.res, connections_mm: Math.round(best.len) };
}

// Parts from a schematic or netlist have no places yet: arrange them on the given outline, or on a
// rectangle drawn to fit them (grown until all fit, then trimmed to them). Returns a note.
export function layoutNewBoard(out) {
  const parts = out.parts;
  const made = !out.outline;
  if (made) {
    const area = parts.reduce((sum, p) => {
      const f = footprintBox(p);
      return sum + (f.x1 - f.x0 + 2) * (f.y1 - f.y0 + 2);
    }, 0) * 1.5;
    const w = Math.max(20, Math.ceil(Math.sqrt(area * 1.33) / 5) * 5);
    out.outline = { kind: 'rect', w, h: Math.max(15, Math.ceil(area / w / 5) * 5), r: 2 };
  }
  let res = arrangeBoard(out);
  for (let i = 0; made && res.off.length && i < 12; i++) {
    out.outline.w += 5;
    out.outline.h += 5;
    res = arrangeBoard(out);
  }
  if (made && !res.off.length) {
    const o = boundingOutline(out.parts);
    for (const p of out.parts) {
      p.x = Math.round((p.x - o.x) * 1000) / 1000;
      p.y = Math.round((p.y - o.y) * 1000) / 1000;
    }
    out.outline = { kind: 'rect', w: o.w, h: o.h, r: 2 };
  }
  const placed = out.parts.filter((p) => !p.off).length;
  return placed === parts.length ? `Arranged all ${parts.length} parts on the board, connected parts near each other (the file does not say where they go); drag them where you want them.` : `Arranged ${placed} of ${parts.length} parts on the board; the rest wait beside it until you drag them on.`;
}

export { rot2 };
