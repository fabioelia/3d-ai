// End-to-end check of the main modelling flows in headless Chromium.
// Usage: node scripts/e2e.cjs [url] [screenshot dir]
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://127.0.0.1:4173/';
const dir = process.argv[3] || '.';
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failed++; };

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const errors = [];
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
  p.on('pageerror', (e) => errors.push(`${e.message} ${(e.stack || '').split('\n').slice(1, 3).join(' | ')}`.slice(0, 500)));
  await p.goto(url);
  await p.waitForFunction(() => window.caliper?.store.results, null, { timeout: 60000 });
  const settle = async () => { await p.waitForTimeout(120); await p.evaluate(() => window.caliper.rebuildNow()); await p.waitForTimeout(450); };
  const state = () => p.evaluate(() => { const s = window.caliper.store; const r = s.results; return { mode: s.mode, sel: s.sel, n: s.doc.features.length, types: s.doc.features.map((f) => f.type), vol: r?.volume, bodies: r?.bodies.length, min: r?.min, max: r?.max, errs: Object.entries(r?.features || {}).filter(([, v]) => v.error).map(([k, v]) => `${k}: ${v.error}`) }; });
  const screen = (w) => p.evaluate((w) => { const v = window.caliper.viewport; const r = v.canvas.getBoundingClientRect(); const s = v.worldToScreen(w); return [r.left + s[0], r.top + s[1]]; }, w);
  const clickWorld = async (w, opts) => { const [x, y] = await screen(w); await p.mouse.move(x, y); await p.mouse.click(x, y, opts); await p.waitForTimeout(80); };
  const dragWorld = async (a, c) => { const [x0, y0] = await screen(a); const [x1, y1] = await screen(c); await p.mouse.move(x0, y0); await p.mouse.down(); await p.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 }); await p.mouse.move(x1, y1, { steps: 4 }); await p.mouse.up(); await p.waitForTimeout(80); };
  const near = (a, c, t = 0.02) => Math.abs(a - c) <= t * Math.max(1, Math.abs(c));

  let s = await state();
  ok(s.bodies === 1 && !s.errs.length, `example part builds clean (${s.errs.join('; ')})`);

  // --- new part: sketch a rectangle on XY and extrude it
  await p.click('#file-btn'); await p.click('[data-file="new"]'); await settle();
  s = await state(); ok(s.n === 0 && s.bodies === 0, 'new empty part');
  await p.click('[data-cmd="sketch"]');
  ok((await state()).mode.kind === 'plane', 'sketch asks for a plane');
  await p.click('#modebar >> text=Top (XY)'); await settle(); await p.waitForTimeout(400);
  s = await state(); ok(s.mode.kind === 'sketch' && s.mode.tool === 'rect', 'sketch mode opens with the rectangle tool');
  await dragWorld([-30, -20, 0], [30, 20, 0]); await settle();
  let sk = await p.evaluate(() => window.caliper.store.doc.features[0].shapes[0]);
  ok(sk && sk.kind === 'rect' && near(sk.w, 60) && near(sk.h, 40) && near(sk.x, 0), `rectangle drawn 60 x 40 (${JSON.stringify(sk)})`);
  await p.click('#modebar >> text=Circle');
  await dragWorld([10, 5, 0], [15, 5, 0]); await settle();
  sk = await p.evaluate(() => window.caliper.store.doc.features[0].shapes[1]);
  ok(sk && sk.kind === 'circle' && sk.d > 6 && sk.hole === true, `circle inside becomes a cut-out (${JSON.stringify(sk)})`);
  await p.screenshot({ path: `${dir}/e2e-sketch.png` });
  await p.fill('#shape-d', '8'); await settle();
  await p.click('#finish-sketch'); await settle();
  s = await state(); ok(s.types.join() === 'sketch,extrude' && s.bodies === 1 && near(s.vol, (2400 - Math.PI * 16) * 10), `finish adds an extrude (vol ${s.vol})`);
  await p.fill('#f-distance', '6'); await settle();
  s = await state(); ok(near(s.max[2], 6), 'typing a distance rebuilds live');

  // --- select top face -> sketch here -> pocket
  await clickWorld([-20, -10, 6]); s = await state();
  ok(s.sel.picks.length === 1 && s.sel.picks[0].kind === 'face', 'clicking the model selects a face');
  await p.click('#modebar >> text=Sketch here'); await settle(); await p.waitForTimeout(400);
  s = await state(); ok(s.mode.kind === 'sketch', 'sketch on face');
  await p.click('#modebar >> text=Slot');
  await dragWorld([-22, -8, 6], [-8, -8, 6]); await settle();
  await p.click('#finish-sketch'); await settle();
  await p.selectOption('#f-op', 'cut'); await p.fill('#f-distance', '-3'); await settle();
  s = await state(); const slotA = 14 * 6 + Math.PI * 9;
  ok(!s.errs.length && near(s.vol, (2400 - Math.PI * 16) * 6 - slotA * 3), `pocket cut into the face (vol ${s.vol}, errs ${s.errs})`);

  // --- fillet: pick mode with rollback
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await p.click('[data-cmd="fillet"]'); await settle();
  s = await state(); ok(s.mode.kind === 'pick' && s.mode.pick === 'edge', 'fillet with nothing selected enters pick mode');
  await clickWorld([30, -20, 3]); await clickWorld([-30, -20, 3]); await settle();
  await p.click('#pick-done'); await settle();
  s = await state(); const f = await p.evaluate(() => window.caliper.store.doc.features.at(-1));
  ok(f.type === 'fillet' && f.edges.pick.length === 2 && !s.errs.length, `two edges picked and filleted (${f.edges.pick.length}, ${s.errs})`);
  await p.fill('#f-radius', '5'); await settle();
  s = await state(); ok(!s.errs.length, 'radius edit rebuilds');

  // --- select then tool: chamfer on a preselected edge; shell on a preselected face
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await clickWorld([0, 20, 6]); s = await state();
  ok(s.sel.picks[0]?.kind === 'edge', 'clicking an edge selects it');
  await p.click('#modebar >> text=Chamfer'); await settle();
  s = await state(); ok(s.types.at(-1) === 'chamfer' && !s.errs.length, `chamfer from selection (${s.errs})`);
  const volBefore = s.vol;
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await p.evaluate(() => window.caliper.viewport.view('bottom')); await p.waitForTimeout(500);
  await clickWorld([5, -12, 0]);
  await p.click('#modebar >> text=Shell'); await settle();
  await p.fill('#f-thickness', '1.2'); await settle();
  s = await state(); ok(s.types.at(-1) === 'shell' && !s.errs.length && s.vol < volBefore * 0.8, `shell from a selected face (vol ${s.vol} < ${volBefore}; ${s.errs})`);
  await p.evaluate(() => window.caliper.viewport.view('iso')); await p.waitForTimeout(500);

  // --- primitives, pattern, parameters, undo/redo
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await p.click('[data-cmd="cylinder"]'); await settle();
  await p.fill('#f-d', '4'); await p.fill('#f-h', '12'); await p.fill('#f-at-x', '-24'); await p.fill('#f-at-y', '14'); await settle();
  await p.click('[data-cmd="pattern"]'); await settle();
  await p.fill('#f-count', '4'); await p.fill('#f-spacing', '16'); await settle();
  s = await state(); ok(s.types.slice(-2).join() === 'cylinder,pattern' && !s.errs.length, `cylinder + pattern (${s.errs})`);
  await p.click('#params .ghost-btn'); await p.fill('#param-name-0', 'peg'); await p.keyboard.press('Tab'); await p.fill('#param-value-0', '18'); await settle();
  await p.click('#timeline [data-id="cylinder1"]'); await p.fill('#f-h', 'peg + 2'); await settle();
  s = await state(); ok(near(s.max[2], 20) && !s.errs.length, `parameter expression drives height (max z ${s.max[2]})`);
  const before = s.n;
  await p.keyboard.press('Escape');
  await p.click('#undo'); await settle(); await p.click('#undo'); await settle();
  await p.click('#redo'); await settle(); await p.click('#redo'); await settle();
  s = await state(); ok(s.n === before && near(s.max[2], 20), 'undo and redo round-trip');
  await p.screenshot({ path: `${dir}/e2e-model.png` });

  // --- export
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), (async () => { await p.click('#export-btn'); await p.click('[data-file="stl"]'); })()]);
  const path = await dl.path(); const size = require('fs').statSync(path).size;
  const buf = require('fs').readFileSync(path); const tris = buf.readUInt32LE(80);
  ok(dl.suggestedFilename().endsWith('.stl') && size === 84 + tris * 50 && tris > 100, `STL downloads (${dl.suggestedFilename()}, ${tris} triangles)`);
  // --- import the STL we just exported, through the Import button
  const before2 = (await state()).bodies;
  await p.setInputFiles('#import-file', { name: 'roundtrip.stl', mimeType: 'model/stl', buffer: buf });
  await p.waitForFunction((n) => window.caliper.store.results?.bodies.length === n + 1, before2, { timeout: 60000 }).catch(() => {});
  s = await state();
  const imp = await p.evaluate(() => { const f = window.caliper.store.doc.features.at(-1); return { type: f.type, name: f.name, note: window.caliper.store.results.features[f.id]?.note, err: window.caliper.store.results.features[f.id]?.error }; });
  ok(imp.type === 'import' && s.bodies === before2 + 1 && !imp.err, `STL import adds a body (${imp.note || imp.err})`);
  await p.screenshot({ path: `${dir}/e2e-import.png` });

  // --- a zip of two STLs (as model sites deliver them): both import, set out side by side, one undo
  const zlib = require('zlib');
  const zipOf = (files) => {
    const parts = []; const central = []; let off = 0;
    for (const [name, data] of files) {
      const body = zlib.deflateRawSync(data); const n = Buffer.from(name);
      const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
      parts.push(h, n, body);
      const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
      central.push(c, n); off += 30 + n.length + body.length;
    }
    const cd = Buffer.concat(central); const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
    return Buffer.concat([...parts, cd, e]);
  };
  const beforeZip = (await state()).bodies;
  const undoDepth = await p.evaluate(() => window.caliper.store.undoStack.length);
  await p.setInputFiles('#import-file', { name: 'thing.zip', mimeType: 'application/zip', buffer: zipOf([['files/part_a.stl', buf], ['files/part_b.stl', buf], ['images/x.png', Buffer.alloc(10)]]) });
  await p.waitForFunction((n) => window.caliper.store.results?.bodies.length === n + 2, beforeZip, { timeout: 60000 }).catch(() => {});
  await settle();
  const zipInfo = await p.evaluate(() => {
    const s = window.caliper.store; const f = s.doc.features.slice(-2);
    const b = f.map((x) => s.results.bodies.find((y) => y.id === x.id));
    return { names: f.map((x) => x.name), apart: b[0] && b[1] && (b[0].max[0] <= b[1].min[0] + 1e-6 || b[1].max[0] <= b[0].min[0] + 1e-6), onBed: b.every((y) => y && Math.abs(y.min[2]) < 1e-6), undo: s.undoStack.length };
  });
  ok(zipInfo.names.join() === 'part_a,part_b' && zipInfo.apart && zipInfo.onBed && zipInfo.undo === undoDepth + 1, `zip import: ${JSON.stringify(zipInfo)}`);
  await p.click('#undo'); await settle();
  ok((await state()).bodies === beforeZip, 'one undo removes the whole zip import');

  const [dl2] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), (async () => { await p.click('#file-btn'); await p.click('[data-file="step"]'); })()]);
  ok(dl2.suggestedFilename().endsWith('.step'), 'STEP downloads');

  // --- reload restores the autosave
  const nSaved = (await state()).n;
  await p.waitForTimeout(600); await p.reload();
  await p.waitForFunction(() => window.caliper?.store.results, null, { timeout: 60000 });
  s = await state(); ok(s.n === nSaved && s.bodies === before2 + 1, 'reload restores the saved part, imported STL included');

  ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' || ') : ''}`);
  await b.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('e2e crashed:', e.message.split('\n').slice(0, 6).join('\n')); process.exit(2); });
