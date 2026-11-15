// End-to-end check of "bring your own AI" through AI Connect: a local AI Connect relay, Caliper in a
// real browser tab, and this script playing the person's AI. It does what the pasted prompt tells an
// AI to do: fetch the instructions, claim the connection, call Caliper's tools over plain HTTP, and
// listen to and answer the side-panel chat.
// Usage: node scripts/e2e-aiconnect.cjs [caliper url] [screenshot dir]
// Needs an ai-connect checkout with its build (npm install) at ../ai-connect, or AI_CONNECT_DIR.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const url = process.argv[2] || 'http://127.0.0.1:4173/';
const dir = process.argv[3] || '.';
const AIC = process.env.AI_CONNECT_DIR || path.resolve(__dirname, '..', '..', 'ai-connect');
const PORT = 8790 + Math.floor(Math.random() * 100);
let failed = 0;
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${m}`);
  if (!c) failed++;
};

(async () => {
  const relay = spawn(process.execPath, [path.join(AIC, 'packages/bridge/dist/cli.js'), 'relay', '--port', String(PORT), '--host', '127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let relayLog = '';
  relay.stderr.on('data', (d) => (relayLog += d));
  for (let i = 0; i < 50 && !/relay on port/.test(relayLog); i++) await new Promise((r) => setTimeout(r, 100));
  ok(/relay on port/.test(relayLog), `a local AI Connect relay runs on ${PORT}`);
  const base = `http://127.0.0.1:${PORT}`;

  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  try {
    await p.goto(`${url}?relay=${encodeURIComponent(base)}`);
    await p.waitForFunction(() => window.caliper?.store.results, null, { timeout: 60000 });

    // --- the person connects their AI: Agent menu, Paste a prompt
    await p.click('#agent-btn');
    const routes = await p.$$eval('#agent-body .aic-opt .aic-t', (els) => els.map((e) => e.textContent));
    ok(routes.some((t) => /Paste a prompt/.test(t)) && routes.some((t) => /On this computer only/.test(t)), `the Agent menu offers AI Connect's ways to connect (${routes.join(' | ')})`);
    await p.click('#agent-body [data-route="prompt"]');
    await p.click('#aic-prompt');
    await p.waitForSelector('#aic-prompt-text');
    const prompt = await p.textContent('#aic-prompt-text');
    const clip = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    ok(/Caliper/.test(prompt) && prompt.includes(`${base}/s/`) && clip === prompt, 'Copy prompt puts the one-time prompt on the clipboard');
    await p.screenshot({ path: `${dir}/aic-1-prompt.png` });

    // --- the AI follows the prompt: fetch the instructions, claim the connection
    const doc = await (await fetch(/(http:\/\/\S+\/s\/\w+)/.exec(prompt)[1])).text();
    const claimUrl = /curl -sS -X POST (\S+\/claim)/.exec(doc)?.[1];
    ok(!!claimUrl && /Caliper/.test(doc), 'the prompt link explains how to connect to Caliper');
    const claim = await (await fetch(claimUrl, { method: 'POST' })).json();
    ok(!!claim.api, `claiming gives the AI its address (${Object.keys(claim).join(', ')})`);
    const api = claim.api;
    await p.waitForFunction(() => window.caliper.agentLink.status === 'connected', null, { timeout: 15000 });
    ok(/AI connected|AI listening/.test(await p.textContent('#agent-label')), `the page shows the AI is connected (${await p.textContent('#agent-label')})`);

    // --- the AI looks around and works with Caliper's tools
    const apps = await (await fetch(`${api}/apps`)).json();
    const app = apps.apps?.[0];
    const names = (app?.tools || []).map((t) => t.name);
    ok(app?.name === 'Caliper' && ['get_state', 'edit_model', 'screenshot', 'export_file', 'get_attachments'].every((n) => names.includes(n)) && !names.includes('open_caliper'), `the AI sees Caliper's tools (${names.length})`);
    ok((app?.skills || []).some((s) => s.name === 'caliper-guide'), 'and its skills, with the guide');
    const call = async (tool, args = {}) => (await fetch(`${api}/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) })).json();
    const st = await call('get_state');
    ok(st.ok && /features/.test(JSON.stringify(st.result)), 'get_state works over AI Connect');
    const n0 = await p.evaluate(() => window.caliper.store.doc.features.length);
    const ed = await call('edit_model', { upsert: [{ id: 'aibox', type: 'box', name: 'From my AI', w: 20, d: 20, h: 10, at: [60, 0, 0], op: 'new' }] });
    await p.waitForTimeout(800);
    const after = await p.evaluate(() => window.caliper.store.doc.features.map((f) => f.name));
    ok(ed.ok && after.length === n0 + 1 && after.includes('From my AI'), `edit_model changes the person's model (${ed.ok ? 'ok' : ed.error})`);
    ok(/From my AI|added/.test(await p.textContent('#chat-log')), 'what the AI changed shows up in the side panel');
    const shot = await call('screenshot', { view: 'iso' });
    ok(shot.ok && JSON.stringify(shot.result).includes('"type":"image"'), 'screenshot returns an image');
    const bad = await call('export_file', { format: 'xyz' });
    ok(!bad.ok && bad.error, `a tool error comes back as an error (${(bad.error || '').slice(0, 60)})`);
    const ex = await call('export_file', { format: 'stl', return_data: true });
    ok(ex.ok && /data_base64/.test(JSON.stringify(ex.result)), 'export_file can hand the file back to the AI');

    // --- chatting from the panel: the AI listens, the person types, the AI answers there
    const listening = fetch(`${api}/listen?wait=25`).then((r) => r.json());
    await p.waitForFunction(() => window.caliper.agentLink.listening, null, { timeout: 10000 });
    ok(/listening/i.test(await p.textContent('#chat-note')), `the chat panel says the AI is listening (${await p.textContent('#chat-note')})`);
    await p.fill('#chat-input', 'Make the new box 30 mm tall');
    await p.press('#chat-input', 'Enter');
    const got = await listening;
    const m = got.messages?.[0];
    ok(m && /30 mm tall/.test(m.text) && m.context?.part, `the AI receives the message with context (${m?.text?.slice(0, 40)})`);
    const box = await p.evaluate(() => window.caliper.store.doc.features.find((f) => f.name === 'From my AI').id);
    await call('edit_model', { patch: [{ id: box, set: { h: 30 } }] });
    await fetch(`${api}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: m.id, text: 'Done: the box is now 30 mm tall.' }) });
    await p.waitForFunction(() => /30 mm tall\./.test(document.querySelector('#chat-log .msg.from-claude:last-child')?.textContent || ''), null, { timeout: 10000 });
    const h = await p.evaluate((id) => window.caliper.store.doc.features.find((f) => f.id === id).h, box);
    ok(h === 30, `the AI's change landed (h = ${h})`);
    ok(await p.isVisible('#chat-log .msg.from-claude:last-child >> text=Undo this change'), 'the answer offers to undo what it changed');
    await p.screenshot({ path: `${dir}/aic-2-chat.png` });

    // --- disconnecting
    await p.click('#agent-btn');
    await p.click('#agent-disconnect');
    await p.waitForTimeout(400);
    ok((await p.evaluate(() => window.caliper.agentLink.status)) === 'idle', 'Disconnect un-pairs the page');
    const late = await call('get_state');
    ok(!late.ok, 'and the AI can no longer reach Caliper');
    ok(!errors.length, `no page errors (${errors.join(' | ')})`);
  } catch (e) {
    console.log('e2e crashed:', e.message);
    failed++;
  } finally {
    await b.close();
    relay.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
