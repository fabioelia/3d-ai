#!/usr/bin/env node
// Caliper MCP bridge: lets any MCP client (Claude Code, Claude Desktop, Cursor, …) see and drive a
// Caliper tab. It speaks MCP to the agent (stdio by default, Streamable HTTP at /mcp), and talks to the
// Caliper page over a WebSocket on 127.0.0.1. Tool calls are forwarded to the page, which runs them
// against the live model and answers. Files the agent imports or exports go through here, because the
// page cannot touch the disk.
//
//   npx -y github:fabioelia/3d-ai            stdio MCP server (what agents launch)
//   npx -y github:fabioelia/3d-ai --http     standalone: serve Caliper and MCP at http://127.0.0.1:7429
//
// Options: --port N (default 7429, or CALIPER_PORT), --no-open (never launch a browser),
// CALIPER_APP_URL to use another copy of the app when this one has no local build.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, BRIDGE_TOOLS } from '../src/agent/catalog.js';
import { GUIDE } from '../src/guide.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const HTTP_ONLY = flag('--http');
const NO_OPEN = flag('--no-open') || process.env.CALIPER_NO_OPEN === '1';
const BASE_PORT = Number(opt('--port') || process.env.CALIPER_PORT || 7429);
const DIST = path.join(ROOT, 'dist');
const HAS_DIST = fs.existsSync(path.join(DIST, 'index.html'));
const APP_URL = process.env.CALIPER_APP_URL || 'https://fabioelia.github.io/3d-ai/';
const log = (...a) => process.stderr.write(`[caliper] ${a.join(' ')}\n`); // stdout belongs to MCP

// A per-user secret: the page must present it to connect, so other websites cannot.
function loadToken() {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'caliper');
  const file = path.join(dir, 'bridge.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (/^\w{24,}$/.test(saved.token)) return saved.token;
  } catch {
    /* first run */
  }
  const token = crypto.randomBytes(18).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token }), { mode: 0o600 });
  } catch (e) {
    log('could not save the connection token:', e.message);
  }
  return token;
}
const TOKEN = process.env.CALIPER_TOKEN || loadToken();

const FRIENDLY = { 'claude-code': 'Claude Code', 'claude-ai': 'Claude', 'claude-desktop': 'Claude', cursor: 'Cursor', 'cursor-vscode': 'Cursor', windsurf: 'Windsurf', 'visual-studio-code': 'VS Code', codex: 'Codex', 'mcp-inspector': 'MCP Inspector' };
const friendly = (info) => {
  const raw = String(info?.name || 'Agent');
  return FRIENDLY[raw.toLowerCase()] || raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
};

function openBrowser(url) {
  if (NO_OPEN) return false;
  try {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------- chat: the page's side panel talks to Claude Code on this computer ----------
// The person types in Caliper; the bridge runs Claude Code headless (`claude -p`) with only the Caliper
// tools, pointed back at this bridge over MCP, and streams its reply into the panel. It runs on the
// person's own Claude login, so no API key is needed.
const CLAUDE_BIN = process.env.CALIPER_CLAUDE_BIN || 'claude';
// Bumped whenever the page needs something new from the bridge; pages tell the person to restart an
// older bridge instead of silently missing features.
const PROTOCOL = 2;
const CHAT_PROMPT = `You are working inside Caliper, a browser CAD tool for 3D-printable parts, and the person is chatting with you from Caliper's side panel while looking at the model. Use the caliper tools to see and change what they have open (get_state and screenshot first). Reply in one to three short plain sentences: no markdown, no code, no JSON. Say what you changed and which parameters are worth tweaking.`;

let chatInfo = null; // { available, version, reason }
function detectClaude() {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(CLAUDE_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve({ available: false, reason: 'Claude Code is not installed on this computer.' });
    }
    const t = setTimeout(() => {
      child.kill();
      resolve({ available: false, reason: 'Claude Code did not respond.' });
    }, 8000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(t);
      resolve({ available: false, reason: 'Claude Code is not installed on this computer (the claude command was not found).' });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0 ? { available: true, version: out.trim().split('\n')[0] } : { available: false, reason: 'Claude Code is installed but did not start.' });
    });
  });
}

// The chat's Claude Code must use the person's own stored login, which it can refresh. When the bridge
// was started by a Claude Code session, the environment carries that session's own variables (and
// possibly its short-lived credentials); a child that inherits them can fail with "OAuth session
// expired and could not be refreshed". So the child starts without them. Provider and config
// settings the person chose (Bedrock, Vertex, a custom config dir, ANTHROPIC_*) are kept.
const KEEP = /^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|CLAUDE_CODE_SKIP_\w+_AUTH)$/;
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE/.test(k) || KEEP.test(k)) env[k] = v;
  return env;
}
const isAuthError = (t) => /oauth|not logged in|\/login|authenticat|credential|invalid api key|401/i.test(String(t || ''));

function runChat(hub, msg, send) {
  let stop = null;
  let cancelled = false;
  const attempt = (inherit) => {
    stop = runClaude(hub, msg, inherit, (ev) => {
      // A clean start that cannot sign in before doing anything: try once more with the inherited
      // environment (some setups only provide credentials that way).
      if (!inherit && ev.kind === 'error' && ev.early && isAuthError(ev.message) && !cancelled) {
        log('chat: sign-in failed with a clean environment; retrying with the inherited one');
        return attempt(true);
      }
      send(ev);
    });
  };
  attempt(false);
  return () => {
    cancelled = true;
    stop?.();
  };
}

function runClaude(hub, msg, inherit, send) {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'caliper', 'chat');
  fs.mkdirSync(dir, { recursive: true });
  const mcp = { mcpServers: { caliper: { type: 'http', url: `http://127.0.0.1:${hub.port}/mcp` } } };
  const args = [
    '-p',
    String(msg.text || ''),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(mcp),
    '--tools',
    '', // no shell, file or web tools: only Caliper's
    '--allowedTools',
    'mcp__caliper',
    '--permission-mode',
    'dontAsk',
    '--append-system-prompt',
    CHAT_PROMPT,
  ];
  if (msg.sessionId && /^[\w-]{8,}$/.test(msg.sessionId)) args.push('--resume', msg.sessionId);
  if (msg.model && /^[\w.-]{2,60}$/.test(msg.model)) args.push('--model', msg.model);
  let child;
  try {
    child = spawn(CLAUDE_BIN, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...(inherit ? process.env : cleanEnv()), CALIPER_CHAT: '1' } });
  } catch (e) {
    send({ kind: 'error', message: `Could not start Claude Code: ${e.message}` });
    return () => {};
  }
  let buf = '';
  let stderr = '';
  let finished = false;
  let worked = false; // it said or did something, so a retry would repeat that
  let streamed = false; // text already sent as deltas for the current message
  const finish = (ev) => {
    if (finished) return;
    finished = true;
    send({ ...ev, early: !worked });
  };
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (finished) continue;
      if (ev.type === 'system' && ev.subtype === 'init') {
        const c = (ev.mcp_servers || []).find((m) => m.name === 'caliper');
        send({ kind: 'start', sessionId: ev.session_id, model: ev.model, caliper: c ? c.status : 'missing' });
      } else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        worked = true;
        streamed = true;
        send({ kind: 'text', delta: ev.event.delta.text });
      } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b.type === 'text' && b.text && !streamed && !(ev.error || isAuthError(b.text) && !worked)) {
            worked = true;
            send({ kind: 'text', delta: b.text });
          }
          if (b.type === 'tool_use') {
            worked = true;
            send({ kind: 'tool', name: String(b.name || '').replace(/^mcp__caliper__/, '') });
          }
        }
        streamed = false;
        send({ kind: 'break' });
      } else if (ev.type === 'result') {
        finish(ev.is_error ? { kind: 'error', message: String(ev.result || ev.subtype || 'Claude Code stopped with an error.'), sessionId: ev.session_id } : { kind: 'done', sessionId: ev.session_id, cost: ev.total_cost_usd, turns: ev.num_turns });
      }
    }
  });
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  child.on('error', (e) => finish({ kind: 'error', message: `Could not start Claude Code: ${e.message}` }));
  child.on('close', (code) => {
    if (code === 0 || code === null) finish({ kind: 'error', message: 'Claude Code stopped without an answer.' });
    else finish({ kind: 'error', message: (stderr.trim().split('\n').pop() || `Claude Code exited with code ${code}.`).slice(0, 400) });
  });
  return () => {
    if (!finished) {
      finished = true;
      child.kill('SIGTERM');
      send({ kind: 'cancelled' });
    }
  };
}

// ---------- the hub: owns the port and the connected Caliper pages ----------
class Hub {
  constructor(port) {
    this.port = port;
    this.apps = []; // { ws, focusedAt, url }
    this.relays = new Set(); // WebSockets from other bridge processes
    this.localAgents = new Map(); // session key -> name
    this.relayAgents = new Map(); // ws -> [names]
    this.pending = new Map(); // id -> { resolve, app, onDone }
    this.seq = 0;
    this.waiters = [];
    this.opened = 0;
  }

  urls() {
    const code = `${this.port}-${TOKEN}`;
    return {
      local: HAS_DIST ? `http://127.0.0.1:${this.port}/` : null,
      hosted: `${APP_URL}#bridge=${code}`,
      code,
    };
  }

  agentNames() {
    return [...new Set([...this.localAgents.values(), ...[...this.relayAgents.values()].flat()])];
  }

  broadcastAgents() {
    const msg = JSON.stringify({ type: 'agents', agents: this.agentNames().map((name) => ({ name })) });
    for (const a of this.apps) if (a.ws.readyState === WebSocket.OPEN) a.ws.send(msg);
  }

  setAgent(key, name) {
    if (name) this.localAgents.set(key, name);
    else this.localAgents.delete(key);
    this.broadcastAgents();
  }

  status() {
    return { connected: this.apps.length > 0, pages: this.apps.length, agents: this.agentNames(), ...this.urls() };
  }

  activeApp() {
    return this.apps.slice().sort((a, b) => b.focusedAt - a.focusedAt)[0] || null;
  }

  waitForApp(ms) {
    if (this.apps.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      const done = () => {
        clearTimeout(t);
        resolve(true);
      };
      this.waiters.push(done);
    });
  }

  addApp(ws) {
    const app = { ws, focusedAt: Date.now(), url: '', chats: new Map() };
    this.apps.push(app);
    log(`Caliper page connected (${this.apps.length} open)`);
    const sendBridgeInfo = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'bridge', version: VERSION, protocol: PROTOCOL, chat: chatInfo || { available: false, reason: 'Checking for Claude Code…' } }));
    sendBridgeInfo();
    if (!chatInfo) chatReady.then(sendBridgeInfo);
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === 'hello') app.url = msg.url || '';
      if (msg.type === 'hello' || msg.type === 'focus') app.focusedAt = Date.now();
      if (msg.type === 'chat') {
        if (!chatInfo?.available) {
          ws.send(JSON.stringify({ type: 'chat-event', id: msg.id, event: { kind: 'error', message: chatInfo?.reason || 'Claude Code is not available.' } }));
          return;
        }
        log('chat: running Claude Code');
        const stop = runChat(this, msg, (event) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'chat-event', id: msg.id, event }));
          if (['done', 'error', 'cancelled'].includes(event.kind)) app.chats.delete(msg.id);
        });
        app.chats.set(msg.id, stop);
      }
      if (msg.type === 'chat-cancel') app.chats.get(msg.id)?.();
      if (msg.type === 'result') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.result);
        }
      }
    });
    ws.on('close', () => {
      for (const stop of app.chats.values()) stop();
      this.apps = this.apps.filter((a) => a !== app);
      log(`Caliper page disconnected (${this.apps.length} open)`);
      for (const [id, p] of this.pending) {
        if (p.app === app) {
          this.pending.delete(id);
          p.resolve({ content: [{ type: 'text', text: 'The Caliper page closed or reloaded before it answered. Check it is open, then try again.' }], isError: true });
        }
      }
    });
    this.broadcastAgents();
    for (const w of this.waiters.splice(0)) w();
  }

  addRelay(ws) {
    this.relays.add(ws);
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === 'agents') {
        this.relayAgents.set(ws, msg.agents || []);
        this.broadcastAgents();
      } else if (msg.type === 'status') {
        ws.send(JSON.stringify({ type: 'status', id: msg.id, status: this.status() }));
      } else if (msg.type === 'wait') {
        const ok = await this.waitForApp(msg.ms || 0);
        ws.send(JSON.stringify({ type: 'status', id: msg.id, status: { ...this.status(), waited: ok } }));
      } else if (msg.type === 'open') {
        ws.send(JSON.stringify({ type: 'status', id: msg.id, status: { ...this.status(), opened: this.open() } }));
      } else if (msg.type === 'call') {
        const ctl = new AbortController();
        ws.calls ||= new Map();
        ws.calls.set(msg.id, ctl);
        const result = await this.call(msg.tool, msg.args, msg.agent, ctl.signal);
        ws.calls.delete(msg.id);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: msg.id, result }));
      } else if (msg.type === 'cancel') {
        ws.calls?.get(msg.id)?.abort();
      }
    });
    ws.on('close', () => {
      this.relays.delete(ws);
      this.relayAgents.delete(ws);
      for (const c of ws.calls?.values() || []) c.abort();
      this.broadcastAgents();
    });
  }

  // Open the page once per minute at most; prefer the copy this bridge serves itself.
  open() {
    if (Date.now() - this.opened < 60000) return false;
    this.opened = Date.now();
    const u = this.urls();
    return openBrowser(u.local || u.hosted);
  }

  call(tool, args, agent, signal) {
    const app = this.activeApp();
    if (!app) return Promise.resolve(notConnected(this.urls()));
    const id = ++this.seq;
    return new Promise((resolve) => {
      const finish = (result) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const limit = tool === 'ask_user' ? (Math.min(900, Number(args?.timeout_seconds) || 180) + 30) * 1000 : 180000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        finish({ content: [{ type: 'text', text: `Caliper did not answer within ${Math.round(limit / 1000)} s.` }], isError: true });
      }, limit);
      const onAbort = () => {
        this.pending.delete(id);
        if (app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify({ type: 'cancel', id }));
        finish({ content: [{ type: 'text', text: 'Cancelled.' }], isError: true });
      };
      signal?.addEventListener('abort', onAbort);
      this.pending.set(id, { resolve: finish, app });
      app.ws.send(JSON.stringify({ type: 'call', id, tool, args, agent }));
    });
  }
}

function notConnected(u) {
  return {
    content: [
      {
        type: 'text',
        text: `Caliper is not open in a browser yet. Call open_caliper, or ask the person to open ${u.local || u.hosted}${u.local ? '' : ` (or paste the connection code ${u.code} into Caliper's Agent menu)`}.`,
      },
    ],
    isError: true,
  };
}

// ---------- relay: a second bridge on the same machine routes through the first ----------
class Relay {
  constructor(port, onLost) {
    this.port = port;
    this.onLost = onLost;
    this.pending = new Map();
    this.seq = 0;
    this.agents = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/__caliper/ws?role=agent&token=${TOKEN}`);
      ws.once('open', () => {
        this.ws = ws;
        this.sendAgents();
        resolve(this);
      });
      ws.once('error', reject);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        p(msg.type === 'result' ? msg.result : msg.status);
      });
      ws.on('close', () => {
        for (const p of this.pending.values()) p({ content: [{ type: 'text', text: 'Lost the connection to the Caliper bridge. Try again.' }], isError: true });
        this.pending.clear();
        if (this.ws === ws) this.onLost?.();
      });
    });
  }
  request(msg, id = ++this.seq) {
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ ...msg, id }));
      else resolve({ content: [{ type: 'text', text: 'The Caliper bridge is restarting. Try again in a moment.' }], isError: true });
    });
  }
  sendAgents() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'agents', agents: [...this.agents.values()] }));
  }
  setAgent(key, name) {
    if (name) this.agents.set(key, name);
    else this.agents.delete(key);
    this.sendAgents();
  }
  status() {
    return this.request({ type: 'status' });
  }
  waitForApp(ms) {
    return this.request({ type: 'wait', ms }).then((s) => s.waited);
  }
  open() {
    return this.request({ type: 'open' }).then((s) => s.opened);
  }
  call(tool, args, agent, signal) {
    const id = ++this.seq;
    signal?.addEventListener('abort', () => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: 'cancel', id })));
    return this.request({ type: 'call', tool, args, agent }, id);
  }
}

// ---------- the HTTP server: app files, MCP over HTTP, the page's WebSocket ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function startServer(port) {
  const hub = new Hub(port);
  const okHost = (req) => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]).has(String(req.headers.host || '').toLowerCase());
  const sameOrigin = (req) => !req.headers.origin || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(req.headers.origin) && new URL(req.headers.origin).port === String(port);
  const sessions = new Map();

  const server = http.createServer(async (req, res) => {
    // Refuse requests addressed to other host names (DNS rebinding).
    if (!okHost(req)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/__caliper/ping') return json(res, { caliper: true, version: VERSION });
    if (url.pathname === '/__caliper/bridge') {
      if (!sameOrigin(req)) return res.writeHead(403).end('Forbidden');
      return json(res, { port, token: TOKEN, version: VERSION });
    }
    if (url.pathname === '/mcp') {
      if (!sameOrigin(req)) return res.writeHead(403).end('Forbidden');
      try {
        await handleMcp(req, res, hub, sessions);
      } catch (e) {
        log('mcp error:', e.message);
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }
    if (!HAS_DIST) {
      // No local build: send the person to the hosted app, already pointed at this bridge.
      res.writeHead(302, { location: hub.urls().hosted }).end();
      return;
    }
    let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST)) return res.writeHead(403).end('Forbidden');
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (!okHost(req) || url.pathname !== '/__caliper/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.searchParams.get('token') !== TOKEN) return ws.close(4401, 'bad token');
      if (url.searchParams.get('role') === 'agent') hub.addRelay(ws);
      else hub.addApp(ws);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({ hub, server });
    });
  });
}

function json(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function handleMcp(req, res, hub, sessions) {
  const sid = req.headers['mcp-session-id'];
  if (req.method === 'POST') {
    const body = await readBody(req);
    let transport = sid ? sessions.get(sid) : null;
    if (!transport) {
      if (sid || !isInitializeRequest(body)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid MCP session. Start with initialize.' }, id: null }));
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const server = createMcpServer(() => hub, `http:${crypto.randomUUID()}`);
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, body);
    return;
  }
  const transport = sid && sessions.get(sid);
  if (!transport) return res.writeHead(400).end('No valid MCP session.');
  await transport.handleRequest(req, res);
}

// ---------- the MCP server an agent talks to ----------
const INSTRUCTIONS = `Caliper is a browser CAD tool for 3D-printable parts, open in the person's browser. These tools let you see exactly what they see (get_state, screenshot), work on the same model they are editing (edit_model, set_model, import_stl), point at things (select, set_view, ask_user) and export files to this computer (export_file). Start with open_caliper if Caliper is not connected, then get_state. Look with screenshot after each change.

${GUIDE}`;

function createMcpServer(getBackend, key) {
  const server = new Server({ name: 'caliper', title: 'Caliper CAD', version: VERSION }, { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS });
  let agentName = 'Agent';
  server.oninitialized = () => {
    agentName = friendly(server.getClientVersion());
    getBackend().setAgent(key, agentName);
    log(`${agentName} attached`);
  };
  server.onclose = () => getBackend()?.setAgent(key, null);

  const all = [...BRIDGE_TOOLS, ...TOOLS];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: all.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'caliper://guide', name: 'guide', title: 'Caliper document reference', mimeType: 'text/plain' },
      { uri: 'caliper://state', name: 'state', title: 'Current Caliper state', mimeType: 'application/json' },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri === 'caliper://guide') return { contents: [{ uri: req.params.uri, mimeType: 'text/plain', text: GUIDE }] };
    if (req.params.uri === 'caliper://state') {
      const r = await getBackend().call('get_state', {}, agentName);
      return { contents: [{ uri: req.params.uri, mimeType: 'application/json', text: r.content?.[0]?.text || '{}' }] };
    }
    throw new Error(`Unknown resource ${req.params.uri}`);
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name } = req.params;
    const args = { ...(req.params.arguments || {}) };
    const backend = getBackend();
    try {
      if (name === 'open_caliper') {
        let st = await backend.status();
        let opened = false;
        if (!st.connected) {
          opened = await backend.open();
          const ok = await backend.waitForApp(Math.min(120, Math.max(0, Number(args.wait_seconds ?? 30))) * 1000);
          st = await backend.status();
          if (!ok)
            return text(
              `Caliper is not connected yet.${opened ? ' A browser window was opened; it may need a moment, or the browser may be asking to allow access to this computer.' : ''} Ask the person to open ${st.local || st.hosted}${st.local ? `, or open ${st.hosted}` : ''}. If they already have Caliper open, they can paste the connection code ${st.code} into its Agent menu.`,
              true,
            );
        }
        return text(JSON.stringify({ connected: true, pages: st.pages, agents: st.agents, open_at: st.local || st.hosted, hosted: st.hosted, connection_code: st.code, next: 'Call get_state to see the model.' }));
      }
      if (!TOOLS.some((t) => t.name === name)) return text(`Unknown tool "${name}".`, true);
      if (name === 'import_stl') {
        if (!args.path) return text('import_stl needs a path to an .stl file.', true);
        const file = path.resolve(process.cwd(), String(args.path).replace(/^~(?=$|\/)/, os.homedir()));
        if (!fs.existsSync(file)) return text(`There is no file at ${file}.`, true);
        const size = fs.statSync(file).size;
        if (size > 200 * 1024 * 1024) return text(`${file} is larger than 200 MB.`, true);
        if (!/\.(stl|zip)$/i.test(file)) return text(`${path.basename(file)} is not an .stl or .zip file.`, true);
        args.data = fs.readFileSync(file).toString('base64');
        args.fileName = path.basename(file);
        delete args.path;
      }
      const result = await backend.call(name, args, agentName, extra.signal);
      if (name === 'export_file' && result?.files?.length) return saveExports(result, args.path);
      const { files, ...rest } = result || {};
      return rest.content ? rest : text('Caliper returned nothing.', true);
    } catch (e) {
      return text(e.message || String(e), true);
    }
  });
  return server;
}

function text(t, isError = false) {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
}

function saveExports(result, wanted) {
  const lines = [];
  for (const f of result.files) {
    let target = wanted ? path.resolve(process.cwd(), String(wanted).replace(/^~(?=$|\/)/, os.homedir())) : path.resolve(process.cwd(), 'caliper-exports', f.name);
    if (wanted && (/[\\/]$/.test(wanted) || (fs.existsSync(target) && fs.statSync(target).isDirectory()))) target = path.join(target, f.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = Buffer.from(f.data, 'base64');
    fs.writeFileSync(target, bytes);
    lines.push(`Saved ${target} (${bytes.length.toLocaleString()} bytes)`);
  }
  const info = result.content?.map((c) => c.text).join('\n') || '';
  return text(`${lines.join('\n')}\n${info}`);
}

// ---------- start ----------
async function isCaliper(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__caliper/ping`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).caliper === true;
  } catch {
    return false;
  }
}

async function acquire() {
  for (let port = BASE_PORT; port < BASE_PORT + 10; port++) {
    try {
      const { hub } = await startServer(port);
      log(`bridge listening on http://127.0.0.1:${port}`);
      return hub;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
    if (await isCaliper(port)) {
      try {
        const relay = new Relay(port, () => reacquire());
        await relay.connect();
        log(`sharing the Caliper bridge on port ${port}`);
        return relay;
      } catch {
        /* that bridge went away; try again on the next round */
      }
    }
  }
  throw new Error(`No free port between ${BASE_PORT} and ${BASE_PORT + 9}.`);
}

let backend = null;
const agentKeys = new Map();
async function reacquire() {
  // The bridge this one shared went away: take over its port, or join whoever did.
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
    try {
      backend = await acquire();
      for (const [key, name] of agentKeys) backend.setAgent(key, name);
      return;
    } catch {
      /* keep trying */
    }
  }
  log('could not reconnect to a Caliper bridge');
}

const getBackend = () => ({
  status: async () => backend.status(),
  open: async () => backend.open(),
  waitForApp: (ms) => backend.waitForApp(ms),
  call: (...a) => backend.call(...a),
  setAgent: (key, name) => {
    if (name) agentKeys.set(key, name);
    else agentKeys.delete(key);
    backend.setAgent(key, name);
  },
});

backend = await acquire();
// Chat needs the claude command; check for it once, in the background.
var chatReady = detectClaude().then((info) => {
  chatInfo = info;
  log(info.available ? `chat: ${info.version}` : `chat unavailable: ${info.reason}`);
});

if (HTTP_ONLY) {
  if (backend instanceof Relay) {
    const st = await backend.status();
    log(`A Caliper bridge is already running on port ${backend.port}. Open ${st.local || st.hosted}`);
    process.exit(0);
  }
  const u = backend.urls();
  log(`MCP endpoint: http://127.0.0.1:${backend.port}/mcp`);
  log(`Open Caliper: ${u.local || u.hosted}`);
  if (!u.local) log(`Connection code: ${u.code}`);
  if (backend.open()) log('Opened Caliper in your browser. Its side-panel chat runs on Claude Code here.');
} else {
  const server = createMcpServer(getBackend, 'stdio');
  const transport = new StdioServerTransport();
  transport.onclose = () => process.exit(0);
  process.stdin.on('end', () => process.exit(0));
  await server.connect(transport);
}
