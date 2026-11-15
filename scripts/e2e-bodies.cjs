// End-to-end check of bodies as things you can pick, name, hide, move and export; measuring; the
// print check; and the fixes from the evaluator round (typing parameter names, Tab, Revolve after a
// sketch, empty-space clicks).
// Usage: node scripts/e2e-bodies.cjs [url] [screenshot dir]
const { chromium } = require('playwright');
const fs = require('fs');
const url = process.argv[2] || 'http://127.0.0.1:4173/';
const dir = process.argv[3] || '.';
let failed = 0;
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${m}`);
  if (!c) failed++;
};

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => window.caliper?.store.results, null, { timeout: 60000 });
  const settle = async () => {
    await p.waitForTimeout(120);
    await p.evaluate(() => window.caliper.rebuildNow());
    await p.waitForTimeout(350);
  };
  const st = () => p.evaluate(() => { const s = window.caliper.store; return { mode: s.mode.kind, sel: s.sel, feats: s.doc.features.map((f) => ({ id: f.id, type: f.type, op: f.op, bodies: f.bodies, drop: f.drop, flat: f.flat, sketch: f.sketch })), bodies: s.results?.bodies.map((b) => ({ id: b.id, name: b.name, min: b.min, max: b.max })), hidden: s.doc.hidden || [], errs: Object.values(s.results?.features || {}).filter((v) => v.error).map((v) => v.error) }; });
  const screen = (w) => p.evaluate((w) => { const v = window.caliper.viewport; const r = v.canvas.getBoundingClientRect(); const s = v.worldToScreen(w); return [r.left + s[0], r.top + s[1]]; }, w);
  const clickWorld = async (w, opts) => { const [x, y] = await screen(w); await p.mouse.move(x, y); await p.mouse.click(x, y, opts); await p.waitForTimeout(100); };
  const near = (a, c, t = 0.02) => Math.abs(a - c) <= t * Math.max(1, Math.abs(c));
  const shot = (n) => p.screenshot({ path: `${dir}/bodies-${n}.png` });

  // --- two boxes from the toolbar are two bodies, listed in Bodies
  await p.click('#file-btn'); await p.click('[data-file="new"]'); await settle();
  await p.click('[data-cmd="box"]'); await settle();
  await p.click('[data-cmd="box"]'); await settle();
  await p.click('#timeline .tl-item >> nth=1');
  await p.fill('#f-at-x', '50'); await settle();
  let s = await st();
  ok(s.bodies.length === 2 && s.feats.every((f) => f.op === 'new'), `a box dropped in free space is its own body (${s.feats.map((f) => f.op)})`);
  ok((await p.$$('#bodies .body-row')).length === 2, 'the Bodies list shows both');
  await p.click('#viewport canvas', { position: { x: 30, y: 30 } }); await p.waitForTimeout(200);
  s = await st(); ok(!s.sel.feature && !s.sel.body, 'clicking empty space lets go of the selection');

  // --- pick a body in the list, rename it
  await p.click('#bodies .body-row >> nth=1'); await p.waitForTimeout(200);
  s = await st(); ok(s.sel.body === 'box2' && (await p.isVisible('#body-name')), 'clicking a body row selects the body and shows it');
  await p.fill('#body-name', 'Lid'); await p.press('#body-name', 'Enter'); await settle();
  s = await st(); ok(s.bodies[1].name === 'Lid' && /Lid/.test(await p.textContent('#bodies')), `renamed body: ${s.bodies[1].name}`);
  await shot('1-selected');

  // --- hide it: not drawn, not in "all shown bodies"
  await p.click('#bodies .body-row >> nth=1 >> .tl-eye'); await settle();
  s = await st();
  const vis = await p.evaluate(() => window.caliper.viewport.bodies.map((b) => b.mesh.visible));
  ok(s.hidden.includes('box2') && vis[1] === false && vis[0] === true, `the eye hides the body from view (${vis})`);
  await p.click('#export-btn');
  const opts = await p.$$eval('#export-what option', (o) => o.map((x) => x.textContent));
  ok(/1 of 2/.test(opts[0]) && opts.some((t) => t === 'Lid'), `export menu offers shown bodies or one body (${opts.join(' | ')})`);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#export-menu [data-file="3mf"]')]);
  const file = `${dir}/bodies-export.3mf`; await dl.saveAs(file);
  const buf = fs.readFileSync(file);
  ok(buf.slice(0, 2).toString() === 'PK' && buf.includes('3D/3dmodel.model') && (buf.toString('latin1').match(/<object /g) || []).length === 1, `3MF of the shown body only (${dl.suggestedFilename()}, ${buf.length} bytes)`);
  await p.click('#bodies-showall'); await settle();
  ok((await st()).hidden.length === 0, 'Show all brings it back');

  // --- move only that body; rest on the bed; lay flat
  await p.click('#bodies .body-row >> nth=1');
  await p.click('#inspector >> text=Move / rotate…'); await settle();
  s = await st(); const mv = s.feats.at(-1);
  ok(mv.type === 'move' && JSON.stringify(mv.bodies) === '["box2"]', `Move from a body targets just that body (${JSON.stringify(mv.bodies)})`);
  ok((await p.$$('#inspector .body-check input')).length === 2, 'Move lists the bodies with checkboxes');
  await p.fill('#f-by-z', '-5'); await settle();
  s = await st(); ok(near(s.bodies[1].min[2], -5) && near(s.bodies[0].min[2], 0), 'only the Lid moved down');
  await p.click('#bodies .body-row >> nth=1');
  ok(/below the bed/.test(await p.textContent('#inspector')), 'the body inspector warns it is below the bed');
  await p.click('#inspector >> text=Rest on the bed'); await settle();
  s = await st(); ok(near(s.bodies[1].min[2], 0) && s.feats.at(-1).drop, 'Rest on the bed puts it back on Z = 0');
  // lay the first box on its side face
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await clickWorld([-10, -15, 8]); // front face of box1 (40 x 30 x 20 at origin)
  s = await st(); ok(s.sel.picks.length === 1 && s.sel.picks[0].kind === 'face', 'picked the side face');
  await p.click('#modebar >> text=Lay flat'); await settle();
  s = await st(); const b1 = s.bodies[0];
  ok(near(b1.max[2] - b1.min[2], 30) && near(b1.min[2], 0) && !s.errs.length, `Lay flat turned it onto that face (${(b1.max[2] - b1.min[2]).toFixed(1)} tall)`);
  await shot('2-moved');

  // --- measure: M, two faces
  await p.keyboard.press('Escape');
  await p.keyboard.press('m'); await p.waitForTimeout(150);
  ok(await p.isVisible('#modebar >> text=Click two faces or edges.'), 'M starts measuring');
  s = await st();
  const lid = s.bodies[1];
  await clickWorld([50, 0, lid.max[2]]); // lid top
  await clickWorld([45, -15, lid.max[2] / 2]); // lid front face
  await p.waitForTimeout(600);
  const m1 = await p.textContent('.mb-measure');
  ok(/angle 90°|90/.test(m1), `measuring a top and a side face gives the angle (${m1})`);
  await p.keyboard.press('Escape'); await p.waitForTimeout(100);
  ok(!(await p.evaluate(() => window.caliper.act.tools.measuring)), 'Esc stops measuring');

  // --- print check
  await p.click('[data-cmd="check"]'); await p.waitForTimeout(300);
  const pc = await p.textContent('#inspector');
  ok(/Print check/.test(pc) && /separate bodies/.test(pc), `the print check runs without an agent (${pc.slice(0, 120)})`);
  await p.selectOption('#print-volume', '180x180x180'); await p.waitForTimeout(200);
  ok(/Print check/.test(await p.textContent('#inspector')), 'printer size can be chosen');
  await shot('3-print');

  // --- typing a parameter name in a sketch field does not leave the sketch
  await p.click('#file-btn'); await p.click('[data-file="new"]'); await settle();
  await p.evaluate(() => { const c = window.caliper; c.store.doc.params.push({ name: 'width', value: '30' }); });
  await p.click('#params .ghost-btn'); await settle();
  await p.fill('#param-name-0', 'width'); await p.press('#param-name-0', 'Tab'); await p.waitForTimeout(250);
  ok(await p.evaluate(() => document.activeElement?.id === 'param-value-0'), 'Tab from a parameter name lands in its value');
  await p.keyboard.type('30'); await settle();
  ok(await p.evaluate(() => window.caliper.store.doc.params[0].value === '30'), 'the value typed after Tab is kept');
  await p.click('[data-cmd="sketch"]'); await p.click('#modebar >> text=Top (XY)'); await settle(); await p.waitForTimeout(500);
  const a = await screen([-10, -10, 0]); const c = await screen([10, 10, 0]);
  await p.mouse.move(a[0], a[1]); await p.mouse.down(); await p.mouse.move(c[0], c[1], { steps: 6 }); await p.mouse.up(); await settle();
  await p.click('#shape-w'); await p.fill('#shape-w', ''); await p.keyboard.type('width', { delay: 40 }); await settle();
  s = await st();
  ok(s.mode === 'sketch' && s.feats.length === 1, `typing "width" letter by letter stays in the sketch (mode ${s.mode}, ${s.feats.length} features)`);
  ok(await p.evaluate(() => window.caliper.store.doc.features[0].shapes[0].w === 'width'), 'and the width ends up as the parameter');

  // --- Revolve right after finishing a sketch replaces the automatic extrude
  await p.click('[data-cmd="revolve"]'); await settle();
  s = await st();
  ok(s.feats.map((f) => f.type).join() === 'sketch,revolve', `Revolve after a sketch makes a revolve, not extrude + revolve (${s.feats.map((f) => f.type)})`);

  // --- board editor: Esc never leaves
  await p.evaluate(() => window.caliper.act.command('board')); await p.waitForTimeout(300);
  await p.mouse.click(720, 450); await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  ok((await st()).mode === 'board', 'Esc in the board editor does not close it');

  ok(!errors.length, `no page errors (${errors.join(' | ')})`);
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  await b.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('e2e crashed:', e.message);
  process.exit(1);
});
