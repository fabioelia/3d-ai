// End-to-end check of the board placement editor in headless Chromium.
// Usage: node scripts/e2e-board.cjs [url] [screenshot dir]
const path = require('node:path');
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://127.0.0.1:4173/';
const dir = process.argv[3] || '.';
let failed = 0;
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${m}`);
  if (!c) failed++;
};

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
  p.on('pageerror', (e) => errors.push(`${e.message} ${(e.stack || '').split('\n').slice(1, 3).join(' | ')}`.slice(0, 500)));
  await p.goto(url);
  await p.waitForFunction(() => window.caliper?.store.results, null, { timeout: 60000 });
  const settle = async () => {
    await p.waitForTimeout(120);
    await p.evaluate(() => window.caliper.rebuildNow());
    await p.waitForTimeout(300);
  };
  const board = () => p.evaluate(() => JSON.parse(JSON.stringify(window.caliper.store.doc.features.find((f) => f.type === 'board') || null)));
  const part = async (ref) => (await board()).parts.find((q) => q.ref === ref);
  const mode = () => p.evaluate(() => window.caliper.store.mode);
  // Screen point of a board coordinate, and of a part's body centre.
  const at = (xy) => p.evaluate((xy) => {
    const ed = window.caliper.act.app.board;
    const r = ed.el.getBoundingClientRect();
    const s = ed.toS(xy);
    return [r.left + s[0], r.top + s[1]];
  }, xy);
  const partAt = (ref) => p.evaluate((ref) => {
    const ed = window.caliper.act.app.board;
    const f = ed.api.board();
    const q = f.parts.find((x) => x.ref === ref);
    const b = q.body;
    const ang = ((q.rot || 0) * Math.PI) / 180;
    const cx = q.side === 'bottom' ? -b.cx : b.cx;
    const c = [q.x + cx * Math.cos(ang) - b.cy * Math.sin(ang), q.y + cx * Math.sin(ang) + b.cy * Math.cos(ang)];
    const r = ed.el.getBoundingClientRect();
    const s = ed.toS(c);
    return [r.left + s[0], r.top + s[1]];
  }, ref);
  const drag = async (a, z) => {
    await p.mouse.move(a[0], a[1]);
    await p.mouse.down();
    await p.mouse.move((a[0] + z[0]) / 2, (a[1] + z[1]) / 2, { steps: 4 });
    await p.mouse.move(z[0], z[1], { steps: 4 });
    await p.mouse.up();
    await p.waitForTimeout(100);
  };

  await p.click('#file-btn');
  await p.click('[data-file="new"]');
  await settle();

  // --- importing a schematic opens the placement editor with every part arranged
  await p.setInputFiles('#import-file', path.join(__dirname, 'fixtures', 'demo.sch'));
  await p.waitForFunction(() => window.caliper.store.mode.kind === 'board', null, { timeout: 10000 });
  await settle();
  let f = await board();
  ok(f && f.parts.length === 4 && f.nets.length === 3 && f.parts.every((q) => !q.off), `schematic imports as a board with its parts placed (${f && f.parts.map((q) => q.ref)})`);
  ok(await p.isVisible('.board-editor') && (await p.textContent('.be-chip')).includes('4/4'), 'the placement editor shows the board');
  ok((await p.$$('.board-editor [data-ref]')).length === 4, 'every part is drawn');
  await p.screenshot({ path: `${dir}/e2e-board-editor.png` });

  // --- drag a part: it snaps to the grid and is one undo step
  const before = await part('R1');
  const from = await partAt('R1');
  const to = await at([0, 0]).then(async (o) => {
    const one = await at([5, 0]);
    return [from[0] + (one[0] - o[0]), from[1]];
  });
  await drag(from, to);
  let after = await part('R1');
  ok(Math.abs(after.x - before.x - 5) < 0.6 && Math.abs(after.y - before.y) < 0.6 && Math.abs((after.x * 2) % 1) < 1e-6, `dragging moves the part 5 mm on the 0.5 mm grid (${before.x} -> ${after.x})`);
  ok((await p.evaluate(() => window.caliper.store.sel.shape)) === 'R1', 'the dragged part is selected');
  ok((await p.inputValue('#part-x')) === String(after.x), 'the inspector shows the part');

  // --- R turns, F flips, both keep the body where it is; undo steps back
  const c0 = await partAt('R1');
  await p.keyboard.press('r');
  after = await part('R1');
  const c1 = await partAt('R1');
  ok(after.rot === (before.rot + 90) % 360 && Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) < 1.5, `R turns the part about its centre (${after.rot}°)`);
  await p.keyboard.press('f');
  after = await part('R1');
  ok(after.side === 'bottom', 'F flips it to the bottom');
  await p.keyboard.press('Control+z');
  ok((await part('R1')).side !== 'bottom', 'undo flips it back');

  // --- a clash shows in red and in the problem list
  const u1 = await partAt('U1');
  const r1 = await partAt('R1');
  await drag(r1, u1);
  await settle();
  let issues = await p.$$eval('.board-issues li', (els) => els.map((e) => e.textContent));
  ok(issues.some((t) => /R1 and U1 overlap|U1 and R1 overlap/.test(t)), `an overlap is listed (${issues[0]})`);
  ok(/problem/.test(await p.textContent('.be-chip')), 'and counted on the board');
  await p.keyboard.press('Control+z');
  await settle();

  // --- dragging a part clear of the board takes it off; arranging puts it back
  // Zoom out with the wheel to get room beside the board.
  const mid = await at([0, 0]);
  await p.mouse.move(mid[0], mid[1]);
  for (let i = 0; i < 4; i++) await p.mouse.wheel(0, 200);
  await p.waitForTimeout(100);
  f = await board();
  const corner = await at([-f.outline.w / 2 - 12, 0]);
  await drag(await partAt('Q1'), corner);
  ok((await part('Q1')).off === true, 'a part dragged off the board is marked not placed');
  await p.selectOption('#modebar select[aria-label="Arrange parts automatically"]', 'rest');
  await settle();
  ok(!(await part('Q1')).off, 'Arrange → Place the rest puts it back on the board');

  // --- holes: H, click on the board
  await p.keyboard.press('Escape');
  await p.keyboard.press('h');
  ok((await mode()).tool === 'hole', 'H picks the hole tool');
  f = await board();
  const spot = await at([f.outline.w / 2 - 4, -f.outline.h / 2 + 4]);
  await p.mouse.click(spot[0], spot[1]);
  f = await board();
  ok(f.holes.length === 1 && f.holes[0].d === 3.2, `clicking adds a mounting hole (${JSON.stringify(f.holes)})`);
  await p.keyboard.press('Escape');

  // --- outline from the inspector
  await p.keyboard.press('Escape');
  await p.evaluate(() => window.caliper.store.mode.kind === 'board' && window.caliper.act.leaveMode());
  await p.click('.tl-item');
  await p.selectOption('#board-outline', 'circle');
  await settle();
  f = await board();
  ok(f.outline.kind === 'circle' && f.outline.d > 0, `the outline turns into a circle (${JSON.stringify(f.outline)})`);
  await p.fill('#board-d', '70');
  await settle();
  ok((await board()).outline.d === 70, 'and takes a typed diameter');

  // --- 3D: one body for the board, one per placed part, in colour
  const res = await p.evaluate(() => window.caliper.store.results.bodies.map((x) => ({ id: x.id, kind: x.kind, color: x.color })));
  ok(res.length === 5 && res[0].kind === 'board' && res.slice(1).every((x) => x.kind === 'part' && x.color), `3D shows the board and its parts (${res.map((x) => x.id)})`);
  await p.click('[data-view="iso"]');
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${dir}/e2e-board-3d.png` });

  // --- an enclosure around it: the fit check finds the lid
  await p.evaluate(() => {
    window.caliper.act.addFeature('box', { w: 80, d: 80, h: 2, at: [0, 0, 4], op: 'new' });
  });
  await settle();
  await p.click('.tl-item >> nth=0');
  await p.click('text=Check fit in enclosure');
  await p.waitForFunction(() => !/Checking/.test(document.querySelector('.board-issues:last-of-type')?.textContent || 'Checking'), null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(500);
  issues = await p.$$eval('.board-issues', (els) => els.map((e) => e.textContent).join(' | '));
  ok(/runs into/.test(issues), `the fit check finds parts running into the lid (${issues.slice(-160)})`);

  // --- STL export leaves the electronics out
  const tri = await p.evaluate(async () => (await window.caliper.act.app.kernel.exportSTL(null, 'draft')).triangles);
  ok(tri === 12, `STL export holds only the printable body (${tri} triangles)`);

  // --- agents see the board view
  const shot = await p.evaluate(async () => (await window.caliper.act.app.board.snapshot({ width: 400, height: 300 })).length);
  ok(shot > 5000, 'the placement view renders to an image for agents');

  ok(!errors.length, `no page errors${errors.length ? `: ${errors.join(' || ')}` : ''}`);
  await b.close();
  console.log(failed ? `\n${failed} board e2e check(s) failed` : '\nAll board e2e checks passed');
  process.exit(failed ? 1 : 0);
})();
