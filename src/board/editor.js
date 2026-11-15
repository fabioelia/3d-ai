// The board placement editor: a top-down 2D view of the board over the 3D view, where parts are
// dragged into place, turned and flipped, with airwires showing what connects to what and clashes
// drawn in red as they happen, and copper routing: traces on two layers, vias, an autorouter and
// design-rule checks (like the board editor in Fusion, Eagle or KiCad).
import { evalExpr } from '../expr.js';
import { boardPolygon, partPolygon, footprintPolygon, toBoard, checkBoard, boardExtent, overBoard, turnPart, flipPart, autoPlace, bodyCenter } from './geometry.js';
import { airwires, connectivity, drc, copperItems, numericBoard, rulesOf, ptSeg } from './route.js';
import { pointInPolygon } from '../sketchgeo.js';
import { arrangeBoard, improvePlacement } from './placement.js';

export const GRIDS = [0.1, 0.25, 0.5, 1, 1.27, 2.54, 5];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const r3 = (v) => Math.round(v * 1000) / 1000;
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

function cssColor(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export class BoardEditor {
  // api: { board(): feature|null, scope(): params, change(fn, key), select(ref|null), selected(): ref|null,
  //        hover(text), tool(): 'select'|'hole', setTool(t), toast(msg) }
  constructor(stage, api) {
    this.stage = stage;
    this.api = api;
    this.active = false;
    this.view = null;
    this.flip = false; // looking from below
    this.grid = 0.5;
    this.drag = null;
    this.work = null;
    this.layer = 'top'; // the copper layer the route tool draws on
    this.route = null; // a trace being drawn: { net, layer, w, pts, done: { traces, vias } }
    this.cursor = null;
    this.el = document.createElement('div');
    this.el.className = 'board-editor';
    this.el.hidden = true;
    this.el.tabIndex = -1;
    this.chip = document.createElement('div');
    this.chip.className = 'be-chip';
    this.svgHost = document.createElement('div');
    this.svgHost.className = 'be-svg';
    this.el.append(this.svgHost, this.chip);
    stage.append(this.el);
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('pointermove', (e) => this.move(e));
    this.el.addEventListener('pointerup', (e) => this.up(e));
    this.el.addEventListener('pointercancel', (e) => this.up(e));
    this.el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.el.addEventListener('dblclick', (e) => {
      if (this.route) return this.finishRoute();
      if (!e.target.closest('[data-ref]') && !e.target.closest('[data-trace]')) this.fit();
    });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.active && this.render()).observe(this.el);
  }

  n = (v) => {
    try {
      return evalExpr(v ?? 0, this.api.scope());
    } catch {
      return 0;
    }
  };

  board() {
    return this.work || this.api.board();
  }

  enter() {
    this.active = true;
    this.el.hidden = false;
    this.readColors();
    if (!this.view || this.viewFor !== this.api.board()?.id) {
      this.viewFor = this.api.board()?.id;
      this.fit(false);
    }
    this.render();
    this.el.focus({ preventScroll: true });
  }

  exit() {
    this.active = false;
    this.route = null;
    this.drag = null;
    this.work = null;
    this.el.hidden = true;
    this.api.hover('');
  }

  readColors() {
    const el = this.el;
    this.c = {
      bg: cssColor(el, '--bd-bg', '#10161c'),
      grid: cssColor(el, '--bd-grid', 'rgba(255,255,255,0.06)'),
      gridMajor: cssColor(el, '--bd-grid-major', 'rgba(255,255,255,0.13)'),
      pcb: cssColor(el, '--bd-pcb', '#1f5130'),
      pcbEdge: cssColor(el, '--bd-pcb-edge', '#7bc48f'),
      pad: cssColor(el, '--bd-pad', '#d6ad55'),
      air: cssColor(el, '--bd-air', '#e9d66b'),
      sel: cssColor(el, '--bd-sel', '#ffb347'),
      bad: cssColor(el, '--bd-bad', '#ff5a52'),
      text: cssColor(el, '--bd-text', '#f2f5f7'),
      partEdge: cssColor(el, '--bd-part-edge', 'rgba(255,255,255,0.55)'),
      hole: cssColor(el, '--bd-hole', '#0b0f13'),
      top: cssColor(el, '--bd-top', '#d0503f'),
      bottom: cssColor(el, '--bd-bottom', '#4a7fd6'),
    };
  }

  size() {
    const r = this.el.getBoundingClientRect();
    return [Math.max(50, r.width), Math.max(50, r.height)];
  }

  fit(draw = true, size = null) {
    const b = this.board();
    if (!b) return;
    const ext = boardExtent(b, this.n);
    const [W, H] = size || this.size();
    const pad = 1.12;
    const s = Math.min(W / Math.max(1, (ext.x1 - ext.x0) * pad), (H - 40) / Math.max(1, (ext.y1 - ext.y0) * pad));
    const view = { cx: ext.cx, cy: ext.cy, s: Math.max(0.5, Math.min(80, s)) };
    if (size) return view;
    this.view = view;
    if (draw) this.render();
    return view;
  }

  // Board millimetres <-> screen pixels.
  toS(p, view = this.view, size = this.size(), flip = this.flip) {
    const [W, H] = size;
    return [W / 2 + (flip ? -1 : 1) * (p[0] - view.cx) * view.s, H / 2 - (p[1] - view.cy) * view.s];
  }
  fromS(x, y) {
    const [W, H] = this.size();
    const r = this.el.getBoundingClientRect();
    const sx = x - r.left;
    const sy = y - r.top;
    return [this.view.cx + ((this.flip ? -1 : 1) * (sx - W / 2)) / this.view.s, this.view.cy - (sy - H / 2) / this.view.s];
  }

  // ---------- drawing ----------
  render() {
    if (!this.active) return;
    const b = this.board();
    if (!b) return;
    if (this.viewFor !== b.id) {
      // Another board: frame it.
      this.viewFor = b.id;
      this.route = null;
      this.fit(false);
    }
    this.svgHost.innerHTML = this.svg(b, this.view, this.size(), this.flip, this.api.selected());
    const placed = (b.parts || []).filter((p) => !p.off).length;
    const issues = this.issues.filter((i) => i.kind !== 'unplaced');
    const rules = this.drcResult;
    const copper = rules ? ` · ${rules.unrouted ? `${rules.unrouted} to route` : 'all routed'}${rules.issues.length ? ` · <span class="bad">${rules.issues.length} DRC error${rules.issues.length === 1 ? '' : 's'}</span>` : (b.traces || []).length ? ' · DRC clean' : ''}` : '';
    const routing = this.route ? ` · routing ${esc(this.route.net || 'a trace')} on the ${this.route.layer} (V: via, Backspace: undo point, double-click: finish, Esc: cancel)` : this.api.tool() === 'route' ? ` · click a pad to start a trace on the ${this.layer}` : '';
    this.chip.innerHTML = !(b.parts || []).length
      ? `No parts yet: import a schematic or board file, or use <b>Add a block</b> in the inspector · grid ${this.grid} mm`
      : `<b>${placed}/${(b.parts || []).length}</b> parts on the board · ${issues.length ? `<span class="bad">${issues.length} problem${issues.length === 1 ? '' : 's'}</span>` : 'no clashes'}${copper} · from ${this.flip ? 'below' : 'above'} · grid ${this.grid} mm${routing}`;
  }

  svg(b, view, size, flip, selected, { forShot = false } = {}) {
    const c = this.c;
    const [W, H] = size;
    const P = (p) => this.toS(p, view, size, flip);
    const path = (poly) => `M${poly.map((p) => P(p).map((v) => v.toFixed(1)).join(',')).join('L')}Z`;
    const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="IBM Plex Sans, system-ui, sans-serif">`];
    out.push(`<rect width="${W}" height="${H}" fill="${c.bg}"/>`);
    // Grid: the snap grid when it is wide enough to see, millimetres otherwise, centimetres stronger.
    let g = this.grid;
    while (g * view.s < 7) g *= g < 1 ? 2 : g < 5 ? 2 : 5;
    const lines = [];
    const major = [];
    const x0 = view.cx - W / 2 / view.s;
    const x1 = view.cx + W / 2 / view.s;
    const y0 = view.cy - H / 2 / view.s;
    const y1 = view.cy + H / 2 / view.s;
    if ((x1 - x0) / g < 400) {
      for (let x = Math.ceil(x0 / g) * g; x <= x1; x += g) (Math.abs(x / 10 - Math.round(x / 10)) < 1e-6 ? major : lines).push(`M${P([x, 0])[0].toFixed(1)},0V${H}`);
      for (let y = Math.ceil(y0 / g) * g; y <= y1; y += g) (Math.abs(y / 10 - Math.round(y / 10)) < 1e-6 ? major : lines).push(`M0,${P([0, y])[1].toFixed(1)}H${W}`);
    }
    out.push(`<path d="${lines.join('')}" stroke="${c.grid}" stroke-width="1"/><path d="${major.join('')}" stroke="${c.gridMajor}" stroke-width="1"/>`);
    // Board and holes.
    const outline = boardPolygon(b, this.n);
    out.push(`<path d="${path(outline)}" fill="${c.pcb}" stroke="${c.pcbEdge}" stroke-width="1.5"/>`);
    (b.holes || []).forEach((h, i) => {
      const [x, y] = P([this.n(h.x), this.n(h.y)]);
      const r = (this.n(h.d) / 2) * view.s;
      out.push(`<g data-hole="${i}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.max(2, r).toFixed(1)}" fill="${c.hole}" stroke="${selected === `hole:${i}` ? c.sel : c.pcbEdge}" stroke-width="${selected === `hole:${i}` ? 2.5 : 1}"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(Math.max(2, r) + 6).toFixed(1)}" fill="transparent"/></g>`);
    });
    const o = P([0, 0]);
    out.push(`<path d="M${o[0] - 6},${o[1]}h12M${o[0]},${o[1] - 6}v12" stroke="${c.pcbEdge}" stroke-width="1" opacity="0.6"/>`);
    // Parts: the far side first and faint, then the near side.
    const issues = checkBoard(b, this.n);
    this.issues = issues;
    const bad = new Set(issues.filter((i) => i.kind !== 'unplaced').flatMap((i) => i.refs));
    const near = flip ? 'bottom' : 'top';
    const parts = (b.parts || []).slice().sort((p, q) => ((p.side || 'top') === near) - ((q.side || 'top') === near));
    const labels = [];
    for (const p of parts) {
      const far = (p.side || 'top') !== near && !p.off;
      const isSel = selected === p.ref;
      const body = partPolygon(p);
      const stroke = isSel ? c.sel : bad.has(p.ref) ? c.bad : c.partEdge;
      const sw = isSel || bad.has(p.ref) ? 2.2 : 1;
      out.push(`<g data-ref="${esc(p.ref)}" opacity="${far ? 0.35 : 1}" style="cursor:${forShot ? 'default' : 'grab'}">`);
      if (p.off || isSel || bad.has(p.ref)) {
        const fp = footprintPolygon(p);
        out.push(`<path d="${path(fp)}" fill="none" stroke="${stroke}" stroke-width="1" stroke-dasharray="4 3" opacity="0.8"/>`);
      }
      out.push(`<path d="${path(body)}" fill="${p.color || '#3a3d44'}" fill-opacity="${p.off ? 0.55 : 0.88}" stroke="${stroke}" stroke-width="${sw}"${p.off ? ' stroke-dasharray="5 3"' : ''}/>`);
      for (const [name, pad] of Object.entries(p.pads || {})) {
        if (pad.length >= 5) {
          const corners = [
            [pad[0] - pad[3] / 2, pad[1] - pad[4] / 2],
            [pad[0] + pad[3] / 2, pad[1] - pad[4] / 2],
            [pad[0] + pad[3] / 2, pad[1] + pad[4] / 2],
            [pad[0] - pad[3] / 2, pad[1] + pad[4] / 2],
          ].map((q) => toBoard(p, q));
          out.push(`<path d="${path(corners)}" fill="${c.pad}"/>`);
        } else {
          const [x, y] = P(toBoard(p, pad));
          const r = Math.max(1.2, ((pad[2] || 1.6) / 2) * view.s);
          if (name === '1') out.push(`<rect x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${(2 * r).toFixed(1)}" height="${(2 * r).toFixed(1)}" fill="${c.pad}"/>`);
          else out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${c.pad}"/>`);
          if (r > 3) out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r * 0.45).toFixed(1)}" fill="${c.hole}"/>`);
        }
      }
      out.push('</g>');
      const sc = body.map(P);
      const bw = Math.max(...sc.map((q) => q[0])) - Math.min(...sc.map((q) => q[0]));
      const bh = Math.max(...sc.map((q) => q[1])) - Math.min(...sc.map((q) => q[1]));
      const fs = Math.max(9, Math.min(16, Math.min(bw / Math.max(2, p.ref.length) * 1.4, bh * 0.5)));
      const [lx, ly] = P(bodyCenter(p));
      if (!far) labels.push(`<text x="${lx.toFixed(1)}" y="${(ly + fs * 0.35).toFixed(1)}" font-size="${fs.toFixed(1)}" font-weight="600" text-anchor="middle" fill="${c.text}" stroke="rgba(0,0,0,0.55)" stroke-width="2.5" paint-order="stroke" pointer-events="none">${esc(p.ref)}</text>`);
    }
    // Copper: the far layer faint, then vias, then the near layer.
    // Connectivity (with pours) is reused while only the view or the cursor changes; pours are left
    // out while a part is being dragged.
    // While a part is dragged, the copper drawn is what was there before (traces do not move with
    // parts) and the airwires join pads directly, so dragging stays smooth on a routed board.
    const dragging = this.drag && (this.drag.kind === 'part' || this.drag.kind === 'hole');
    const key = dragging ? null : JSON.stringify(b);
    if (!dragging && this.connKey !== key) {
      this.connKey = key;
      this.nb = numericBoard(b, this.n);
      this.conn = connectivity(this.nb);
    }
    const nb = this.nb || numericBoard(b, this.n);
    const conn = this.conn || connectivity(nb);
    const sel = String(selected || '');
    const traceColor = { top: c.top, bottom: c.bottom };
    for (const layer of [flip ? 'top' : 'bottom', flip ? 'bottom' : 'top']) {
      const far = layer !== (flip ? 'bottom' : 'top');
      // Pours on this layer, as one path of row strips.
      for (const pour of conn.pours || []) {
        if (pour.layer !== layer) continue;
        const st = pour.grid.step / 2;
        const d = [];
        for (const [x0, x1, y] of pour.grid.runs()) {
          const a = P([x0, y + st]);
          const z = P([x1, y - st]);
          d.push(`M${Math.min(a[0], z[0]).toFixed(1)},${a[1].toFixed(1)}H${Math.max(a[0], z[0]).toFixed(1)}V${z[1].toFixed(1)}H${Math.min(a[0], z[0]).toFixed(1)}Z`);
        }
        out.push(`<path d="${d.join('')}" fill="${traceColor[layer]}" opacity="${far ? 0.12 : 0.26}" pointer-events="none"/>`);
        const spokes = pour.grid.spokes().map((sp) => `M${P(sp.a)[0].toFixed(1)},${P(sp.a)[1].toFixed(1)}L${P(sp.b)[0].toFixed(1)},${P(sp.b)[1].toFixed(1)}`);
        if (spokes.length) out.push(`<path d="${spokes.join('')}" stroke="${traceColor[layer]}" stroke-width="${Math.max(1, (pour.grid.spokes()[0].w || 0.5) * view.s).toFixed(1)}" opacity="${far ? 0.25 : 0.6}" pointer-events="none"/>`);
      }
      (nb.traces || []).forEach((t, i) => {
        if ((t.layer === 'bottom' ? 'bottom' : 'top') !== layer) return;
        const d = t.pts.map((p, k) => `${k ? 'L' : 'M'}${P(p)[0].toFixed(1)},${P(p)[1].toFixed(1)}`).join('');
        const isSel = sel === `trace:${i}`;
        out.push(`<g data-trace="${i}" style="cursor:pointer"><path d="${d}" stroke="${isSel ? c.sel : traceColor[layer]}" stroke-width="${Math.max(1, (t.w || 0.25) * view.s).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="${far ? 0.45 : 0.9}"/><path d="${d}" stroke="transparent" stroke-width="${Math.max(8, (t.w || 0.25) * view.s).toFixed(1)}" fill="none"/></g>`);
      });
      if (!far) continue;
      (nb.vias || []).forEach((v, i) => {
        const [x, y] = P([v.x, v.y]);
        const isSel = sel === `via:${i}`;
        out.push(`<g data-via="${i}" style="cursor:pointer"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.max(2, ((v.d || 0.6) / 2) * view.s).toFixed(1)}" fill="${isSel ? c.sel : c.pad}"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.max(0.8, ((v.drill || 0.3) / 2) * view.s).toFixed(1)}" fill="${c.hole}"/></g>`);
      });
    }
    // Airwires, brighter for the selected part's nets.
    const selNets = new Set();
    const selTrace = sel.startsWith('trace:') ? nb.traces?.[+sel.slice(6)] : null;
    if (selTrace?.net) selNets.add(selTrace.net);
    if (selected && !sel.includes(':')) for (const net of b.nets || []) if ((net.pads || []).some(([r]) => r === selected)) selNets.add(net.name);
    if (this.route?.net) selNets.add(this.route.net);
    let wires;
    if (dragging) {
      const live = { ...numericBoard(b, this.n), traces: [], vias: [], pours: [] };
      wires = airwires(live, connectivity(live));
    } else wires = this.wiresKey === key ? this.wires : airwires(nb, conn);
    this.wires = wires;
    this.wiresKey = key;
    const dim = [];
    const hot = [];
    for (const w of wires) {
      const a = P(w.from);
      const z = P(w.to);
      (selNets.has(w.net) ? hot : dim).push(`M${a[0].toFixed(1)},${a[1].toFixed(1)}L${z[0].toFixed(1)},${z[1].toFixed(1)}`);
    }
    out.push(`<path d="${dim.join('')}" stroke="${c.air}" stroke-width="0.8" opacity="${selNets.size ? 0.3 : 0.7}" fill="none" pointer-events="none"/>`);
    if (hot.length) out.push(`<path d="${hot.join('')}" stroke="${c.air}" stroke-width="2" fill="none" pointer-events="none"/>`);
    // Design-rule problems, once there is copper to check (not while dragging).
    if ((nb.traces || []).length || (nb.vias || []).length) {
      if (!dragging && !this.route && this.drcKey !== key) {
        this.drcResult = drc(nb);
        this.drcKey = key;
      }
      for (const i of this.drcResult?.issues || []) {
        const [x, y] = P(i.at);
        out.push(`<g pointer-events="none"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="none" stroke="${c.bad}" stroke-width="2"/><path d="M${x - 4},${y - 4}L${x + 4},${y + 4}M${x - 4},${y + 4}L${x + 4},${y - 4}" stroke="${c.bad}" stroke-width="2"/></g>`);
      }
    } else this.drcResult = { issues: [], unrouted: wires.filter((w) => !w.offBoard).length };
    // The trace being drawn.
    if (this.route && !forShot) {
      const r = this.route;
      const pts = r.pts.concat(this.cursor ? [this.angled(r.pts[r.pts.length - 1], this.cursor)] : []);
      for (const t of r.done.traces) out.push(`<path d="${t.pts.map((p, k) => `${k ? 'L' : 'M'}${P(p)[0].toFixed(1)},${P(p)[1].toFixed(1)}`).join('')}" stroke="${traceColor[t.layer]}" stroke-width="${Math.max(1, t.w * view.s).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.9" pointer-events="none"/>`);
      if (pts.length > 1) out.push(`<path d="${pts.map((p, k) => `${k ? 'L' : 'M'}${P(p)[0].toFixed(1)},${P(p)[1].toFixed(1)}`).join('')}" stroke="${traceColor[r.layer]}" stroke-width="${Math.max(1, r.w * view.s).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.75" stroke-dasharray="${Math.max(2, r.w * view.s * 2)} ${Math.max(2, r.w * view.s)}" pointer-events="none"/>`);
      for (const v of r.done.vias) {
        const [x, y] = P([v.x, v.y]);
        out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.max(2, (v.d / 2) * view.s).toFixed(1)}" fill="${c.pad}" pointer-events="none"/>`);
      }
    }
    out.push(...labels);
    if (forShot) {
      const placed = (b.parts || []).filter((p) => !p.off).length;
      out.push(`<text x="12" y="22" font-size="14" fill="${c.text}">${esc(b.name || 'Board')}: ${placed}/${(b.parts || []).length} parts placed, viewed from ${flip ? 'below' : 'above'}. ${issues.filter((i) => i.kind !== 'unplaced').length} placement problems, ${this.drcResult?.unrouted ?? 0} connections to route, ${this.drcResult?.issues.length ?? 0} DRC errors. Red: top copper, blue: bottom.</text>`);
    }
    out.push('</svg>');
    return out.join('');
  }

  // A picture of the editor for agents (PNG data URL), fitted to the board.
  async snapshot({ width = 1200, height = 800, flip = this.flip, board = null } = {}) {
    const b = board || this.api.board();
    if (!b) throw new Error('There is no board to show.');
    if (!this.c) this.readColors();
    const keep = this.work;
    this.work = b;
    const view = this.fit(false, [width, height]);
    this.work = keep;
    const src = this.svg(b, view, [width, height], flip, this.api.selected(), { forShot: true });
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // ---------- pointer ----------
  snap(v, e) {
    if (e?.altKey || !this.grid) return r3(v);
    return r3(Math.round(v / this.grid) * this.grid);
  }

  // ---------- routing ----------
  // From `from` toward `to`, held to a multiple of 45 degrees.
  angled(from, to) {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    if (!dx && !dy) return from.slice();
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = dx * Math.cos(a) + dy * Math.sin(a);
    return [r3(from[0] + Math.cos(a) * len), r3(from[1] + Math.sin(a) * len)];
  }

  // The copper under a board point: a pad first, then a via, then a trace.
  copperAt(p, tol = 0) {
    const b = this.api.board();
    if (!b) return null;
    const conn = this.conn && this.connKey === JSON.stringify(b) ? this.conn : connectivity(numericBoard(b, this.n));
    let best = null;
    for (const it of conn.items) {
      const s = it.shape;
      const gap = s.poly ? (pointInPolygon(p, s.poly) ? -1 : Infinity) : ptSeg(p, s.a, s.b) - s.r;
      if (gap > tol) continue;
      const rank = { pad: 0, via: 1, trace: 2 }[it.kind];
      if (!best || rank < best.rank || (rank === best.rank && gap < best.gap)) best = { it, rank, gap };
    }
    if (!best) return null;
    const it = best.it;
    let at = it.at;
    if (it.kind === 'trace') {
      // The nearest point on the segment.
      const [a, c] = [it.shape.a, it.shape.b];
      const dx = c[0] - a[0];
      const dy = c[1] - a[1];
      const l2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
      at = [r3(a[0] + t * dx), r3(a[1] + t * dy)];
    }
    return { item: it, kind: it.kind, net: it.groupNet || it.net || null, at: [r3(at[0]), r3(at[1])], layers: it.layers, id: it.id };
  }

  startRoute(p) {
    const hit = this.copperAt(p, 3 / this.view.s);
    if (!hit) {
      this.api.toast('Start a trace on a pad, a via or the end of a trace.');
      return;
    }
    const rules = rulesOf(this.api.board());
    const layer = hit.layers.includes(this.layer) ? this.layer : hit.layers[0];
    this.route = { net: hit.net, layer, w: rules.trace, pts: [hit.at], done: { traces: [], vias: [] }, from: hit.id };
    this.render();
  }

  routeClick(p, e) {
    const r = this.route;
    const last = r.pts[r.pts.length - 1];
    const hit = this.copperAt(p, 3 / this.view.s);
    if (hit && hit.id !== r.from && hit.layers.includes(r.layer) && (hit.net === r.net || !r.net || !hit.net)) {
      const elbow = this.angled(last, hit.at);
      if (Math.hypot(elbow[0] - hit.at[0], elbow[1] - hit.at[1]) > 1e-6 && Math.hypot(elbow[0] - last[0], elbow[1] - last[1]) > 1e-6) r.pts.push(elbow);
      r.pts.push(hit.at);
      r.net ||= hit.net;
      this.finishRoute();
      return;
    }
    if (hit && hit.net && r.net && hit.net !== r.net && hit.kind !== 'trace') {
      this.api.toast(`That ${hit.kind} is on ${hit.net}; this trace is ${r.net}.`);
      return;
    }
    const q = this.angled(last, [this.snap(p[0], e), this.snap(p[1], e)]);
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) < 1e-6) return;
    r.pts.push(q);
    r.from = null;
    this.render();
  }

  // Drop a via at the last point and carry on on the other layer.
  routeVia() {
    const r = this.route;
    if (!r) return false;
    const rules = rulesOf(this.api.board());
    const last = r.pts[r.pts.length - 1];
    if (r.pts.length >= 2) r.done.traces.push({ net: r.net, layer: r.layer, w: r.w, pts: r.pts.slice() });
    r.done.vias.push({ x: last[0], y: last[1], d: rules.via, drill: Math.max(rules.drill, rules.minDrill), net: r.net });
    r.layer = r.layer === 'top' ? 'bottom' : 'top';
    this.layer = r.layer;
    r.pts = [last];
    this.render();
    return true;
  }

  finishRoute() {
    const r = this.route;
    if (!r) return;
    this.route = null;
    if (r.pts.length >= 2) r.done.traces.push({ net: r.net, layer: r.layer, w: r.w, pts: r.pts });
    if (!r.done.traces.length && !r.done.vias.length) return this.render();
    this.api.change((f) => {
      f.traces = [...(f.traces || []), ...r.done.traces];
      if (r.done.vias.length) f.vias = [...(f.vias || []), ...r.done.vias];
    }, null);
  }

  cancelRoute() {
    this.route = null;
    this.render();
  }

  down(e) {
    this.el.focus({ preventScroll: true });
    const b = this.api.board();
    if (!b) return;
    const partEl = e.target.closest?.('[data-ref]');
    const holeEl = e.target.closest?.('[data-hole]');
    const traceEl = e.target.closest?.('[data-trace]');
    const viaEl = e.target.closest?.('[data-via]');
    const at = this.fromS(e.clientX, e.clientY);
    if (e.button === 0 && this.api.tool() === 'route') {
      if (this.route) this.routeClick(at, e);
      else this.startRoute(at);
      return;
    }
    this.el.setPointerCapture(e.pointerId);
    if (e.button === 0 && this.api.tool() === 'select' && !partEl && (traceEl || viaEl)) {
      this.api.select(traceEl ? `trace:${traceEl.dataset.trace}` : `via:${viaEl.dataset.via}`);
      return;
    }
    if (e.button === 0 && this.api.tool() === 'hole' && !partEl) {
      const hole = { x: this.snap(at[0], e), y: this.snap(at[1], e), d: this.lastHole || 3.2 };
      this.api.change((f) => (f.holes = [...(f.holes || []), hole]), null);
      this.api.select(`hole:${(b.holes || []).length}`);
      return;
    }
    if (e.button === 0 && (partEl || holeEl)) {
      const ref = partEl ? partEl.dataset.ref : `hole:${holeEl.dataset.hole}`;
      this.api.select(ref);
      const item = partEl ? b.parts.find((p) => p.ref === ref) : b.holes[+holeEl.dataset.hole];
      this.drag = { kind: partEl ? 'part' : 'hole', ref, index: holeEl ? +holeEl.dataset.hole : -1, start: at, orig: [this.n(item.x), this.n(item.y)], moved: false, id: e.pointerId };
      this.work = structuredClone(b);
      return;
    }
    if (e.button === 0) this.api.select(null);
    this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, view: { ...this.view }, id: e.pointerId };
  }

  move(e) {
    const d = this.drag;
    if (this.route && !d) {
      const p = this.fromS(e.clientX, e.clientY);
      this.cursor = [this.snap(p[0], e), this.snap(p[1], e)];
      const hit = this.copperAt(p, 3 / this.view.s);
      this.api.hover(`${this.route.net || 'trace'} on the ${this.route.layer} · x ${f1(this.cursor[0])} y ${f1(this.cursor[1])}${hit ? ` · over ${hit.kind === 'pad' ? `pad ${hit.id}` : `a ${hit.kind}`}${hit.net ? ` (${hit.net})` : ''}` : ''}`);
      this.render();
      return;
    }
    if (!d) {
      const partEl = e.target.closest?.('[data-ref]');
      const b = this.api.board();
      const p = partEl && b?.parts.find((q) => q.ref === partEl.dataset.ref);
      const at = this.view ? this.fromS(e.clientX, e.clientY) : [0, 0];
      this.api.hover(p ? `${p.ref}${p.value ? ` · ${p.value}` : ''} · ${p.package} · ${f1(this.n(p.body.w))} × ${f1(this.n(p.body.d))} × ${f1(this.n(p.h))} mm${this.n(p.lift) ? ` (lifted ${f1(this.n(p.lift))})` : ''} · ${p.off ? 'not on the board' : `${p.side || 'top'}, ${this.n(p.rot) || 0}°`}` : `x ${f1(at[0])}  y ${f1(at[1])} mm`);
      return;
    }
    if (d.kind === 'pan') {
      this.view = { ...d.view, cx: d.view.cx - ((this.flip ? -1 : 1) * (e.clientX - d.sx)) / d.view.s, cy: d.view.cy + (e.clientY - d.sy) / d.view.s };
      this.render();
      return;
    }
    const at = this.fromS(e.clientX, e.clientY);
    const dx = at[0] - d.start[0];
    const dy = at[1] - d.start[1];
    if (!d.moved && Math.hypot(dx, dy) * this.view.s < 3) return;
    d.moved = true;
    const nx = this.snap(d.orig[0] + dx, e);
    const ny = this.snap(d.orig[1] + dy, e);
    if (d.kind === 'part') {
      const p = this.work.parts.find((q) => q.ref === d.ref);
      p.x = nx;
      p.y = ny;
      if (overBoard(p, this.work, this.n)) delete p.off;
      else p.off = true;
      this.api.hover(`${p.ref}: x ${f1(nx)}  y ${f1(ny)} mm${p.off ? ' · off the board' : ''}`);
    } else {
      const h = this.work.holes[d.index];
      h.x = nx;
      h.y = ny;
    }
    this.render();
  }

  up(e) {
    const d = this.drag;
    this.drag = null;
    if (this.el.hasPointerCapture?.(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    if (!d || d.kind === 'pan') return;
    const work = this.work;
    this.work = null;
    if (!d.moved) return this.render();
    if (d.kind === 'part') {
      const p = work.parts.find((q) => q.ref === d.ref);
      this.api.change((f) => {
        const t = f.parts.find((q) => q.ref === d.ref);
        if (!t) return;
        t.x = p.x;
        t.y = p.y;
        if (p.off) t.off = true;
        else delete t.off;
      }, null);
    } else {
      const h = work.holes[d.index];
      this.api.change((f) => {
        if (f.holes?.[d.index]) Object.assign(f.holes[d.index], { x: h.x, y: h.y });
      }, null);
    }
  }

  wheel(e) {
    e.preventDefault();
    if (!this.view) return;
    const at = this.fromS(e.clientX, e.clientY);
    const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    const s = Math.max(0.5, Math.min(120, this.view.s * k));
    // Keep the point under the cursor still.
    const r = this.el.getBoundingClientRect();
    const [W, H] = this.size();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    this.view = { s, cx: at[0] - ((this.flip ? -1 : 1) * (sx - W / 2)) / s, cy: at[1] + (sy - H / 2) / s };
    this.render();
  }

  // ---------- commands ----------
  selectedPart() {
    const ref = this.api.selected();
    return ref && !String(ref).includes(':') ? this.api.board()?.parts.find((p) => p.ref === ref) || null : null;
  }

  editPart(fn) {
    const ref = this.api.selected();
    if (!ref || String(ref).includes(':')) {
      this.api.toast('Select a part first: click it on the board.');
      return false;
    }
    this.api.change((f) => {
      const p = f.parts.find((q) => q.ref === ref);
      if (p) fn(p, f);
    }, null);
    return true;
  }

  rotate(deg = 90) {
    this.editPart((p) => turnPart(p, deg));
  }

  flipSide() {
    this.editPart((p) => flipPart(p));
  }

  takeOff() {
    const ref = this.api.selected();
    if (ref && /^(trace|via):/.test(String(ref))) {
      const [kind, i] = String(ref).split(':');
      this.api.change((f) => (kind === 'trace' ? f.traces : f.vias)?.splice(+i, 1), null);
      this.api.select(null);
      return;
    }
    if (ref && String(ref).startsWith('hole:')) {
      const i = +ref.slice(5);
      this.api.change((f) => f.holes.splice(i, 1), null);
      this.api.select(null);
      return;
    }
    this.editPart((p, f) => {
      p.off = true;
      autoPlace(f, this.n, { which: [] }); // re-stack the parts waiting beside the board
    });
  }

  nudge(dx, dy) {
    const ref = this.api.selected();
    if (ref && String(ref).startsWith('hole:')) {
      const i = +ref.slice(5);
      this.api.change((f) => {
        const h = f.holes[i];
        h.x = r3(this.n(h.x) + dx);
        h.y = r3(this.n(h.y) + dy);
      }, `nudge:${ref}`);
      return;
    }
    const ref2 = ref;
    if (!this.selectedPart()) return;
    this.api.change((f) => {
      const p = f.parts.find((q) => q.ref === ref2);
      p.x = r3(this.n(p.x) + dx);
      p.y = r3(this.n(p.y) + dy);
      if (overBoard(p, f, this.n)) delete p.off;
    }, `nudge:${ref2}`);
  }

  arrange(which = 'all', sides = ['top']) {
    const b = this.api.board();
    if (!b) return;
    const refs = which === 'rest' ? b.parts.filter((p) => p.off).map((p) => p.ref) : null;
    if (refs && !refs.length) return this.api.toast('Every part is already on the board.');
    let res = null;
    this.api.change((f) => {
      res = arrangeBoard(f, this.n, { which: refs, sides });
    }, null);
    if (res) this.api.toast(res.off.length ? `Placed ${res.placed} part${res.placed === 1 ? '' : 's'}, connected parts near each other; ${res.off.length} did not fit and wait beside the board (${res.off.join(', ')}).` : `Placed ${res.placed} part${res.placed === 1 ? '' : 's'}, connected parts near each other.`);
    this.fit();
  }

  // Shorten the connections without starting over: nudge, turn and swap parts.
  tidy() {
    let res = null;
    this.api.change((f) => {
      res = improvePlacement(f, this.n);
    }, null);
    if (res) this.api.toast(res.moves ? `Moved, turned or swapped parts ${res.moves} times: connections ${res.before} → ${res.after} mm.` : 'No change found that shortens the connections without a clash.');
  }

  async autoroute(nets = null) {
    const b = this.api.board();
    if (!b) return null;
    if (!(b.nets || []).length) {
      this.api.toast('This board has no nets to route. Import a schematic or board file with its connections.');
      return null;
    }
    this.busy = true;
    this.api.toast('Routing…');
    let res;
    try {
      res = await this.api.autoroute(numericBoard(b, this.n), nets ? { nets } : {});
    } catch (e) {
      this.busy = false;
      this.api.toast(`The autorouter stopped: ${e.message}`);
      return null;
    }
    this.busy = false;
    if (res.traces.length || res.vias.length)
      this.api.change((f) => {
        f.traces = [...(f.traces || []), ...res.traces];
        f.vias = [...(f.vias || []), ...res.vias];
      }, null);
    this.api.toast(
      res.total === 0
        ? 'Every connection is already routed.'
        : `Routed ${res.routed} of ${res.total} connections with ${res.vias.length} via${res.vias.length === 1 ? '' : 's'}${res.failed.length ? `; ${res.failed.length} could not be routed (${[...new Set(res.failed.map((x) => x.net))].join(', ')}): move parts apart, or route them by hand` : ''}.`,
    );
    return res;
  }

  clearCopper() {
    this.api.change((f) => {
      f.traces = [];
      f.vias = [];
    }, null);
  }

  setLayer(layer) {
    this.layer = layer;
    if (this.route && this.route.layer !== layer) this.routeVia();
    this.render();
  }

  setFlip(v) {
    this.flip = v;
    this.render();
  }

  setGrid(g) {
    this.grid = g;
    this.render();
  }

  key(e) {
    if (!this.active) return false;
    const k = e.key;
    if (this.route) {
      if (k === 'Escape') this.cancelRoute();
      else if (k === 'v' || k === 'V') this.routeVia();
      else if (k === 'Enter') this.finishRoute();
      else if (k === 'Backspace' || k === 'Delete') {
        if (this.route.pts.length > 1) this.route.pts.pop();
        else this.cancelRoute();
        this.render();
      } else if (k === 'w' || k === 'W') this.route.w = this.route.w >= 1 ? 0.25 : Math.round((this.route.w + 0.25) * 100) / 100;
      else return false;
      return true;
    }
    if (k === 'x' || k === 'X') {
      this.api.setTool(this.api.tool() === 'route' ? 'select' : 'route');
      return true;
    }
    const step = (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : this.grid || 0.5);
    if (k === 'r' || k === 'R') this.rotate(e.shiftKey ? -90 : 90);
    else if (k === 'f' || k === 'F') this.flipSide();
    else if (k === 'Delete' || k === 'Backspace') this.takeOff();
    else if (k === 'ArrowLeft') this.nudge((this.flip ? 1 : -1) * step, 0);
    else if (k === 'ArrowRight') this.nudge((this.flip ? -1 : 1) * step, 0);
    else if (k === 'ArrowUp') this.nudge(0, step);
    else if (k === 'ArrowDown') this.nudge(0, -step);
    else if (k === 'h' || k === 'H') this.api.setTool(this.api.tool() === 'hole' ? 'select' : 'hole');
    else if (k === 'v' || k === 'V') this.api.setTool('select');
    else if (k === 'Escape' && (this.api.selected() || this.api.tool() !== 'select')) {
      this.api.select(null);
      this.api.setTool('select');
    } else return false;
    return true;
  }
}
