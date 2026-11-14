// The board placement editor: a top-down 2D view of the board over the 3D view, where parts are
// dragged into place, turned and flipped, with airwires showing what connects to what and clashes
// drawn in red as they happen (like the board editor in Fusion or Eagle, without the routing).
import { evalExpr } from '../expr.js';
import { boardPolygon, partPolygon, footprintPolygon, toBoard, airwires, checkBoard, boardExtent, overBoard, turnPart, flipPart, autoPlace, bodyCenter } from './geometry.js';

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
      if (!e.target.closest('[data-ref]')) this.fit();
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
    if (!this.view) this.fit(false);
    this.render();
    this.el.focus({ preventScroll: true });
  }

  exit() {
    this.active = false;
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
    this.svgHost.innerHTML = this.svg(b, this.view, this.size(), this.flip, this.api.selected());
    const placed = (b.parts || []).filter((p) => !p.off).length;
    const issues = this.issues.filter((i) => i.kind !== 'unplaced');
    this.chip.innerHTML = `<b>${placed}/${(b.parts || []).length}</b> parts on the board · ${issues.length ? `<span class="bad">${issues.length} problem${issues.length === 1 ? '' : 's'}</span>` : 'no clashes'} · viewed from ${this.flip ? 'below' : 'above'} · grid ${this.grid} mm`;
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
    // Airwires, brighter for the selected part's nets.
    const selNets = new Set();
    if (selected && !String(selected).startsWith('hole:')) for (const net of b.nets || []) if ((net.pads || []).some(([r]) => r === selected)) selNets.add(net.name);
    const wires = airwires(b);
    this.wires = wires;
    const dim = [];
    const hot = [];
    for (const w of wires) {
      const a = P(w.from);
      const z = P(w.to);
      (selNets.has(w.net) ? hot : dim).push(`M${a[0].toFixed(1)},${a[1].toFixed(1)}L${z[0].toFixed(1)},${z[1].toFixed(1)}`);
    }
    out.push(`<path d="${dim.join('')}" stroke="${c.air}" stroke-width="0.8" opacity="${selNets.size ? 0.3 : 0.7}" fill="none" pointer-events="none"/>`);
    if (hot.length) out.push(`<path d="${hot.join('')}" stroke="${c.air}" stroke-width="2" fill="none" pointer-events="none"/>`);
    out.push(...labels);
    if (forShot) {
      const placed = (b.parts || []).filter((p) => !p.off).length;
      out.push(`<text x="12" y="22" font-size="14" fill="${c.text}">${esc(b.name || 'Board')}: ${placed}/${(b.parts || []).length} parts placed, viewed from ${flip ? 'below' : 'above'}. ${issues.filter((i) => i.kind !== 'unplaced').length} problems.</text>`);
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

  down(e) {
    this.el.focus({ preventScroll: true });
    const b = this.api.board();
    if (!b) return;
    const partEl = e.target.closest?.('[data-ref]');
    const holeEl = e.target.closest?.('[data-hole]');
    const at = this.fromS(e.clientX, e.clientY);
    this.el.setPointerCapture(e.pointerId);
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
    return ref && !String(ref).startsWith('hole:') ? this.api.board()?.parts.find((p) => p.ref === ref) || null : null;
  }

  editPart(fn) {
    const ref = this.api.selected();
    if (!ref || String(ref).startsWith('hole:')) {
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
      res = autoPlace(f, this.n, { which: refs, sides });
    }, null);
    if (res) this.api.toast(res.off.length ? `Placed ${res.placed} part${res.placed === 1 ? '' : 's'}; ${res.off.length} did not fit and wait beside the board (${res.off.join(', ')}).` : `Placed ${res.placed} part${res.placed === 1 ? '' : 's'}.`);
    this.fit();
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
