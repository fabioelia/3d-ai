// End-to-end check of the MCP bridge, the way an agent uses it: real MCP clients (stdio and HTTP), the
// bridge, and a real browser tab running Caliper. Needs a build (npm run bundle) and Playwright.
//   node scripts/e2e-bridge.mjs [screenshots dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadKernel } from './kernel-node.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'caliper-shots-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'caliper-bridge-'));
const PORT = 7541;
const chatLog = path.join(work, 'claude-args.log');
const envLog = path.join(work, 'claude-env.log');
// As when Claude Code starts the bridge: its own session variables are in the environment.
const promptLog = path.join(work, 'claude-prompts.log');
const env = { ...process.env, FAKE_CLAUDE_PROMPTS: promptLog, CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'parent-session-token', CLAUDE_CONFIG_DIR: path.join(work, 'claude-config'), XDG_CONFIG_HOME: path.join(work, 'config'), CALIPER_NO_OPEN: '1', CALIPER_PORT: String(PORT), CALIPER_CLAUDE_BIN: path.join(ROOT, 'scripts/fake-claude.mjs'), FAKE_CLAUDE_LOG: chatLog, FAKE_CLAUDE_ENV_LOG: envLog };

let failed = 0;
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${m}`);
  if (!c) failed++;
};
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const json = (r) => {
  try {
    return JSON.parse(r.content.find((c) => c.type === 'text').text);
  } catch {
    return {};
  }
};

async function agent(name) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bridge/server.mjs')], env, cwd: work, stderr: 'pipe' });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  transport.stderr?.on('data', (d) => process.env.DEBUG && process.stderr.write(d));
  return { client, transport, call: (n, a = {}) => client.callTool({ name: n, arguments: a }, undefined, { timeout: 240000 }) };
}

// A fixture STL, made by the kernel itself.
const k = await loadKernel();
k.evaluate({ features: [{ id: 'b', type: 'box', w: 30, d: 20, h: 8 }, { id: 'c', type: 'cylinder', d: 8, h: 20, at: [0, 0, -5], op: 'cut' }] });
fs.writeFileSync(path.join(work, 'spacer.stl'), Buffer.from(k.exportSTL(null, 'standard').buffer));

const A = await agent('claude-code');
const tools = (await A.client.listTools()).tools.map((t) => t.name);
ok(['open_caliper', 'get_state', 'screenshot', 'edit_model', 'import_file', 'ask_user', 'export_file'].every((t) => tools.includes(t)), `tools listed: ${tools.join(', ')}`);
ok(/Caliper is a browser CAD tool/.test(A.client.getInstructions() || ''), 'server instructions carry the guide');

let r = await A.call('get_state');
ok(r.isError && /not open/.test(textOf(r)), `calls before a page connects explain what to do: ${textOf(r).slice(0, 120)}`);
r = await A.call('open_caliper', { wait_seconds: 1 });
ok(r.isError && /http:\/\/127\.0\.0\.1:7541\//.test(textOf(r)), 'open_caliper without a page gives the address');

// The person opens Caliper from the bridge; it connects by itself.
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/`);
r = await A.call('open_caliper', { wait_seconds: 60 });
const opened = json(r);
ok(!r.isError && opened.connected && opened.agents.includes('Claude Code'), `page connected, agent named: ${JSON.stringify(opened.agents)}`);
await page.waitForFunction(() => document.getElementById('agent-btn').dataset.state === 'live', null, { timeout: 15000 });
ok((await page.textContent('#agent-label')) === 'Claude Code', 'the page shows which agent is attached');

// See what the person sees.
await page.waitForFunction(() => window.caliper?.store.results, null, { timeout: 60000 });
r = await A.call('get_state');
let st = json(r);
ok(st.document?.features?.length === 6 && st.build?.ok && st.view?.mode === 'modelling' && st.view.camera?.view === 'iso', `get_state: ${st.document?.features?.length} features, build ok ${st.build?.ok}, view ${st.view?.camera?.view}`);
await page.evaluate(() => {
  const s = window.caliper.store;
  const b = s.results.bodies[0];
  const top = b.faces.findIndex((f) => f.n && f.n[2] > 0.99 && f.c[2] > 3);
  window.caliper.act.viewportClick({ kind: 'face', b: b.id, i: top }, {});
});
st = json(await A.call('get_state', { since: st.next_since }));
ok(st.view.selection.elements.length === 1 && st.view.selection.elements[0].kind === 'face' && st.activity.some((e) => e.by === 'user' && /selected/.test(e.did)), `the person's selection and actions are visible: ${JSON.stringify(st.view.selection.elements[0]).slice(0, 120)}`);
r = await A.call('screenshot', { view: 'all', labels: 'faces' });
const img = r.content.find((c) => c.type === 'image');
ok(img && img.mimeType === 'image/png' && img.data.length > 20000, `screenshot returns a PNG (${img ? Math.round(img.data.length / 1365) : 0} KB)`);
ok(json({ content: r.content.filter((c) => c.type === 'text') }).labels?.length > 3, 'labels come with a legend of refs');
if (img) fs.writeFileSync(path.join(shots, 'bridge-labels.png'), Buffer.from(img.data, 'base64'));

// Build and change things.
r = await A.call('set_model', {
  name: 'Clip',
  params: [{ name: 'w', value: '40' }],
  features: [{ id: 'box1', type: 'box', name: 'Block', w: 'w', d: 20, h: 10 }],
});
ok(!r.isError && json(r).ok, `set_model builds: ${textOf(r).slice(0, 100)}`);
const verticals = json(await A.call('query_geometry', { kind: 'edge', where: { parallel: 'z' } }));
ok(verticals.total === 4 && verticals.items.every((e) => /^box1:E\d+$/.test(e.ref)), `query_geometry gives refs: ${verticals.items.map((e) => e.ref).join(', ')}`);
r = await A.call('edit_model', { upsert: [{ id: 'fillet1', type: 'fillet', name: 'Corners', edges: verticals.items.slice(0, 2).map((e) => e.ref), radius: 3 }], set_params: { w: 50 } });
ok(json(r).ok && json(r).bodies[0].size_mm[0] === 50, `edit_model with refs and a parameter change: ${textOf(r).slice(0, 120)}`);
const stored = await page.evaluate(() => window.caliper.store.doc.features.find((f) => f.id === 'fillet1').edges);
ok(stored?.pick?.length === 2 && stored.pick[0].m, 'refs are stored as anchored picks');
r = await A.call('edit_model', { patch: [{ id: 'fillet1', set: { radius: 30 } }] });
ok(!json(r).ok && json(r).errors[0].feature === 'fillet1', `errors come back in the report: ${json(r).errors?.[0]?.message}`);
await A.call('ui_action', { action: 'undo' });
r = await A.call('measure', { a: 'box1' });
ok(near(json(r).a.size[0], 50), `measure a body: ${JSON.stringify(json(r).a).slice(0, 120)}`);
r = await A.call('check_printability', { build_volume: [220, 220, 250] });
ok(json(r).ok === true && json(r).bodies[0].bed_contact_mm2 > 900, `printability: ${JSON.stringify(json(r).issues)}`);

// Point at things.
r = await A.call('select', { elements: [verticals.items[2].ref] });
const sel = await page.evaluate(() => window.caliper.store.sel.picks);
ok(sel.length === 1 && sel[0].kind === 'edge', 'select highlights an edge for the person');
r = await A.call('set_view', { view: 'top' });
ok(json(r).camera?.view === 'top', 'set_view moves their camera');

// Import a file from disk, then export to disk.
r = await A.call('import_stl', { path: 'spacer.stl', at: [60, 0, 0] }); // the old name still works
st = json(r);
ok(!r.isError && st.ok && st.bodies.length === 2 && st.notes?.[0]?.note.includes('exact solid'), `import_stl from disk: ${textOf(r).slice(0, 140)}`);
r = await A.call('export_file', { format: 'stl', path: 'out/clip.stl' });
const outFile = path.join(work, 'out/clip.stl');
ok(!r.isError && fs.existsSync(outFile) && fs.statSync(outFile).size > 1000, `export_file writes to disk: ${textOf(r).split('\n')[0]}`);
r = await A.call('export_file', { format: 'project' });
const proj = path.join(work, 'caliper-exports', 'Clip.caliper.json');
ok(fs.existsSync(proj) && Object.keys(JSON.parse(fs.readFileSync(proj, 'utf8')).files || {}).length === 1, 'project export embeds the imported STL');

// Circuit boards: import an Eagle board, lay it out, check it against an enclosure, look at it.
fs.copyFileSync(new URL('./fixtures/demo.brd', import.meta.url), path.join(work, 'demo.brd'));
r = await A.call('import_file', { path: 'demo.brd' });
st = json(r);
ok(!r.isError && st.ok && st.bodies.some((b) => /circuit board/.test(b.kind)) && st.bodies.filter((b) => /board part/.test(b.kind)).length === 4, `import_file brings in an Eagle board: ${textOf(r).slice(0, 160)}`);
const boardId = st.added?.[0];
r = await A.call('place_parts', { board: boardId, parts: [{ ref: 'U1', lift: 8.5 }, { ref: 'Q1', center: [12, 30] }], holes: [{ x: 4, y: 4, d: 3.2 }, { x: 46, y: 4, d: 3.2 }, { x: 4, y: 36, d: 3.2 }] });
st = json(r);
ok(!r.isError && st.summary.placed === 4 && st.summary.holes.length === 3 && st.summary.problems.some((m) => /hole/.test(m)), `place_parts moves parts and reports problems: ${JSON.stringify(st.summary.problems)}`);
r = await A.call('place_parts', { board: boardId, arrange: 'all', sides: ['top', 'bottom'] });
st = json(r);
ok(st.arranged?.placed === 4 && st.summary.problems.length === 0, `place_parts arranges automatically: ${JSON.stringify(st.arranged)}`);
r = await A.call('check_board', { board: boardId });
st = json(r);
ok(!r.isError && st.parts.length === 4 && st.enclosure && st.longest_nets.length === 3, `check_board reports placement, enclosure and nets: ${textOf(r).slice(0, 160)}`);
r = await A.call('screenshot', { view: 'board', board: boardId, size: 'small' });
const boardImg = r.content.find((c) => c.type === 'image');
ok(boardImg && boardImg.data.length > 5000 && /airwires/.test(textOf({ content: r.content.filter((c) => c.type === 'text') })), 'screenshot shows the board placement view');
if (boardImg) fs.writeFileSync(path.join(shots, 'bridge-board.png'), Buffer.from(boardImg.data, 'base64'));
r = await A.call('export_file', { format: 'eagle_script', board: boardId, path: 'out/demo.scr' });
ok(!r.isError && /MOVE U1/.test(fs.readFileSync(path.join(work, 'out/demo.scr'), 'utf8')), 'export_file writes an Eagle placement script');
r = await A.call('export_file', { format: 'stl', path: 'out/clip2.stl' });
ok(!r.isError && fs.statSync(path.join(work, 'out/clip2.stl')).size === fs.statSync(outFile).size, 'STL export leaves the board and its parts out');
await A.call('edit_model', { remove: [boardId] });

// Ask the person; they answer in the page.
const asking = A.call('ask_user', { question: 'Which edge should be rounded?', expect: 'selection', timeout_seconds: 60 });
await page.waitForSelector('#ask:not([hidden])', { timeout: 10000 });
await page.evaluate(() => {
  const b = window.caliper.store.results.bodies[0];
  const e = b.edges.findIndex((d) => !d.seam && d.t === 'LINE');
  window.caliper.act.viewportClick({ kind: 'edge', b: b.id, i: e }, {}); // the person clicks an edge
});
await page.screenshot({ path: path.join(shots, 'bridge-ask.png') });
await page.click('#ask-done');
r = await asking;
ok(json(r).done === true && json(r).selection.elements.length === 1, `ask_user returns their answer and selection: ${textOf(r).slice(0, 120)}`);

// The person sees what the agent did.
const lines = await page.$$eval('.agent-line', (els) => els.map((e) => e.textContent));
ok(lines.some((l) => /Claude Code.*replaced the whole part/.test(l)) && lines.some((l) => /Claude Code.*looked at the model/.test(l)), `activity shows in the page (${lines.length} lines)`);

// The side-panel chat runs on Claude Code through the bridge (a stand-in claude here).
await page.waitForFunction(() => /Claude Code on this computer/.test(document.getElementById('chat-note').textContent), null, { timeout: 15000 }).catch(() => {});
ok(/Claude Code on this computer/.test(await page.textContent('#chat-note')), `the chat offers Claude Code: ${await page.textContent('#chat-note')}`);
await page.fill('#chat-input', 'a box please');
await page.click('#chat-send');
await page.waitForFunction(() => !document.querySelector('#assistant.running') && /40 mm box/.test(document.getElementById('chat-log').innerText), null, { timeout: 60000 }).catch(() => {});
let chatState = await page.evaluate(() => ({ name: window.caliper.store.doc.name, log: document.getElementById('chat-log').innerText }));
ok(chatState.name === 'Chat box' && /I made a 40 mm box/.test(chatState.log) && /Building the model|Model updated/.test(chatState.log), `chat message builds the model through Claude Code: ${chatState.log.split('\n').slice(-4).join(' | ')}`);
const runs = fs.readFileSync(chatLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a[0] === '-p');
const a0 = runs[0];
ok(a0[a0.indexOf('--tools') + 1] === '' && a0[a0.indexOf('--allowedTools') + 1] === 'mcp__caliper' && a0.includes('--strict-mcp-config') && a0[a0.indexOf('--permission-mode') + 1] === 'dontAsk', 'Claude Code runs with Caliper tools only');
const env0 = JSON.parse(fs.readFileSync(envLog, 'utf8').trim().split('\n')[0]);
ok(env0.CLAUDECODE === null && env0.CLAUDE_CODE_OAUTH_TOKEN === null && env0.CLAUDE_CONFIG_DIR, `the chat's Claude Code does not inherit the parent session's variables, but keeps the config dir: ${JSON.stringify(env0)}`);
await page.fill('#chat-input', 'make it taller');
await page.click('#chat-send');
await page.waitForFunction(() => !document.querySelector('#assistant.running') && /25 mm tall/.test(document.getElementById('chat-log').innerText), null, { timeout: 60000 }).catch(() => {});
const runs2 = fs.readFileSync(chatLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a[0] === '-p');
const sid = runs2[0].includes('--resume') ? null : runs2[1][runs2[1].indexOf('--resume') + 1];
const h = await page.evaluate(() => window.caliper.store.doc.features[0]?.h);
ok(runs2.length === 2 && sid && h === 25, `follow-up resumes the same Claude Code session (${sid}) and edits (h = ${h})`);
await page.click('text=Undo this change');
await page.waitForTimeout(800);
ok((await page.evaluate(() => window.caliper.store.doc.features[0]?.h)) === 10, 'the chat turn can be undone');
const envRuns = () => fs.readFileSync(envLog, 'utf8').trim().split('\n').length;
const before = envRuns();
await page.fill('#chat-input', 'parent-auth: make it taller');
await page.click('#chat-send');
await page.waitForFunction(() => !document.querySelector('#assistant.running'), null, { timeout: 60000 }).catch(() => {});
const lastBubble = await page.$$eval('.msg.from-claude', (els) => els.at(-1).innerText);
ok(envRuns() === before + 2 && /25 mm tall/.test(lastBubble) && !/Failed to authenticate/.test(lastBubble), `when a clean start cannot sign in, the chat retries with the inherited environment: ${lastBubble.replace(/\n/g, ' | ')}`);
// Attach an image, a text file and a zip (a 3D part plus a schematic) to one message.
{
  const zlib = await import('node:zlib');
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
  // A real 8x8 red PNG.
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...Array(8).fill([220, 30, 30]).flat()])));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  const bodiesBefore = await page.evaluate(() => window.caliper.store.results.bodies.length);
  await page.setInputFiles('#chat-file', [
    { name: 'sketch.png', mimeType: 'image/png', buffer: png },
    { name: 'sizes.txt', mimeType: 'text/plain', buffer: Buffer.from('Outer can: 66 diameter x 115 height') },
    { name: 'project.zip', mimeType: 'application/zip', buffer: zipOf([['spacer.stl', fs.readFileSync(path.join(work, 'spacer.stl'))], ['board.sch', Buffer.from('<?xml version="1.0"?><eagle version="9.7.0"><drawing/></eagle>')], ['__MACOSX/._spacer.stl', Buffer.alloc(4)]]) },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.attach-chip').length === 4, null, { timeout: 30000 }).catch(() => {});
  const chips = await page.$$eval('.attach-chip', (els) => els.map((e) => e.innerText.trim()));
  ok(chips.length === 4 && (await page.evaluate(() => window.caliper.store.results.bodies.length)) === bodiesBefore + 1, `attachments: image, text, the zip's part imported and its schematic attached (${chips.join(' | ')})`);
  await page.fill('#chat-input', 'what do you make of these?');
  await page.click('#chat-send');
  await page.waitForFunction(() => !document.querySelector('#assistant.running') && /image\(s\) and your files/.test(document.getElementById('chat-log').innerText), null, { timeout: 60000 }).catch(() => {});
  const sent = JSON.parse(fs.readFileSync(promptLog, 'utf8').trim().split('\n').at(-1));
  ok(sent.images === 1 && /66 diameter x 115 height/.test(sent.prompt) && /<eagle version/.test(sent.prompt) && /dropped project\.zip into the chat\. Now in the model: spacer\.stl \(Import feature import\d+\)/.test(sent.prompt) && /what do you make of these/.test(sent.prompt), `Claude Code receives the image, the files' text and where the part went (${sent.prompt.length} characters)`);
  ok((await page.$$('.msg.from-user .msg-images img')).length >= 1 && (await page.$$('.attach-chip')).length === 0, 'the message shows the image and the tray empties');
}
await page.fill('#chat-input', 'this will fail');
await page.click('#chat-send');
await page.waitForFunction(() => !document.querySelector('#assistant.running') && document.querySelector('.msg-error'), null, { timeout: 30000 }).catch(() => {});
ok(/not signed in/.test((await page.textContent('.msg-error')) || ''), `Claude Code errors are explained: ${await page.textContent('.msg-error')}`);
await page.fill('#chat-input', 'slow box');
await page.click('#chat-send');
await page.waitForTimeout(1500);
await page.click('#chat-stop');
await page.waitForFunction(() => !document.querySelector('#assistant.running'), null, { timeout: 15000 }).catch(() => {});
ok(!(await page.evaluate(() => !!document.querySelector('#assistant.running'))), 'Stop cancels a Claude Code run');
await page.screenshot({ path: path.join(shots, 'bridge-chat.png') });

// A bridge from before the chat existed (still running because the agent kept it alive) never
// introduces itself; the page says how to restart it instead of "checking" forever.
{
  const { WebSocketServer } = await import('ws');
  const old = new WebSocketServer({ port: PORT + 8, host: '127.0.0.1' });
  old.on('connection', (ws) => ws.on('message', () => {}));
  const p2 = await browser.newPage();
  await p2.goto(`http://127.0.0.1:${PORT}/#bridge=${PORT + 8}-${'a'.repeat(32)}`);
  await p2.waitForFunction(() => /older version/.test(document.getElementById('chat-note').textContent), null, { timeout: 15000 }).catch(() => {});
  ok(/older version.*\/mcp.*Reconnect/.test(await p2.textContent('#chat-note')), `an outdated bridge is named, with how to restart it: ${await p2.textContent('#chat-note')}`);
  await p2.close();
  old.close();
}

// A second agent shares the same bridge; an HTTP client attaches too.
const B = await agent('cursor');
const pageBodies = await page.evaluate(() => window.caliper.store.results.bodies.length);
r = await B.call('get_state', { include: ['build'] });
ok(!r.isError && json(r).build.bodies.length === pageBodies, 'a second agent (second bridge process) reaches the same page');
const H = new Client({ name: 'mcp-inspector', version: '1.0.0' });
await H.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
r = await H.callTool({ name: 'get_state', arguments: { include: ['view'] } });
ok(!r.isError && json(r).view.camera, 'an HTTP MCP client works too');
await page.waitForFunction(() => /Claude Code, Cursor, MCP Inspector/.test(document.getElementById('agent-label').textContent), null, { timeout: 10000 }).catch(() => {});
ok(/Claude Code/.test(await page.textContent('#agent-label')) && /Cursor/.test(await page.textContent('#agent-label')), `all agents listed: ${await page.textContent('#agent-label')}`);
await page.screenshot({ path: path.join(shots, 'bridge-page.png') });

// The first agent quits: the second bridge takes over the port and the page reconnects.
await A.client.close();
await page.waitForFunction(() => document.getElementById('agent-btn').dataset.state === 'live', null, { timeout: 30000 }).catch(() => {});
await new Promise((res) => setTimeout(res, 1500));
r = await B.call('get_state', { include: ['build'] });
ok(!r.isError && json(r).build?.bodies?.length === pageBodies, `after the first agent quits, the second keeps working: ${textOf(r).slice(0, 100)}`);

ok(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`);
await H.close();
await B.client.close();
await browser.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
