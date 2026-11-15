// Footprints and 3D families from package names. KiCad schematics and netlists only name their
// footprints ("Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal"); the geometry lives in
// KiCad's library, so the standard library's naming scheme is turned back into pads and a body here.
// Coordinates are Caliper's: millimetres, y up, pad 1 where KiCad puts the footprint origin.
// Pads: through-hole [x, y, diameter, drill], surface-mount [x, y, min(w,h), w, h].

const r3 = (v) => Math.round(v * 1000) / 1000;
const num = (s, re, d = null) => {
  const m = re.exec(s);
  return m ? parseFloat(m[1]) : d;
};

// Pad shape from the stored array.
export function padShape(pad) {
  if (pad.length >= 5) return { smd: true, w: pad[3], h: pad[4], drill: 0 };
  const d = pad[2] || 1.6;
  return { smd: false, w: d, h: d, drill: pad[3] || Math.round(Math.min(d - 0.5, d * 0.6) * 100) / 100 };
}

const tht = (x, y, d, drill) => [r3(x), r3(y), r3(d), r3(drill)];
const smd = (x, y, w, h) => [r3(x), r3(y), r3(Math.min(w, h)), r3(w), r3(h)];
const body = (x0, y0, x1, y1) => ({ cx: r3((x0 + x1) / 2), cy: r3((y0 + y1) / 2), w: r3(Math.abs(x1 - x0)), d: r3(Math.abs(y1 - y0)) });

// Two-row (SOIC, TSSOP …) or four-side (QFN, QFP) surface-mount ICs.
function gullWing(n, pitch, bw, bl, span, pw, pl) {
  const pads = {};
  const per = n / 2;
  for (let i = 0; i < per; i++) {
    const y = ((per - 1) / 2 - i) * pitch;
    pads[String(i + 1)] = smd(-span / 2, y, pl, pw);
    pads[String(n - i)] = smd(span / 2, y, pl, pw);
  }
  return { pads, body: { cx: 0, cy: 0, w: bw, d: bl } };
}
function quad(n, pitch, bw, bl, pl, pw) {
  const pads = {};
  const per = n / 4;
  let k = 1;
  const off = ((per - 1) / 2) * pitch;
  for (let i = 0; i < per; i++) pads[String(k++)] = smd(-bw / 2 - pl / 2 + 0.3, off - i * pitch, pl, pw);
  for (let i = 0; i < per; i++) pads[String(k++)] = smd(-off + i * pitch, -bl / 2 - pl / 2 + 0.3, pw, pl);
  for (let i = 0; i < per; i++) pads[String(k++)] = smd(bw / 2 + pl / 2 - 0.3, -off + i * pitch, pl, pw);
  for (let i = 0; i < per; i++) pads[String(k++)] = smd(off - i * pitch, bl / 2 + pl / 2 - 0.3, pw, pl);
  return { pads, body: { cx: 0, cy: 0, w: bw, d: bl } };
}

const CHIP = { '0201': [0.6, 0.3], '0402': [1.0, 0.5], '0603': [1.6, 0.8], '0805': [2.0, 1.25], 1206: [3.2, 1.6], 1210: [3.2, 2.5], 1812: [4.5, 3.2], 2010: [5.0, 2.5], 2512: [6.3, 3.2] };

// Footprint from a (KiCad-style) name; null when the name is not one Caliper knows.
export function footprintFromName(full = '', pinCount = 0) {
  const name = String(full).split(':').pop();
  const u = name.toUpperCase();
  const P = num(name, /_P(\d+(?:\.\d+)?)mm/i);
  // Mounting holes become board holes.
  if (/^MOUNTINGHOLE/.test(u)) return { hole: num(name, /_(\d+(?:\.\d+)?)mm/i, 3.2) };
  // Axial: resistors, diodes.
  if (/AXIAL|DO-?41|DO-?35|DO-?15|DO-?201/.test(u) && !/VERTICAL/.test(u)) {
    const pitch = P || 10.16;
    const L = num(name, /_L(\d+(?:\.\d+)?)mm/i, /DO-?41/.test(u) ? 5.2 : /DO-?35/.test(u) ? 3.8 : 6.3);
    const D = num(name, /_D(\d+(?:\.\d+)?)mm/i, /DO-?41/.test(u) ? 2.7 : /DO-?35/.test(u) ? 1.9 : 2.5);
    const drill = D > 2.6 ? 1.0 : 0.8;
    return { pads: { 1: tht(0, 0, drill + 0.8, drill), 2: tht(pitch, 0, drill + 0.8, drill) }, body: body(pitch / 2 - L / 2, -D / 2, pitch / 2 + L / 2, D / 2), shape: 'box', h: D, family: 'axial' };
  }
  // Radial electrolytic / disc / box capacitors.
  if (/^CP_RADIAL|^C_RADIAL|CPOL/.test(u)) {
    const D = num(name, /_D(\d+(?:\.\d+)?)mm/i, 6.3);
    const pitch = P || (D >= 8 ? 3.5 : 2.5);
    return { pads: { 1: tht(0, 0, 1.6, 0.8), 2: tht(pitch, 0, 1.6, 0.8) }, body: { cx: r3(pitch / 2), cy: 0, w: D, d: D }, shape: 'cylinder', h: r3(Math.max(5, D * 1.4)), family: 'radial-cap' };
  }
  if (/^C_DISC|^C_RECT/.test(u)) {
    const D = num(name, /_[DL](\d+(?:\.\d+)?)mm/i, 5);
    const W = num(name, /_W(\d+(?:\.\d+)?)mm/i, 2.5);
    const pitch = P || 5;
    return { pads: { 1: tht(0, 0, 1.6, 0.8), 2: tht(pitch, 0, 1.6, 0.8) }, body: body(pitch / 2 - D / 2, -W / 2, pitch / 2 + D / 2, W / 2), shape: 'box', h: r3(D + 1), family: /DISC/.test(u) ? 'disc-cap' : 'box' };
  }
  // Pin headers and sockets: rows x columns, pad 1 at the origin, rows going down.
  const hdr = /^(PINHEADER|PINSOCKET|PIN_?HEADER|CONN_\d+X\d+)?.*?(\d+)X(\d+)/.exec(u);
  if (/^PINHEADER|^PINSOCKET/.test(u) && hdr) {
    const cols = +hdr[2];
    const rows = +hdr[3];
    const pitch = P || 2.54;
    const pads = {};
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pads[String(r * cols + c + 1)] = tht(c * pitch, -r * pitch, pitch * 0.68, 1.0);
    return { pads, body: body(-pitch / 2, pitch / 2, (cols - 0.5) * pitch, -(rows - 0.5) * pitch), shape: 'box', h: 8.5, family: /SOCKET/.test(u) ? 'socket' : 'header' };
  }
  // JST and similar wire-to-board connectors: one row.
  if (/^JST_|^MOLEX|^TERMINALBLOCK/.test(u)) {
    const n = num(name, /_1x(\d+)/i, pinCount || 2);
    const pitch = P || 2.0;
    const pads = {};
    for (let i = 0; i < n; i++) pads[String(i + 1)] = tht(i * pitch, 0, Math.min(1.75, pitch * 0.85), 0.75);
    const deep = /XH/.test(u) ? 5.75 : /TERMINAL/.test(u) ? 8 : 4.5;
    return { pads, body: body(-1.95, deep - 1.7, (n - 1) * pitch + 1.95, -1.7), shape: 'box', h: /TERMINAL/.test(u) ? 10 : 6, family: 'jst' };
  }
  if (/^TO-?92/.test(u)) {
    const pitch = /WIDE/.test(u) ? 2.54 : 1.27;
    return { pads: { 1: tht(0, 0, 1.3, 0.75), 2: tht(pitch, 0, 1.3, 0.75), 3: tht(2 * pitch, 0, 1.3, 0.75) }, body: { cx: pitch, cy: -0.6, w: 4.8, d: 3.6 }, shape: 'box', h: 5, family: 'to92' };
  }
  if (/^TO-?220/.test(u)) {
    return { pads: { 1: tht(0, 0, 2, 1.1), 2: tht(2.54, 0, 2, 1.1), 3: tht(5.08, 0, 2, 1.1) }, body: { cx: 2.54, cy: 1.2, w: 10.2, d: 4.6 }, shape: 'box', h: 15, family: 'box' };
  }
  if (/^DIP-?(\d+)/.test(u)) {
    const n = num(u, /^DIP-?(\d+)/, 8);
    const W = num(name, /_W(\d+(?:\.\d+)?)mm/i, 7.62);
    const pads = {};
    for (let i = 0; i < n / 2; i++) {
      pads[String(i + 1)] = tht(0, -i * 2.54, 1.6, 0.8);
      pads[String(n - i)] = tht(W, -i * 2.54, 1.6, 0.8);
    }
    return { pads, body: body(0.635, 1.27, W - 0.635, -(n / 2 - 0.5) * 2.54), shape: 'box', h: 4.5, family: 'dip' };
  }
  // Chip passives: R_0805_2012Metric, C_0603_…, LED_1206_…
  const chip = /^(R|C|L|LED|D|FB)_(0201|0402|0603|0805|1206|1210|1812|2010|2512)/.exec(u);
  if (chip) {
    const [L, W] = CHIP[chip[2]];
    const pl = Math.max(0.3, L * 0.45);
    return { pads: { 1: smd(-L / 2 - pl * 0.15, 0, pl, W + 0.2), 2: smd(L / 2 + pl * 0.15, 0, pl, W + 0.2) }, body: { cx: 0, cy: 0, w: L, d: W }, shape: 'box', h: chip[1] === 'R' ? 0.5 : 0.9, family: 'chip' };
  }
  if (/^D_SM[ABC]\b|^D_SM[ABC]_|^D_SOD-?123|^D_SOD-?323|^D_MINIMELF/.test(u)) {
    const dims = /SMC/.test(u) ? [6.9, 5.9, 2.3] : /SMB/.test(u) ? [4.3, 3.6, 2.3] : /SMA/.test(u) ? [4.3, 2.6, 2.3] : /323/.test(u) ? [1.7, 1.25, 1] : /MELF/.test(u) ? [3.5, 1.5, 1.5] : [2.7, 1.6, 1.15];
    const [L, W, H] = dims;
    return { pads: { 1: smd(-L / 2 - 0.2, 0, Math.max(0.6, L * 0.3), W * 0.65), 2: smd(L / 2 + 0.2, 0, Math.max(0.6, L * 0.3), W * 0.65) }, body: { cx: 0, cy: 0, w: L, d: W }, shape: 'box', h: H, family: 'diode-smd' };
  }
  if (/^SOT-?23/.test(u)) {
    const n = num(u, /^SOT-?23-(\d)/, 3);
    const pads = {};
    if (n === 3) Object.assign(pads, { 1: smd(-1.14, 0.95, 1.33, 0.6), 2: smd(-1.14, -0.95, 1.33, 0.6), 3: smd(1.14, 0, 1.33, 0.6) });
    else for (let i = 0; i < n; i++) pads[String(i + 1)] = i < Math.ceil(n / 2) ? smd(-1.14, 0.95 - i * 0.95, 1.33, 0.6) : smd(1.14, -0.95 + (i - Math.ceil(n / 2)) * 0.95 * (n === 5 ? 2 : 1), 1.33, 0.6);
    return { pads, body: { cx: 0, cy: 0, w: 1.6, d: 2.9 }, shape: 'box', h: 1.1, family: 'sot' };
  }
  if (/^SOT-?223/.test(u)) {
    const pads = { 1: smd(-3.15, 2.3, 2, 1), 2: smd(-3.15, 0, 2, 1), 3: smd(-3.15, -2.3, 2, 1), 4: smd(3.15, 0, 2, 3.2) };
    return { pads, body: { cx: 0, cy: 0, w: 3.5, d: 6.5 }, shape: 'box', h: 1.8, family: 'sot' };
  }
  const so = /^(SOIC|SOP|TSSOP|MSOP|SSOP|VSSOP|HTSSOP|SO)-(\d+)/.exec(u);
  if (so) {
    const n = +so[2];
    const bw = num(name, /_(\d+(?:\.\d+)?)x\d+(?:\.\d+)?mm/i, so[1] === 'SOIC' || so[1] === 'SO' ? 3.9 : 4.4);
    const bl = num(name, /_\d+(?:\.\d+)?x(\d+(?:\.\d+)?)mm/i, (n / 2) * (P || 1.27) + 0.6);
    const pitch = P || (so[1] === 'SOIC' || so[1] === 'SO' ? 1.27 : 0.65);
    const span = bw + (so[1] === 'SOIC' || so[1] === 'SO' ? 1.5 : 1.4);
    const fp = gullWing(n, pitch, bw, bl, span, pitch * 0.47, 1.5);
    return { ...fp, shape: 'box', h: so[1] === 'SOIC' ? 1.75 : 1.2, family: 'ic-smd' };
  }
  const q = /^(QFN|DFN|QFP|LQFP|TQFP|VQFN|WQFN)-(\d+)/.exec(u);
  if (q) {
    const n = +q[2];
    const bw = num(name, /_(\d+(?:\.\d+)?)x\d+(?:\.\d+)?mm/i, 5);
    const bl = num(name, /_\d+(?:\.\d+)?x(\d+(?:\.\d+)?)mm/i, bw);
    const pitch = P || 0.5;
    const isQfp = /QFP/.test(q[1]);
    const fp = quad(n, pitch, bw, bl, isQfp ? 1.5 : 0.8, pitch * 0.5);
    return { ...fp, shape: 'box', h: isQfp ? 1.6 : 0.9, family: 'ic-smd' };
  }
  if (/^LED_D(\d)/.test(u) || /^LED_D\d+(\.\d+)?MM/.test(u)) {
    const D = num(name, /_D(\d+(?:\.\d+)?)mm/i, 5);
    return { pads: { 1: tht(0, 0, 1.8, 0.9), 2: tht(2.54, 0, 1.8, 0.9) }, body: { cx: 1.27, cy: 0, w: D, d: D }, shape: 'cylinder', h: D + 3.6, family: 'led' };
  }
  return null;
}

// A plain stand-in when the footprint is unknown: the pins in a 2.54 mm row with a body around them.
export function fallbackFootprint(pins = []) {
  const list = pins.length ? pins : ['1', '2'];
  const pads = {};
  list.forEach((p, i) => (pads[p] = tht(i * 2.54, 0, 1.7, 1.0)));
  const w = Math.max(5, (list.length - 1) * 2.54 + 3);
  return { pads, body: { cx: r3(((list.length - 1) * 2.54) / 2), cy: 0, w: r3(w), d: 4 }, shape: 'box', h: 3.5, family: 'box', guessed: true };
}

// What kind of thing a part is, for its 3D model.
export function partFamily(part) {
  if (part.family) return part.family;
  const s = `${part.package || ''} ${part.value || ''}`.toUpperCase();
  const pads = Object.values(part.pads || {});
  const smdPads = pads.filter((p) => p.length >= 5).length;
  const area = (part.body?.w || 0) * (part.body?.d || 0);
  if (/CPOL|ELKO|ELECTROLYTIC|CP_RADIAL/.test(s)) return 'radial-cap';
  if (/C_DISC|C_RAD|CERAMIC/.test(s)) return 'disc-cap';
  if (/AXIAL|0207|0204|DO-?41|DO-?35/.test(s)) return 'axial';
  if (/PINSOCKET|SOCKET|FEMALE/.test(s)) return 'socket';
  if (/HDR|HEADER|PINHD|(^|[_ -])[1-4]X\d{1,2}\b/.test(s) && area < 120) return 'header';
  if (/JST|MOLEX/.test(s)) return 'jst';
  if (/TO-?92/.test(s)) return 'to92';
  if (/SOT/.test(s)) return 'sot';
  if (/\bSMA\b|DIODE_SMA|SMB|SOD/.test(s)) return 'diode-smd';
  if (/^(R|C|L)_?(0402|0603|0805|1206)/.test(s)) return 'chip';
  if (/SOIC|TSSOP|QFN|QFP|SSOP/.test(s)) return 'ic-smd';
  if (/DIP/.test(s)) return 'dip';
  if (area > 120 || /^MOD|MODULE|BREAKOUT|XIAO|ESP|ARDUINO|PICO/.test(s)) return 'module';
  if (smdPads && smdPads === pads.length) return 'ic-smd';
  return 'box';
}
