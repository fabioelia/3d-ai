// End-to-end check that redrawing the panels never costs the person their place: a changed select
// or ticked box keeps its focus (so the next key does not leak into a shortcut), lists keep their
// scroll, typed text and the caret survive rebuilds, Tab goes where it should, and picking a row in
// a long list leaves that row where it was.
// Usage: node scripts/e2e-ui-quirks.cjs [url] [screenshot dir]
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
  const errors = [];
  const page = async (viewport, extra = {}) => {
    const p = await b.newPage({ viewport, ...extra });
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url);
    await p.waitForFunction(() => window.caliper?.store.results, null, { timeout: 60000 });
    return p;
  };
  // A short window, where the panels scroll.
  let p = await page({ width: 1280, height: 700 });
  const settle = async () => {
    await p.waitForTimeout(120);
    await p.evaluate(() => window.caliper.rebuildNow());
    await p.waitForTimeout(300);
  };
  const active = () => p.evaluate(() => { const a = document.activeElement; return a && a !== document.body ? a.id || a.className || a.tagName : 'body'; });
  const scrollOf = (sel) => p.evaluate((s) => Math.round(document.querySelector(s)?.scrollTop ?? -1), sel);
  const scrollTo = (sel, top) => p.evaluate(([s, t]) => { const el = document.querySelector(s); el.scrollTop = t; return Math.round(el.scrollTop); }, [sel, top]);
  // Focus without Playwright scrolling the control into view first, so scroll changes are the app's.
  const focus = (sel) => p.evaluate((s) => document.querySelector(s).focus({ preventScroll: true }), sel);
  const feats = () => p.evaluate(() => window.caliper.store.doc.features.length);
  const feature = (id) => p.evaluate((id) => JSON.parse(JSON.stringify(window.caliper.store.doc.features.find((f) => f.id === id) || null)), id);
  const pick = (id) => p.evaluate((id) => document.querySelector(`#timeline .tl-item[data-id="${id}"]`).click(), id);
  const example = async () => {
    await p.click('#file-btn');
    await p.click('[data-file="example"]');
    await settle();
  };
  await example();

  // --- a select keeps its focus after a change that redraws the inspector; the next key is not a shortcut
  await pick('cylinder1');
  await settle();
  const deep = await scrollTo('#inspector', 10000);
  await focus('#f-op');
  await p.keyboard.press('ArrowUp');
  await settle();
  ok((await feature('cylinder1')).op === 'new', 'ArrowUp on Operation changes it');
  ok((await active()) === 'f-op', `the Operation select keeps the focus after the redraw (${await active()})`);
  ok((await scrollOf('#inspector')) === deep, `the inspector stays scrolled where it was (${deep})`);
  let n = await feats();
  await p.keyboard.press('e');
  await p.waitForTimeout(150);
  ok((await feats()) === n && (await p.evaluate(() => window.caliper.store.sel.feature)) === 'cylinder1', 'pressing E next does not start an Extrude');

  // --- a select that adds or removes fields (Extent) keeps focus; F does not start a Fillet
  await pick('extrude1');
  await settle();
  await focus('#f-extent');
  await p.keyboard.press('ArrowDown');
  await settle();
  ok((await feature('extrude1')).extent === 'through', 'Extent changes to Through all');
  ok((await active()) === 'f-extent', `the Extent select keeps the focus though fields went away (${await active()})`);
  n = await feats();
  await p.keyboard.press('f');
  await p.waitForTimeout(150);
  ok((await feats()) === n && (await p.evaluate(() => window.caliper.store.mode.kind)) === 'model', 'pressing F next does not start a Fillet');
  await p.keyboard.press('ArrowUp');
  await settle();

  // --- typing a parameter name letter by letter: the text and caret survive the rebuilds
  await pick('cylinder1');
  await settle();
  await focus('#f-at-z');
  await p.keyboard.press('Control+a');
  await p.keyboard.type('thickness+1', { delay: 40 });
  await settle();
  ok((await p.inputValue('#f-at-z')) === 'thickness+1' && (await active()) === 'f-at-z', 'typing "thickness+1" keeps every letter and the focus');
  ok((await p.evaluate(() => document.activeElement.selectionStart)) === 11, 'the caret stays at the end');
  ok(JSON.stringify((await feature('cylinder1')).at) === '[0,0,"thickness+1"]', 'and the value is applied');

  // --- emptying a field and pressing Tab lands on the next control (the redraw used to drop it)
  await focus('#f-h');
  await p.keyboard.press('Control+a');
  await p.keyboard.press('Backspace');
  await p.keyboard.press('Tab');
  await settle();
  ok((await feature('cylinder1')).h === undefined, 'an emptied field goes back to its default');
  ok((await active()) === 'f-axis', `Tab from the emptied field lands on the next one (${await active()})`);
  await example();

  // --- an agent adding a feature while the person types does not take the field away
  await pick('cylinder1');
  await settle();
  await focus('#f-h');
  await p.keyboard.press('End');
  await p.keyboard.type('+1', { delay: 40 });
  await p.evaluate(() => window.caliper.act.addFeature('sphere', {}, { by: 'agent', focus: false }));
  await settle();
  await p.keyboard.type('0', { delay: 40 });
  await settle();
  const typed = await p.evaluate(() => document.querySelector('#f-h')?.value ?? null);
  ok((await active()) === 'f-h' && typed === 'post_h+10', `typing carries on while an agent adds a feature (${typed})`);
  ok((await feature('cylinder1')).h === 'post_h+10', 'and lands in the model');

  // --- an agent's activity lines follow the bottom of the chat only while the person is there
  await p.evaluate(() => { for (let i = 0; i < 30; i++) window.caliper.act.addFeature('box', { at: [i * 30, 0, 0] }, { by: 'agent', focus: false }); });
  await settle();
  const logScroll = () => p.evaluate(() => { const l = document.querySelector('#chat-log'); return [Math.round(l.scrollTop), l.scrollHeight - l.clientHeight]; });
  let [, maxLog] = await logScroll();
  ok(maxLog > 50, `the chat log fills up with the agent's activity (${maxLog})`);
  await scrollTo('#chat-log', 20);
  await p.evaluate(() => window.caliper.act.addFeature('box', {}, { by: 'agent', focus: false }));
  await settle();
  ok((await logScroll())[0] === 20, 'reading back up the chat is not yanked to the bottom by a new line');
  await scrollTo('#chat-log', 100000);
  await p.evaluate(() => window.caliper.act.addFeature('box', {}, { by: 'agent', focus: false }));
  await settle();
  const [top2, max2] = await logScroll();
  ok(Math.abs(top2 - max2) <= 1, 'at the bottom, new lines stay in view');
  await example();

  // --- the parameter list keeps its scroll when something else redraws it
  for (let i = 0; i < 6; i++) await p.click('#params .ghost-btn');
  await settle();
  ok(await p.isVisible('#param-filter'), 'many parameters bring the filter');
  const plist = await scrollTo('.p-list', 60);
  await pick('cylinder1');
  await settle();
  await focus('#f-op');
  await p.keyboard.press('ArrowUp');
  await settle();
  ok(plist > 0 && (await scrollOf('.p-list')) === plist, `the parameter list stays scrolled (${plist}) after an inspector change`);
  await focus('#param-value-5');
  await p.keyboard.press('End');
  await p.keyboard.type('1', { delay: 40 });
  await settle();
  ok((await active()) === 'param-value-5' && (await scrollOf('.p-list')) === plist, 'typing a parameter value keeps the focus and the scroll');
  // filtered: rename, then Tab to the value
  await p.fill('#param-filter', 'p');
  await settle();
  const nameId = await p.evaluate(() => document.querySelector('.p-row:not([hidden]) .p-name').id);
  await focus(`#${nameId}`);
  await p.keyboard.press('Control+a');
  await p.keyboard.type('pp_new', { delay: 30 });
  await p.keyboard.press('Tab');
  await settle();
  ok((await active()) === nameId.replace('name', 'value') && (await p.inputValue('#param-filter')) === 'p', `renaming then Tab goes to its value, the filter stays (${await active()})`);
  await example();

  // --- the timeline keeps the keyboard focus on the row picked with Enter
  await focus('#timeline .tl-item[data-id="fillet1"]');
  await p.keyboard.press('Enter');
  await settle();
  ok((await p.evaluate(() => document.activeElement.dataset.id)) === 'fillet1' && (await p.evaluate(() => window.caliper.store.sel.feature)) === 'fillet1', 'Enter on a timeline row selects it and keeps the focus there');
  // Suppress from the inspector: the button keeps the focus
  await focus('#inspector .insp-actions.foot .btn.small:not(.danger)');
  await p.keyboard.press('Enter');
  await settle();
  ok((await feature('fillet1')).suppressed && (await p.evaluate(() => document.activeElement.closest('#inspector .insp-actions.foot') !== null)), 'Suppress keeps the focus on the button');
  await p.keyboard.press('Enter');
  await settle();
  ok(!(await feature('fillet1')).suppressed, 'and Enter again turns it back on');

  // --- print check: the printer size keeps the focus; M does not start measuring
  await p.keyboard.press('Escape');
  await p.click('[data-cmd="check"]');
  await settle();
  await focus('#print-volume');
  await p.keyboard.press('ArrowDown');
  await settle();
  ok((await active()) === 'print-volume', `the printer size select keeps the focus (${await active()})`);
  await p.keyboard.press('m');
  await p.waitForTimeout(150);
  ok(!(await p.evaluate(() => window.caliper.act.tools.measuring)), 'pressing M next does not start measuring');
  await p.keyboard.press('ArrowUp');
  await p.evaluate(() => document.activeElement.blur());
  await p.keyboard.press('Escape');

  // --- Move: the body checklist keeps focus and scroll when a box is ticked
  for (let i = 0; i < 8; i++) {
    await p.click('[data-cmd="box"]');
    await settle();
  }
  await p.evaluate(() => window.caliper.act.command('move'));
  await settle();
  const checks = await scrollTo('.body-checks', 1000);
  const boxId = await p.evaluate(() => [...document.querySelectorAll('.body-checks input')].at(-1).id);
  await focus(`#${boxId}`);
  await p.keyboard.press('Space');
  await settle();
  const moved = await p.evaluate(() => window.caliper.store.doc.features.at(-1).bodies);
  ok(Array.isArray(moved) && moved.length === 8 && !moved.includes(boxId.slice(9)) && !(await p.isChecked(`#${boxId}`)), `unticking one body of "all" moves all the others (${moved})`);
  ok((await active()) === boxId, `the checkbox keeps the focus (${await active()})`);
  ok(checks > 0 && (await scrollOf('.body-checks')) === checks, `the checklist stays scrolled (${checks})`);
  await focus('#f-drop');
  await p.keyboard.press('Space');
  await settle();
  ok((await active()) === 'f-drop' && (await p.evaluate(() => window.caliper.store.doc.features.at(-1).drop)), 'ticking Rest on the bed keeps the focus');
  await p.screenshot({ path: `${dir}/ui-quirks-move.png` });

  // --- board: a long inspector
  await p.click('#file-btn');
  await p.click('[data-file="new"]');
  await settle();
  await p.setInputFiles('#import-file', path.join(__dirname, 'fixtures', 'demo.sch'));
  await p.waitForFunction(() => window.caliper.store.mode.kind === 'board', null, { timeout: 10000 });
  await settle();
  const rowTop = (ref) => p.evaluate((r) => Math.round(document.querySelector(`#inspector [data-key="part-${r}"]`).getBoundingClientRect().top), ref);
  const deepB = await scrollTo('#inspector', 100000);
  ok(deepB > 300, `the board inspector scrolls (${deepB})`);
  const ref = await p.evaluate(() => document.querySelectorAll('#inspector .board-parts tbody tr')[1].dataset.key.slice(5));
  const top0 = await rowTop(ref);
  const box = await p.evaluate((r) => { const q = document.querySelector(`#inspector [data-key="part-${r}"]`).getBoundingClientRect(); return [q.left + 20, q.top + q.height / 2]; }, ref);
  await p.mouse.click(box[0], box[1]);
  await settle();
  ok((await p.evaluate(() => window.caliper.store.sel.shape)) === ref, `clicking a row in the parts table selects ${ref}`);
  const top1 = await rowTop(ref);
  ok(Math.abs(top1 - top0) <= 2 && (await scrollOf('#inspector')) > 300, `the row stays under the pointer instead of the list jumping to the top (${top0} -> ${top1})`);
  ok((await p.evaluate(() => document.activeElement.dataset.key)) === `part-${ref}`, 'and keeps the focus');
  await p.screenshot({ path: `${dir}/ui-quirks-board-row.png` });
  // part fields while scrolled
  const sideBefore = (await p.evaluate((r) => window.caliper.store.doc.features.find((f) => f.type === 'board').parts.find((q) => q.ref === r), ref));
  await p.evaluate(() => document.querySelector('#part-side').scrollIntoView({ block: 'center' }));
  const s0 = await scrollOf('#inspector');
  await focus('#part-side');
  await p.keyboard.press(sideBefore.side === 'bottom' ? 'ArrowUp' : 'ArrowDown');
  await settle();
  let partNow = await p.evaluate((r) => window.caliper.store.doc.features.find((f) => f.type === 'board').parts.find((q) => q.ref === r), ref);
  ok((partNow.side || 'top') !== (sideBefore.side || 'top'), 'Side flips the part');
  ok((await active()) === 'part-side' && Math.abs((await scrollOf('#inspector')) - s0) <= 2, `the Side select keeps the focus and the scroll (${s0} -> ${await scrollOf('#inspector')})`);
  await p.keyboard.press('r');
  await p.waitForTimeout(150);
  partNow = await p.evaluate((r) => window.caliper.store.doc.features.find((f) => f.type === 'board').parts.find((q) => q.ref === r), ref);
  ok((partNow.rot || 0) === (sideBefore.rot || 0), 'pressing R next does not turn the part');
  await p.evaluate(() => document.querySelector('#part-h').scrollIntoView({ block: 'center' }));
  const s1 = await scrollOf('#inspector');
  await focus('#part-h');
  await p.keyboard.press('Control+a');
  await p.keyboard.type('4.5', { delay: 40 });
  await settle();
  ok((await active()) === 'part-h' && (await p.inputValue('#part-h')) === '4.5' && Math.abs((await scrollOf('#inspector')) - s1) <= 2, 'typing a part height keeps focus, text and scroll');
  // the board's own fields
  await p.evaluate(() => window.caliper.act.app.board.api.select(null));
  await settle();
  await p.evaluate(() => document.querySelector('#pour-bottom').scrollIntoView({ block: 'center' }));
  const s2 = await scrollOf('#inspector');
  await focus('#pour-bottom');
  await p.keyboard.press('ArrowDown');
  await settle();
  ok((await p.evaluate(() => window.caliper.store.doc.features.find((f) => f.type === 'board').pours?.length)) === 1, 'the bottom pour is set');
  ok((await active()) === 'pour-bottom' && Math.abs((await scrollOf('#inspector')) - s2) <= 2, `the pour select keeps the focus and the scroll (${s2} -> ${await scrollOf('#inspector')})`);
  await p.evaluate(() => document.querySelector('#board-outline').scrollIntoView({ block: 'center' }));
  await focus('#board-outline');
  await p.keyboard.press('ArrowDown');
  await settle();
  ok((await active()) === 'board-outline' && (await p.isVisible('#board-d')), 'switching the outline to a circle keeps the focus on the select');
  const open = await p.evaluate(() => [...document.querySelectorAll('#inspector details')].map((x) => x.open).join());
  await p.evaluate(() => document.querySelector('#inspector details[data-sec="routing"] > summary').click());
  await focus('#rule-clearance');
  await p.keyboard.press('Control+a');
  await p.keyboard.type('0.25', { delay: 40 });
  await settle();
  ok((await p.evaluate(() => document.querySelector('#inspector details[data-sec="routing"]').open)) === false && open.split(',').every((x) => x === 'true'), 'a folded section stays folded across redraws');
  await p.close();

  // --- a phone: the select keeps focus too
  p = await page({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await p.tap('#file-btn');
  await p.tap('[data-file="example"]');
  await settle();
  await p.tap('#timeline .tl-item[data-id="cylinder1"]');
  await settle();
  await focus('#f-op');
  await p.selectOption('#f-op', 'cut');
  await settle();
  ok((await p.evaluate(() => window.caliper.store.doc.features.find((f) => f.id === 'cylinder1').op)) === 'cut' && (await active()) === 'f-op', 'on a phone the Operation select keeps the focus');
  await p.close();

  ok(!errors.length, `no page errors (${errors.join(' | ')})`);
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  await b.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('e2e crashed:', e.message);
  process.exit(1);
});
