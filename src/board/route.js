// Copper on a board: what is connected (pads, traces and vias that touch), the airwires still to route,
// design-rule checks, and a two-layer grid autorouter. Pure: runs in the page, the worker and Node.
//
// board.traces: [{ net, layer: 'top' | 'bottom', w, pts: [[x, y], …] }]
// board.vias:   [{ x, y, d, drill, net }]
// board.rules:  { clearance, trace, via, drill, edge, minTrace, minDrill }
import { toBoard, boardPolygon, rot2 } from './geometry.js';
import { padShape } from './footprints.js';
import { pointInPolygon, distToPolyline, bounds } from '../sketchgeo.js';

export const RULES = { clearance: 0.2, trace: 0.25, via: 0.6, drill: 0.3, edge: 0.3, minTrace: 0.15, minDrill: 0.3, ring: 0.13 };
export const rulesOf = (b) => ({ ...RULES, ...(b.rules || {}) });
const r3 = (v) => Math.round(v * 1000) / 1000;
const BOTH = ['top', 'bottom'];

// A board with every expression resolved to a number (the worker has no parameter scope).
export function numericBoard(b, n = Number) {
  const num = (v, d = 0) => (v === undefined || v === null ? d : n(v));
  return {
    ...b,
    thickness: num(b.thickness, 1.6),
    outline: b.outline?.kind === 'path' ? { ...b.outline, pts: b.outline.pts.map((p) => p.map((v) => num(v))) } : Object.fromEntries(Object.entries(b.outline || { kind: 'rect', w: 60, h: 40 }).map(([k, v]) => [k, k === 'kind' ? v : num(v)])),
    holes: (b.holes || []).map((h) => ({ x: num(h.x), y: num(h.y), d: num(h.d, 3.2) })),
    parts: (b.parts || []).map((p) => ({ ...p, x: num(p.x), y: num(p.y), rot: num(p.rot), h: num(p.h, 1), lift: num(p.lift) })),
  };
}

// ---------- shapes ----------
// Copper as capsules (a segment with a radius; a round pad is a zero-length one) or convex polygons.
function segSegDist(a, b, c, d) {
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}
export function ptSeg(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function polyEdgesDist(poly, a, b) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, segSegDist(poly[i], poly[(i + 1) % poly.length], a, b));
  return best;
}
// Gap between two copper shapes (0 or less when they touch).
export function shapeGap(s, t) {
  if (s.poly && t.poly) {
    if (s.poly.some((v) => pointInPolygon(v, t.poly)) || t.poly.some((v) => pointInPolygon(v, s.poly))) return 0;
    let best = Infinity;
    for (let i = 0; i < s.poly.length; i++) best = Math.min(best, polyEdgesDist(t.poly, s.poly[i], s.poly[(i + 1) % s.poly.length]));
    return best;
  }
  if (s.poly || t.poly) {
    const p = s.poly ? s : t;
    const c = s.poly ? t : s;
    if (pointInPolygon(c.a, p.poly) || pointInPolygon(c.b, p.poly)) return -c.r;
    return polyEdgesDist(p.poly, c.a, c.b) - c.r;
  }
  return segSegDist(s.a, s.b, t.a, t.b) - s.r - t.r;
}
function shapeBox(s) {
  if (s.poly) {
    const b = bounds(s.poly);
    return [b.x0, b.y0, b.x1, b.y1];
  }
  return [Math.min(s.a[0], s.b[0]) - s.r, Math.min(s.a[1], s.b[1]) - s.r, Math.max(s.a[0], s.b[0]) + s.r, Math.max(s.a[1], s.b[1]) + s.r];
}
// Distance from a point to a shape's copper (negative inside).
function pointGap(p, s) {
  if (s.poly) return pointInPolygon(p, s.poly) ? -0.001 : distToPolyline(p, s.poly);
  return ptSeg(p, s.a, s.b) - s.r;
}

// ---------- copper items ----------
// Every piece of copper: pads of parts on the board, trace segments, vias.
export function copperItems(b) {
  const netOfPad = new Map();
  for (const net of b.nets || []) for (const [ref, pad] of net.pads || []) netOfPad.set(`${ref}.${pad}`, net.name);
  const items = [];
  for (const p of b.parts || []) {
    if (p.off) continue;
    for (const [name, pad] of Object.entries(p.pads || {})) {
      const ps = padShape(pad);
      const c = toBoard(p, pad);
      let shape;
      if (ps.smd) {
        const corners = [
          [pad[0] - ps.w / 2, pad[1] - ps.h / 2],
          [pad[0] + ps.w / 2, pad[1] - ps.h / 2],
          [pad[0] + ps.w / 2, pad[1] + ps.h / 2],
          [pad[0] - ps.w / 2, pad[1] + ps.h / 2],
        ].map((q) => toBoard(p, q));
        shape = { poly: p.side === 'bottom' ? corners.reverse() : corners };
      } else shape = { a: c, b: c, r: ps.w / 2 };
      items.push({ kind: 'pad', id: `${p.ref}.${name}`, ref: p.ref, net: netOfPad.get(`${p.ref}.${name}`) || null, layers: ps.smd ? [p.side === 'bottom' ? 'bottom' : 'top'] : BOTH, shape, at: c, drill: ps.drill });
    }
  }
  (b.traces || []).forEach((t, ti) => {
    for (let i = 0; i + 1 < (t.pts || []).length; i++) items.push({ kind: 'trace', id: `trace:${ti}:${i}`, trace: ti, net: t.net || null, layers: [t.layer === 'bottom' ? 'bottom' : 'top'], shape: { a: t.pts[i], b: t.pts[i + 1], r: (t.w || RULES.trace) / 2 }, at: [(t.pts[i][0] + t.pts[i + 1][0]) / 2, (t.pts[i][1] + t.pts[i + 1][1]) / 2], w: t.w || RULES.trace });
  });
  (b.vias || []).forEach((v, vi) => items.push({ kind: 'via', id: `via:${vi}`, via: vi, net: v.net || null, layers: BOTH, shape: { a: [v.x, v.y], b: [v.x, v.y], r: (v.d || RULES.via) / 2 }, at: [v.x, v.y], drill: v.drill || RULES.drill }));
  for (const it of items) it.box = shapeBox(it.shape);
  return items;
}

// Pairs of items whose boxes come within `pad` of each other and share a layer.
function nearPairs(items, pad, fn) {
  const order = items.map((_, i) => i).sort((i, j) => items[i].box[0] - items[j].box[0]);
  for (let x = 0; x < order.length; x++) {
    const A = items[order[x]];
    for (let y = x + 1; y < order.length; y++) {
      const B = items[order[y]];
      if (B.box[0] > A.box[2] + pad) break;
      if (B.box[1] > A.box[3] + pad || A.box[1] > B.box[3] + pad) continue;
      if (!A.layers.some((l) => B.layers.includes(l))) continue;
      fn(A, B);
    }
  }
}

// ---------- connectivity ----------
// Groups of copper that touch. Each item gets `group`; each group its pads' nets.
export function connectivity(b, items = copperItems(b)) {
  const parent = items.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const index = new Map(items.map((it, i) => [it, i]));
  nearPairs(items, 0.001, (A, B) => {
    if (A.kind === 'pad' && B.kind === 'pad' && A.ref === B.ref) return; // pads of one part only meet through copper
    if (shapeGap(A.shape, B.shape) <= 0.001) parent[find(index.get(A))] = find(index.get(B));
  });
  const groups = new Map();
  items.forEach((it, i) => {
    const g = find(i);
    it.group = g;
    if (!groups.has(g)) groups.set(g, { items: [], nets: new Set() });
    groups.get(g).items.push(it);
    if (it.kind === 'pad' && it.net) groups.get(g).nets.add(it.net);
  });
  // Copper with no net of its own takes its group's.
  for (const it of items) {
    const nets = groups.get(it.group).nets;
    it.groupNet = nets.size === 1 ? [...nets][0] : it.net;
  }
  return { items, groups };
}

// Airwires: the connections each net still needs, joining its separate groups of copper by the
// shortest straight lines (a minimum spanning tree), as routed copper leaves fewer of them.
export function airwires(b, conn = null) {
  const { items } = conn || connectivity(b);
  const off = new Set((b.parts || []).filter((p) => p.off).map((p) => p.ref));
  const pads = new Map();
  for (const p of b.parts || []) for (const [name, pad] of Object.entries(p.pads || {})) pads.set(`${p.ref}.${name}`, toBoard(p, pad));
  const groupOf = new Map(items.filter((it) => it.kind === 'pad').map((it) => [it.id, it.group]));
  const out = [];
  for (const net of b.nets || []) {
    const keys = [...new Set((net.pads || []).map(([ref, pad]) => `${ref}.${pad}`))].filter((k) => pads.has(k));
    // One node per group of connected copper; parts beside the board are their own nodes.
    const nodes = new Map();
    for (const k of keys) {
      const g = groupOf.has(k) ? `g${groupOf.get(k)}` : `k${k}`;
      if (!nodes.has(g)) nodes.set(g, []);
      nodes.get(g).push(k);
    }
    const list = [...nodes.values()];
    if (list.length < 2) continue;
    const inTree = [0];
    const rest = list.map((_, i) => i).slice(1);
    while (rest.length) {
      let best = null;
      for (const a of inTree)
        for (const bI of rest)
          for (const ka of list[a])
            for (const kb of list[bI]) {
              const pa = pads.get(ka);
              const pb = pads.get(kb);
              const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
              if (!best || d < best.d) best = { a: ka, b: kb, d, i: bI };
            }
      const offBoard = off.has(best.a.split('.')[0]) || off.has(best.b.split('.')[0]);
      out.push({ net: net.name, from: pads.get(best.a), to: pads.get(best.b), length: best.d, a: best.a, b: best.b, ...(offBoard ? { offBoard: true } : {}) });
      inTree.push(best.i);
      rest.splice(rest.indexOf(best.i), 1);
    }
  }
  return out;
}

// ---------- design rules ----------
// Returns [{ kind, message, at: [x, y], nets?, refs? }].
export function drc(b, rules = rulesOf(b)) {
  const conn = connectivity(b);
  const { items, groups } = conn;
  const issues = [];
  const fmt = (v) => r3(v);
  const name = (it) => (it.kind === 'pad' ? `pad ${it.id}` : it.kind === 'via' ? 'a via' : `a ${it.layers[0]} trace`);
  // Shorts: one piece of copper joining pads of different nets.
  for (const g of groups.values()) {
    if (g.nets.size < 2) continue;
    const at = g.items.find((it) => it.kind !== 'pad')?.at || g.items[0].at;
    issues.push({ kind: 'short', message: `Short: ${[...g.nets].join(' and ')} are joined by copper.`, at, nets: [...g.nets] });
  }
  // Clearance between copper of different nets.
  const seen = new Set();
  nearPairs(items, rules.clearance, (A, B) => {
    if (A.kind === 'pad' && B.kind === 'pad' && A.ref === B.ref) return;
    if (A.group === B.group) return;
    const na = A.groupNet;
    const nb = B.groupNet;
    if (na && nb && na === nb) return; // same net, not joined yet: an airwire, not a problem
    const gap = shapeGap(A.shape, B.shape);
    if (gap >= rules.clearance - 1e-6) return;
    const key = `${A.group}|${B.group}|${A.layers.join()}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({
      kind: 'clearance',
      message: `${name(A)}${na ? ` (${na})` : ''} is ${fmt(Math.max(0, gap))} mm from ${name(B)}${nb ? ` (${nb})` : ''}; the rule is ${rules.clearance} mm.`,
      at: [(A.at[0] + B.at[0]) / 2, (A.at[1] + B.at[1]) / 2],
      nets: [na, nb].filter(Boolean),
    });
  });
  // Board edge and mounting holes.
  const outline = boardPolygon(b);
  for (const it of items) {
    if (it.kind === 'pad') continue; // parts have their own edge check in the placement check
    const pts = it.shape.poly || [it.shape.a, it.shape.b];
    const r = it.shape.r || 0;
    const outside = pts.some((p) => !pointInPolygon(p, outline));
    const gap = Math.min(...pts.map((p) => distToPolyline(p, outline))) - r;
    if (outside || gap < rules.edge - 1e-6) issues.push({ kind: 'edge', message: `${name(it)}${it.groupNet ? ` (${it.groupNet})` : ''} is ${outside ? 'off the board' : `${fmt(Math.max(0, gap))} mm from the board edge (rule ${rules.edge} mm)`}.`, at: it.at });
    for (const h of b.holes || []) {
      const g = pointGap([h.x, h.y], it.shape) - h.d / 2;
      if (g < rules.clearance) issues.push({ kind: 'hole', message: `${name(it)} is ${fmt(Math.max(0, g))} mm from the hole at (${fmt(h.x)}, ${fmt(h.y)}).`, at: [h.x, h.y] });
    }
  }
  // Sizes.
  (b.traces || []).forEach((t, i) => {
    if ((t.w || RULES.trace) < rules.minTrace - 1e-9) issues.push({ kind: 'width', message: `A ${t.layer} trace${t.net ? ` (${t.net})` : ''} is ${t.w} mm wide; the minimum is ${rules.minTrace} mm.`, at: t.pts[0], trace: i });
  });
  (b.vias || []).forEach((v) => {
    if ((v.drill || RULES.drill) < rules.minDrill - 1e-9) issues.push({ kind: 'drill', message: `A via drill of ${v.drill} mm is under the ${rules.minDrill} mm minimum.`, at: [v.x, v.y] });
    if (((v.d || RULES.via) - (v.drill || RULES.drill)) / 2 < rules.ring - 1e-9) issues.push({ kind: 'drill', message: `A via at (${fmt(v.x)}, ${fmt(v.y)}) has too thin a copper ring.`, at: [v.x, v.y] });
  });
  const open = airwires(b, conn).filter((w) => !w.offBoard);
  return { issues, unrouted: open.length, airwires: open };
}

// ---------- autorouter ----------
// A two-layer maze router on a grid: shortest connections first, 45° moves, vias where a layer is
// blocked, existing copper kept. Returns new { traces, vias } and the connections it could not route.
export function autoroute(src, opts = {}) {
  const b = src;
  const rules = { ...rulesOf(b), ...(opts.rules || {}) };
  const w = opts.width || rules.trace;
  const step = opts.step || Math.max(0.1, Math.min(0.25, (w + rules.clearance) / 2));
  const viaD = rules.via;
  const viaDrill = Math.max(rules.drill, rules.minDrill);
  const outline = boardPolygon(b);
  const bb = bounds(outline);
  const x0 = bb.x0 - step;
  const y0 = bb.y0 - step;
  const nx = Math.ceil((bb.x1 - bb.x0) / step) + 3;
  const ny = Math.ceil((bb.y1 - bb.y0) / step) + 3;
  const N = nx * ny;
  if (N > 4e6) throw new Error('The board is too big for the autorouter at this grid.');
  const nets = (b.nets || []).map((n) => n.name);
  const netIdx = new Map(nets.map((n, i) => [n, i + 1]));
  const only = opts.nets ? new Set(opts.nets) : null;
  const cx = (i) => x0 + i * step;
  const cy = (j) => y0 + j * step;
  // Occupancy per layer: 0 free, -1 blocked, k a net's own copper zone, -2 zones of several nets.
  const occ = [new Int32Array(N), new Int32Array(N)];
  const L = (layer) => (layer === 'bottom' ? 1 : 0);
  const inflate = rules.clearance + w / 2;
  const mark = (shape, layers, k, extra = inflate) => {
    const box = shapeBox(shape);
    const i0 = Math.max(0, Math.floor((box[0] - extra - x0) / step));
    const i1 = Math.min(nx - 1, Math.ceil((box[2] + extra - x0) / step));
    const j0 = Math.max(0, Math.floor((box[1] - extra - y0) / step));
    const j1 = Math.min(ny - 1, Math.ceil((box[3] + extra - y0) / step));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        if (pointGap([cx(i), cy(j)], shape) > extra) continue;
        for (const layer of layers) {
          const o = occ[L(layer)];
          const c = j * nx + i;
          if (o[c] === -1) continue;
          if (k <= 0) o[c] = -1;
          else if (o[c] === 0) o[c] = k;
          else if (o[c] !== k) o[c] = -2;
        }
      }
  };
  // The board edge and the holes block both layers.
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const p = [cx(i), cy(j)];
      if (!pointInPolygon(p, outline) || distToPolyline(p, outline) < rules.edge + w / 2) occ[0][j * nx + i] = occ[1][j * nx + i] = -1;
    }
  for (const h of b.holes || []) mark({ a: [h.x, h.y], b: [h.x, h.y], r: h.d / 2 }, BOTH, -1);
  const conn = connectivity(b);
  for (const it of conn.items) {
    const net = it.groupNet;
    mark(it.shape, it.layers, net && netIdx.has(net) ? netIdx.get(net) : -1);
  }
  const free = (layer, c, k) => {
    const v = occ[layer][c];
    return v === 0 || v === k;
  };
  // Through-hole copper of other nets also blocks vias placed next to it.
  const viaR = Math.ceil((viaD / 2 + rules.clearance) / step);
  const viaOk = (i, j, k) => {
    for (let dj = -viaR; dj <= viaR; dj++)
      for (let di = -viaR; di <= viaR; di++) {
        if (di * di + dj * dj > viaR * viaR) continue;
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) return false;
        const c = jj * nx + ii;
        if (!free(0, c, k) || !free(1, c, k)) return false;
      }
    return true;
  };
  const DIRS = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  // Search state is (layer, cell); the direction a cell was reached from is kept beside it, so turns
  // cost a little without multiplying the states by eight.
  const S = 2 * N;
  const gScore = new Float32Array(S);
  const from = new Int32Array(S);
  const arrive = new Int8Array(S);
  const stamp = new Int32Array(S);
  const closed = new Int32Array(S);
  let epoch = 0;
  let hk = new Float64Array(1 << 16);
  let hv = new Int32Array(1 << 16);
  let hn = 0;
  const push = (f, s) => {
    if (hn === hk.length) {
      const k2 = new Float64Array(hn * 2);
      k2.set(hk);
      hk = k2;
      const v2 = new Int32Array(hn * 2);
      v2.set(hv);
      hv = v2;
    }
    let i = hn++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= f) break;
      hk[i] = hk[p];
      hv[i] = hv[p];
      i = p;
    }
    hk[i] = f;
    hv[i] = s;
  };
  const pop = () => {
    const top = hv[0];
    const f = hk[--hn];
    const v = hv[hn];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= hn) break;
      const m = l + 1 < hn && hk[l + 1] < hk[l] ? l + 1 : l;
      if (hk[m] >= f) break;
      hk[i] = hk[m];
      hv[i] = hv[m];
      i = m;
    }
    hk[i] = f;
    hv[i] = v;
    return top;
  };
  const cellOf = (p) => [Math.round((p[0] - x0) / step), Math.round((p[1] - y0) / step)];
  const VIA_COST = opts.viaCost ?? 12;
  const TURN = 0.4;
  // One connection: from the copper of group A to the copper of group B, both of net k.
  const search = (k, starts, goal, target) => {
    epoch++;
    hn = 0;
    const h = (i, j) => {
      const dx = Math.abs(cx(i) - target[0]) / step;
      const dy = Math.abs(cy(j) - target[1]) / step;
      return (Math.max(dx, dy) + 0.4142 * Math.min(dx, dy)) * 1.3;
    };
    for (const [layer, i, j] of starts) {
      const s = layer * N + j * nx + i;
      stamp[s] = epoch;
      gScore[s] = 0;
      from[s] = -1;
      arrive[s] = 8;
      push(h(i, j), s);
    }
    const dist = Math.hypot(target[0] - cx(starts[0][1]), target[1] - cy(starts[0][2])) / step;
    let budget = opts.budget || Math.max(40000, Math.min(400000, dist * dist * 40));
    while (hn && budget-- > 0) {
      const s = pop();
      if (closed[s] === epoch) continue;
      closed[s] = epoch;
      const layer = s >= N ? 1 : 0;
      const c = s - layer * N;
      const i = c % nx;
      const j = (c - i) / nx;
      const g = gScore[s];
      const dir = arrive[s];
      if (goal(layer, c)) return { s, layer };
      const relax = (ns, cost, ni, nj, d) => {
        const ng = g + cost;
        if (stamp[ns] === epoch && gScore[ns] <= ng) return;
        stamp[ns] = epoch;
        gScore[ns] = ng;
        from[ns] = s;
        arrive[ns] = d;
        push(ng + h(ni, nj), ns);
      };
      for (let d = 0; d < 8; d++) {
        const ni = i + DIRS[d][0];
        const nj = j + DIRS[d][1];
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nc = nj * nx + ni;
        if (!free(layer, nc, k)) continue;
        if (d % 2 && (!free(layer, j * nx + ni, k) || !free(layer, nj * nx + i, k))) continue; // no corner cutting
        const turn = dir === 8 ? 0 : Math.min((d - dir + 8) % 8, (dir - d + 8) % 8);
        if (turn > 2) continue; // no hairpins
        relax(layer * N + nc, (d % 2 ? 1.4142 : 1) + turn * TURN, ni, nj, d);
      }
      if (viaOk(i, j, k)) relax((1 - layer) * N + c, VIA_COST, i, j, 8);
    }
    return null;
  };
  const added = { traces: [], vias: [] };
  const failed = [];
  const wires = airwires(b, conn)
    .filter((x) => !x.offBoard && (!only || only.has(x.net)) && netIdx.has(x.net))
    .sort((p, q) => p.length - q.length);
  const order = opts.order ? opts.order.map((i) => wires[i]).filter(Boolean) : wires;
  const padItems = new Map(conn.items.filter((it) => it.kind === 'pad').map((it) => [it.id, it]));
  for (const wire of order) {
    const k = netIdx.get(wire.net);
    const A = padItems.get(wire.a);
    const B = padItems.get(wire.b);
    if (!A || !B) continue;
    const starts = [];
    const [ai, aj] = cellOf(A.at);
    for (const layer of A.layers) starts.push([L(layer), ai, aj]);
    const goalLayers = B.layers.map(L);
    const goal = (layer, c) => {
      if (!goalLayers.includes(layer)) return false;
      const i = c % nx;
      const j = (c - i) / nx;
      return pointGap([cx(i), cy(j)], B.shape) <= step * 0.5;
    };
    // A start cell sits inside its own pad's zone; make sure it is open for this net.
    for (const [layer, i, j] of starts) if (occ[layer][j * nx + i] !== k && occ[layer][j * nx + i] !== 0) occ[layer][j * nx + i] = k;
    const found = search(k, starts, goal, B.at);
    if (!found) {
      failed.push({ net: wire.net, a: wire.a, b: wire.b });
      continue;
    }
    // Walk back to the start, then turn the cells into traces (one per layer run) and vias.
    const cells = [];
    for (let s = found.s; s !== -1; s = from[s]) {
      const layer = s >= N ? 1 : 0;
      const c = s - layer * N;
      cells.push([layer, c % nx, (c - (c % nx)) / nx]);
    }
    cells.reverse();
    const runs = [];
    for (const [layer, i, j] of cells) {
      const last = runs[runs.length - 1];
      if (!last || last.layer !== layer) runs.push({ layer, pts: [[i, j]] });
      else last.pts.push([i, j]);
    }
    runs.forEach((run, ri) => {
      // Drop points where the direction does not change.
      const pts = [];
      for (let q = 0; q < run.pts.length; q++) {
        const p = run.pts[q];
        if (pts.length >= 2) {
          const a = pts[pts.length - 2];
          const m = pts[pts.length - 1];
          if ((m[0] - a[0]) * (p[1] - m[1]) === (m[1] - a[1]) * (p[0] - m[0]) && Math.sign(m[0] - a[0]) === Math.sign(p[0] - m[0]) && Math.sign(m[1] - a[1]) === Math.sign(p[1] - m[1])) pts[pts.length - 1] = p;
          else pts.push(p);
        } else if (!pts.length || pts[pts.length - 1][0] !== p[0] || pts[pts.length - 1][1] !== p[1]) pts.push(p);
      }
      let mm = pts.map(([i, j]) => [r3(cx(i)), r3(cy(j))]);
      if (ri === 0) mm.unshift([r3(A.at[0]), r3(A.at[1])]);
      if (ri === runs.length - 1) mm.push([r3(B.at[0]), r3(B.at[1])]);
      mm = mm.filter((p, q) => q === 0 || p[0] !== mm[q - 1][0] || p[1] !== mm[q - 1][1]);
      const layer = run.layer ? 'bottom' : 'top';
      if (mm.length >= 2) {
        const t = { net: wire.net, layer, w, pts: mm };
        added.traces.push(t);
        for (let q = 0; q + 1 < mm.length; q++) mark({ a: mm[q], b: mm[q + 1], r: w / 2 }, [layer], k);
      }
      if (ri < runs.length - 1) {
        const [i, j] = run.pts[run.pts.length - 1];
        const v = { x: r3(cx(i)), y: r3(cy(j)), d: viaD, drill: viaDrill, net: wire.net };
        added.vias.push(v);
        mark({ a: [v.x, v.y], b: [v.x, v.y], r: viaD / 2 }, BOTH, k);
      }
    });
  }
  return { ...added, routed: order.length - failed.length, failed, total: order.length, grid: step };
}

// Route, and if some connections fail, try once more with those first; keep the better result.
export function autorouteBest(b, opts = {}) {
  const first = autoroute(b, opts);
  if (!first.failed.length || opts.single) return first;
  const wires = airwires(b)
    .filter((x) => !x.offBoard && (!opts.nets || opts.nets.includes(x.net)))
    .sort((p, q) => p.length - q.length);
  const failedKeys = new Set(first.failed.map((f) => `${f.a}|${f.b}`));
  const idx = wires.map((_, i) => i);
  const order = [...idx.filter((i) => failedKeys.has(`${wires[i].a}|${wires[i].b}`)), ...idx.filter((i) => !failedKeys.has(`${wires[i].a}|${wires[i].b}`))];
  const second = autoroute(b, { ...opts, order });
  return second.failed.length < first.failed.length ? second : first;
}

// Length of copper per net, for reports.
export function copperLength(b) {
  const out = {};
  for (const t of b.traces || []) {
    let len = 0;
    for (let i = 0; i + 1 < t.pts.length; i++) len += Math.hypot(t.pts[i + 1][0] - t.pts[i][0], t.pts[i + 1][1] - t.pts[i][1]);
    out[t.net || '(no net)'] = r3((out[t.net || '(no net)'] || 0) + len);
  }
  return out;
}

export { rot2 };
