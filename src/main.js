// Caliper: boot, wire the kernel, viewport, sketcher and panels together.
import './style.css';
import { Kernel } from './kernel/client.js';
import { evalExpr } from './expr.js';
import { outline } from './sketchgeo.js';
import { Viewport } from './viewport.js';
import { Sketcher } from './sketcher.js';
import { BoardEditor } from './board/editor.js';
import { store, on, emit, update, select, loadSaved, visibleDoc, featureById, replaceDoc, undo, redo, setMode, EXAMPLE_DOC, normalize } from './store.js';
import { initUI, toast, showTab } from './ui.js';
import { initAssistant, attachFiles } from './assistant.js';
import { initAgentPanel } from './agent/panel.js';
import { saveFile, safeName } from './export.js';
import { embedFiles, absorbFiles } from './files.js';
import * as act from './actions.js';

const $ = (id) => document.getElementById(id);
document.body.dataset.tab ||= 'model';

loadSaved();
const viewport = new Viewport($('viewport'));
const kernel = new Kernel();
const sketcher = new Sketcher(viewport, $('sk-label'), {
  sketch: () => (store.mode.kind === 'sketch' ? featureById(store.mode.id) : null),
  scope: () => store.results?.params || {},
  change: (fn, key) =>
    update(
      (doc) => {
        const sk = doc.features.find((f) => f.id === store.mode.id);
        if (sk) fn(sk);
      },
      { key },
    ),
  selectShape: (id) => select({ shape: id }),
  selectedShape: () => store.sel.shape,
  setTool: (tool) => act.setSketchTool(tool),
});
const boardEditor = new BoardEditor(document.querySelector('.stage'), {
  board: () => {
    const f = featureById(store.mode.kind === 'board' ? store.mode.id : store.sel.feature);
    return f?.type === 'board' ? f : null;
  },
  scope: () => store.results?.params || {},
  change: (fn, key) => {
    const id = store.mode.kind === 'board' ? store.mode.id : store.sel.feature;
    update(
      (doc) => {
        const f = doc.features.find((x) => x.id === id);
        if (f && f.type === 'board') fn(f);
      },
      { key },
    );
  },
  select: (ref) => select({ shape: ref }),
  selected: () => (store.mode.kind === 'board' ? store.sel.shape : null),
  hover: (text) => {
    $('readout').textContent = text;
  },
  tool: () => (store.mode.kind === 'board' ? store.mode.tool || 'select' : 'select'),
  setTool: (t) => act.setBoardTool(t),
  autoroute: (board, opts) => kernel.autoroute(board, opts),
  toast: (m) => toast(m),
});
Object.assign(act.app, { viewport, sketcher, board: boardEditor, kernel, toast, rebuildNow });
viewport.setHidden(store.doc.hidden);

// ---------- rebuild loop ----------
let timer = null;
let waiters = [];
let sketchFrameKey = '';

function scheduleRebuild() {
  clearTimeout(timer);
  timer = setTimeout(runRebuild, 30);
}

function rebuildNow() {
  return new Promise((resolve) => {
    if (store.kernel.state === 'error') return resolve(null);
    waiters.push(resolve); // resolved by the next finished rebuild (or once the kernel is ready)
    clearTimeout(timer);
    runRebuild();
  });
}

async function runRebuild() {
  if (store.kernel.state !== 'ready') return;
  store.kernel.busy = true;
  emit('kernel');
  let res = null;
  try {
    res = await kernel.evaluate(JSON.parse(JSON.stringify(visibleDoc())));
    if (res === null) return; // a newer rebuild took over and will report
  } catch (e) {
    toast(e.message || 'The geometry kernel hit an error.', 'error');
    store.kernel.busy = false;
    emit('kernel');
    waiters.splice(0).forEach((w) => w(null));
    return;
  }
  store.kernel.busy = false;
  store.results = res;
  // Picked faces/edges are re-anchored by the kernel as the model changes; keep those refreshed
  // references without creating undo steps or another rebuild.
  let refreshed = false;
  for (const [id, fresh] of Object.entries(res.picks || {})) {
    const f = featureById(id);
    if (!f) continue;
    for (const key of ['edges', 'faces', 'face']) if (fresh[key] && f[key]) f[key] = fresh[key];
    if (fresh.plane && f.plane) f.plane = fresh.plane;
    refreshed = true;
  }
  if (refreshed) {
    try {
      localStorage.setItem('caliper.doc.v1', JSON.stringify(store.doc));
    } catch {
      /* autosave is a convenience */
    }
  }
  viewport.setBodies(res.bodies, res.min ? { min: res.min, max: res.max } : {});
  emit('kernel');
  emit('results');
  syncSketch();
  syncHighlights();
  waiters.splice(0).forEach((w) => w(res));
}

// ---------- mode plumbing ----------
function syncSketch() {
  const { mode } = store;
  if (mode.kind !== 'sketch') {
    if (sketcher.active) sketcher.exit();
    sketchFrameKey = '';
    return;
  }
  const info = store.results?.features?.[mode.id];
  if (!info) return;
  if (!info.frame) {
    toast(info.error || 'This sketch has lost its plane.', 'error');
    sketcher.exit();
    setMode({ kind: 'model' });
    return;
  }
  const key = `${mode.id}:${JSON.stringify(info.frame)}`;
  if (key !== sketchFrameKey) {
    const first = sketchFrameKey.split(':')[0] !== mode.id;
    sketchFrameKey = key;
    sketcher.enter(info.frame);
    sketcher.tool = mode.tool;
    if (first) {
      viewport.lookAtFrame(info.frame);
      const sk = featureById(mode.id);
      if (!viewport.bounds && !sk?.shapes?.length) viewport.fit(true, { min: [-45, -45, -1], max: [45, 45, 1] });
    }
  }
  sketcher.redraw();
}

function syncHighlights() {
  const { mode } = store;
  let selected = [];
  if (mode.kind === 'pick') {
    const f = featureById(mode.feature);
    selected = (f?.[mode.key]?.pick || []).map((p) => ({ kind: mode.pick, b: p.b, i: p.i }));
  } else if (mode.kind === 'model') selected = store.sel.picks;
  viewport.setHighlights({ selected, bodies: mode.kind === 'model' && store.sel.body ? [store.sel.body] : [] });
}

let lastModeKind = 'model';
on('mode', () => {
  const { mode } = store;
  if (mode.kind === 'board' && mode.tool !== 'route' && boardEditor.route) boardEditor.cancelRoute();
  if (mode.kind === 'board' && !boardEditor.active) boardEditor.enter();
  else if (mode.kind !== 'board' && boardEditor.active) boardEditor.exit();
  else if (boardEditor.active) boardEditor.render();
  viewport.pickFilter = mode.kind === 'model' ? 'any' : mode.kind === 'plane' ? 'plane' : mode.kind === 'pick' ? mode.pick : 'none';
  viewport.showPlanes(mode.kind === 'plane');
  viewport.setHighlights({ hover: null });
  viewport.canvas.style.cursor = mode.kind === 'sketch' ? 'crosshair' : '';
  if (mode.kind === 'sketch' && sketcher.active && sketcher.tool !== mode.tool) sketcher.setTool(mode.tool);
  if (lastModeKind === 'sketch' && mode.kind !== 'sketch') {
    viewport.view('iso');
    setTimeout(() => viewport.fit(), 300);
  }
  lastModeKind = mode.kind;
  scheduleRebuild();
  syncHighlights();
});
on('doc', () => {
  viewport.setHidden(store.doc.hidden);
  scheduleRebuild();
  if (sketcher.active) sketcher.redraw();
  if (boardEditor.active) {
    if (!featureById(store.mode.id)) act.leaveMode();
    else boardEditor.render();
  }
});
on('select', () => {
  syncHighlights();
  if (sketcher.active) sketcher.redraw();
  if (boardEditor.active) boardEditor.render();
});
on('results', () => boardEditor.active && boardEditor.render());

// ---------- the timeline feature in the view ----------
// The selected (or hovered) timeline feature shows its own geometry see-through over the model: the
// solid it adds or cuts, the edges or faces it works on, a sketch's outline, a board.
const ghostCache = new WeakMap(); // build results -> Map(feature id -> ghost)
let ghostHover = null;
const ghostWanted = () => (store.mode.kind === 'model' ? ghostHover || (store.sel.picks.length ? null : store.sel.feature) : null);

function sketchGhost(f, frame) {
  if (!frame || !f.shapes?.length) return null;
  const scope = store.results?.params || {};
  const n = (v) => {
    try {
      return evalExpr(v ?? 0, scope);
    } catch {
      return 0;
    }
  };
  const at = ([u, v]) => [0, 1, 2].map((k) => frame.origin[k] + frame.x[k] * u + frame.y[k] * v);
  return { polylines: f.shapes.map((s) => outline(s, n)).filter((pts) => pts.length > 1).map((pts) => pts.map(at)) };
}

function boardGhost(id, res) {
  const list = res.bodies.filter((b) => (b.id === id || b.board === id) && !b.detail && b.kind !== 'copper');
  if (!list.length) return null;
  const count = list.reduce((s2, b) => s2 + b.positions.length, 0);
  const positions = new Float32Array(count);
  const indices = [];
  let o = 0;
  for (const b of list) {
    positions.set(b.positions, o);
    for (const i of b.indices) indices.push(i + o / 3);
    o += b.positions.length;
  }
  return { positions, indices: new Uint32Array(indices), lines: new Float32Array(0) };
}

async function ghostFor(id) {
  const res = store.results;
  if (!res) return null;
  let m = ghostCache.get(res);
  if (!m) ghostCache.set(res, (m = new Map()));
  if (m.has(id)) return m.get(id);
  const f = featureById(id);
  let g = null;
  if (!f || f.suppressed || res.features?.[id]?.error) g = null;
  else if (f.type === 'sketch') g = sketchGhost(f, res.features?.[id]?.frame);
  else if (f.type === 'board') g = boardGhost(id, res);
  else g = await kernel.ghost(id).catch(() => null);
  m.set(id, g);
  return g;
}

async function syncGhost() {
  const id = ghostWanted();
  if (!id) return viewport.setGhost(null);
  const g = await ghostFor(id);
  if (ghostWanted() === id) viewport.setGhost(g);
}
on('select', syncGhost);
on('results', syncGhost);
on('mode', syncGhost);
on('body-hover', (id) => viewport.setHighlights({ hoverBody: id || null }));
on('ghost-hover', (id) => {
  ghostHover = id || null;
  syncGhost();
});

viewport.handlers = {
  click: (pick, evt) => act.viewportClick(pick, evt),
  hover: (pick) => {
    if (store.mode.kind === 'plane') viewport.showPlanes(true, pick?.kind === 'plane' ? pick.name : null);
    viewport.setHighlights({ hover: pick && pick.kind !== 'plane' ? pick : null });
    viewport.canvas.style.cursor = store.mode.kind === 'sketch' ? 'crosshair' : pick ? 'pointer' : '';
  },
  pointer: (type, evt) => {
    if (store.mode.kind === 'sketch') sketcher.pointer(type, evt);
    else if (type === 'dbl' && store.mode.kind === 'model') act.viewportDoubleClick(viewport.pickAt(evt));
  },
  theme: () => {
    sketcher.redraw();
    boardEditor.readColors();
    boardEditor.render();
  },
};

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y' && !typing) {
    e.preventDefault();
    redo();
    return;
  }
  if (typing) {
    if (e.key === 'Escape') t.blur();
    return;
  }
  if (store.mode.kind === 'sketch' && sketcher.key(e)) {
    e.preventDefault();
    return;
  }
  if (store.mode.kind === 'board' && !mod && boardEditor.key(e)) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    if (act.tools.measuring) act.setMeasuring(false);
    else if (store.mode.kind !== 'model') act.leaveMode();
    else if (store.sel.picks.length) select({ picks: [] });
    else if (store.sel.feature || store.sel.body) select({ feature: null, shape: null, body: null });
    return;
  }
  if (e.key === 'Enter' && store.mode.kind !== 'model') {
    act.leaveMode();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && store.mode.kind === 'model' && store.sel.feature) {
    e.preventDefault();
    act.deleteFeature(store.sel.feature);
    return;
  }
  if (mod || e.altKey || store.mode.kind !== 'model') return;
  const keys = { e: 'extrude', f: 'fillet', s: 'sketch', m: 'measure' };
  const cmd = keys[e.key.toLowerCase()];
  if (cmd) {
    e.preventDefault();
    act.command(cmd);
  }
});

// ---------- file menu ----------
async function exportFile(kind, ids = null) {
  if (!store.results?.bodies.length || store.mode.kind !== 'model') {
    if (store.mode.kind !== 'model') act.leaveMode();
    await rebuildNow();
  }
  if (!store.results?.bodies.length) return toast('There is nothing to export yet. Build a solid first.');
  // Which bodies: the export menu's choice (all shown bodies, or one), or ids passed in (a body's own
  // Export buttons). Hidden bodies stay out of "all"; boards and their parts are never printed.
  if (!ids) {
    const what = $('export-what')?.value || 'visible';
    if (what !== 'visible') ids = [what];
    else {
      const rows = act.bodyRows();
      const shown = rows.filter((b) => !act.isHidden(b.id) && (kind === 'step' || !b.kind));
      if (!shown.length) return toast(rows.some((b) => act.isHidden(b.id)) ? 'Every body is hidden. Show the ones to export in the Bodies list.' : 'There is nothing printable to export yet.', 'error');
      ids = shown.length === rows.length && kind !== 'step' ? null : shown.map((b) => b.id);
    }
  }
  const one = ids && ids.length === 1 ? store.results.bodies.find((b) => b.id === ids[0]) : null;
  const base = safeName(one ? `${store.doc.name} ${one.name}` : store.doc.name);
  try {
    if (kind === 'stl') {
      const out = await kernel.exportSTL(ids, $('stl-quality').value);
      const msg = await saveFile(`${base}.stl`, out.buffer, 'model/stl');
      if (msg) toast(`${msg} · ${out.triangles.toLocaleString()} triangles`);
    } else if (kind === '3mf') {
      const meshes = await kernel.exportMeshes(ids, $('stl-quality').value);
      const { build3MF } = await import('./threemf.js');
      const msg = await saveFile(`${base}.3mf`, await build3MF(meshes, store.doc.name), 'model/3mf');
      if (msg) toast(`${msg} · ${meshes.length} object${meshes.length === 1 ? '' : 's'} on the plate`);
    } else {
      const out = await kernel.exportSTEP(ids);
      const msg = await saveFile(`${base}.step`, out.buffer, 'model/step');
      if (msg) toast(out.skipped?.length ? `${msg}. Left out ${out.skipped.join(', ')}: mesh bodies cannot go in a STEP file.` : msg);
    }
  } catch (e) {
    toast(e.message || 'Export failed.', 'error');
  }
}

const fileActions = {
  new: () => {
    replaceDoc({ name: 'Untitled part', params: [], features: [] });
    viewport.fit(true, { min: [-40, -40, 0], max: [40, 40, 30] });
  },
  example: () => {
    replaceDoc(structuredClone(EXAMPLE_DOC));
    viewport.fitted = false;
  },
  open: () => $('open-file').click(),
  import: () => $('import-file').click(),
  save: async () => {
    try {
      const { example, ...doc } = store.doc;
      const full = await embedFiles(doc); // imported STLs travel inside the project file
      const msg = await saveFile(`${safeName(store.doc.name)}.caliper.json`, JSON.stringify(full, null, full.files ? 0 : 2), 'application/json');
      if (msg) toast(msg);
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  stl: () => exportFile('stl'),
  '3mf': () => exportFile('3mf'),
  step: () => exportFile('step'),
  body: (kind, id) => exportFile(kind, [id]),
};

async function openProject(file) {
  try {
    const doc = JSON.parse(await file.text());
    if (!doc || !Array.isArray(doc.features)) throw new Error('not a Caliper project');
    replaceDoc(normalize(await absorbFiles(doc)));
    viewport.fitted = false;
    toast(`Opened ${file.name}`);
  } catch {
    toast('That file is not a Caliper project (.caliper.json).', 'error');
  }
}
$('open-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) openProject(file);
});
$('import-file').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) act.importFiles(files);
});

// Drop 3D files, circuit files or a saved project anywhere on the window.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dropping');
  }
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  const files = [...e.dataTransfer.files];
  const project = files.find((f) => /\.json$/i.test(f.name));
  if (project) return openProject(project);
  // Pictures dropped anywhere go to the chat, for Claude to look at.
  const pictures = files.filter((f) => f.type?.startsWith('image/'));
  if (pictures.length) {
    attachFiles(pictures).then((ok) => {
      if (ok) {
        showTab('assistant');
        toast(`Attached ${pictures.length === 1 ? 'the image' : `${pictures.length} images`} to your next chat message.`);
      } else toast('Images can be attached to the chat in the hosted app (Claude Code over MCP).', 'error');
    });
    if (!files.some((f) => /\.(stl|zip)$/i.test(f.name))) return;
  }
  const stls = files.filter((f) => /\.(stl|step|stp|obj|3mf|zip|sch|brd|kicad_pcb|kicad_sch|net)$/i.test(f.name));
  // Other files (notes, schematics) go to the chat for Claude to read.
  const docs = files.filter((f) => !pictures.includes(f) && !stls.includes(f));
  if (docs.length) attachFiles(docs).then((ok) => ok && (showTab('assistant'), toast(`Attached ${docs.map((f) => f.name).join(', ')} to your next chat message.`)));
  if (stls.length) act.importFiles(stls);
  else if (!pictures.length && !docs.length) toast('Drop 3D files (STL, STEP, OBJ, 3MF or a zip) or boards (Eagle .sch / .brd, KiCad .kicad_pcb / .kicad_sch / .net) to import them, other files to share them with Claude, or a .caliper.json project to open it.', 'error');
});

// ---------- theme ----------
const refreshTheme = () => viewport.applyTheme();
new MutationObserver(refreshTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshTheme);

// ---------- go ----------
initUI(fileActions);
initAssistant();
const agentLink = initAgentPanel();
document.fonts?.ready.then(() => viewport.resize());

kernel
  .init((p) => {
    store.kernel.progress = p;
    emit('kernel');
  })
  .then(() => {
    store.kernel = { state: 'ready', progress: 1, message: '' };
    emit('kernel');
    runRebuild();
    emit('kernel-ready');
    kernel
      .loadFont()
      .then((ok) => {
        store.fontReady = ok;
        if (ok && store.doc.features.some((f) => f.shapes?.some((s) => s.kind === 'text'))) {
          // Text shapes were waiting for the font: rebuild them now.
          kernel.call('evaluate', { doc: { features: [] } }).then(() => runRebuild());
        }
      })
      .catch(() => {});
  })
  .catch((e) => {
    store.kernel = { state: 'error', progress: 0, message: `The geometry kernel could not start (${e.message || 'unknown error'}). Reload the page to try again.` };
    emit('kernel');
    waiters.splice(0).forEach((w) => w(null));
  });

// Small hook for automated checks.
window.caliper = { store, viewport, act, rebuildNow, agentLink, ghostFor };
