// Commands: everything the toolbar, timeline, viewport clicks and keyboard can do to the document.
import { store, update, select, setMode, newFeatureId, featureById, emit } from './store.js';
import { FEATURES, DEFAULTS, MAKES_TOOL, featureLabel } from './schema.js';
import { readEagle, isEagle } from './board/eagle.js';
import { readKicad, isKicad } from './board/kicad.js';
import { boardPolygon } from './board/geometry.js';
import { bounds } from './sketchgeo.js';

export const app = { viewport: null, sketcher: null, board: null, kernel: null, toast: () => {}, rebuildNow: async () => null };

const round = (v) => Math.round(v * 1000) / 1000;

export function bodyOf(pick) {
  return store.results?.bodies.find((b) => b.id === pick.b) || null;
}
export function descOf(pick) {
  const b = bodyOf(pick);
  if (!b) return null;
  return (pick.kind === 'face' ? b.faces : b.edges)[pick.i] || null;
}
export function pickRef(pick) {
  const d = descOf(pick) || {};
  return pick.kind === 'face' ? { b: pick.b, i: pick.i, c: d.c, n: d.n, t: d.t } : { b: pick.b, i: pick.i, m: d.m, l: d.l, t: d.t, d: d.d };
}
const selected = (kind) => store.sel.picks.filter((p) => p.kind === kind);
const selectedPlanarFace = () => selected('face').find((p) => descOf(p)?.n) || null;
const hasBodies = () => (store.results?.bodies.length || 0) > 0;

function defaultName(type) {
  const label = FEATURES[type]?.label || type;
  const n = store.doc.features.filter((f) => f.type === type).length + 1;
  return `${label} ${n}`;
}

export function addFeature(type, props = {}, { by = 'user', focus = true } = {}) {
  const f = { id: newFeatureId(type), type, name: defaultName(type), ...structuredClone(DEFAULTS[type] || {}), ...props };
  update((doc) => doc.features.push(f), { by });
  // An agent adding a feature opens it in the inspector but leaves the person's selection alone.
  select(by === 'user' ? { feature: f.id, shape: null, picks: [] } : { feature: f.id, shape: null }, { by });
  if (by === 'user' && focus) emit('focus-first');
  return f;
}

export function deleteFeature(id) {
  if (store.mode.kind !== 'model') leaveMode();
  update((doc) => {
    doc.features = doc.features.filter((f) => f.id !== id);
  });
  if (store.sel.feature === id) select({ feature: null, shape: null });
}

export function toggleSuppress(id) {
  update((doc) => {
    const f = doc.features.find((x) => x.id === id);
    if (f) {
      if (f.suppressed) delete f.suppressed;
      else f.suppressed = true;
    }
  });
}

export function moveFeature(id, delta) {
  update((doc) => {
    const i = doc.features.findIndex((f) => f.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= doc.features.length) return;
    const [f] = doc.features.splice(i, 1);
    doc.features.splice(j, 0, f);
  });
}

// ---------- modes ----------
export function leaveMode() {
  const { mode } = store;
  if (mode.kind === 'sketch') return finishSketch();
  if (mode.kind === 'board') {
    setMode({ kind: 'model' });
    select({ feature: mode.id, shape: null });
    return;
  }
  app.viewport.showPlanes(false);
  if (mode.kind !== 'model') setMode({ kind: 'model' });
}

export function startSketch() {
  if (store.mode.kind !== 'model') leaveMode();
  const face = selectedPlanarFace();
  if (face) return createSketch({ face: { pick: [pickRef(face)] } });
  select({ picks: [] });
  setMode({ kind: 'plane' });
  app.viewport.showPlanes(true);
}

export function createSketch(plane) {
  app.viewport.showPlanes(false);
  const f = addFeature('sketch', { plane, shapes: [] });
  editSketch(f.id);
}

export function editSketch(id) {
  const f = featureById(id);
  if (!f) return;
  if (store.mode.kind === 'sketch' && store.mode.id !== id) finishSketch();
  select({ feature: id, shape: null, picks: [] });
  setMode({ kind: 'sketch', id, tool: nextSketchTool || (f.shapes?.length ? 'select' : 'rect') });
  nextSketchTool = null;
}

export function finishSketch() {
  const { mode } = store;
  if (mode.kind !== 'sketch') return;
  const id = mode.id;
  app.sketcher.exit();
  setMode({ kind: 'model' });
  const f = featureById(id);
  if (!f) return;
  const used = store.doc.features.some((x) => x.sketch === id);
  if (!f.shapes?.length && !used) {
    update((doc) => {
      doc.features = doc.features.filter((x) => x.id !== id);
    }, { quiet: true });
    select({ feature: null, shape: null });
    return;
  }
  if (!used && f.shapes?.length) {
    const onFace = typeof f.plane === 'object' || !['XY', 'XZ', 'YZ'].includes(String(f.plane).toUpperCase());
    // Only round or slotted shapes drawn on a face of the model: those are holes.
    const holes = onFace && hasBodies() && f.shapes.every((s) => ['circle', 'slot'].includes(s.kind) || s.hole);
    const ex = addFeature('extrude', holes ? { sketch: id, extent: 'through', op: 'cut' } : { sketch: id, distance: 10, op: hasBodies() ? 'join' : 'new' });
    lastAuto = { id: ex.id, sketch: id, revision: store.revision };
    app.toast(holes ? 'Sketch finished: cut through as holes. Set Extent to Distance for a blind hole, or Operation to Join to add material.' : 'Sketch finished and extruded. Set the distance, or choose Revolve or Cut instead in the inspector.');
  } else select({ feature: id, shape: null });
}

// The extrude made automatically when a sketch is finished, while it is still untouched: picking
// Revolve (or "Revolve instead") replaces it rather than stacking a revolve on top.
let lastAuto = null;
export function autoExtrude(id) {
  if (!lastAuto || lastAuto.id !== id) return null;
  const f = featureById(id);
  return f && f.type === 'extrude' && f.sketch === lastAuto.sketch ? lastAuto : null;
}
export function replaceAutoExtrude(id, type) {
  const auto = autoExtrude(id);
  if (!auto) return null;
  const sketch = auto.sketch;
  lastAuto = null;
  if (type === 'cut') {
    update((doc) => Object.assign(doc.features.find((x) => x.id === id), { op: 'cut' }));
    return featureById(id);
  }
  const rev = { id: newFeatureId('revolve'), type: 'revolve', name: defaultName('revolve'), ...structuredClone(DEFAULTS.revolve), sketch, op: featureById(id).op };
  update((doc) => {
    const i = doc.features.findIndex((x) => x.id === id);
    if (i >= 0) doc.features.splice(i, 1, rev);
  });
  select({ feature: rev.id, shape: null, picks: [] });
  return rev;
}

// Double-click in the view: a board part opens the placement editor with that part selected.
export function viewportDoubleClick(pick) {
  if (store.mode.kind !== 'model' || !pick) return;
  const body = store.results?.bodies.find((b) => b.id === pick.b);
  if (body && !body.board && body.kind !== 'board') return selectBody(body.id); // double-click picks the whole body
  if (!(body?.board || body?.kind === 'board')) return;
  editBoard(body.board || body.id);
  if (body.ref) select({ shape: body.ref });
}

// ---------- boards ----------
const BOARD_EXT = /\.(sch|brd|kicad_pcb|kicad_sch|net)$/i;
const IS_LAYOUT = /\.(brd|kicad_pcb)$/i;

export function editBoard(id) {
  const f = featureById(id);
  if (!f || f.type !== 'board') return;
  if (store.mode.kind !== 'model' && !(store.mode.kind === 'board' && store.mode.id === id)) leaveMode();
  select({ feature: id, shape: null, picks: [] });
  setMode({ kind: 'board', id, tool: 'select' });
}

export function setBoardTool(tool) {
  if (store.mode.kind !== 'board') return;
  store.mode = { ...store.mode, tool };
  emit('mode');
}

// A board feature from Eagle props (or an empty one), centred on the bed with its lowest part on it.
export function addBoard(props = {}, { by = 'user', name = null } = {}) {
  const b = { thickness: 1.6, holes: [], parts: [], nets: [], outline: { kind: 'rect', w: 60, h: 40, r: 2 }, ...props };
  const bb = bounds(boardPolygon(b));
  const below = Math.max(0, ...b.parts.filter((p) => !p.off && p.side === 'bottom').map((p) => (Number(p.lift) || 0) + (Number(p.h) || 0)));
  const at = [-bb.cx, -bb.cy, below].map((v) => Math.round(v * 1000) / 1000 || 0);
  const count = store.doc.features.filter((f) => f.type === 'board').length;
  // No field takes the focus: the placement editor's keys (R, F, X…) should reach the board.
  return addFeature('board', { name: name || `Board ${count + 1}`, ...b, at }, { by, focus: false });
}

export function addBoardPart(boardId) {
  let ref = null;
  update((doc) => {
    const f = doc.features.find((x) => x.id === boardId);
    if (!f) return;
    f.parts ||= [];
    let i = 1;
    while (f.parts.some((p) => p.ref === `P${i}`)) i++;
    ref = `P${i}`;
    const bb = bounds(boardPolygon(f));
    f.parts.push({ ref, value: 'Block', package: 'BLOCK', x: Math.round(bb.cx), y: Math.round(bb.cy), rot: 0, side: 'top', h: 5, body: { cx: 0, cy: 0, w: 10, d: 10 }, shape: 'box', pads: {}, color: '#2f5b8f' });
  });
  if (ref) select({ shape: ref });
  return ref;
}

// Mounting posts for a board, printed with the enclosure: one under each hole, from the surface below
// up to the board, with a pilot hole for a screw. One undo step.
export async function addStandoffs(boardId, { wall = 1.8, screw = null, by = 'user' } = {}) {
  const f = featureById(boardId);
  if (!f || f.type !== 'board') return { error: 'There is no such board.' };
  const { evalExpr } = await import('./expr.js');
  const n = (v) => evalExpr(v ?? 0, store.results?.params || {});
  const rot = (f.rot || [0, 0, 0]).map(n);
  if (rot.some((v) => Math.abs(v) > 1e-6)) return { error: 'Standoffs are made for a board lying flat (rotation 0, 0, 0).' };
  const holes = (f.holes || []).map((h) => ({ x: n(h.x), y: n(h.y), d: n(h.d) }));
  if (!holes.length) return { error: 'The board has no mounting holes yet. Add them in the placement editor (H), or with the Hole tool.' };
  const at = (f.at || [0, 0, 0]).map(n);
  const hits = await app.kernel.surfaceBelow(holes.map((h) => [at[0] + h.x, at[1] + h.y, at[2] - 0.01]));
  const added = [];
  const skipped = [];
  const nothingBelow = [];
  if (hits.every((x) => !x)) return { error: 'Nothing of the enclosure is under the board\'s holes (an open tube, or a separate bottom piece not imported yet). Import or model the part the board should stand on, then add standoffs.' };
  const r3 = (v) => Math.round(v * 1000) / 1000;
  update(
    (doc) => {
      holes.forEach((h, i) => {
        if (!hits[i]) {
          nothingBelow.push(i + 1);
          return;
        }
        const base = hits[i].z;
        const height = r3(at[2] - base);
        if (height < 0.5) {
          skipped.push(i + 1);
          return;
        }
        const x = r3(at[0] + h.x);
        const y = r3(at[1] + h.y);
        const d = r3(Math.max(5, h.d + 2 * wall));
        const pilot = r3(screw ?? Math.round(h.d * 0.78 * 10) / 10);
        const depth = r3(Math.min(height, 8));
        const post = { id: newFeatureId('cylinder'), type: 'cylinder', name: `Standoff ${i + 1}`, d, h: height, at: [x, y, r3(base)], op: 'join' };
        const bore = { id: newFeatureId('cylinder'), type: 'cylinder', name: `Screw hole ${i + 1}`, d: pilot, h: depth, at: [x, y, r3(at[2] - depth)], op: 'cut' };
        doc.features.push(post, bore);
        added.push(post.id, bore.id);
      });
    },
    { by, key: `standoffs:${Date.now()}` },
  );
  await app.rebuildNow();
  return { added: added.length / 2, skipped, nothingBelow };
}

export function startPick(feature, key, kind) {
  if (store.mode.kind === 'sketch') finishSketch();
  select({ feature, picks: [] });
  setMode({ kind: 'pick', feature, key, pick: kind });
}

export function setSketchTool(tool) {
  if (store.mode.kind !== 'sketch') return;
  store.mode = { ...store.mode, tool };
  app.sketcher.setTool(tool);
  emit('mode');
}

// ---------- viewport clicks ----------
export function viewportClick(pick, evt) {
  const { mode } = store;
  if (mode.kind === 'plane') {
    if (!pick) return;
    if (pick.kind === 'plane') createSketch(pick.name);
    else if (pick.kind === 'face' && pick.planar) createSketch({ face: { pick: [pickRef(pick)] } });
    else app.toast('Sketches need a flat face. Pick a planar face or one of the three planes.');
    return;
  }
  if (mode.kind === 'pick') {
    if (!pick || pick.kind !== mode.pick) return;
    const single = FEATURES[featureById(mode.feature)?.type]?.fields.find((x) => x.key === mode.key)?.single;
    update((doc) => {
      const f = doc.features.find((x) => x.id === mode.feature);
      if (!f) return;
      const cur = f[mode.key] && typeof f[mode.key] === 'object' && Array.isArray(f[mode.key].pick) ? f[mode.key].pick : [];
      const at = cur.findIndex((p) => p.b === pick.b && p.i === pick.i);
      if (at >= 0) cur.splice(at, 1);
      else if (single) cur.splice(0, cur.length, pickRef(pick));
      else cur.push(pickRef(pick));
      f[mode.key] = { pick: cur };
    });
    if (single && featureById(mode.feature)?.[mode.key]?.pick?.length) leaveMode(); // one face is all it takes
    return;
  }
  if (mode.kind !== 'model') return;
  if (!pick) {
    // Empty space: let go of whatever is selected, as in other CAD tools.
    if (store.sel.picks.length || store.sel.feature || store.sel.body) select({ picks: [], feature: null, shape: null, body: null });
    return;
  }
  // A circuit board or one of its parts: select the board (its faces are not for modelling).
  const body = store.results?.bodies.find((b) => b.id === pick.b);
  if (body?.board || body?.kind === 'board') {
    const boardId = body.board || body.id;
    select({ feature: boardId, shape: null, picks: [] });
    if (body.ref) app.toast(`${body.name} on ${featureLabel(featureById(boardId) || { type: 'board' })}. Double-click to place it.`);
    return;
  }
  const p = { kind: pick.kind, b: pick.b, i: pick.i };
  const same = (q) => q.kind === p.kind && q.b === p.b && q.i === p.i;
  const multi = evt.shiftKey || evt.ctrlKey || evt.metaKey;
  let picks;
  if (tools.measuring) picks = store.sel.picks.some(same) ? store.sel.picks.filter((q) => !same(q)) : [...store.sel.picks, p].slice(-2);
  else if (multi) picks = store.sel.picks.some(same) ? store.sel.picks.filter((q) => !same(q)) : [...store.sel.picks.filter((q) => q.kind === p.kind), p];
  else picks = store.sel.picks.length === 1 && same(store.sel.picks[0]) ? [] : [p];
  select({ picks });
}

// ---------- importing ----------
// Brings 3D files (STL, STEP, OBJ, 3MF, or zips of them) in as Import features; returns the new
// feature ids. `items` are File objects or { name, bytes }. Several parts keep the layout they share in
// their files (centred on the bed as a group) unless they would overlap, in which case they are set out
// in a row. Other files found in zips go to `others` (the chat attaches them for Claude to read).
export async function importFiles(items, { by = 'user', props = {}, others = null } = {}) {
  const { putFile } = await import('./files.js');
  const { readZip, realEntry, MODEL_EXT, inflateRawWeb } = await import('./zip.js');
  const skipped = [];
  const parts = [];
  const boards = [];
  for (const item of items) {
    const name = item.name || 'model.stl';
    // Files are Blobs (which have their own bytes() method these days); plain { name, bytes } items
    // come from agents.
    const isBlob = typeof Blob !== 'undefined' && item instanceof Blob;
    const size = isBlob ? item.size : item.bytes?.length || 0;
    if (size > 200 * 1024 * 1024) {
      app.toast(`${name} is larger than 200 MB.`, 'error');
      continue;
    }
    const bytes = isBlob ? new Uint8Array(await item.arrayBuffer()) : item.bytes;
    if (/\.zip$/i.test(name)) {
      try {
        const found = await readZip(bytes, inflateRawWeb, { accept: realEntry });
        for (const e of found) {
          if (MODEL_EXT.test(e.name)) parts.push(e);
          else if (BOARD_EXT.test(e.name)) {
            boards.push(e);
            others?.push(e); // the chat also hands the schematic itself to Claude
          }
          else if (others) others.push(e);
          else skipped.push(e.name);
        }
        if (!found.some((e) => MODEL_EXT.test(e.name) || BOARD_EXT.test(e.name))) app.toast(`${name} has no 3D files or circuit boards inside (STL, STEP, OBJ, 3MF, or an Eagle or KiCad board or schematic).`, 'error');
      } catch (e) {
        app.toast(`${name}: ${e.message}`, 'error');
      }
    } else if (MODEL_EXT.test(name)) parts.push({ name, bytes });
    else if (BOARD_EXT.test(name) || (/\.(xml|eagle|txt)$/i.test(name) && (isEagle(bytes) || isKicad(bytes)))) {
      boards.push({ name, bytes });
      others?.push({ name, bytes });
    }
    else if (others) others.push({ name, bytes });
    else app.toast(`${name} is not a file Caliper can import (STL, STEP, OBJ, 3MF, an Eagle or KiCad board, schematic or netlist, or a zip of them).`, 'error');
  }
  if (skipped.length) app.toast(`Skipped ${skipped.join(', ')}: not 3D files. Drop the zip into the chat to share them with Claude.`);
  const boardIds = boards.length ? importBoards(boards, { by }) : [];
  if (!parts.length) return boardIds;
  if (store.mode.kind !== 'model') leaveMode();
  const many = parts.length > 1;
  const key = `import:${Date.now()}`;
  const ids = [];
  for (const part of parts) ids.push(await putFile(part.name, part.bytes));
  const added = [];
  update(
    (doc) => {
      parts.forEach((part, i) => {
        const id = newFeatureId('import');
        doc.features.push({ id, type: 'import', name: part.name.replace(MODEL_EXT, ''), fileName: part.name, file: ids[i], op: 'new', ...(many ? { align: 'original' } : {}), ...props });
        added.push(id);
      });
    },
    { by, key },
  );
  let res = await app.rebuildNow();
  if (many && res) {
    // Lay the parts out: keep their shared layout if nothing overlaps, otherwise set them in a row.
    const boxes = added.map((id) => res.bodies.find((b) => b.id === id)).filter(Boolean);
    const overlap = (a, b) => [0, 1, 2].reduce((v, k) => v * Math.max(0, Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k])), 1);
    const vol = (a) => [0, 1, 2].reduce((v, k) => v * Math.max(1e-9, a.max[k] - a.min[k]), 1);
    let crowded = false;
    for (let i = 0; i < boxes.length && !crowded; i++) for (let j = i + 1; j < boxes.length && !crowded; j++) if (overlap(boxes[i], boxes[j]) > 0.1 * Math.min(vol(boxes[i]), vol(boxes[j]))) crowded = true;
    const at = new Map();
    if (crowded) {
      const gap = 5;
      const width = boxes.reduce((w, b) => w + (b.max[0] - b.min[0]), 0) + gap * (boxes.length - 1);
      let x = -width / 2;
      for (const b of boxes) {
        const w = b.max[0] - b.min[0];
        at.set(b.id, { align: 'bed', at: [Math.round((x + w / 2) * 1000) / 1000, 0, 0] });
        x += w + gap;
      }
    } else if (boxes.length) {
      const lo = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k])));
      const hi = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k])));
      const shift = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]].map((v) => Math.round(v * 1000) / 1000);
      for (const b of boxes) at.set(b.id, { align: 'original', at: shift });
    }
    update(
      (doc) => {
        for (const f of doc.features) if (at.has(f.id)) Object.assign(f, at.get(f.id));
      },
      { by, key, quiet: true }, // part of the same import, so one undo removes it all
    );
    res = await app.rebuildNow();
  }
  if (boardIds.length) added.push(...boardIds);
  select({ feature: added[added.length - 1], shape: null }, { by });
  app.viewport.fit();
  const errs = added.map((id) => res?.features?.[id]?.error).filter(Boolean);
  if (errs.length) app.toast(errs[0], 'error');
  else if (!many) app.toast(res?.features?.[added[0]]?.note || 'Imported.');
  else {
    const notes = added.map((id) => res?.features?.[id]?.note || '');
    const ref = notes.filter((n) => /reference mesh/.test(n)).length;
    const fixed = notes.filter((n) => /Repaired/.test(n)).length;
    app.toast(`Imported ${added.length} parts${fixed ? `, repaired ${fixed}` : ''}${ref ? `; ${ref} came in as reference meshes because they are not closed solids` : ''}. Click a part in the timeline for details.`);
  }
  return added;
}

// Eagle / Fusion Electronics files become board features. A board file wins over the schematic of
// the same name, since it knows where the parts go.
function importBoards(files, { by }) {
  const base = (n) => n.replace(/^.*[\\/]/, '').replace(BOARD_EXT, '').toLowerCase();
  const withBoard = new Set(files.filter((f) => IS_LAYOUT.test(f.name)).map((f) => base(f.name)));
  const ids = [];
  for (const file of files) {
    if (!IS_LAYOUT.test(file.name) && withBoard.has(base(file.name))) continue;
    try {
      const short = file.name.replace(/^.*[\\/]/, '');
      const reader = isKicad(file.bytes) ? readKicad : isEagle(file.bytes) ? readEagle : null;
      if (!reader) throw new Error('not an Eagle, Fusion Electronics or KiCad file Caliper can read.');
      const { props, notes } = reader(file.bytes, short);
      if (store.mode.kind !== 'model') leaveMode();
      const f = addBoard(props, { by, name: file.name.replace(/^.*[\\/]/, '').replace(BOARD_EXT, '') });
      ids.push(f.id);
      // A short toast; the full notes stay at the top of the board's inspector.
      const guessed = notes.find((t) => /estimates/.test(t));
      const placedNote = notes.find((t) => /^Arranged/.test(t));
      const placed = props.parts.filter((p) => !p.off).length;
      app.toast(`${short}: ${props.parts.length} parts, ${props.nets.length} nets${placedNote ? `, ${placed === props.parts.length ? 'all' : placed} arranged on the board` : ''}.${guessed ? ' Some heights are estimates: see the notes in the inspector.' : ''}`);
      if (notes.length) update((doc) => (doc.features.find((x) => x.id === f.id).notes = notes), { by, quiet: true });
      if (by === 'user') editBoard(f.id);
    } catch (e) {
      app.toast(`${file.name}: ${e.message}`, 'error');
    }
  }
  return ids;
}

// ---------- toolbar ----------
function findSketch() {
  const cur = featureById(store.sel.feature);
  if (cur?.type === 'sketch') return cur;
  const sketches = store.doc.features.filter((f) => f.type === 'sketch' && !f.suppressed && f.shapes?.length);
  const unused = sketches.filter((s) => !store.doc.features.some((f) => f.sketch === s.id));
  return unused[unused.length - 1] || sketches[sketches.length - 1] || null;
}

function placement() {
  const face = selectedPlanarFace();
  if (!face) return {};
  const d = descOf(face);
  const n = d.n;
  const at = d.c.map(round);
  let rot = null;
  if (n[0] > 0.999) rot = [0, 90, 0];
  else if (n[0] < -0.999) rot = [0, -90, 0];
  else if (n[1] > 0.999) rot = [-90, 0, 0];
  else if (n[1] < -0.999) rot = [90, 0, 0];
  else if (n[2] < -0.999) rot = [180, 0, 0];
  return rot ? { at, rot } : { at };
}

// Measure mode: clicks collect two faces or edges (any mix) and the mode bar shows the distance
// and angle between them.
export const tools = { measuring: false };
export function setMeasuring(on) {
  tools.measuring = on;
  select({ picks: on ? store.sel.picks.slice(-2) : [], feature: null, body: null });
}

let nextSketchTool = null;
export function command(name) {
  if (name !== 'sketch' && name !== 'measure' && store.mode.kind !== 'model') leaveMode();
  if (name !== 'measure' && tools.measuring) tools.measuring = false;
  const op = hasBodies() ? 'join' : 'new';
  switch (name) {
    case 'sketch':
      return startSketch();
    case 'text':
      // Text lives in sketches: pick the plane or face, then click where the lettering starts.
      nextSketchTool = 'text';
      if (store.mode.kind === 'sketch') return setSketchTool('text');
      app.toast('Text: pick a plane or a flat face, then click where the text starts.');
      return startSketch();
    case 'measure':
      if (store.mode.kind !== 'model') leaveMode();
      setMeasuring(!tools.measuring);
      return null;
    case 'check':
      if (store.mode.kind !== 'model') leaveMode();
      select({ feature: null, body: null, shape: null, picks: [] });
      emit('print-check', true);
      return null;
    case 'import':
      return document.getElementById('import-file')?.click();
    case 'board': {
      const cur = featureById(store.sel.feature);
      const boards = store.doc.features.filter((f) => f.type === 'board');
      const target = cur?.type === 'board' ? cur : boards[boards.length - 1];
      if (target) return editBoard(target.id);
      const f = addBoard({}, { by: 'user' });
      editBoard(f.id);
      app.toast('New board. Import a schematic or board (Eagle, Fusion Electronics or KiCad) to bring in its parts, or add blocks; set its outline in the inspector.');
      return f;
    }
    // A shape placed on a picked face joins that body; one dropped in free space is its own body
    // (switch Operation to Join or Cut to combine it).
    case 'box':
    case 'cylinder':
    case 'cone':
    case 'torus': {
      const pl = placement();
      return addFeature(name, { ...pl, op: pl.at ? op : 'new' });
    }
    case 'sphere': {
      const pl = placement();
      return addFeature('sphere', { ...(pl.at ? { at: pl.at } : {}), op: pl.at ? op : 'new' });
    }
    case 'extrude': {
      const face = selectedPlanarFace();
      if (face) return addFeature('extrude', { name: defaultName('extrude').replace('Extrude', 'Push/pull'), face: { pick: [pickRef(face)] }, distance: 5, op: 'join' });
      const sk = findSketch();
      if (!sk) {
        app.toast('Extrude needs a profile. Draw a sketch, or select a flat face to push or pull it.');
        return startSketch();
      }
      return addFeature('extrude', { sketch: sk.id, distance: 10, op });
    }
    case 'revolve': {
      const sk = findSketch();
      if (!sk) {
        app.toast('Revolve needs a profile. Draw half of the cross-section in a sketch first.');
        return startSketch();
      }
      const auto = lastAuto && featureById(lastAuto.id) && lastAuto.sketch === sk.id && store.revision === lastAuto.revision;
      if (auto) return replaceAutoExtrude(lastAuto.id, 'revolve');
      return addFeature('revolve', { sketch: sk.id, op });
    }
    case 'fillet':
    case 'chamfer': {
      if (!hasBodies()) return app.toast('Make a solid first, then round or bevel its edges.');
      let edges = selected('edge');
      if (!edges.length) {
        // A selected face stands for the edges around it.
        const seen = new Set();
        for (const fc of selected('face')) {
          const body = bodyOf(fc);
          body?.edges.forEach((d, i) => {
            if (!d.seam && (d.f || []).includes(fc.i) && !seen.has(`${fc.b}:${i}`)) {
              seen.add(`${fc.b}:${i}`);
              edges.push({ kind: 'edge', b: fc.b, i });
            }
          });
        }
      }
      const f = addFeature(name, { edges: { pick: edges.map(pickRef) } });
      if (!edges.length) startPick(f.id, 'edges', 'edge');
      return f;
    }
    case 'shell': {
      if (!hasBodies()) return app.toast('Make a solid first, then hollow it out.');
      const faces = selected('face');
      const f = addFeature('shell', { faces: { pick: faces.map(pickRef) } });
      if (!faces.length) startPick(f.id, 'faces', 'face');
      return f;
    }
    case 'pattern': {
      const cur = featureById(store.sel.feature);
      const tools = store.doc.features.filter((f) => MAKES_TOOL.has(f.type) && !f.suppressed);
      const src = cur && MAKES_TOOL.has(cur.type) ? cur : tools[tools.length - 1];
      if (!src) return app.toast('Patterns repeat an extrude, revolve or primitive. Create one first.');
      return addFeature('pattern', { features: [src.id] });
    }
    case 'mirror': {
      if (!hasBodies()) return app.toast('Make a solid first, then mirror it.');
      const cur = featureById(store.sel.feature);
      return addFeature('mirror', cur && MAKES_TOOL.has(cur.type) ? { features: [cur.id] } : {});
    }
    case 'move': {
      if (!hasBodies()) return app.toast('Make a solid first, then move it.');
      const ids = store.sel.body ? [store.sel.body] : [...new Set(store.sel.picks.map((p) => p.b))];
      return addFeature('move', ids.length ? { bodies: ids } : {});
    }
    default:
      return null;
  }
}

// ---------- bodies ----------
// The Bodies list: each solid in the model, plus one row per circuit board (its parts go with it).
export const bodyRows = () => (store.results?.bodies || []).filter((b) => !b.kind || b.kind === 'board');

export function selectBody(id) {
  if (store.mode.kind !== 'model') leaveMode();
  select({ body: id, feature: null, shape: null, picks: [] });
}

function setHidden(fn) {
  update(
    (doc) => {
      const set = new Set(doc.hidden || []);
      fn(set);
      const known = new Set(bodyRows().map((b) => b.id));
      const list = [...set].filter((id) => known.has(id));
      if (list.length) doc.hidden = list;
      else delete doc.hidden;
    },
    { quiet: true },
  );
}
export const isHidden = (id) => (store.doc.hidden || []).includes(id);
export function toggleBodyHidden(id) {
  const hide = !isHidden(id);
  setHidden((set) => (hide ? set.add(id) : set.delete(id)));
  if (hide && store.sel.body === id) select({ body: null });
}
export function isolateBody(id) {
  setHidden((set) => {
    set.clear();
    for (const b of bodyRows()) if (b.id !== id) set.add(b.id);
  });
}
export function showAllBodies() {
  setHidden((set) => set.clear());
}

export function renameBody(id, name) {
  const body = bodyRows().find((b) => b.id === id);
  const f = featureById(id);
  update(
    (doc) => {
      if (f?.type === 'board') {
        doc.features.find((x) => x.id === id).name = name || f.name;
        return;
      }
      doc.bodyNames ||= {};
      if (name && name !== body?.name) doc.bodyNames[id] = name;
      else if (!name) delete doc.bodyNames[id];
      if (!Object.keys(doc.bodyNames).length) delete doc.bodyNames;
    },
    { key: `bodyname.${id}` },
  );
}

function moveName(word) {
  const n = store.doc.features.filter((f) => f.type === 'move' && String(f.name || '').startsWith(word)).length + 1;
  return `${word} ${n}`;
}
export function moveBody(id) {
  if (store.mode.kind !== 'model') leaveMode();
  return addFeature('move', { bodies: [id] });
}
export function dropToBed(id) {
  if (store.mode.kind !== 'model') leaveMode();
  const f = addFeature('move', { name: moveName('Rest on bed'), bodies: [id], drop: true }, { focus: false });
  app.toast('Moved it down so it rests on the bed (Z = 0).');
  return f;
}
// Turn a body so one of its flat faces lies on the bed, the way slicers do it.
export function layFlat(id = null) {
  if (store.mode.kind !== 'model') leaveMode();
  const face = selectedPlanarFace();
  if (face && (!id || face.b === id)) {
    const f = addFeature('move', { name: moveName('Lay flat'), bodies: [face.b], flat: { pick: [pickRef(face)] } }, { focus: false });
    app.toast('Turned it so that face rests on the bed.');
    return f;
  }
  const f = addFeature('move', { name: moveName('Lay flat'), ...(id ? { bodies: [id] } : {}), flat: { pick: [] } }, { focus: false });
  startPick(f.id, 'flat', 'face');
  app.toast('Click the flat face that should rest on the bed.');
  return f;
}
