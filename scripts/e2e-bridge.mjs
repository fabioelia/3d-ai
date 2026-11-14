// End-to-end check of the MCP bridge, the way an agent uses it: real MCP clients (stdio and HTTP), the
// bridge, and a real browser tab running Caliper. Needs a build (npm run build) and Playwright.
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
const env = { ...process.env, XDG_CONFIG_HOME: path.join(work, 'config'), CALIPER_NO_OPEN: '1', CALIPER_PORT: String(PORT) };

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
ok(['open_caliper', 'get_state', 'screenshot', 'edit_model', 'import_stl', 'ask_user', 'export_file'].every((t) => tools.includes(t)), `tools listed: ${tools.join(', ')}`);
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
r = await A.call('import_stl', { path: 'spacer.stl', at: [60, 0, 0] });
st = json(r);
ok(!r.isError && st.ok && st.bodies.length === 2 && st.notes?.[0]?.note.includes('exact solid'), `import_stl from disk: ${textOf(r).slice(0, 140)}`);
r = await A.call('export_file', { format: 'stl', path: 'out/clip.stl' });
const outFile = path.join(work, 'out/clip.stl');
ok(!r.isError && fs.existsSync(outFile) && fs.statSync(outFile).size > 1000, `export_file writes to disk: ${textOf(r).split('\n')[0]}`);
r = await A.call('export_file', { format: 'project' });
const proj = path.join(work, 'caliper-exports', 'Clip.caliper.json');
ok(fs.existsSync(proj) && Object.keys(JSON.parse(fs.readFileSync(proj, 'utf8')).files || {}).length === 1, 'project export embeds the imported STL');

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

// A second agent shares the same bridge; an HTTP client attaches too.
const B = await agent('cursor');
r = await B.call('get_state', { include: ['build'] });
ok(!r.isError && json(r).build.bodies.length === 2, 'a second agent (second bridge process) reaches the same page');
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
ok(!r.isError && json(r).build?.bodies?.length === 2, `after the first agent quits, the second keeps working: ${textOf(r).slice(0, 100)}`);

ok(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`);
await H.close();
await B.client.close();
await browser.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
