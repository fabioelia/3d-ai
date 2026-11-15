// 3D models of parts, built from their footprint and size: an axial resistor lies on its bent leads,
// an electrolytic stands on two legs, a header has its plastic strip and square pins, a module is a
// little board on its pins, a chip has its metal ends. Each model is a few simple solids gathered
// into compounds (no booleans, so a board of fifty parts still rebuilds quickly), in three colours:
// the part's own, dark plastic, and metal.
//
// Coordinates are the part's own (package) millimetres with z = 0 on the board surface it sits on;
// pins reach down through a board of thickness `th`. The kernel then turns, flips and places it.
import { partFamily, padShape } from './footprints.js';

export const DARK = '#1c1e22';
export const METAL = '#c9c3b2';
export const GOLD = '#d2a546';

export function partModel(r, part, th = 1.6) {
  const b = part.body || { cx: 0, cy: 0, w: 2, d: 2 };
  const w = Math.max(0.2, b.w);
  const d = Math.max(0.2, b.d);
  const h = Math.max(0.2, part.h ?? 1);
  const lift = Math.max(0, part.lift ?? 0);
  const pads = Object.entries(part.pads || {}).map(([name, p]) => ({ name, x: p[0], y: p[1], ...padShape(p) }));
  const tht = pads.filter((p) => !p.smd);
  const main = [];
  const dark = [];
  const metal = [];
  const box = (x0, y0, z0, x1, y1, z1) => r.makeBox([Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)]);
  const cyl = (rad, len, at, dir = [0, 0, 1]) => r.makeCylinder(Math.max(0.05, rad), Math.max(0.05, len), at, dir);
  // Leads straight down through the board from z = top.
  const legs = (top, rad = 0.3, list = tht) => {
    for (const p of list) metal.push(cyl(Math.min(rad, (p.drill || 0.8) * 0.42), top + th + 1.2, [p.x, p.y, -th - 1.2]));
  };
  const family = partFamily(part);
  switch (family) {
    case 'axial': {
      const [p1, p2] = tht.length >= 2 ? tht : [{ x: b.cx - w / 2 - 2, y: b.cy }, { x: b.cx + w / 2 + 2, y: b.cy }];
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || w + 4;
      const ux = (p2.x - p1.x) / len;
      const uy = (p2.y - p1.y) / len;
      const dia = Math.min(w, d);
      const L = Math.max(w, d);
      const z = lift + dia / 2 + 0.4;
      const c = [(p1.x + p2.x) / 2, (p1.y + p2.y) / 2];
      main.push(cyl(dia / 2, L, [c[0] - (ux * L) / 2, c[1] - (uy * L) / 2, z], [ux, uy, 0]));
      // Bent leads: down through the board, along to the body.
      const lr = 0.3;
      for (const [p, s] of [
        [p1, 1],
        [p2, -1],
      ]) {
        metal.push(cyl(lr, z + th + 1.2, [p.x, p.y, -th - 1.2]));
        metal.push(cyl(lr, (len - L) / 2 + 0.2, [p.x, p.y, z], [ux * s, uy * s, 0]));
      }
      // Colour bands on resistors.
      if (/^R|RES|AXIAL|0207|0204/i.test(`${part.ref} ${part.package}`) && !/DIODE|DO-/i.test(part.package || ''))
        for (const t of [0.22, 0.34, 0.46, 0.75]) dark.push(cyl(dia / 2 + 0.03, L * 0.06, [c[0] + ux * (t - 0.5) * L, c[1] + uy * (t - 0.5) * L, z], [ux, uy, 0]));
      else dark.push(cyl(dia / 2 + 0.03, L * 0.12, [c[0] - ux * L * 0.4, c[1] - uy * L * 0.4, z], [ux, uy, 0])); // diode band (cathode)
      break;
    }
    case 'radial-cap':
    case 'led': {
      const dia = Math.max(w, d);
      const z0 = lift + 0.4;
      main.push(cyl(dia / 2, h - z0 > 0.5 ? h - z0 : h, [b.cx, b.cy, z0]));
      // The minus stripe down one side.
      if (family === 'radial-cap') dark.push(box(b.cx + dia / 2 - 0.9, b.cy - dia * 0.18, z0 + 0.2, b.cx + dia / 2 + 0.02, b.cy + dia * 0.18, Math.max(z0 + 0.5, h - 0.4)));
      metal.push(cyl(dia / 2 - 0.4, 0.05, [b.cx, b.cy, h - 0.02]));
      legs(z0 + 0.3, 0.3);
      break;
    }
    case 'disc-cap': {
      const dia = Math.max(w, d);
      const thick = Math.min(w, d);
      const along = w >= d ? [0, 1, 0] : [1, 0, 0];
      const z = lift + 1.5 + dia / 2;
      main.push(cyl(dia / 2, thick, [b.cx - (along[0] * thick) / 2, b.cy - (along[1] * thick) / 2, z], along));
      legs(z - dia / 2 + 0.6, 0.25);
      break;
    }
    case 'header':
    case 'socket': {
      const xs = tht.map((p) => p.x);
      const ys = tht.map((p) => p.y);
      const pitch = 2.54;
      const [x0, x1, y0, y1] = xs.length ? [Math.min(...xs) - pitch / 2, Math.max(...xs) + pitch / 2, Math.min(...ys) - pitch / 2, Math.max(...ys) + pitch / 2] : [b.cx - w / 2, b.cx + w / 2, b.cy - d / 2, b.cy + d / 2];
      const socket = family === 'socket';
      const base = socket ? h : Math.min(2.5, h);
      main.push(box(x0, y0, lift, x1, y1, lift + base));
      const pin = 0.32;
      for (const p of tht) {
        if (socket) dark.push(box(p.x - 0.5, p.y - 0.5, lift + base - 0.02, p.x + 0.5, p.y + 0.5, lift + base + 0.01));
        metal.push(box(p.x - pin, p.y - pin, -th - 3, p.x + pin, p.y + pin, socket ? lift + 0.5 : lift + h));
      }
      return { main: done(main, r), dark: done(dark, r), metal: done(metal, r), metalColor: GOLD };
    }
    case 'jst': {
      main.push(box(b.cx - w / 2, b.cy - d / 2, lift, b.cx + w / 2, b.cy + d / 2, lift + h));
      for (const p of tht) metal.push(box(p.x - 0.32, p.y - 0.32, -th - 2.5, p.x + 0.32, p.y + 0.32, lift + h + 0.01));
      return { main: done(main, r), dark: null, metal: done(metal, r), color: '#ece6d3' };
    }
    case 'to92': {
      const z0 = lift + 2.5;
      main.push(cyl(Math.min(w, 4.8) / 2, Math.max(1, h - z0), [b.cx, b.cy + 0.6, z0]));
      dark.push(box(b.cx - w / 2, b.cy - d / 2 - 0.05, z0, b.cx + w / 2, b.cy - d / 2 + 0.6, h));
      legs(z0 + 0.2, 0.22);
      return { main: done(main, r), dark: done(dark, r), metal: done(metal, r), color: DARK };
    }
    case 'chip': {
      const end = Math.min(w, d) * 0.35;
      const long = w >= d;
      const [hw, hd] = [w / 2, d / 2];
      main.push(long ? box(b.cx - hw + end, b.cy - hd, 0, b.cx + hw - end, b.cy + hd, h) : box(b.cx - hw, b.cy - hd + end, 0, b.cx + hw, b.cy + hd - end, h));
      if (long) metal.push(box(b.cx - hw, b.cy - hd, 0, b.cx - hw + end, b.cy + hd, h), box(b.cx + hw - end, b.cy - hd, 0, b.cx + hw, b.cy + hd, h));
      else metal.push(box(b.cx - hw, b.cy - hd, 0, b.cx + hw, b.cy - hd + end, h), box(b.cx - hw, b.cy + hd - end, 0, b.cx + hw, b.cy + hd, h));
      break;
    }
    case 'sot':
    case 'ic-smd':
    case 'diode-smd': {
      const z0 = family === 'diode-smd' ? 0 : 0.1;
      main.push(box(b.cx - w / 2, b.cy - d / 2, z0, b.cx + w / 2, b.cy + d / 2, h));
      for (const p of pads) {
        if (!p.smd) continue;
        metal.push(box(p.x - p.w * 0.35, p.y - p.h * 0.35, 0, p.x + p.w * 0.35, p.y + p.h * 0.35, Math.min(0.35, h / 3)));
      }
      if (family === 'diode-smd') dark.push(box(b.cx - w / 2 + w * 0.12, b.cy - d / 2 - 0.01, h - 0.01, b.cx - w / 2 + w * 0.26, b.cy + d / 2 + 0.01, h + 0.02));
      return { main: done(main, r), dark: done(dark, r), metal: done(metal, r), color: family === 'diode-smd' ? '#2a2c30' : DARK };
    }
    case 'dip': {
      main.push(box(b.cx - w / 2, b.cy - d / 2, lift + 0.5, b.cx + w / 2, b.cy + d / 2, h));
      legs(lift + 0.8, 0.25);
      return { main: done(main, r), dark: null, metal: done(metal, r), color: DARK };
    }
    case 'module': {
      // A small board on its pins: the plate in the part's colour, a chip or two on top, header pins
      // through both boards, and the plastic of the headers underneath when it stands on them.
      const plate = Math.min(1.2, h * 0.5);
      const z0 = lift;
      main.push(box(b.cx - w / 2, b.cy - d / 2, z0, b.cx + w / 2, b.cy + d / 2, z0 + plate));
      const chipH = Math.max(0.3, h - plate);
      const cw = Math.min(w * 0.42, 9);
      const cd = Math.min(d * 0.42, 9);
      dark.push(box(b.cx - cw / 2, b.cy - cd / 2, z0 + plate, b.cx + cw / 2, b.cy + cd / 2, z0 + plate + chipH));
      dark.push(box(b.cx + w * 0.24, b.cy - d * 0.38, z0 + plate, b.cx + w * 0.4, b.cy - d * 0.22, z0 + plate + Math.min(chipH, 1) * 0.6));
      for (const p of tht) metal.push(box(p.x - 0.32, p.y - 0.32, -th - 2.5, p.x + 0.32, p.y + 0.32, z0 + plate + 0.8));
      if (z0 > 0.5 && tht.length) {
        // Header strips: one per row of pins.
        const rows = new Map();
        for (const p of tht) {
          const k = Math.round(p.y * 4) / 4;
          if (!rows.has(k)) rows.set(k, []);
          rows.get(k).push(p.x);
        }
        const cols = new Map();
        for (const p of tht) {
          const k = Math.round(p.x * 4) / 4;
          if (!cols.has(k)) cols.set(k, []);
          cols.get(k).push(p.y);
        }
        const byRow = [...rows.values()].filter((v) => v.length > 1).length >= [...cols.values()].filter((v) => v.length > 1).length;
        for (const [k, list] of byRow ? rows : cols) {
          const lo = Math.min(...list) - 1.27;
          const hi = Math.max(...list) + 1.27;
          dark.push(byRow ? box(lo, k - 1.27, 0, hi, k + 1.27, z0) : box(k - 1.27, lo, 0, k + 1.27, hi, z0));
        }
      }
      return { main: done(main, r), dark: done(dark, r), metal: done(metal, r), metalColor: GOLD };
    }
    default: {
      main.push(part.shape === 'cylinder' ? cyl(Math.max(w, d) / 2, h, [b.cx, b.cy, lift]) : box(b.cx - w / 2, b.cy - d / 2, lift, b.cx + w / 2, b.cy + d / 2, lift + h));
      if (tht.length) legs(lift + 0.5, 0.3);
    }
  }
  return { main: done(main, r), dark: done(dark, r), metal: done(metal, r) };
}

const done = (list, r) => (list.length ? (list.length === 1 ? list[0] : r.makeCompound(list)) : null);
