// What each agent tool does inside the page. Results are MCP-shaped: { content: [{type:'text'|'image'}],
// isError?, files? }, so the bridge can pass them straight through and the built-in assistant can
// map them onto the Claude API.
import { store, on, update, replaceDoc, normalize, select, featureById, undo, redo, logActivity } from '../store.js';
import { FEATURES, featureLabel } from '../schema.js';
import { GUIDE } from '../guide.js';
import * as act from '../actions.js';
import { putFile, fromB64, toB64, embedFiles } from '../files.js';
import { saveFile, safeName } from '../export.js';
import { toolByName } from './catalog.js';
import { evalExpr } from '../expr.js';
import { checkBoard, airwires, autoPlace, overBoard, turnPart, flipPart, bodyCenter } from '../board/geometry.js';
import { eagleScript } from '../board/script.js';

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (p) => (Array.isArray(p) ? p.map((x) => Math.round(x * 1000) / 1000) : p);
const text = (obj) => ({ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const ok = (...content) => ({ content });
const fail = (message) => ({ content: [text(message)], isError: true });
const REF = /^(.+):([FE])(\d+)$/;

// ---------- reading the built model ----------
const bodies = () => store.results?.bodies || [];
const refOf = (p) => `${p.b}:${p.kind === 'face' ? 'F' : 'E'}${p.i}`;

function describeRef(ref) {
  const m = REF.exec(ref);
  if (!m) return null;
  const body = bodies().find((b) => b.id === m[1]);
  const kind = m[2] === 'F' ? 'face' : 'edge';
  const d = body && (kind === 'face' ? body.faces : body.edges)[Number(m[3])];
  if (!d) return { ref, missing: true };
  if (kind === 'face') return { ref, kind, type: d.t.toLowerCase(), area: r2(d.a), center: r3(d.c), ...(d.n ? { normal: r3(d.n) } : {}), ...(d.r ? { radius: d.r } : {}), body: body.name };
  return { ref, kind, type: d.t.toLowerCase(), length: r2(d.l), start: r3(d.s), end: r3(d.e), mid: r3(d.m), ...(d.r ? { radius: d.r, diameter: r2(d.r * 2) } : {}), body: body.name };
}

export function buildReport(res = store.results) {
  if (!res) return { ok: false, note: 'The model has not been built yet.' };
  const errors = [];
  const notes = [];
  for (const f of store.doc.features) {
    const info = res.features?.[f.id];
    if (f.suppressed || !info) continue;
    if (info.error) errors.push({ feature: f.id, name: featureLabel(f), type: f.type, message: info.error });
    if (info.note) notes.push({ feature: f.id, note: info.note });
  }
  const paramErrors = Object.entries(res.paramErrors || {}).map(([name, message]) => ({ parameter: name, message }));
  return {
    ok: !errors.length && !paramErrors.length,
    errors,
    ...(paramErrors.length ? { parameter_errors: paramErrors } : {}),
    ...(notes.length ? { notes } : {}),
    parameters: res.params,
    bodies: res.bodies.map((b) => ({
      id: b.id,
      name: b.name,
      kind: b.kind === 'board' ? 'circuit board (not printed; never joined or cut unless named as a target)' : b.kind === 'part' ? `board part ${b.ref} on ${b.board}` : b.isReference ? 'reference mesh (not a closed solid; cannot be cut or joined)' : b.isMesh ? 'mesh' : 'solid',
      size_mm: b.max.map((v, i) => r2(v - b.min[i])),
      min: r3(b.min),
      max: r3(b.max),
      ...(b.isReference ? { approximate_volume_mm3: r2(b.volume) } : { volume_mm3: r2(b.volume) }),
      ...(b.isMesh ? { triangles: b.triangles } : { faces: b.faces.length, edges: b.edges.filter((e) => !e.seam).length }),
    })),
    ...(res.bodies.length ? {} : { note: 'The model has no solid bodies.' }),
    rebuild_ms: res.ms,
  };
}

function viewState() {
  const { mode, sel } = store;
  const vp = act.app.viewport;
  const out = { kernel: store.kernel.state };
  if (mode.kind === 'sketch') {
    const f = featureById(mode.id);
    out.mode = `editing sketch ${mode.id}; features after it are hidden until the sketch is finished`;
    out.open_sketch = { id: mode.id, tool: mode.tool, plane: r3obj(store.results?.features?.[mode.id]?.frame), shapes: f?.shapes || [] };
    if (sel.shape) out.open_sketch.selected_shape = sel.shape;
  } else if (mode.kind === 'pick') {
    out.mode = `picking ${mode.pick}s for ${mode.feature}; features from it on are hidden until picking is done`;
  } else if (mode.kind === 'board') {
    const f = featureById(mode.id);
    out.mode = `placing parts on ${mode.id} in the board placement editor (a 2D top view${act.app.board?.flip ? ', seen from below' : ''}; the 3D view is behind it until they press Done)`;
    out.board_editor = { board: mode.id, tool: mode.tool || 'select', grid_mm: act.app.board?.grid, ...(sel.shape ? { selected: String(sel.shape).startsWith('hole:') ? { hole: Number(String(sel.shape).slice(5)), ...f?.holes?.[Number(String(sel.shape).slice(5))] } : { part: sel.shape } } : {}) };
  } else if (mode.kind === 'plane') out.mode = 'starting a sketch: choosing a plane';
  else out.mode = 'modelling';
  const picks = mode.kind === 'pick' ? (featureById(mode.feature)?.[mode.key]?.pick || []).map((p) => ({ kind: mode.pick, b: p.b, i: p.i })) : sel.picks;
  out.selection = {
    elements: picks.map((p) => describeRef(refOf(p))),
    ...(sel.feature ? { feature: { id: sel.feature, name: featureLabel(featureById(sel.feature) || { type: '?' }) } } : {}),
  };
  const hv = vp?.highlight?.hover;
  if (hv && hv.kind !== 'plane') out.hovering = refOf(hv);
  if (vp) out.camera = vp.cameraState();
  out.panel = document.body.dataset.tab;
  return out;
}
const r3obj = (f) => (f ? Object.fromEntries(Object.entries(f).map(([k, v]) => [k, r3(v)])) : f);

export function stateSnapshot({ since, include } = {}) {
  const want = new Set(include && include.length ? include : ['document', 'build', 'view', 'activity']);
  const out = { revision: store.revision };
  if (want.has('document')) {
    const { example, ...doc } = store.doc;
    out.document = doc;
    if (example) out.document_note = 'This is the built-in example part, not something the person made.';
  }
  if (want.has('build')) out.build = buildReport();
  if (want.has('view')) out.view = viewState();
  if (want.has('activity')) {
    const list = store.activity.filter((e) => since === undefined || e.seq > since).slice(-40);
    out.activity = list.map((e) => ({ seq: e.seq, at: new Date(e.t).toISOString(), by: e.by, did: e.text }));
    out.next_since = store.activity.length ? store.activity[store.activity.length - 1].seq : 0;
  }
  return out;
}

// ---------- preparing edits ----------
async function ready() {
  if (store.kernel.state === 'ready') return;
  if (store.kernel.state === 'error') throw new Error(store.kernel.message);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The geometry kernel is still loading. Try again in a moment.')), 90000);
    on('kernel-ready', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function toModelMode(by) {
  if (store.mode.kind !== 'model') {
    act.leaveMode();
    logActivity(by, 'closed what the person had open to make an edit');
  }
}

function checkFeatures(list) {
  if (!Array.isArray(list)) throw new Error('"features" must be an array of feature objects.');
  for (const f of list) {
    if (!f || typeof f !== 'object' || !f.type) throw new Error('Every feature needs a "type".');
    if (!FEATURES[f.type]) throw new Error(`Unknown feature type "${f.type}". Valid types: ${Object.keys(FEATURES).join(', ')}.`);
    if (f.type === 'import' && f.file && !String(f.file).startsWith('stl_')) throw new Error('Import features get their "file" from import_file; do not write file ids by hand.');
  }
}

// Refs written by an agent ("extrude1:E4") are stored as picks with the element's geometry, so they
// keep pointing at the same element when earlier dimensions change.
function anchorSelector(sel) {
  const list = Array.isArray(sel) ? sel : [sel];
  const picks = [];
  const rest = [];
  for (const c of list) {
    const m = typeof c === 'string' ? REF.exec(c) : null;
    if (!m) {
      rest.push(c);
      continue;
    }
    const body = bodies().find((b) => b.id === m[1]);
    const i = Number(m[3]);
    const d = body && (m[2] === 'F' ? body.faces : body.edges)[i];
    if (!d) {
      rest.push(c); // let the kernel explain what is wrong with it
      continue;
    }
    picks.push(m[2] === 'F' ? { b: m[1], i, c: d.c, n: d.n, t: d.t } : { b: m[1], i, m: d.m, l: d.l, t: d.t, d: d.d });
  }
  if (!picks.length) return sel;
  const pickClause = { pick: picks };
  return rest.length ? [pickClause, ...rest] : pickClause;
}
function anchorFeature(f) {
  const g = { ...f };
  for (const key of ['edges', 'faces', 'face']) if (g[key] !== undefined) g[key] = anchorSelector(g[key]);
  if (g.plane && typeof g.plane === 'object' && g.plane.face !== undefined) g.plane = { ...g.plane, face: anchorSelector(g.plane.face) };
  return g;
}

async function rebuildReport(extra = {}) {
  const res = await act.app.rebuildNow();
  const report = buildReport(res);
  return ok(text({ ...extra, ...report, ...(report.ok ? { next: 'Take a screenshot to check the result.' } : { next: 'Fix the errors above (edit_model), then check again.' }) }));
}

// ---------- tools ----------
const IMPL = {
  async get_state(args) {
    await ready();
    if (!store.results) await act.app.rebuildNow(); // a page that just opened: wait for its first build
    return ok(text(stateSnapshot(args)));
  },

  async get_guide() {
    return ok(text(GUIDE));
  },

  async screenshot(args, ctx) {
    await ready();
    const size = { small: [640, 480], medium: [1024, 768], large: [1600, 1200] }[args.size || 'medium'] || [1024, 768];
    if (args.view === 'board' || (store.mode.kind === 'board' && (!args.view || args.view === 'current'))) {
      const b = findBoard(args.board);
      const dataUrl = await act.app.board.snapshot({ width: size[0], height: size[1], board: b, flip: !!args.from_below });
      const info = { view: 'board', board: b.id, from_below: !!args.from_below, legend: 'Top-down placement view. Green: the board; grey holes; coloured blocks: part bodies with copper pads and their refs; yellow lines: airwires (connections still to route); red outline: a part with a placement problem; dashed: footprint, or a part not on the board yet (waiting at the left).', summary: boardSummary(b) };
      if (ctx.noImages) return ok(text(info));
      return ok({ type: 'image', data: dataUrl.split(',')[1], mimeType: 'image/png' }, text(info));
    }
    let highlight = null;
    if (args.highlight !== undefined) {
      const kind = guessKind(args.highlight, args.kind);
      const found = await act.app.kernel.query(args.highlight, kind);
      highlight = found.map((x) => ({ kind, b: x.b, i: x.i }));
    }
    const shot = act.app.viewport.capture({ view: args.view || 'current', width: size[0], height: size[1], labels: args.labels || 'none', highlight });
    const info = { view: args.view || 'current', camera: act.app.viewport.cameraState(), ...(shot.legend.length ? { labels: shot.legend } : {}) };
    if (store.mode.kind !== 'model') info.note = `The person is ${viewState().mode}.`;
    if (ctx.noImages) return ok(text({ ...info, note: 'Images are not available to the assistant in this view; use get_state, query_geometry and measure instead.' }));
    return ok({ type: 'image', data: shot.dataUrl.split(',')[1], mimeType: 'image/png' }, text(info));
  },

  async query_geometry(args) {
    await ready();
    const kind = args.kind;
    if (kind === 'body') {
      const items = [];
      for (const b of bodies()) items.push((await act.app.kernel.measure(b.id)).a);
      return ok(text({ total: items.length, items }));
    }
    if (kind !== 'face' && kind !== 'edge') return fail('kind must be face, edge or body.');
    const out = await act.app.kernel.listElements(kind, args.where ?? null, Math.min(500, args.limit || 60));
    if (out.total > out.items.length) out.note = `Showing ${out.items.length} of ${out.total}. Narrow it with "where".`;
    if (store.mode.kind !== 'model') out.mode_note = `The person is ${viewState().mode}.`;
    return ok(text(out));
  },

  async measure(args) {
    await ready();
    return ok(text(await act.app.kernel.measure(args.a, args.b)));
  },

  async check_printability(args) {
    await ready();
    return ok(text(printability(args)));
  },

  async set_model(args, ctx) {
    await ready();
    checkFeatures(args.features);
    toModelMode(ctx.by);
    replaceDoc({ name: args.name || store.doc.name, params: args.params || [], features: args.features.map(anchorFeature) }, { by: ctx.by });
    return rebuildReport({ changed: `replaced the model with ${args.features.length} features` });
  },

  async edit_model(args, ctx) {
    await ready();
    if (args.upsert) checkFeatures(args.upsert);
    toModelMode(ctx.by);
    const problems = [];
    const changed = update(
      (doc) => {
        if (args.rename) doc.name = String(args.rename);
        for (const [k, v] of Object.entries(args.set_params || {})) {
          const p = doc.params.find((x) => x.name === k);
          if (p) p.value = String(v);
          else doc.params.push({ name: k, value: String(v) });
        }
        const drop = new Set(args.remove || []);
        for (const id of drop) if (!doc.features.some((f) => f.id === id)) problems.push(`remove: no feature "${id}"`);
        if (drop.size) doc.features = doc.features.filter((f) => !drop.has(f.id));
        for (const p of args.patch || []) {
          const f = doc.features.find((x) => x.id === p.id);
          if (!f) {
            problems.push(`patch: no feature "${p.id}"`);
            continue;
          }
          const set = anchorFeature(p.set || {});
          for (const [k, v] of Object.entries(set)) if (k !== 'id') f[k] = v;
          for (const k of p.unset || []) delete f[k];
        }
        let at = args.after ? doc.features.findIndex((f) => f.id === args.after) : -1;
        if (args.after && at < 0) problems.push(`after: no feature "${args.after}"; added at the end`);
        for (const raw of args.upsert || []) {
          const f = anchorFeature(raw);
          const i = f.id ? doc.features.findIndex((x) => x.id === f.id) : -1;
          if (i >= 0) doc.features[i] = f;
          else if (at >= 0) doc.features.splice(++at, 0, f);
          else doc.features.push(f);
        }
        for (const mv of args.move || []) {
          const i = doc.features.findIndex((f) => f.id === mv.id);
          if (i < 0) {
            problems.push(`move: no feature "${mv.id}"`);
            continue;
          }
          const [f] = doc.features.splice(i, 1);
          const j = mv.after ? doc.features.findIndex((x) => x.id === mv.after) : -1;
          if (mv.after && j < 0) problems.push(`move: no feature "${mv.after}"`);
          doc.features.splice(j + 1, 0, f);
        }
        const fixed = normalize(doc);
        doc.params = fixed.params;
        doc.features = fixed.features;
      },
      { by: ctx.by },
    );
    if (!changed) return ok(text({ ...buildReport(), note: 'Nothing changed: the edit matched the current model.', ...(problems.length ? { problems } : {}) }));
    return rebuildReport(problems.length ? { problems } : {});
  },

  async import_file(args, ctx) {
    await ready();
    if (!args.data) return fail('import_file reads files through the Caliper MCP bridge; it is not available here.');
    toModelMode(ctx.by);
    const item = { name: args.fileName || 'model.stl', bytes: fromB64(args.data) };
    const props = {};
    for (const k of ['mode', 'units', 'scale', 'align', 'at', 'rot', 'op']) if (args[k] !== undefined) props[k] = args[k];
    const added = await act.importFiles([item], { by: ctx.by, props });
    if (!added.length) return fail(`${item.name} has no 3D files Caliper could read (STL, STEP, OBJ or 3MF).`);
    if (added.length === 1 && args.name) update((doc) => (doc.features.find((f) => f.id === added[0]).name = String(args.name)), { by: ctx.by, quiet: true });
    return rebuildReport({ added });
  },

  async select(args, ctx) {
    await ready();
    const patch = {};
    if (args.elements !== undefined) {
      const kind = guessKind(args.elements, args.kind);
      const found = await act.app.kernel.query(args.elements, kind);
      patch.picks = found.map((x) => ({ kind, b: x.b, i: x.i }));
    }
    if (args.feature !== undefined) {
      if (args.feature && !featureById(args.feature)) return fail(`There is no feature "${args.feature}".`);
      patch.feature = args.feature || null;
      patch.shape = null;
    }
    if (store.mode.kind !== 'model' && patch.picks) toModelMode(ctx.by);
    select(patch, { by: ctx.by });
    return ok(text(viewState().selection));
  },

  async set_view(args) {
    await ready();
    const vp = act.app.viewport;
    if (args.view) vp.view(args.view);
    if (args.focus) {
      const box = boundsOf(args.focus);
      if (!box) return fail(`Nothing called "${args.focus}" to focus on.`);
      setTimeout(() => vp.fit(true, box), args.view ? 280 : 0);
    } else if (args.fit !== false) setTimeout(() => vp.fit(), args.view ? 280 : 0);
    await new Promise((r) => setTimeout(r, 600));
    return ok(text({ camera: vp.cameraState() }));
  },

  async ui_action(args, ctx) {
    const steps = Math.max(1, Math.min(50, args.steps || 1));
    switch (args.action) {
      case 'edit_sketch': {
        const f = featureById(args.feature);
        if (f?.type !== 'sketch') return fail(`"${args.feature}" is not a sketch.`);
        act.editSketch(f.id);
        break;
      }
      case 'edit_board': {
        const f = findBoard(args.feature);
        act.editBoard(f.id);
        break;
      }
      case 'finish_sketch':
        if (store.mode.kind !== 'sketch') return fail('No sketch is open.');
        act.finishSketch();
        break;
      case 'exit_mode':
        act.leaveMode();
        break;
      case 'focus_feature':
        if (!featureById(args.feature)) return fail(`There is no feature "${args.feature}".`);
        select({ feature: args.feature, shape: null }, { by: ctx.by });
        break;
      case 'show_panel': {
        const tab = { timeline: 'model', inspector: 'inspect', assistant: 'assistant' }[args.panel];
        if (!tab) return fail('panel must be timeline, inspector or assistant.');
        (await import('../ui.js')).showTab(tab);
        break;
      }
      case 'undo':
      case 'redo': {
        let n = 0;
        for (let i = 0; i < steps; i++) if (args.action === 'undo' ? undo(ctx.by) : redo(ctx.by)) n++;
        if (!n) return fail(`There is nothing to ${args.action}.`);
        return rebuildReport({ [args.action === 'undo' ? 'undid' : 'redid']: n });
      }
      default:
        return fail(`Unknown action "${args.action}".`);
    }
    await act.app.rebuildNow();
    return ok(text(viewState()));
  },

  async show_message(args, ctx) {
    act.app.toast(`${ctx.by}: ${args.text}`, args.kind === 'warning' ? 'error' : 'info');
    logActivity(ctx.by, `said: ${args.text}`);
    return ok(text('Shown.'));
  },

  async ask_user(args, ctx, signal) {
    await ready();
    const answer = await act.app.ask({ question: String(args.question), expect: args.expect || 'selection', from: ctx.by, timeout: Math.min(900, args.timeout_seconds || 180) * 1000, signal });
    const out = { ...answer, selection: viewState().selection };
    return ok(text(out));
  },

  async export_file(args, ctx) {
    await ready();
    const base = safeName(store.doc.name);
    let name;
    let bytes;
    let note = '';
    if (args.format === 'stl') {
      const out = await act.app.kernel.exportSTL(args.bodies || null, args.quality || 'standard');
      name = `${base}.stl`;
      bytes = new Uint8Array(out.buffer);
      note = `${out.triangles.toLocaleString()} triangles`;
    } else if (args.format === 'step') {
      const out = await act.app.kernel.exportSTEP(args.bodies || null);
      name = `${base}.step`;
      bytes = new Uint8Array(out.buffer);
      if (out.skipped?.length) note = `left out mesh bodies: ${out.skipped.join(', ')}`;
    } else if (args.format === 'project') {
      const { example, ...doc } = store.doc;
      name = `${base}.caliper.json`;
      bytes = new TextEncoder().encode(JSON.stringify(await embedFiles(doc)));
    } else if (args.format === 'eagle_script') {
      const b = findBoard(args.board);
      name = `${safeName(featureLabel(b))}-placement.scr`;
      bytes = new TextEncoder().encode(eagleScript(b, num, { name: featureLabel(b) }));
      note = 'Run it in the Eagle or Fusion Electronics board editor: File > Execute Script.';
    } else return fail('format must be stl, step, project or eagle_script.');
    logActivity(ctx.by, `exported ${name}`);
    if (ctx.transport === 'bridge') return { content: [text({ file: name, bytes: bytes.length, ...(note ? { note } : {}) })], files: [{ name, path: args.path || null, data: toB64(bytes) }] };
    const msg = await saveFile(name, bytes, 'application/octet-stream');
    return ok(text({ file: name, bytes: bytes.length, saved: msg || 'The person declined the save.', ...(note ? { note } : {}) }));
  },
};

// ---------- boards ----------
const num = (v) => {
  try {
    return evalExpr(v ?? 0, store.results?.params || {});
  } catch {
    return 0;
  }
};

function findBoard(id) {
  const boards = store.doc.features.filter((f) => f.type === 'board');
  if (id) {
    const f = featureById(id) || boards.find((b) => featureLabel(b) === id);
    if (!f || f.type !== 'board') throw new Error(`There is no board "${id}". Boards: ${boards.map((b) => b.id).join(', ') || 'none'}.`);
    return f;
  }
  const cur = featureById(store.mode.kind === 'board' ? store.mode.id : store.sel.feature);
  if (cur?.type === 'board') return cur;
  if (!boards.length) throw new Error('There is no board yet. Import an Eagle .sch or .brd with import_file, or add a "board" feature with edit_model.');
  if (boards.length > 1) throw new Error(`There are several boards (${boards.map((b) => b.id).join(', ')}); say which one with "board".`);
  return boards[0];
}

function boardSummary(b) {
  const issues = checkBoard(b, num);
  const wires = airwires(b);
  const parts = b.parts || [];
  return {
    board: b.id,
    outline: b.outline,
    thickness: b.thickness ?? 1.6,
    holes: b.holes || [],
    placed: parts.filter((p) => !p.off).length,
    total: parts.length,
    not_placed: parts.filter((p) => p.off).map((p) => p.ref),
    problems: issues.filter((i) => i.kind !== 'unplaced').map((i) => i.message),
    airwires: wires.length,
    airwire_length_mm: Math.round(wires.filter((w) => !w.offBoard).reduce((s, w) => s + w.length, 0)),
  };
}

function partRow(p) {
  const c = bodyCenter({ ...p, x: num(p.x), y: num(p.y) });
  return { ref: p.ref, value: p.value, package: p.package, x: p.x, y: p.y, rot: p.rot || 0, side: p.side || 'top', on_board: !p.off, body_mm: [num(p.body?.w), num(p.body?.d), num(p.h)], ...(num(p.lift) ? { lift: p.lift } : {}), body_center: c.map((v) => Math.round(v * 100) / 100) };
}

IMPL.place_parts = async (args, ctx) => {
  await ready();
  const b = findBoard(args.board);
  const problems = [];
  let arranged = null;
  const changed = update(
    (doc) => {
      const f = doc.features.find((x) => x.id === b.id);
      if (args.outline) f.outline = args.outline;
      if (args.thickness !== undefined) f.thickness = args.thickness;
      if (args.at) f.at = args.at;
      if (args.rot) f.rot = args.rot;
      if (args.holes) f.holes = args.holes;
      for (const ch of args.parts || []) {
        let p = f.parts.find((q) => q.ref === ch.ref);
        if (!p && ch.add) {
          p = { ref: ch.ref, value: ch.value || 'Block', package: ch.package || 'BLOCK', x: 0, y: 0, rot: 0, side: 'top', h: 5, body: { cx: 0, cy: 0, w: 10, d: 10 }, shape: 'box', pads: {}, color: '#2f5b8f' };
          f.parts.push(p);
        }
        if (!p) {
          problems.push(`There is no part ${ch.ref} on ${b.id}.`);
          continue;
        }
        if (ch.remove) {
          f.parts = f.parts.filter((q) => q !== p);
          continue;
        }
        if (ch.side && ch.side !== (p.side || 'top')) flipPart(p);
        if (ch.turn) turnPart(p, Number(ch.turn));
        for (const k of ['x', 'y', 'rot', 'h', 'lift', 'shape', 'value', 'color']) if (ch[k] !== undefined) p[k] = ch[k];
        if (ch.body) p.body = { ...p.body, ...ch.body };
        if (ch.center) {
          // Place by the centre of the body rather than the package origin.
          const now = bodyCenter({ ...p, x: num(p.x), y: num(p.y) });
          p.x = Math.round((num(p.x) + num(ch.center[0]) - now[0]) * 1000) / 1000;
          p.y = Math.round((num(p.y) + num(ch.center[1]) - now[1]) * 1000) / 1000;
        }
        if (ch.off === true) p.off = true;
        else if (ch.off === false || ch.x !== undefined || ch.y !== undefined || ch.center) {
          if (overBoard(p, f, num) || ch.off === false) delete p.off;
          else p.off = true;
        }
      }
      if (args.arrange) {
        const which = args.arrange === 'rest' ? f.parts.filter((p) => p.off).map((p) => p.ref) : Array.isArray(args.arrange) ? args.arrange : null;
        arranged = autoPlace(f, num, { which, sides: args.sides || ['top'], gap: args.gap ?? 1, margin: args.margin ?? 1 });
      }
    },
    { by: ctx.by },
  );
  const res = await act.app.rebuildNow();
  const err = res?.features?.[b.id]?.error;
  const fresh = featureById(b.id);
  return ok(
    text({
      changed,
      ...(arranged ? { arranged } : {}),
      ...(problems.length ? { problems_with_request: problems } : {}),
      ...(err ? { error: err } : {}),
      summary: boardSummary(fresh),
      next: 'Look with screenshot (view "board" for the placement, "iso" for 3D), then check_board against the enclosure.',
    }),
  );
};

IMPL.check_board = async (args) => {
  await ready();
  const b = findBoard(args.board);
  if (store.mode.kind !== 'board') await act.app.rebuildNow();
  const out = boardSummary(b);
  const issues = checkBoard(b, num, { edge: args.edge_clearance ?? 0.5, holeClearance: args.hole_clearance ?? 0.5 });
  out.problems = issues.map((i) => ({ kind: i.kind, parts: i.refs, message: i.message }));
  if (args.enclosure !== false) {
    const fit = await act.app.kernel.interference({ board: b.id, clearance: args.clearance ?? 0.5 });
    out.enclosure = fit.bodies ? { checked_against: fit.bodies, issues: fit.issues.map((i) => (i.kind === 'collides' ? `${i.part} runs into ${i.body} (${i.bodyId}): ${i.volume} mm³ overlap.` : `${i.part} is ${i.distance} mm from ${i.body} (${i.bodyId}).`)) } : { note: 'No other bodies to check against (model or import the enclosure).' };
  }
  const wires = airwires(b);
  const byNet = new Map();
  for (const w of wires) byNet.set(w.net, (byNet.get(w.net) || 0) + w.length);
  out.longest_nets = [...byNet.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([net, len]) => ({ net, length_mm: Math.round(len) }));
  if (args.parts !== false) out.parts = (b.parts || []).map(partRow);
  return ok(text(out));
};

function guessKind(sel, kind) {
  if (kind === 'face' || kind === 'edge') return kind;
  const first = Array.isArray(sel) ? sel.find((x) => typeof x === 'string' && REF.test(x)) : typeof sel === 'string' ? sel : null;
  const m = first && REF.exec(first);
  if (m) return m[2] === 'F' ? 'face' : 'edge';
  if (typeof sel === 'string' && ['top', 'bottom', 'left', 'right', 'front', 'back'].includes(sel)) return 'face';
  return 'edge';
}

function boundsOf(ref) {
  const m = REF.exec(ref);
  if (!m) {
    const b = bodies().find((x) => x.id === ref || x.name === ref);
    return b ? { min: b.min, max: b.max } : null;
  }
  const d = describeRef(ref);
  if (!d || d.missing) return null;
  const pts = d.kind === 'edge' ? [d.start, d.end, d.mid] : [d.center];
  const pad = Math.max(4, Math.sqrt(d.area || 0) / 2, (d.length || 0) / 2, d.radius || 0);
  const min = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k])) - pad);
  const max = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])) + pad);
  return { min, max };
}

// ---------- printability ----------
function printability({ overhang_angle = 45, build_volume } = {}) {
  const list = bodies().filter((b) => !b.kind); // circuit boards and their parts are not printed
  if (!list.length) return { ok: false, note: bodies().length ? 'Only a circuit board and its parts are here; they are not printed. Model the enclosure first.' : 'There is nothing to print yet.' };
  const res = { min: [0, 1, 2].map((k) => Math.min(...list.map((b) => b.min[k]))), max: [0, 1, 2].map((k) => Math.max(...list.map((b) => b.max[k]))) };
  const bed = res.min[2];
  const limit = Math.sin((overhang_angle * Math.PI) / 180);
  const issues = [];
  const report = { bed_z: r3(bed), bodies: [] };
  for (const b of list) {
    const P = b.positions;
    const I = b.indices;
    const tri = new Map(); // face index -> overhang area
    let overhang = 0;
    let contact = 0;
    const faceOf = new Int32Array(I.length / 3).fill(-1);
    for (const g of b.faceGroups) for (let k = g.start; k < g.start + g.count; k += 3) faceOf[k / 3] = g.i;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3;
      const c = I[t + 1] * 3;
      const d = I[t + 2] * 3;
      const ux = P[c] - P[a];
      const uy = P[c + 1] - P[a + 1];
      const uz = P[c + 2] - P[a + 2];
      const vx = P[d] - P[a];
      const vy = P[d + 1] - P[a + 1];
      const vz = P[d + 2] - P[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (!len) continue;
      const area = len / 2;
      const zMax = Math.max(P[a + 2], P[c + 2], P[d + 2]);
      if (nz / len < -0.999 && zMax <= bed + 0.05) contact += area;
      else if (-nz / len > limit && zMax > bed + 0.05) {
        overhang += area;
        const fi = faceOf[t / 3];
        tri.set(fi, (tri.get(fi) || 0) + area);
      }
    }
    const entry = {
      body: b.id,
      name: b.name,
      size_mm: b.max.map((v, i) => r2(v - b.min[i])),
      bed_contact_mm2: r2(contact),
      overhang_mm2: r2(overhang),
    };
    if (!b.isMesh && overhang > 0.5) {
      entry.overhang_faces = [...tri.entries()]
        .filter(([fi]) => fi >= 0)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 12)
        .map(([fi, area]) => ({ ref: `${b.id}:F${fi}`, area_mm2: r2(area), center: r3(b.faces[fi]?.c) }));
    }
    if (b.isMesh) entry.triangles = b.triangles;
    if (b.min[2] > bed + 0.05) issues.push(`${b.name} floats ${r2(b.min[2] - bed)} mm above the bed; it needs support or should be moved down.`);
    if (contact < 1) issues.push(`${b.name} has almost no flat area on the bed (${r2(contact)} mm²); it may not stick. Consider a flat base or a brim.`);
    if (overhang > 1) issues.push(`${b.name} has ${r2(overhang)} mm² of overhang steeper than ${overhang_angle}° from vertical; it needs supports there or a design change (chamfers instead of fillets on downward edges, or rotate the part).`);
    report.bodies.push(entry);
  }
  if (list.length > 1) issues.push(`There are ${list.length} separate bodies. They will print as separate parts unless joined.`);
  if (bed !== 0 && Math.abs(bed) > 0.01) issues.push(`The lowest point is at Z = ${r2(bed)}, not 0. Most slicers drop parts onto the bed anyway.`);
  if (Array.isArray(build_volume) && build_volume.length === 3) {
    const size = res.max.map((v, i) => v - res.min[i]);
    const fits = size.every((s, i) => s <= Number(build_volume[i]));
    report.fits_build_volume = fits;
    if (!fits) issues.push(`The part (${size.map(r2).join(' × ')} mm) is larger than the build volume (${build_volume.join(' × ')} mm).`);
  }
  report.issues = issues;
  report.ok = issues.length === 0;
  report.not_checked = 'Wall thickness, small holes and bridging are not checked.';
  return report;
}

// ---------- entry point ----------
export async function runTool(name, args = {}, ctx = {}, signal) {
  const def = toolByName(name);
  const impl = IMPL[name];
  if (!def || !impl) return fail(`Unknown tool "${name}".`);
  const c = { by: ctx.by || 'agent', transport: ctx.transport || 'inapp', noImages: !!ctx.noImages };
  try {
    return await impl(args || {}, c, signal);
  } catch (e) {
    return fail(e?.message || String(e));
  }
}
