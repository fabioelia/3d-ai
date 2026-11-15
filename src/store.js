// Document state, undo history, selection and persistence.

const KEY = 'caliper.doc.v1';

export const EXAMPLE_DOC = {
  name: 'Example: standoff plate',
  example: true,
  params: [
    { name: 'width', value: '60' },
    { name: 'depth', value: '40' },
    { name: 'thickness', value: '4' },
    { name: 'hole', value: '4.2' },
    { name: 'post_d', value: '14' },
    { name: 'post_h', value: '16' },
  ],
  features: [
    {
      id: 'sketch1',
      type: 'sketch',
      name: 'Plate outline',
      plane: 'XY',
      shapes: [
        { id: 'r1', kind: 'rect', x: 0, y: 0, w: 'width', h: 'depth', r: 6 },
        { id: 'c1', kind: 'circle', x: 'width/2 - 8', y: 'depth/2 - 8', d: 'hole', hole: true },
        { id: 'c2', kind: 'circle', x: '-(width/2 - 8)', y: 'depth/2 - 8', d: 'hole', hole: true },
        { id: 'c3', kind: 'circle', x: 'width/2 - 8', y: '-(depth/2 - 8)', d: 'hole', hole: true },
        { id: 'c4', kind: 'circle', x: '-(width/2 - 8)', y: '-(depth/2 - 8)', d: 'hole', hole: true },
      ],
    },
    { id: 'extrude1', type: 'extrude', name: 'Plate', sketch: 'sketch1', distance: 'thickness', op: 'new' },
    { id: 'cylinder1', type: 'cylinder', name: 'Post', d: 'post_d', h: 'post_h', at: [0, 0, 'thickness'], op: 'join' },
    { id: 'cylinder2', type: 'cylinder', name: 'Bore', d: 'post_d - 6', h: 'post_h + thickness + 2', at: [0, 0, -1], op: 'cut' },
    { id: 'fillet1', type: 'fillet', name: 'Post root', edges: { kind: 'circle', near: [0, 'post_d/2', 'thickness'] }, radius: 2 },
    { id: 'chamfer1', type: 'chamfer', name: 'Post rim', edges: { kind: 'circle', near: [0, 'post_d/2', 'thickness + post_h'] }, distance: 1 },
  ],
};

const listeners = {};
export const on = (evt, fn) => {
  (listeners[evt] ||= []).push(fn);
};
export const emit = (evt, data) => {
  for (const fn of listeners[evt] || []) fn(data);
};

export const store = {
  doc: structuredClone(EXAMPLE_DOC),
  results: null, // last kernel output for the displayed state
  kernel: { state: 'loading', progress: 0, message: '' },
  sel: { feature: null, shape: null, picks: [], body: null }, // picks: [{ kind: 'face'|'edge', b, i }]; body: a body picked in the Bodies list
  mode: { kind: 'model' }, // model | plane | sketch {id, tool} | pick {feature, key, kind}
  undoStack: [],
  redoStack: [],
  activity: [], // what happened, newest last: { seq, t, by, text }
  revision: 0, // bumps on every document change
  lastKey: null,
  lastAt: 0,
};

export function loadSaved() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const doc = JSON.parse(raw);
    if (doc && Array.isArray(doc.features)) {
      store.doc = normalize(doc);
      return true;
    }
  } catch {
    /* storage may be unavailable; start from the example */
  }
  return false;
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(store.doc));
    } catch {
      /* ignore: autosave is a convenience */
    }
  }, 400);
}

export function normalize(doc) {
  const out = { name: String(doc.name || 'Untitled part'), params: [], features: [] };
  if (doc.example) out.example = true;
  // View state kept with the part: bodies hidden from view, and names given to bodies.
  if (Array.isArray(doc.hidden) && doc.hidden.length) out.hidden = doc.hidden.map(String);
  if (doc.bodyNames && typeof doc.bodyNames === 'object' && !Array.isArray(doc.bodyNames)) out.bodyNames = { ...doc.bodyNames };
  for (const p of doc.params || []) {
    if (p && p.name !== undefined) out.params.push({ name: String(p.name), value: typeof p.value === 'number' ? String(p.value) : String(p.value ?? '0') });
  }
  if (doc.params && !Array.isArray(doc.params) && typeof doc.params === 'object') {
    for (const [name, value] of Object.entries(doc.params)) out.params.push({ name, value: String(value) });
  }
  const seen = new Set();
  for (const f of doc.features || []) {
    if (!f || typeof f !== 'object' || !f.type) continue;
    const g = { ...f };
    if (!g.id || seen.has(g.id)) g.id = uniqueId(g.type, seen);
    seen.add(g.id);
    if (g.type === 'sketch') {
      const ids = new Set();
      g.shapes = (g.shapes || []).filter((s) => s && s.kind).map((s) => {
        const t = { ...s };
        if (!t.id || ids.has(t.id)) t.id = uniqueId(t.kind[0], ids);
        ids.add(t.id);
        return t;
      });
    }
    out.features.push(g);
  }
  return out;
}

function uniqueId(prefix, taken) {
  for (let i = 1; ; i++) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

export function newFeatureId(type) {
  return uniqueId(type, new Set(store.doc.features.map((f) => f.id)));
}
export function newShapeId(sketch, kind) {
  return uniqueId(kind[0], new Set((sketch.shapes || []).map((s) => s.id)));
}

export const featureById = (id) => store.doc.features.find((f) => f.id === id) || null;

// ---------- activity ----------
// A running log of who did what, so an agent can catch up on the person's edits and the person can
// see what an agent did. `by` is 'user', 'assistant' (the built-in chat) or an agent's name.
let seq = 0;
let lastLog = null;
export function logActivity(by, text, { merge = null } = {}) {
  if (!text) return;
  const now = Date.now();
  if (merge && lastLog && lastLog.merge === merge && lastLog.by === by && now - lastLog.t < 2500) {
    lastLog.text = text;
    lastLog.t = now;
    emit('activity', lastLog);
    return;
  }
  const entry = { seq: ++seq, t: now, by, text, merge };
  store.activity.push(entry);
  if (store.activity.length > 300) store.activity.shift();
  lastLog = entry;
  emit('activity', entry);
}

const fname = (f) => `${f.name || f.type} (${f.id})`;
// What happened to a board's parts, in words: "moved U4 to (12, -3), flipped C1 to the bottom".
function describeParts(a, b) {
  const old = new Map(a.map((p) => [p.ref, p]));
  const out = [];
  for (const p of b) {
    const o = old.get(p.ref);
    if (!o) {
      out.push(`added ${p.ref}`);
      continue;
    }
    if (JSON.stringify(o) === JSON.stringify(p)) continue;
    const bits = [];
    if (!!o.off !== !!p.off) bits.push(p.off ? `took ${p.ref} off the board` : `put ${p.ref} on the board at (${p.x}, ${p.y})`);
    else if (o.x !== p.x || o.y !== p.y) bits.push(`moved ${p.ref} to (${p.x}, ${p.y})`);
    if ((o.side || 'top') !== (p.side || 'top')) bits.push(`flipped ${p.ref} to the ${p.side || 'top'}`);
    if ((o.rot || 0) !== (p.rot || 0)) bits.push(`turned ${p.ref} to ${p.rot || 0}°`);
    const other = Object.keys({ ...o, ...p }).filter((k) => !['x', 'y', 'off', 'side', 'rot'].includes(k) && JSON.stringify(o[k]) !== JSON.stringify(p[k]));
    if (other.length) bits.push(`set ${p.ref} ${other.map((k) => (typeof p[k] === 'object' ? k : `${k} = ${p[k]}`)).join(', ')}`);
    out.push(...bits);
  }
  for (const r of old.keys()) if (!b.some((p) => p.ref === r)) out.push(`removed ${r}`);
  if (out.length > 6) return `${out.slice(0, 5).join(', ')} and ${out.length - 5} more part changes`;
  return out.join(', ') || 'changed parts';
}

export function describeChange(a, b) {
  const out = [];
  if (a.name !== b.name) out.push(`renamed the part to "${b.name}"`);
  if (JSON.stringify(a.bodyNames || {}) !== JSON.stringify(b.bodyNames || {})) for (const [id, n] of Object.entries(b.bodyNames || {})) if ((a.bodyNames || {})[id] !== n) out.push(`renamed body ${id} to "${n}"`);
  if (JSON.stringify(a.hidden || []) !== JSON.stringify(b.hidden || [])) out.push((b.hidden || []).length ? `hid ${(b.hidden || []).join(', ')} from view` : 'showed all bodies');
  const pa = new Map((a.params || []).map((p) => [p.name, p.value]));
  const pb = new Map((b.params || []).map((p) => [p.name, p.value]));
  for (const [k, v] of pb) {
    if (!pa.has(k)) out.push(`added parameter ${k} = ${v}`);
    else if (pa.get(k) !== v) out.push(`set ${k} = ${v} (was ${pa.get(k)})`);
  }
  for (const k of pa.keys()) if (!pb.has(k)) out.push(`removed parameter ${k}`);
  const fa = new Map((a.features || []).map((f) => [f.id, f]));
  const fb = new Map((b.features || []).map((f) => [f.id, f]));
  for (const [id, f] of fb) {
    const old = fa.get(id);
    if (!old) {
      out.push(`added ${f.type} ${fname(f)}`);
      continue;
    }
    if (JSON.stringify(old) === JSON.stringify(f)) continue;
    const keys = [...new Set([...Object.keys(old), ...Object.keys(f)])].filter((k) => JSON.stringify(old[k]) !== JSON.stringify(f[k]));
    if (keys.length === 1 && keys[0] === 'suppressed') out.push(`${f.suppressed ? 'suppressed' : 'unsuppressed'} ${fname(f)}`);
    else if (keys.includes('shapes')) out.push(`edited the shapes in ${fname(f)}`);
    else if (f.type === 'board' && keys.length === 1 && keys[0] === 'parts') out.push(`${describeParts(old.parts || [], f.parts || [])} on ${fname(f)}`);
    else
      out.push(
        `changed ${fname(f)}: ${keys
          .map((k) => {
            const v = f[k];
            return v === undefined ? `removed ${k}` : typeof v === 'object' ? (/edges|faces|face/.test(k) && v?.pick ? `${k} (${v.pick.length} picked)` : k) : `${k} = ${v}`;
          })
          .join(', ')}`,
      );
  }
  for (const [id, f] of fa) if (!fb.has(id)) out.push(`deleted ${fname(f)}`);
  const orderA = (a.features || []).map((f) => f.id).filter((id) => fb.has(id));
  const orderB = (b.features || []).map((f) => f.id).filter((id) => fa.has(id));
  if (orderA.join() !== orderB.join()) out.push('reordered the timeline');
  return out.join('; ');
}

// Change the document. `key` coalesces rapid edits of the same field into one undo step.
export function update(fn, { key = null, quiet = false, by = 'user' } = {}) {
  const now = Date.now();
  const before = JSON.stringify(store.doc);
  fn(store.doc);
  const after = JSON.stringify(store.doc);
  if (after === before) return false;
  store.revision++;
  logActivity(by, describeChange(JSON.parse(before), store.doc), { merge: key ? `${by}:${key}` : null });
  if (!quiet) {
    if (!(key && key === store.lastKey && now - store.lastAt < 1500)) {
      store.undoStack.push(before);
      if (store.undoStack.length > 200) store.undoStack.shift();
    }
    store.redoStack.length = 0;
    store.lastKey = key;
    store.lastAt = now;
    if (store.doc.example) delete store.doc.example;
  }
  saveSoon();
  emit('doc', { quiet });
  return true;
}

export function replaceDoc(doc, { undoable = true, by = 'user' } = {}) {
  store.revision++;
  logActivity(by, `replaced the whole part with "${doc.name || 'Untitled part'}" (${(doc.features || []).length} features)`);
  if (undoable) {
    store.undoStack.push(JSON.stringify(store.doc));
    store.redoStack.length = 0;
  }
  store.lastKey = null;
  store.doc = normalize(doc);
  store.sel = { feature: null, shape: null, picks: [] };
  store.mode = { kind: 'model' };
  saveSoon();
  emit('doc', {});
  emit('select');
  emit('mode');
}

function restore(from, to, by, label) {
  if (!from.length) return false;
  store.revision++;
  logActivity(by, label);
  to.push(JSON.stringify(store.doc));
  store.doc = JSON.parse(from.pop());
  store.lastKey = null;
  if (store.sel.feature && !featureById(store.sel.feature)) store.sel = { feature: null, shape: null, picks: [] };
  if ((store.mode.kind === 'sketch' && !featureById(store.mode.id)) || (store.mode.kind === 'pick' && !featureById(store.mode.feature))) {
    store.mode = { kind: 'model' };
    emit('mode');
  }
  store.sel.picks = [];
  saveSoon();
  emit('doc', {});
  emit('select');
  return true;
}
export const undo = (by = 'user') => restore(store.undoStack, store.redoStack, by, 'undid the last change');
export const redo = (by = 'user') => restore(store.redoStack, store.undoStack, by, 'redid a change');

const refList = (picks) => picks.map((p) => `${p.b}:${p.kind === 'face' ? 'F' : 'E'}${p.i}`).join(', ');
export function select(patch, { by = 'user' } = {}) {
  const prev = store.sel;
  store.sel = { ...store.sel, ...patch };
  // A feature and a body are two different things to show in the inspector: picking one drops the other.
  if (patch.feature && patch.body === undefined) store.sel.body = null;
  if (patch.body) store.sel.feature = null;
  if (patch.picks && refList(patch.picks) !== refList(prev.picks || [])) {
    logActivity(by, patch.picks.length ? `selected ${refList(patch.picks)}` : 'cleared the selection', { merge: `${by}:select` });
  }
  emit('select');
}

export function setMode(mode, { by = 'user' } = {}) {
  const prev = store.mode;
  store.mode = mode;
  if (mode.kind !== prev.kind || mode.id !== prev.id) {
    const f = (id) => store.doc.features.find((x) => x.id === id);
    const text =
      mode.kind === 'sketch'
        ? `opened sketch ${fname(f(mode.id) || { id: mode.id, type: 'sketch' })} for editing`
        : mode.kind === 'board'
          ? `opened the placement editor for ${fname(f(mode.id) || { id: mode.id, type: 'board' })}`
          : mode.kind === 'plane'
          ? 'started a sketch and is choosing its plane'
          : mode.kind === 'pick'
            ? `is picking ${mode.pick}s for ${fname(f(mode.feature) || { id: mode.feature, type: 'feature' })}`
            : prev.kind === 'sketch'
              ? 'finished the sketch'
              : prev.kind === 'board'
                ? 'closed the placement editor'
              : prev.kind === 'pick'
                ? 'finished picking'
                : 'returned to modelling';
    logActivity(by, text);
  }
  emit('mode');
}

// The slice of the document the viewport should show for the current mode: while a sketch is open
// or a selection is being re-picked, later features are rolled back, as in a CAD timeline.
export function visibleDoc() {
  const { doc, mode } = store;
  if (mode.kind === 'sketch' || mode.kind === 'pick') {
    const id = mode.kind === 'sketch' ? mode.id : mode.feature;
    const at = doc.features.findIndex((f) => f.id === id);
    if (at >= 0) return { ...doc, features: doc.features.slice(0, mode.kind === 'sketch' ? at + 1 : at) };
  }
  return doc;
}
