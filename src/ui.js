// Panels: toolbar, parameters, timeline, inspector, mode bar and readouts.
import { store, on, emit, update, select, featureById, undo, redo, setMode } from './store.js';
import { evalExpr, fmt } from './expr.js';
import { FEATURES, SHAPES, EDGE_PRESETS, FACE_PRESETS, MAKES_TOOL, featureLabel } from './schema.js';
import * as act from './actions.js';
import { checkBoard, flipPart } from './board/geometry.js';
import { airwires, drc, numericBoard, rulesOf, RULES, copperLength } from './board/route.js';
import { fabFiles, bomCSV } from './board/gerber.js';
import { readSizes } from './board/sizes.js';
import { zip } from './export.js';
import { eagleScript } from './board/script.js';
import { GRIDS } from './board/editor.js';
import { saveFile, safeName } from './export.js';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}${extra}</svg>`;
export const ICON = {
  sketch: svg('<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>'),
  import: svg('<path d="M12 3v11M7.500 9.500L12 14l4.500-4.500"/><path d="M4 15v4h16v-4"/>'),
  agent: svg('<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M3 13v2M21 13v2"/>'),
  box: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  cylinder: svg('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>'),
  sphere: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12c0 1.9 3.8 3.4 8.5 3.4s8.5-1.5 8.5-3.4"/>'),
  cone: svg('<path d="M12 3L5 18"/><path d="M12 3l7 15"/><ellipse cx="12" cy="18" rx="7" ry="2.8"/>'),
  torus: svg('<ellipse cx="12" cy="12" rx="9" ry="5.5"/><ellipse cx="12" cy="11" rx="3.6" ry="1.6"/>'),
  extrude: svg('<path d="M5 19h14l-2-5H7z"/><path d="M12 12V3M8.5 6.5L12 3l3.5 3.5"/>'),
  revolve: svg('<path d="M12 3v18"/><path d="M12 6c4.5 0 7 1.5 7 3s-2.5 3-7 3"/><path d="M19 9v6c0 1.5-2.5 3-7 3"/><path d="M7 7.5C5.8 8 5 8.5 5 9"/>'),
  fillet: svg('<path d="M4 20V11a7 7 0 017-7h9"/><path d="M4 20h16V4" stroke-dasharray="2 3"/>'),
  chamfer: svg('<path d="M4 20v-9l7-7h9"/><path d="M4 20h16V4" stroke-dasharray="2 3"/>'),
  shell: svg('<path d="M4 6h16v14H4z"/><path d="M8 6v10h8V6"/>'),
  pattern: svg('<rect x="4" y="4" width="5" height="5"/><rect x="15" y="4" width="5" height="5"/><rect x="4" y="15" width="5" height="5"/><rect x="15" y="15" width="5" height="5"/>'),
  mirror: svg('<path d="M12 3v18" stroke-dasharray="2 3"/><path d="M9 7L4 17h5z"/><path d="M15 7l5 10h-5z"/>'),
  move: svg('<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>'),
  undo: svg('<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12h-2" transform="translate(0 -4)"/>'),
  redo: svg('<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 12h2" transform="translate(0 -4)"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  eyeOff: svg('<path d="M4 4l16 16"/><path d="M9.5 6C10.300 5.700 11.100 5.500 12 5.500c6 0 9.500 6.500 9.500 6.500a17 17 0 01-3 3.700M6.300 7.800A17 17 0 002.500 12S6 18.500 12 18.500c1.300 0 2.500-.300 3.600-.800"/>'),
  trash: svg('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'),
  select: svg('<path d="M6 3l12 9-5.500 1L15.500 19l-2.200 1-3-6L6 18z"/>'),
  rect: svg('<rect x="4" y="6" width="16" height="12"/>'),
  circle: svg('<circle cx="12" cy="12" r="8"/>'),
  polygon: svg('<path d="M12 3.500l7.400 4.250v8.500L12 20.500l-7.400-4.250v-8.500z"/>'),
  slot: svg('<rect x="3" y="8" width="18" height="8" rx="4"/>'),
  text: svg('<path d="M5 7V5h14v2M12 5v14M9 19h6"/>'),
  path: svg('<path d="M4 18l5-11 6 7 5-8"/><circle cx="4" cy="18" r="1.3"/><circle cx="9" cy="7" r="1.3"/><circle cx="15" cy="14" r="1.3"/><circle cx="20" cy="6" r="1.3"/>'),
  up: svg('<path d="M6 14l6-6 6 6"/>'),
  down: svg('<path d="M6 10l6 6 6-6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>'),
  file: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'),
  board: svg('<rect x="3" y="5" width="18" height="14" rx="1.5"/><rect x="6.500" y="8.500" width="5" height="5"/><path d="M14 9h4M14 12h4M7 16.500h10"/><circle cx="5.500" cy="7.500" r=".6"/>'),
  hole: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.500"/>'),
  rotate: svg('<path d="M20 12a8 8 0 11-2.300-5.600"/><path d="M20 4v5h-5"/>'),
  flip: svg('<path d="M12 3v18" stroke-dasharray="2 3"/><path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>'),
  off: svg('<rect x="9" y="9" width="11" height="11" rx="1"/><path d="M4 4l6 6M4 9V4h5"/>'),
  route: svg('<path d="M4 18h5l6-12h5"/><circle cx="4" cy="18" r="1.800"/><circle cx="20" cy="6" r="1.800"/>'),
  arrange: svg('<rect x="3.500" y="3.500" width="8" height="6"/><rect x="13.500" y="3.500" width="7" height="6"/><rect x="3.500" y="12.500" width="5" height="8"/><rect x="10.500" y="12.500" width="10" height="8"/>'),
  download: svg('<path d="M12 4v11M7.500 10.500L12 15l4.500-4.500M5 20h14"/>'),
};

const TOOLBAR = [
  [
    ['sketch', 'Sketch', 'Draw a 2D profile on a plane or a flat face'],
    ['import', 'Import', 'Bring in a 3D file, or an Eagle / Fusion Electronics .sch or .brd (or drop one onto the view)'],
    ['board', 'Board', 'Lay out a circuit board: place the parts of an Eagle schematic and see them in 3D'],
  ],
  [
    ['box', 'Box', 'Add a box'],
    ['cylinder', 'Cylinder', 'Add a cylinder'],
    ['sphere', 'Sphere', 'Add a sphere'],
    ['cone', 'Cone', 'Add a cone'],
    ['torus', 'Torus', 'Add a ring'],
  ],
  [
    ['extrude', 'Extrude', 'Pull a sketch or a flat face into a solid (E)'],
    ['revolve', 'Revolve', 'Spin a sketch around an axis'],
  ],
  [
    ['fillet', 'Fillet', 'Round edges (F)'],
    ['chamfer', 'Chamfer', 'Bevel edges'],
    ['shell', 'Shell', 'Hollow out a solid'],
  ],
  [
    ['pattern', 'Pattern', 'Repeat a feature in rows or around an axis'],
    ['mirror', 'Mirror', 'Mirror across a plane'],
    ['move', 'Move', 'Move, rotate or copy bodies'],
  ],
];

const SKETCH_TOOLS = [
  ['select', 'Select', 'Select and drag shapes (V)'],
  ['rect', 'Rectangle', 'Drag corner to corner (R)'],
  ['circle', 'Circle', 'Drag from the centre (C)'],
  ['polygon', 'Polygon', 'Drag from the centre (P)'],
  ['slot', 'Slot', 'Drag end to end (O)'],
  ['path', 'Line', 'Click points, click the first one to close (L)'],
  ['text', 'Text', 'Click where the text starts (T)'],
];

const $ = (id) => document.getElementById(id);
let refreshers = [];
let inspectorSig = '';
let selfEdit = false;
let toastTimer = null;

export function toast(msg, kind = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'error' ? 7000 : 4500);
}

const scope = () => store.results?.params || {};
const isPlain = (v) => typeof v === 'number' || /^\s*-?\d*\.?\d+\s*$/.test(String(v));

// ---------- controls ----------
function exprInput({ get, set, unit, def, id, label }) {
  const input = h('input', { type: 'text', class: 'in', id, inputmode: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': label, value: String(get() ?? def ?? '') });
  const note = h('span', { class: 'in-note' });
  const refresh = () => {
    const raw = input.value.trim();
    input.classList.remove('bad');
    note.textContent = '';
    if (raw === '') return;
    try {
      const v = evalExpr(isPlain(raw) ? Number(raw) : raw, scope());
      if (!isPlain(raw)) note.textContent = `= ${fmt(v)}${unit ? ` ${unit}` : ''}`;
    } catch (e) {
      input.classList.add('bad');
      note.textContent = e.message;
    }
  };
  const commit = () => {
    const raw = input.value.trim();
    selfEdit = true;
    set(raw === '' ? undefined : isPlain(raw) ? Number(raw) : raw);
    selfEdit = false;
    refresh();
  };
  input.addEventListener('input', commit);
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && isPlain(input.value)) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      input.value = String(Math.round((Number(input.value) + step) * 1000) / 1000);
      commit();
    }
    if (e.key === 'Enter') input.blur();
  });
  refreshers.push(refresh);
  refresh();
  return h('span', { class: 'in-wrap' }, input, unit ? h('span', { class: 'in-unit' }, unit) : null, note);
}

function selectInput({ get, set, options, id, label }) {
  const el = h(
    'select',
    { class: 'in', id, 'aria-label': label, onchange: () => set(el.value) },
    options.map(([v, text]) => h('option', { value: v }, text)),
  );
  el.value = get();
  return el;
}

function row(label, control, hint) {
  return h('div', { class: 'row' }, h('label', { class: 'row-label', for: control.querySelector?.('input,select')?.id || control.id }, label), h('div', { class: 'row-ctl' }, control, hint ? h('div', { class: 'row-hint' }, hint) : null));
}

// ---------- toolbar ----------
function renderToolbar() {
  const bar = $('toolbar');
  bar.replaceChildren(
    ...TOOLBAR.map((group) =>
      h(
        'div',
        { class: 'tool-group' },
        group.map(([id, label, tip]) => h('button', { class: 'tool', type: 'button', title: tip, 'data-cmd': id, onclick: () => act.command(id) }, h('span', { class: 'tool-ico', html: ICON[id] }), h('span', { class: 'tool-label' }, label))),
      ),
    ),
  );
}

// ---------- parameters ----------
function renderParams() {
  const box = $('params');
  refreshersFor('params', []);
  const list = [];
  const rows = store.doc.params.map((p, i) => {
    const name = h('input', { type: 'text', class: 'in p-name', id: `param-name-${i}`, 'aria-label': 'Parameter name', spellcheck: 'false', value: p.name });
    name.addEventListener('change', () => {
      const next = name.value.trim().replace(/[^A-Za-z0-9_]/g, '_');
      update((doc) => renameParam(doc, i, next));
    });
    const value = h('input', { type: 'text', class: 'in p-value', id: `param-value-${i}`, 'aria-label': `${p.name} value`, spellcheck: 'false', autocomplete: 'off', value: p.value });
    const note = h('span', { class: 'p-note' });
    const refresh = () => {
      const err = store.results?.paramErrors?.[p.name];
      value.classList.toggle('bad', !!err);
      const v = store.results?.params?.[p.name];
      note.textContent = err ? err : !isPlain(value.value) && v !== undefined ? `= ${fmt(v)}` : '';
      note.classList.toggle('bad', !!err);
    };
    value.addEventListener('input', () => {
      selfEdit = true;
      update((doc) => (doc.params[i].value = value.value.trim() || '0'), { key: `param.${i}` });
      selfEdit = false;
    });
    value.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && isPlain(value.value)) {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        value.value = String(Math.round((Number(value.value) + step) * 1000) / 1000);
        value.dispatchEvent(new Event('input'));
      }
      if (e.key === 'Enter') value.blur();
    });
    list.push(refresh);
    refresh();
    return h(
      'div',
      { class: 'p-row' },
      name,
      h('span', { class: 'p-eq' }, '='),
      value,
      h('button', { class: 'icon-btn', type: 'button', title: `Delete ${p.name}`, 'aria-label': `Delete parameter ${p.name}`, html: ICON.close, onclick: () => update((doc) => doc.params.splice(i, 1)) }),
      note,
    );
  });
  refreshersFor('params', list);
  box.replaceChildren(
    ...rows,
    h(
      'button',
      {
        class: 'ghost-btn',
        type: 'button',
        onclick: () => {
          update((doc) => {
            let n = doc.params.length + 1;
            while (doc.params.some((p) => p.name === `p${n}`)) n++;
            doc.params.push({ name: `p${n}`, value: '10' });
          });
          $(`param-name-${store.doc.params.length - 1}`)?.select();
        },
      },
      h('span', { html: ICON.plus }),
      'Add parameter',
    ),
  );
}

// Renaming a parameter also rewrites the expressions that use it.
function renameParam(doc, i, next) {
  const prev = doc.params[i].name;
  if (!next || next === prev || doc.params.some((p) => p.name === next)) return;
  doc.params[i].name = next;
  const re = new RegExp(`(?<![A-Za-z0-9_])${prev}(?![A-Za-z0-9_])`, 'g');
  const walk = (o) => {
    for (const k of Object.keys(o)) {
      if (k === 'id' || k === 'name' || k === 'type' || k === 'kind' || k === 'text') continue;
      if (typeof o[k] === 'string') o[k] = o[k].replace(re, next);
      else if (o[k] && typeof o[k] === 'object') walk(o[k]);
    }
  };
  doc.params.forEach((p) => (p.value = p.value.replace(re, next)));
  doc.features.forEach(walk);
}

const groups = {};
function refreshersFor(name, list) {
  groups[name] = list;
}

// ---------- timeline ----------
function renderTimeline() {
  const ol = $('timeline');
  const info = store.results?.features || {};
  const rolled = store.mode.kind === 'sketch' ? store.mode.id : store.mode.kind === 'pick' ? store.mode.feature : null;
  let after = false;
  const items = store.doc.features.map((f) => {
    const err = !f.suppressed && info[f.id]?.error;
    const li = h(
      'li',
      {
        class: `tl-item${store.sel.feature === f.id ? ' selected' : ''}${err ? ' error' : ''}${f.suppressed ? ' suppressed' : ''}${after ? ' rolled' : ''}`,
        'data-id': f.id,
        tabindex: '0',
        onclick: () => {
          if (store.mode.kind === 'sketch' && store.mode.id !== f.id) act.finishSketch();
          if (store.mode.kind === 'board' && store.mode.id !== f.id) act.leaveMode();
          select({ feature: f.id, shape: null });
        },
        ondblclick: () => (f.type === 'sketch' ? act.editSketch(f.id) : f.type === 'board' ? act.editBoard(f.id) : null),
        onkeydown: (e) => {
          if (e.key === 'Enter') {
            if (f.type === 'sketch') act.editSketch(f.id);
            else if (f.type === 'board') act.editBoard(f.id);
            else select({ feature: f.id, shape: null });
          }
        },
      },
      h('span', { class: 'tl-ico', html: ICON[f.type] || ICON.box }),
      h('span', { class: 'tl-name' }, featureLabel(f)),
      err ? h('span', { class: 'tl-err', title: err, html: ICON.warn }) : null,
      h('button', {
        class: 'icon-btn tl-eye',
        type: 'button',
        title: f.suppressed ? 'Turn this feature back on' : 'Suppress (skip) this feature',
        'aria-label': f.suppressed ? `Unsuppress ${featureLabel(f)}` : `Suppress ${featureLabel(f)}`,
        html: f.suppressed ? ICON.eyeOff : ICON.eye,
        onclick: (e) => {
          e.stopPropagation();
          act.toggleSuppress(f.id);
        },
      }),
    );
    if (f.id === rolled) after = true;
    return li;
  });
  ol.replaceChildren(...(items.length ? items : [h('li', { class: 'tl-empty' }, 'Nothing here yet. Start with Sketch or a Box, or ask the assistant for a first draft.')]));
}

// ---------- inspector ----------
function presetOf(value, presets) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.pick) && Object.keys(value).length === 1) return 'pick';
  const s = JSON.stringify(value);
  const hit = presets.find((p) => p.length > 2 && (JSON.stringify(p[2]) === s || (typeof p[2] === 'string' && JSON.stringify({ on: p[2] }) === s)));
  return hit ? hit[0] : 'custom';
}

function selectorField(f, fd, setKey) {
  const kind = fd.type === 'edges' ? 'edge' : 'face';
  const presets = fd.single ? [FACE_PRESETS[0]] : kind === 'edge' ? EDGE_PRESETS : FACE_PRESETS;
  const cur = presetOf(f[fd.key], presets);
  const opts = presets.map((p) => [p[0], p[1]]);
  if (cur === 'custom') opts.push(['custom', 'Custom (set by the assistant)']);
  const sel = selectInput({
    id: `f-${fd.key}`,
    label: fd.label,
    options: opts,
    get: () => cur,
    set: (v) => {
      const p = presets.find((x) => x[0] === v);
      if (v === 'pick') setKey({ pick: [] });
      else if (p) setKey(structuredClone(p[2]));
    },
  });
  const parts = [fd.single ? null : sel];
  if (cur === 'pick') {
    const n = f[fd.key].pick.length;
    const picking = store.mode.kind === 'pick' && store.mode.feature === f.id && store.mode.key === fd.key;
    parts.push(
      h(
        'div',
        { class: 'pick-line' },
        h('span', { class: `pick-count${n ? '' : ' none'}` }, n ? `${n} ${kind}${n === 1 ? '' : 's'} picked` : `No ${kind}s picked yet`),
        h('button', { class: picking ? 'btn primary small' : 'btn small', type: 'button', onclick: () => (picking ? act.leaveMode() : act.startPick(f.id, fd.key, kind)) }, picking ? 'Done' : n ? 'Change' : `Pick ${kind}s`),
      ),
    );
  } else if (cur === 'custom') parts.push(h('code', { class: 'custom-sel' }, JSON.stringify(f[fd.key])));
  return h('div', { class: 'sel-field' }, parts);
}

function vec3Field(obj, fd, setKey, idp) {
  const cur = () => (Array.isArray(obj[fd.key]) ? obj[fd.key] : fd.def || [0, 0, 0]);
  return h(
    'div',
    { class: 'vec3' },
    ['x', 'y', 'z'].map((axis, i) =>
      h(
        'label',
        { class: 'vec3-cell' },
        h('span', { class: 'vec3-axis' }, axis),
        exprInput({
          id: `${idp}-${fd.key}-${axis}`,
          label: `${fd.label} ${axis}`,
          get: () => cur()[i],
          set: (v) => {
            const next = cur().slice();
            next[i] = v === undefined ? 0 : v;
            setKey(next);
          },
        }),
      ),
    ),
  );
}

function fieldControl(obj, fd, setKey, idp) {
  switch (fd.type) {
    case 'expr':
      return exprInput({ id: `${idp}-${fd.key}`, label: fd.label, unit: fd.unit, def: fd.def, get: () => obj[fd.key], set: setKey });
    case 'text': {
      const el = h('input', { type: 'text', class: 'in', id: `${idp}-${fd.key}`, value: obj[fd.key] ?? '' });
      el.addEventListener('input', () => {
        selfEdit = true;
        setKey(el.value);
        selfEdit = false;
      });
      return el;
    }
    case 'select':
      return selectInput({ id: `${idp}-${fd.key}`, label: fd.label, options: fd.options, get: () => obj[fd.key] ?? fd.def ?? fd.options[0][0], set: setKey });
    case 'bool': {
      const el = h('input', { type: 'checkbox', id: `${idp}-${fd.key}`, onchange: () => setKey(el.checked || undefined) });
      el.checked = !!obj[fd.key];
      return el;
    }
    case 'vec3':
      return vec3Field(obj, fd, setKey, idp);
    case 'edges':
    case 'faces':
      return selectorField(obj, fd, setKey);
    case 'sketch': {
      const sketches = store.doc.features.filter((x) => x.type === 'sketch');
      return selectInput({ id: `${idp}-${fd.key}`, label: fd.label, options: sketches.length ? sketches.map((s) => [s.id, featureLabel(s)]) : [['', 'No sketches yet']], get: () => obj[fd.key] ?? '', set: setKey });
    }
    case 'tools': {
      const tools = store.doc.features.filter((x) => MAKES_TOOL.has(x.type) && x.id !== obj.id);
      const opts = tools.map((s) => [s.id, featureLabel(s)]);
      if (fd.optional) opts.unshift(['', fd.optional]);
      return selectInput({ id: `${idp}-${fd.key}`, label: fd.label, options: opts.length ? opts : [['', 'Nothing to repeat yet']], get: () => [].concat(obj[fd.key] || [])[0] ?? '', set: (v) => setKey(v ? [v] : undefined) });
    }
    case 'plane': {
      const pl = obj.plane ?? 'XY';
      const base = typeof pl === 'string' && ['XY', 'XZ', 'YZ'].includes(pl.toUpperCase());
      const opts = [
        ['XY', 'XY (top view)'],
        ['XZ', 'XZ (front view)'],
        ['YZ', 'YZ (side view)'],
      ];
      if (!base) opts.push(['face', typeof pl === 'string' ? `Face: ${pl}` : 'A face of the model']);
      return selectInput({ id: `${idp}-${fd.key}`, label: fd.label, options: opts, get: () => (base ? pl.toUpperCase() : 'face'), set: (v) => v !== 'face' && setKey(v) });
    }
    default:
      return h('span', {}, '');
  }
}

function fieldRows(obj, fields, setter, idp) {
  return fields.filter((fd) => !fd.showIf || fd.showIf(obj)).map((fd) => (fd.type === 'bool' ? h('label', { class: 'row check' }, fieldControl(obj, fd, (v) => setter(fd.key, v), idp), h('span', {}, fd.label)) : row(fd.label, fieldControl(obj, fd, (v) => setter(fd.key, v), idp), fd.hint)));
}

// ---------- boards ----------
const OUTLINES = [
  ['rect', 'Rectangle'],
  ['circle', 'Circle'],
  ['path', 'Custom outline (from the file)'],
];

function boardRows(f, setter) {
  const { mode, sel } = store;
  const editing = mode.kind === 'board' && mode.id === f.id;
  const ref = editing ? sel.shape : null;
  const part = ref && !String(ref).includes(':') ? (f.parts || []).find((p) => p.ref === ref) : null;
  const traceAt = ref && String(ref).startsWith('trace:') ? Number(String(ref).slice(6)) : -1;
  const viaAt = ref && String(ref).startsWith('via:') ? Number(String(ref).slice(4)) : -1;
  const holeAt = ref && String(ref).startsWith('hole:') ? Number(String(ref).slice(5)) : -1;
  const hole = holeAt >= 0 ? f.holes?.[holeAt] : null;
  const n = (v) => {
    try {
      return evalExpr(v ?? 0, scope());
    } catch {
      return 0;
    }
  };
  const editIn = (fn, key) =>
    update(
      (doc) => {
        const x = doc.features.find((y) => y.id === f.id);
        if (x) fn(x);
      },
      { key },
    );
  const out = [];
  out.push(
    h(
      'div',
      { class: 'insp-actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => (editing ? act.leaveMode() : act.editBoard(f.id)) }, editing ? 'Done' : 'Place and route'),
      h('button', { class: 'btn small', type: 'button', title: 'Add a block for a part that is not in the schematic (a battery holder, a sensor on a cable…)', onclick: () => (act.editBoard(f.id), act.addBoardPart(f.id)) }, 'Add a block'),
    ),
  );

  if (part) {
    const pset = (key, v) =>
      editIn((x) => {
        const p = x.parts.find((q) => q.ref === part.ref);
        if (!p) return;
        if (v === undefined) delete p[key];
        else p[key] = v;
      }, `${f.id}.${part.ref}.${key}`);
    const bset = (key, v) =>
      editIn((x) => {
        const p = x.parts.find((q) => q.ref === part.ref);
        if (p) p.body = { ...p.body, [key]: v === undefined ? 1 : v };
      }, `${f.id}.${part.ref}.body.${key}`);
    const body = part.body || {};
    out.push(
      h('h3', { class: 'insp-sub' }, `${part.ref}`, h('span', { class: 'insp-sub-note' }, [part.value, part.package].filter(Boolean).join(' · '))),
      row('X', exprInput({ id: 'part-x', label: 'X', unit: 'mm', get: () => part.x, set: (v) => pset('x', v ?? 0) })),
      row('Y', exprInput({ id: 'part-y', label: 'Y', unit: 'mm', get: () => part.y, set: (v) => pset('y', v ?? 0) })),
      row('Rotation', exprInput({ id: 'part-rot', label: 'Rotation', unit: '°', get: () => part.rot ?? 0, set: (v) => pset('rot', v ?? 0) })),
      row('Side', selectInput({ id: 'part-side', label: 'Side', options: [['top', 'Top'], ['bottom', 'Bottom']], get: () => part.side || 'top', set: (v) => (part.side || 'top') !== v && editIn((x) => flipPart(x.parts.find((q) => q.ref === part.ref)), null) })),
      row('Height', exprInput({ id: 'part-h', label: 'Height', unit: 'mm', get: () => part.h, set: (v) => pset('h', v) }), 'from the board surface, or from the lift'),
      row('Lift', exprInput({ id: 'part-lift', label: 'Lift', unit: 'mm', def: 0, get: () => part.lift, set: (v) => pset('lift', v || undefined) }), 'gap under the part, about 8.5 on pin headers'),
      row('Body width', exprInput({ id: 'part-w', label: 'Body width', unit: 'mm', get: () => body.w, set: (v) => bset('w', v) })),
      row('Body depth', exprInput({ id: 'part-d', label: 'Body depth', unit: 'mm', get: () => body.d, set: (v) => bset('d', v) })),
      row('Shape', selectInput({ id: 'part-shape', label: 'Shape', options: [['box', 'Box'], ['cylinder', 'Cylinder']], get: () => part.shape || 'box', set: (v) => pset('shape', v) })),
    );
    // 3D model: drawn from the footprint, a plain block, or the person's own file.
    const model = part.model && typeof part.model === 'object' ? part.model : null;
    const pickModel = () => {
      const input = h('input', { type: 'file', accept: '.step,.stp,.stl,.obj,.3mf,.wrl', hidden: true });
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        if (/\.wrl$/i.test(file.name)) return toast('VRML (.wrl) models are not supported; use the STEP version of the model (KiCad ships both).', 'error');
        const { putFile } = await import('./files.js');
        const id = await putFile(file.name, new Uint8Array(await file.arrayBuffer()));
        pset('model', { file: id, fileName: file.name });
        toast(`${part.ref} now shows ${file.name}, centred on its body. Turn or shift it below if it sits wrong.`);
      });
      document.body.append(input);
      input.click();
      setTimeout(() => input.remove(), 60000);
    };
    out.push(
      row(
        '3D model',
        selectInput({
          id: 'part-model',
          label: '3D model',
          options: [['auto', 'From the footprint'], ['box', 'Plain block'], ...(model ? [['file', `File: ${model.fileName}`]] : []), ['pick', 'Load a STEP / STL file…']],
          get: () => (model ? 'file' : part.model === 'box' ? 'box' : 'auto'),
          set: (v) => (v === 'pick' ? pickModel() : v === 'file' ? null : pset('model', v === 'box' ? 'box' : undefined)),
        }),
      ),
    );
    if (model) {
      const mset = (key, v) =>
        editIn((x) => {
          const p = x.parts.find((q) => q.ref === part.ref);
          if (p?.model && typeof p.model === 'object') p.model = { ...p.model, [key]: v };
        }, `${f.id}.${part.ref}.model.${key}`);
      out.push(
        row('Model turn', vec3Field(model, { key: 'rot', label: 'Model turn', def: [0, 0, 0] }, (v) => mset('rot', v), 'model-rot'), 'degrees about x, y, z'),
        row('Model shift', vec3Field(model, { key: 'at', label: 'Model shift', def: [0, 0, 0] }, (v) => mset('at', v), 'model-at')),
        row('Model units', selectInput({ id: 'model-units', label: 'Model units', options: [['mm', 'Millimetres'], ['in', 'Inches'], ['cm', 'Centimetres'], ['m', 'Metres']], get: () => model.units || 'mm', set: (v) => mset('units', v) })),
      );
    }
    const on = h('input', { type: 'checkbox', id: 'part-on', onchange: () => (on.checked ? pset('off', undefined) : act.app.board?.takeOff()) });
    on.checked = !part.off;
    out.push(h('label', { class: 'row check' }, on, h('span', {}, 'On the board')));
    const nets = (f.nets || []).filter((net) => (net.pads || []).some(([r]) => r === part.ref)).map((net) => net.name);
    if (nets.length) out.push(h('p', { class: 'insp-note' }, `Connects to ${nets.join(', ')}.`));
  } else if (traceAt >= 0 && f.traces?.[traceAt]) {
    const t = f.traces[traceAt];
    let len = 0;
    for (let i = 0; i + 1 < t.pts.length; i++) len += Math.hypot(t.pts[i + 1][0] - t.pts[i][0], t.pts[i + 1][1] - t.pts[i][1]);
    const tset = (key, v) => editIn((x) => x.traces[traceAt] && (x.traces[traceAt][key] = v), `${f.id}.trace${traceAt}.${key}`);
    out.push(
      h('h3', { class: 'insp-sub' }, 'Trace', h('span', { class: 'insp-sub-note' }, `${t.net || 'no net'} · ${fmt(len, 1)} mm`)),
      row('Width', exprInput({ id: 'trace-w', label: 'Width', unit: 'mm', get: () => t.w ?? RULES.trace, set: (v) => tset('w', Number(v) || RULES.trace) })),
      row('Layer', selectInput({ id: 'trace-layer', label: 'Layer', options: [['top', 'Top copper'], ['bottom', 'Bottom copper']], get: () => t.layer || 'top', set: (v) => tset('layer', v) })),
      h('div', { class: 'insp-actions' }, h('button', { class: 'btn small danger', type: 'button', onclick: () => act.app.board?.takeOff() }, 'Delete trace')),
    );
  } else if (viaAt >= 0 && f.vias?.[viaAt]) {
    const v = f.vias[viaAt];
    const vset = (key, val) => editIn((x) => x.vias[viaAt] && (x.vias[viaAt][key] = val), `${f.id}.via${viaAt}.${key}`);
    out.push(
      h('h3', { class: 'insp-sub' }, 'Via', h('span', { class: 'insp-sub-note' }, v.net || 'no net')),
      row('Pad', exprInput({ id: 'via-d', label: 'Pad', unit: 'mm', get: () => v.d, set: (val) => vset('d', Number(val) || RULES.via) })),
      row('Drill', exprInput({ id: 'via-drill', label: 'Drill', unit: 'mm', get: () => v.drill, set: (val) => vset('drill', Number(val) || RULES.drill) })),
      h('div', { class: 'insp-actions' }, h('button', { class: 'btn small danger', type: 'button', onclick: () => act.app.board?.takeOff() }, 'Delete via')),
    );
  } else if (hole) {
    const hset = (key, v) =>
      editIn((x) => {
        if (x.holes?.[holeAt]) x.holes[holeAt][key] = v ?? 0;
      }, `${f.id}.hole${holeAt}.${key}`);
    out.push(
      h('h3', { class: 'insp-sub' }, `Hole ${holeAt + 1}`),
      row('X', exprInput({ id: 'hole-x', label: 'X', unit: 'mm', get: () => hole.x, set: (v) => hset('x', v) })),
      row('Y', exprInput({ id: 'hole-y', label: 'Y', unit: 'mm', get: () => hole.y, set: (v) => hset('y', v) })),
      row('Diameter', exprInput({ id: 'hole-d', label: 'Diameter', unit: 'mm', get: () => hole.d, set: (v) => hset('d', v) }), '3.2 for M3 screws'),
      h('div', { class: 'insp-actions' }, h('button', { class: 'btn small danger', type: 'button', onclick: () => act.app.board?.takeOff() }, 'Delete hole')),
    );
  } else {
    const ol = f.outline || { kind: 'rect', w: 60, h: 40 };
    const oset = (key, v) =>
      editIn((x) => {
        x.outline = { ...(x.outline || { kind: 'rect', w: 60, h: 40 }) };
        if (v === undefined) delete x.outline[key];
        else x.outline[key] = v;
      }, `${f.id}.outline.${key}`);
    const kind = selectInput({
      id: 'board-outline',
      label: 'Outline',
      options: ol.kind === 'path' ? OUTLINES : OUTLINES.slice(0, 2),
      get: () => ol.kind,
      set: (v) =>
        editIn((x) => {
          const cur = x.outline || {};
          const pts = cur.kind === 'path' ? cur.pts.map((p) => [n(p[0]), n(p[1])]) : null;
          const span = pts ? [Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))] : null;
          const big = Math.max(n(cur.w || 0), n(cur.h || 0), n(cur.d || 0), ...(span || [0])) || 50;
          const c = pts ? [(Math.max(...pts.map((p) => p[0])) + Math.min(...pts.map((p) => p[0]))) / 2, (Math.max(...pts.map((p) => p[1])) + Math.min(...pts.map((p) => p[1]))) / 2] : [cur.x ?? 0, cur.y ?? 0];
          x.outline = v === 'circle' ? { kind: 'circle', d: big, x: c[0], y: c[1] } : { kind: 'rect', w: span ? span[0] : n(cur.d) || big, h: span ? span[1] : n(cur.d) || big * 0.75, r: 2, x: c[0], y: c[1] };
        }, null),
    });
    out.push(h('h3', { class: 'insp-sub' }, 'Board'), row('Outline', kind));
    if (ol.kind === 'circle') out.push(row('Diameter', exprInput({ id: 'board-d', label: 'Diameter', unit: 'mm', get: () => ol.d, set: (v) => oset('d', v) })));
    if (ol.kind === 'rect') {
      out.push(
        row('Width', exprInput({ id: 'board-w', label: 'Width', unit: 'mm', get: () => ol.w, set: (v) => oset('w', v) })),
        row('Height', exprInput({ id: 'board-h', label: 'Height', unit: 'mm', get: () => ol.h, set: (v) => oset('h', v) })),
        row('Corner radius', exprInput({ id: 'board-r', label: 'Corner radius', unit: 'mm', def: 0, get: () => ol.r, set: (v) => oset('r', v) })),
      );
    }
    out.push(
      h(
        'div',
        { class: 'insp-actions' },
        h('button', {
          class: 'btn small',
          type: 'button',
          title: 'Shape the board to the inside of the enclosure at the board\'s height, 1 mm clear of the wall',
          onclick: async () => {
            const at = (f.at || [0, 0, 0]).map(n);
            try {
              const res = await act.app.kernel.fitBoard({ at, th: n(f.thickness ?? 1.6), clearance: 1 });
              editIn((x) => (x.outline = res.outline), null);
              toast(res.outline.kind === 'circle' ? `The enclosure is ${fmt(res.wall.d, 2)} mm across inside at this height; the board is now ${fmt(res.outline.d, 2)} mm round.` : `The board now follows the inside of the enclosure, 1 mm clear of the wall (${res.outline.pts.length} points).`);
            } catch (e) {
              toast(e.message, 'error');
            }
          },
        }, 'Fit outline to enclosure'),
        h('button', {
          class: 'btn small',
          type: 'button',
          title: 'Printed mounting posts under each hole, from the enclosure below up to the board, with a pilot hole for the screw',
          onclick: async () => {
            const res = await act.addStandoffs(f.id);
            if (res.error) return toast(res.error, 'error');
            toast(`Added ${res.added} standoff${res.added === 1 ? '' : 's'}${res.onSurface < res.added ? ` (${res.added - res.onSurface} start on the bed: nothing is under them)` : ', joined to the enclosure'}, with ${res.added === 1 ? 'a pilot hole' : 'pilot holes'} for self-tapping screws.${res.skipped.length ? ` Holes ${res.skipped.join(', ')} sit right on a surface.` : ''}`);
          },
        }, 'Add standoffs'),
        h('button', {
          class: 'btn small',
          type: 'button',
          title: 'Set part heights from a sizes list, BOM or notes: any line naming a part (U4) with L x W x H in mm',
          onclick: () => {
            const input = h('input', { type: 'file', accept: '.txt,.csv,.tsv,.md,text/plain', hidden: true });
            input.addEventListener('change', async () => {
              const file = input.files[0];
              input.remove();
              if (!file) return;
              const found = readSizes(await file.text(), (f.parts || []).map((p) => p.ref));
              if (!found.length) return toast(`${file.name} has no lines that name a part of this board with a size like "21 x 17.8 x 3.5".`, 'error');
              editIn((x) => {
                for (const s2 of found) {
                  const p = x.parts.find((q) => q.ref === s2.ref);
                  if (p) p.h = s2.h;
                }
              }, null);
              toast(`Heights from ${file.name}: ${found.map((s2) => `${s2.ref} ${s2.h}`).join(', ')} mm. Modules on pin headers also need their Lift (about 8.5 mm).`);
            });
            document.body.append(input);
            input.click();
          },
        }, 'Heights from a file…'),
      ),
      ...fieldRows(f, FEATURES.board.fields, setter, 'f'),
    );
    if (ol.kind === 'path') out.push(h('p', { class: 'insp-note' }, `Outline from ${f.source || 'the file'}, ${ol.pts.length} points. Switch to a rectangle or circle to size it here.`));
  }

  // Problems: refreshed in place as values change, so typing keeps its focus.
  const list = h('ul', { class: 'board-issues', 'aria-live': 'polite' });
  const fillIssues = () => {
    const cur = featureById(f.id);
    if (!cur) return;
    const issues = checkBoard(cur, n);
    const wires = airwires(numericBoard(cur, n));
    const len = wires.filter((w) => !w.offBoard).reduce((sum, w) => sum + w.length, 0);
    list.replaceChildren(
      ...(issues.length ? issues : [{ kind: 'ok', refs: [], message: 'No clashes: every part is on the board, clear of the others, the edge and the holes.' }]).map((i) =>
        h('li', { class: `bi-${i.kind}`, onclick: () => i.refs[0] && (act.editBoard(f.id), select({ shape: i.refs[0] })) }, i.message),
      ),
      h('li', { class: 'bi-info' }, wires.length ? `${(cur.nets || []).length} nets; ${wires.length} connection${wires.length === 1 ? '' : 's'} (${Math.round(len)} mm) still to route.` : `${(cur.nets || []).length} nets, all routed.`),
    );
  };
  refreshers.push(fillIssues);
  fillIssues();
  out.push(h('h3', { class: 'insp-sub' }, 'Placement check'), list);

  // Copper: design rules, their check, and the autorouter.
  const rules = rulesOf(f);
  const rset = (key, v) => editIn((x) => (x.rules = { ...(x.rules || {}), [key]: Number(v) || RULES[key] }), `${f.id}.rules.${key}`);
  const drcList = h('ul', { class: 'board-issues', 'aria-live': 'polite' });
  const fillDrc = () => {
    const cur = featureById(f.id);
    if (!cur) return;
    const nb = numericBoard(cur, n);
    if (!(nb.traces || []).length && !(nb.vias || []).length) {
      drcList.replaceChildren(h('li', { class: 'bi-info' }, 'No copper yet. Route by hand (Route tool, X) or let the autorouter do it.'));
      return;
    }
    const res = drc(nb);
    const lens = copperLength(nb);
    const total = Object.values(lens).reduce((a, v) => a + v, 0);
    drcList.replaceChildren(
      ...(res.issues.length ? res.issues.slice(0, 40) : [{ kind: 'ok', message: `Design rules pass: ${nb.traces.length} traces (${Math.round(total)} mm), ${(nb.vias || []).length} vias.` }]).map((i) => h('li', { class: i.kind === 'ok' ? 'bi-ok' : 'bi-overlap' }, i.message)),
      ...(res.issues.length > 40 ? [h('li', { class: 'bi-info' }, `and ${res.issues.length - 40} more.`)] : []),
      h('li', { class: res.unrouted ? 'bi-unplaced' : 'bi-ok' }, res.unrouted ? `${res.unrouted} connection${res.unrouted === 1 ? '' : 's'} still unrouted.` : 'Every connection is routed.'),
    );
  };
  refreshers.push(fillDrc);
  fillDrc();
  out.push(
    h('h3', { class: 'insp-sub' }, 'Routing'),
    h(
      'div',
      { class: 'rules-grid' },
      row('Trace', exprInput({ id: 'rule-trace', label: 'Trace width', unit: 'mm', get: () => rules.trace, set: (v) => rset('trace', v) })),
      row('Clearance', exprInput({ id: 'rule-clearance', label: 'Clearance', unit: 'mm', get: () => rules.clearance, set: (v) => rset('clearance', v) })),
      row('Via', exprInput({ id: 'rule-via', label: 'Via pad', unit: 'mm', get: () => rules.via, set: (v) => rset('via', v) })),
      row('Via drill', exprInput({ id: 'rule-drill', label: 'Via drill', unit: 'mm', get: () => rules.drill, set: (v) => rset('drill', v) })),
    ),
    ...(() => {
      // Copper pours, one per layer: the net that fills the free space (usually GND).
      const netNames = (f.nets || []).map((x) => x.name);
      const guess = netNames.find((x) => /^(GND|VSS|0V|AGND|DGND)$/i.test(x)) || netNames.find((x) => /GND/i.test(x));
      const opts = [['', 'None'], ...(guess ? [[guess, guess]] : []), ...netNames.filter((x) => x !== guess).map((x) => [x, x])];
      const pourOf = (layer) => (f.pours || []).find((p) => p.layer === layer)?.net || '';
      const setPour = (layer, net) =>
        editIn((x) => {
          x.pours = (x.pours || []).filter((p) => p.layer !== layer);
          if (net) x.pours.push({ net, layer });
          if (!x.pours.length) delete x.pours;
        }, null);
      return [
        row('Top pour', selectInput({ id: 'pour-top', label: 'Top copper pour', options: opts, get: () => pourOf('top'), set: (v) => setPour('top', v) })),
        row('Bottom pour', selectInput({ id: 'pour-bottom', label: 'Bottom copper pour', options: opts, get: () => pourOf('bottom'), set: (v) => setPour('bottom', v) }), 'fills the free copper with a net; a GND pour on the bottom saves most ground routing'),
      ];
    })(),
    drcList,
    h(
      'div',
      { class: 'insp-actions' },
      h('button', { class: 'btn small', type: 'button', title: 'Route every connection that is not routed yet, keeping the traces already there', onclick: () => (act.editBoard(f.id), act.app.board?.autoroute()) }, 'Autoroute'),
      h('button', { class: 'btn small', type: 'button', title: 'Remove every trace and via', onclick: () => editIn((x) => ((x.traces = []), (x.vias = [])), null) }, 'Remove copper'),
      h('button', {
        class: 'btn small',
        type: 'button',
        title: 'Gerber and drill files to order the board from a board house',
        onclick: async () => {
          const cur = featureById(f.id);
          const nb = numericBoard(cur, n);
          const res = drc(nb);
          const base = safeName(featureLabel(cur));
          const files = fabFiles(nb, base);
          const blob = zip(files.map((x) => ({ name: x.name, data: new TextEncoder().encode(x.data) })));
          const msg = await saveFile(`${base}-gerbers.zip`, new Uint8Array(await blob.arrayBuffer()), 'application/zip');
          if (msg) toast(`${msg}.${res.unrouted ? ` Note: ${res.unrouted} connections are not routed yet.` : ''}${res.issues.length ? ` ${res.issues.length} design-rule errors remain.` : ''} Check the files in a Gerber viewer before ordering.`, res.unrouted || res.issues.length ? 'error' : 'info');
        },
      }, 'Export Gerbers'),
      h('button', {
        class: 'btn small',
        type: 'button',
        title: 'Bill of materials: every part, grouped by value and package, with references and quantities',
        onclick: async () => {
          const msg = await saveFile(`${safeName(featureLabel(f))}-bom.csv`, bomCSV(featureById(f.id)), 'text/csv');
          if (msg) toast(msg);
        },
      }, 'BOM (.csv)'),
    ),
  );
  const fit = h('ul', { class: 'board-issues' });
  out.push(
    h(
      'div',
      { class: 'insp-actions' },
      h('button', {
        class: 'btn small',
        type: 'button',
        title: 'Test every part against the other bodies (an enclosure) for collisions and tight gaps',
        onclick: async () => {
          fit.replaceChildren(h('li', { class: 'bi-info' }, 'Checking…'));
          try {
            const res = await act.app.kernel.interference({ board: f.id, clearance: 0.5 });
            fit.replaceChildren(
              ...(res.bodies ? (res.issues.length ? res.issues.map((i) => h('li', { class: i.kind === 'collides' ? 'bi-overlap' : 'bi-edge' }, i.kind === 'collides' ? `${i.part} runs into ${i.body} (${fmt(i.volume, 1)} mm³ overlap).` : i.distance === null ? `${i.part} comes within 0.5 mm of ${i.body} (measured on its box: the enclosure is a mesh).` : `${i.part} is ${fmt(i.distance, 2)} mm from ${i.body}.`)) : [h('li', { class: 'bi-ok' }, `Fits: no part touches or comes within 0.5 mm of ${res.bodies === 1 ? 'the other body' : `the ${res.bodies} other bodies`}.`)]) : [h('li', { class: 'bi-info' }, 'There is nothing else in the model to check against yet. Import or model the enclosure.')]),
            );
          } catch (e) {
            fit.replaceChildren(h('li', { class: 'bi-overlap' }, e.message));
          }
        },
      }, 'Check fit in enclosure'),
      h('button', {
        class: 'btn small',
        type: 'button',
        title: 'A script that moves the parts to these places in the Eagle or Fusion Electronics board editor',
        onclick: async () => {
          const msg = await saveFile(`${safeName(featureLabel(f))}-placement.scr`, eagleScript(featureById(f.id), n, { name: featureLabel(f) }), 'text/plain');
          if (msg) toast(`${msg}. Run it in the Eagle / Fusion Electronics board editor (File > Execute Script).`);
        },
      }, 'Export to Eagle (.scr)'),
    ),
    fit,
  );

  // Every part, to find one quickly.
  const parts = f.parts || [];
  if (parts.length)
    out.push(
      h('h3', { class: 'insp-sub' }, `Parts (${parts.filter((p) => !p.off).length} of ${parts.length} placed)`),
      h(
        'table',
        { class: 'bodies board-parts' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Part'), h('th', {}, 'Side'), h('th', {}, 'Size (mm)'))),
        h(
          'tbody',
          {},
          parts.map((p) =>
            h(
              'tr',
              { class: `${p.ref === ref ? 'sel' : ''}${p.off ? ' off' : ''}`, tabindex: '0', title: [p.value, p.package].filter(Boolean).join(' · '), onclick: () => (act.editBoard(f.id), select({ shape: p.ref })) },
              h('td', {}, h('span', { class: 'swatch', style: `background:${p.color || '#3a3d44'}` }), p.ref),
              h('td', {}, p.off ? 'off' : p.side || 'top'),
              h('td', { class: 'num' }, `${fmt(n(p.body?.w), 1)} × ${fmt(n(p.body?.d), 1)} × ${fmt(n(p.h), 1)}`),
            ),
          ),
        ),
      ),
    );
  return out;
}

function inspectorSignature() {
  const { mode, sel } = store;
  const f = featureById(sel.feature);
  const sk = mode.kind === 'sketch' ? featureById(mode.id) : null;
  const shape = sk && sel.shape ? sk.shapes.find((s) => s.id === sel.shape) : null;
  const shapeOf = (o) => (o ? Object.keys(o).sort().join(',') + JSON.stringify([o.type, o.kind, o.extent, o.face !== undefined, o.plane, o.hole, o.suppressed, o.sketch, o.features, o.op, o.side, o.axis, o.dir, o.dir2, o.copy]) : '');
  const sels = f ? JSON.stringify([f.edges && (f.edges.pick ? f.edges.pick.length : f.edges), f.faces && (f.faces.pick ? f.faces.pick.length : f.faces), f.face && f.face.pick && f.face.pick.length]) : '';
  // With nothing selected the inspector shows each body's size and volume, so those count too.
  const sizes = f ? '' : (store.results?.bodies || []).map((b) => `${b.name}:${b.min.concat(b.max).map((v) => v.toFixed(2)).join(',')}:${Math.round(b.volume)}`).join(';');
  // Boards: which part or hole is selected and the shape of what it has, not the values being typed.
  const brd = f?.type === 'board' ? JSON.stringify([f.outline?.kind, f.pours, (f.holes || []).length, (f.parts || []).map((p) => `${p.ref}${p.off ? '-' : ''}${p.side === 'bottom' ? 'b' : ''}${p.shape}`).join(), mode.kind === 'board' && mode.id === f.id, sel.shape && (f.parts || []).find((p) => p.ref === sel.shape) ? Object.keys((f.parts || []).find((p) => p.ref === sel.shape)).sort().join() : '']) : '';
  return [brd, sizes, store.results?.features?.[sel.feature]?.note, store.results?.features?.[sel.feature]?.error, mode.kind, mode.feature, mode.key, sel.feature, sel.shape, shapeOf(f), sels, shapeOf(shape), sk ? sk.shapes.length : '', store.doc.features.length, sel.picks.length, store.results?.bodies.length].join('|');
}

function renderInspector(force = false) {
  const sig = inspectorSignature();
  if (!force && sig === inspectorSig) return;
  inspectorSig = sig;
  refreshers = [];
  const box = $('inspector');
  const { mode, sel } = store;
  const info = store.results?.features || {};

  // A shape inside the open sketch.
  if (mode.kind === 'sketch') {
    const sk = featureById(mode.id);
    const shape = sk && sel.shape ? sk.shapes.find((s) => s.id === sel.shape) : null;
    if (sk && shape) {
      const def = SHAPES[shape.kind] || { label: shape.kind, fields: [] };
      const setter = (key, v) =>
        update(
          (doc) => {
            const s = doc.features.find((x) => x.id === sk.id)?.shapes.find((x) => x.id === shape.id);
            if (!s) return;
            if (v === undefined) delete s[key];
            else s[key] = v;
          },
          { key: `${sk.id}.${shape.id}.${key}` },
        );
      const hole = h('input', { type: 'checkbox', id: 'shape-hole', onchange: () => setter('hole', hole.checked || undefined) });
      hole.checked = !!shape.hole;
      box.replaceChildren(
        h('div', { class: 'insp-head' }, h('span', { class: 'insp-ico', html: ICON[shape.kind] || ICON.rect }), h('h2', {}, def.label), h('span', { class: 'insp-tag' }, 'in sketch')),
        ...fieldRows(shape, def.fields, setter, 'shape'),
        h('p', { class: 'insp-note' }, shape.kind === 'path' ? `${shape.pts.length} points. Drag the path to move it.` : shape.kind === 'text' ? 'The box in the view is a placeholder; the real letters appear once the sketch is extruded.' : 'Type exact sizes here. Values can use parameters, like width/2.'),
        h('label', { class: 'row check' }, hole, h('span', {}, 'Cut-out (subtract from the other shapes)')),
        h('div', { class: 'insp-actions' }, h('button', { class: 'btn danger', type: 'button', onclick: () => { update((doc) => { const s = doc.features.find((x) => x.id === sk.id); s.shapes = s.shapes.filter((x) => x.id !== shape.id); }); select({ shape: null }); } }, 'Delete shape')),
      );
      return;
    }
  }

  const f = featureById(sel.feature);
  if (f) {
    const def = FEATURES[f.type] || { label: f.type, fields: [] };
    const setter = (key, v) =>
      update(
        (doc) => {
          const x = doc.features.find((y) => y.id === f.id);
          if (!x) return;
          if (v === undefined) delete x[key];
          else x[key] = v;
        },
        { key: `${f.id}.${key}` },
      );
    const name = h('input', { type: 'text', class: 'in insp-name', id: 'feature-name', 'aria-label': 'Feature name', value: featureLabel(f) });
    name.addEventListener('input', () => {
      selfEdit = true;
      setter('name', name.value);
      selfEdit = false;
      renderTimeline();
    });
    const err = !f.suppressed && info[f.id]?.error;
    const at = store.doc.features.findIndex((x) => x.id === f.id);
    const kids = [
      h('div', { class: 'insp-head' }, h('span', { class: 'insp-ico', html: ICON[f.type] || ICON.box }), name, h('span', { class: 'insp-tag' }, def.label)),
      err ? h('div', { class: 'insp-error', role: 'alert' }, h('span', { html: ICON.warn }), h('span', {}, err)) : null,
      f.suppressed ? h('div', { class: 'insp-warn' }, 'Suppressed: this feature is skipped until you turn it back on.') : null,
      !err && info[f.id]?.note && f.type !== 'board' ? h('p', { class: 'insp-note' }, info[f.id].note) : null,
      ...(f.type === 'board' ? boardRows(f, setter) : fieldRows(f, def.fields, setter, 'f')),
    ];
    if (f.type === 'sketch') {
      const editing = mode.kind === 'sketch' && mode.id === f.id;
      kids.push(
        h('p', { class: 'insp-note' }, f.shapes?.length ? `${f.shapes.length} shape${f.shapes.length === 1 ? '' : 's'}: ${f.shapes.map((s) => SHAPES[s.kind]?.label || s.kind).join(', ')}` : 'Empty sketch. Pick a shape tool above the view and drag on the plane.'),
        h('div', { class: 'insp-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => (editing ? act.finishSketch() : act.editSketch(f.id)) }, editing ? 'Finish sketch' : 'Edit sketch')),
      );
    }
    kids.push(
      h(
        'div',
        { class: 'insp-actions foot' },
        h('button', { class: 'icon-btn', type: 'button', title: 'Move earlier in the timeline', 'aria-label': 'Move earlier', html: ICON.up, disabled: at <= 0, onclick: () => act.moveFeature(f.id, -1) }),
        h('button', { class: 'icon-btn', type: 'button', title: 'Move later in the timeline', 'aria-label': 'Move later', html: ICON.down, disabled: at >= store.doc.features.length - 1, onclick: () => act.moveFeature(f.id, 1) }),
        h('button', { class: 'btn small', type: 'button', onclick: () => act.toggleSuppress(f.id) }, f.suppressed ? 'Unsuppress' : 'Suppress'),
        h('button', { class: 'btn small danger', type: 'button', onclick: () => act.deleteFeature(f.id) }, 'Delete'),
      ),
    );
    box.replaceChildren(...kids.filter(Boolean));
    return;
  }

  // Nothing selected: part summary.
  const res = store.results;
  // A board's parts, pins and copper are many bodies; the board's own row stands for them.
  const bodies = (res?.bodies || []).filter((b) => !b.kind || b.kind === 'board');
  box.replaceChildren(
    h('div', { class: 'insp-head' }, h('span', { class: 'insp-ico', html: ICON.box }), h('h2', {}, 'Part')),
    bodies.length
      ? h(
          'table',
          { class: 'bodies' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Body'), h('th', {}, 'Size (mm)'), h('th', {}, 'Volume'))),
          h(
            'tbody',
            {},
            bodies.map((b) => h('tr', {}, h('td', {}, b.name), h('td', { class: 'num' }, b.max.map((v, i) => fmt(v - b.min[i], 1)).join(' × ')), h('td', { class: 'num', title: b.isReference ? 'Approximate: this reference mesh is not a closed solid' : null }, `${b.isReference ? '≈ ' : ''}${fmt(b.volume / 1000, 2)} cm³`))),
          ),
        )
      : h('p', { class: 'insp-note' }, 'No solids yet.'),
    h('p', { class: 'insp-note' }, 'Click a feature in the timeline to edit it. Click a face or edge in the view to select it, then pick a tool.'),
  );
}

// ---------- mode bar, hints, readout ----------
function renderModebar() {
  const bar = $('modebar');
  const { mode, sel } = store;
  let kids = null;
  if (mode.kind === 'sketch') {
    const f = featureById(mode.id);
    kids = [
      h('span', { class: 'mb-title' }, featureLabel(f || { type: 'sketch' })),
      h(
        'div',
        { class: 'mb-tools', role: 'toolbar', 'aria-label': 'Sketch tools' },
        SKETCH_TOOLS.map(([id, label, tip]) => h('button', { class: `tool${mode.tool === id ? ' active' : ''}`, type: 'button', title: tip, 'aria-pressed': String(mode.tool === id), onclick: () => act.setSketchTool(id) }, h('span', { class: 'tool-ico', html: ICON[id] }), h('span', { class: 'tool-label' }, label))),
      ),
      h('button', { class: 'btn primary', type: 'button', id: 'finish-sketch', onclick: () => act.finishSketch() }, 'Finish sketch'),
    ];
  } else if (mode.kind === 'board') {
    const f = featureById(mode.id);
    const ed = act.app.board;
    const tool = (id, label, tip) => h('button', { class: `tool${mode.tool === id ? ' active' : ''}`, type: 'button', title: tip, 'aria-pressed': String(mode.tool === id), onclick: () => act.setBoardTool(id) }, h('span', { class: 'tool-ico', html: ICON[id] }), h('span', { class: 'tool-label' }, label));
    const cmd = (icon, label, tip, fn) => h('button', { class: 'tool', type: 'button', title: tip, onclick: fn }, h('span', { class: 'tool-ico', html: ICON[icon] }), h('span', { class: 'tool-label' }, label));
    const auto = h(
      'select',
      { class: 'in mb-select', 'aria-label': 'Arrange or route automatically', title: 'Arrange parts or route copper automatically', onchange: () => {
        const v = auto.value;
        auto.value = '';
        if (v === 'rest') ed.arrange('rest', ['top', 'bottom']);
        else if (v === 'top') ed.arrange('all', ['top']);
        else if (v === 'both') ed.arrange('all', ['top', 'bottom']);
        else if (v === 'route') ed.autoroute();
        else if (v === 'tidy') ed.tidy();
        else if (v === 'unroute') ed.clearCopper();
      } },
      h('option', { value: '' }, 'Auto…'),
      h('option', { value: 'rest' }, 'Place the rest'),
      h('option', { value: 'tidy' }, 'Tidy: shorter connections'),
      h('option', { value: 'top' }, 'Rearrange all, top side'),
      h('option', { value: 'both' }, 'Rearrange all, both sides'),
      h('option', { value: 'route' }, 'Autoroute what is left'),
      h('option', { value: 'unroute' }, 'Remove all traces and vias'),
    );
    const grid = h('select', { class: 'in mb-select', 'aria-label': 'Snap grid', title: 'Snap grid (hold Alt while dragging to place freely)', onchange: () => ed.setGrid(Number(grid.value)) }, GRIDS.map((g) => h('option', { value: String(g) }, `${g} mm`)));
    grid.value = String(ed.grid);
    const below = h('input', { type: 'checkbox', id: 'board-below', onchange: () => ed.setFlip(below.checked) });
    below.checked = ed.flip;
    const routing = mode.tool === 'route';
    const layer = h('select', { class: 'in mb-select', id: 'route-layer', 'aria-label': 'Copper layer', title: 'Layer to draw on (V while routing drops a via and switches)', onchange: () => ed.setLayer(layer.value) }, h('option', { value: 'top' }, 'Top copper'), h('option', { value: 'bottom' }, 'Bottom copper'));
    layer.value = ed.layer;
    const rules = rulesOf(f || {});
    const width = h('select', { class: 'in mb-select', id: 'route-width', 'aria-label': 'Trace width', title: 'Width of new traces', onchange: () => update((doc) => { const x = doc.features.find((y) => y.id === mode.id); if (x) x.rules = { ...(x.rules || {}), trace: Number(width.value) }; }) }, [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.8, 1].map((w) => h('option', { value: String(w) }, `${w} mm`)));
    width.value = String(rules.trace);
    kids = [
      h('span', { class: 'mb-title' }, featureLabel(f || { type: 'board' })),
      h('div', { class: 'mb-tools', role: 'toolbar', 'aria-label': 'Board tools' }, tool('select', 'Select', 'Select and drag parts, traces and vias (V)'), tool('route', 'Route', 'Draw copper traces: click a pad, click corners, click the pad to join (X)'), tool('hole', 'Hole', 'Click to add mounting holes (H)')),
      routing
        ? h('div', { class: 'mb-tools' }, layer, width)
        : h('div', { class: 'mb-tools' }, cmd('rotate', 'Rotate', 'Turn the selected part 90° (R, Shift+R the other way)', () => ed.rotate(90)), cmd('flip', 'Flip', 'Move the selected part to the other side of the board (F)', () => ed.flipSide()), cmd('off', 'Remove', 'Take the selected part off the board, or delete the selected trace, via or hole (Delete)', () => ed.takeOff())),
      auto,
      grid,
      h('label', { class: 'mb-check', for: 'board-below', title: 'Look at the board from below' }, below, 'Below'),
      h('button', { class: 'btn small', type: 'button', onclick: () => ed.fit() }, 'Fit'),
      h('button', { class: 'btn primary', type: 'button', id: 'board-done', onclick: () => act.leaveMode() }, 'Done'),
    ];
  } else if (mode.kind === 'plane') {
    kids = [
      h('span', { class: 'mb-title' }, 'Where do you want to sketch?'),
      h('div', { class: 'mb-tools' }, [['XY', 'Top (XY)'], ['XZ', 'Front (XZ)'], ['YZ', 'Side (YZ)']].map(([p, label]) => h('button', { class: 'btn', type: 'button', onclick: () => act.createSketch(p) }, label))),
      h('span', { class: 'mb-note' }, 'or click a flat face'),
      h('button', { class: 'btn', type: 'button', onclick: () => act.leaveMode() }, 'Cancel'),
    ];
  } else if (mode.kind === 'pick') {
    const f = featureById(mode.feature);
    const n = f?.[mode.key]?.pick?.length || 0;
    const noun = mode.pick === 'edge' ? 'edges' : 'faces';
    kids = [
      h('span', { class: 'mb-title' }, `Pick ${noun}`),
      h('span', { class: 'mb-note' }, `Click ${noun} for ${featureLabel(f || {})}. ${n} picked.`),
      h('button', { class: 'btn primary', type: 'button', id: 'pick-done', onclick: () => act.leaveMode() }, 'Done'),
    ];
  } else if (sel.picks.length) {
    const faces = sel.picks.filter((p) => p.kind === 'face');
    const edges = sel.picks.filter((p) => p.kind === 'edge');
    const planar = faces.some((p) => act.descOf(p)?.n);
    const btn = (label, cmd) => h('button', { class: 'btn small', type: 'button', onclick: () => act.command(cmd) }, label);
    kids = [
      h('span', { class: 'mb-title' }, edges.length ? `${edges.length} edge${edges.length === 1 ? '' : 's'} selected` : `${faces.length} face${faces.length === 1 ? '' : 's'} selected`),
      h('div', { class: 'mb-tools' }, edges.length ? [btn('Fillet', 'fillet'), btn('Chamfer', 'chamfer')] : [planar ? btn('Sketch here', 'sketch') : null, planar ? btn('Push / pull', 'extrude') : null, btn('Shell', 'shell')]),
      h('span', { class: 'mb-note' }, describePick(sel.picks[sel.picks.length - 1])),
      h('button', { class: 'icon-btn', type: 'button', title: 'Clear selection', 'aria-label': 'Clear selection', html: ICON.close, onclick: () => select({ picks: [] }) }),
    ];
  }
  bar.hidden = !kids;
  bar.replaceChildren(...(kids || []).filter(Boolean));
  const hint = $('hint');
  hint.textContent =
    mode.kind === 'board'
      ? mode.tool === 'route'
        ? 'Click a pad, click corners (45°), click a pad of the same net to finish. V: via to the other layer, Backspace: undo a corner, double-click: end here, Esc: cancel.'
        : 'Drag parts to place them; R turns, F flips, Delete removes, arrows nudge, X routes. Scroll zooms, drag empty space to pan. Alt: no snap.'
      : mode.kind === 'sketch'
      ? 'Drag to draw. Right-drag orbits, middle-drag pans. Hold Alt to turn off snapping. Esc cancels.'
      : mode.kind === 'pick'
        ? 'Click to add or remove. Later features are hidden while you pick.'
        : mode.kind === 'plane'
          ? 'Pick a plane or a flat face.'
          : 'Drag to orbit, right-drag to pan, scroll to zoom. Click a face or edge to select it.';
}

function describePick(p) {
  const d = act.descOf(p);
  if (!d) return '';
  if (p.kind === 'edge') return d.t === 'LINE' ? `Straight, ${fmt(d.l, 2)} mm` : d.t === 'CIRCLE' ? `Arc, ${fmt(d.l, 2)} mm long` : `Curve, ${fmt(d.l, 2)} mm`;
  return d.n ? `Flat, ${fmt(d.a, 1)} mm²` : `${d.t.charAt(0)}${d.t.slice(1).toLowerCase()}, ${fmt(d.a, 1)} mm²`;
}

function renderReadout() {
  const el = $('readout');
  const res = store.results;
  const k = store.kernel;
  if (k.state === 'error') {
    el.textContent = '';
    return;
  }
  if (!res || !res.min) {
    el.textContent = res ? 'Empty part' : '';
    return;
  }
  const size = res.max.map((v, i) => fmt(v - res.min[i], 1)).join(' × ');
  const n = res.bodies.length;
  el.textContent = `${size} mm  ·  ${fmt(res.volume / 1000, 2)} cm³${n > 1 ? `  ·  ${n} bodies` : ''}`;
}

function renderKernel() {
  const k = store.kernel;
  const box = $('loading');
  box.hidden = k.state === 'ready';
  if (k.state === 'loading') {
    $('loading-text').textContent = k.message || 'Loading the geometry kernel…';
    $('loading-bar').style.width = `${Math.round((k.progress || 0) * 100)}%`;
    $('loading-bar').parentElement.hidden = false;
  } else if (k.state === 'error') {
    $('loading-text').textContent = k.message;
    $('loading-bar').parentElement.hidden = true;
  }
  $('busy').hidden = !k.busy;
}

function renderTop() {
  $('undo').disabled = !store.undoStack.length;
  $('redo').disabled = !store.redoStack.length;
  const name = $('doc-name');
  if (document.activeElement !== name) name.value = store.doc.name;
  $('example-tag').hidden = !store.doc.example;
}

// ---------- menus ----------
function bindMenus(fileActions) {
  const menus = [
    ['file-btn', 'file-menu'],
    ['export-btn', 'export-menu'],
  ];
  const closeAll = () => menus.forEach(([b, m]) => { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); });
  for (const [b, m] of menus) {
    $(b).addEventListener('click', (e) => {
      e.stopPropagation();
      const open = $(m).hidden;
      closeAll();
      $(m).hidden = !open;
      $(b).setAttribute('aria-expanded', String(open));
    });
    $(m).addEventListener('click', (e) => e.stopPropagation());
  }
  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeAll());
  for (const el of document.querySelectorAll('[data-file]')) {
    el.addEventListener('click', () => {
      closeAll();
      fileActions[el.dataset.file]?.();
    });
  }
}

export function initUI(fileActions) {
  renderToolbar();
  bindMenus(fileActions);
  $('undo').addEventListener('click', () => undo());
  $('redo').addEventListener('click', () => redo());
  $('doc-name').addEventListener('input', () => {
    selfEdit = true;
    update((doc) => (doc.name = $('doc-name').value || 'Untitled part'), { key: 'docname' });
    selfEdit = false;
  });
  for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => (b.dataset.view === 'fit' ? act.app.viewport.fit() : act.app.viewport.view(b.dataset.view)));
  for (const t of document.querySelectorAll('[data-tab]')) {
    t.addEventListener('click', () => {
      document.body.dataset.tab = t.dataset.tab;
      for (const o of document.querySelectorAll('[data-tab]')) o.setAttribute('aria-selected', String(o === t));
    });
  }

  const all = (force) => {
    renderTop();
    renderParams();
    renderTimeline();
    renderInspector(force);
    renderModebar();
  };
  on('doc', () => {
    renderTop();
    if (!selfEdit) renderParams();
    renderTimeline();
    renderInspector(!selfEdit);
    renderModebar();
  });
  on('select', () => {
    renderTimeline();
    renderInspector(true);
    renderModebar();
    if (store.sel.feature && document.body.dataset.tab === 'model' && store.mode.kind !== 'sketch') showTab('inspect');
  });
  on('mode', () => {
    renderTimeline();
    renderInspector(true);
    renderModebar();
  });
  on('results', () => {
    renderTimeline();
    renderInspector();
    renderReadout();
    for (const fn of refreshers) fn();
    for (const fn of groups.params || []) fn();
    // Errors on the selected feature appear and clear as dimensions change.
    const f = featureById(store.sel.feature);
    const err = f && store.results?.features?.[f.id]?.error;
    const shown = document.querySelector('#inspector .insp-error span:last-child')?.textContent;
    if ((err || '') !== (shown || '') && document.activeElement?.closest?.('#inspector') == null) renderInspector(true);
    else if ((err || '') !== (shown || '')) patchError(err);
    if (store.mode.kind === 'model' && store.sel.picks.length) renderModebar();
  });
  on('kernel', renderKernel);
  on('focus-first', () => {
    requestAnimationFrame(() => {
      const el = document.querySelector('#inspector .row .in:not(select)');
      if (el && window.matchMedia('(min-width: 821px)').matches) {
        el.focus();
        el.select?.();
      }
    });
  });
  all(true);
  renderKernel();
  renderReadout();
}

function patchError(err) {
  const box = $('inspector');
  box.querySelector('.insp-error')?.remove();
  if (err) box.querySelector('.insp-head')?.after(h('div', { class: 'insp-error', role: 'alert' }, h('span', { html: ICON.warn }), h('span', {}, err)));
}

export function showTab(name) {
  document.body.dataset.tab = name;
  for (const o of document.querySelectorAll('[data-tab]')) o.setAttribute('aria-selected', String(o.dataset.tab === name));
}

export { setMode, emit };
