// The page's side of the MCP bridge: a WebSocket to bridge/server.mjs on this computer. The bridge
// forwards each agent tool call here; the page runs it against the live model and answers.
import { runTool } from './tools.js';

const SAVED = 'caliper.bridge';
// The bridge protocol this page needs (bridge/server.mjs sends its own). Older bridges, often still
// running from before an update because the agent keeps it alive, are named as such.
const PROTOCOL = 2;
export const RESTART_HINT = 'In Claude Code, run /mcp, pick caliper and choose Reconnect (or restart Claude Code). npx fetches the current version.';
const OUTDATED = { available: false, outdated: true, reason: `The Caliper bridge on this computer is an older version, from before the side-panel chat. Restart it to update: ${RESTART_HINT}` };
const read = () => {
  try {
    return JSON.parse(localStorage.getItem(SAVED) || 'null');
  } catch {
    return null;
  }
};
const write = (v) => {
  try {
    if (v) localStorage.setItem(SAVED, JSON.stringify(v));
    else localStorage.removeItem(SAVED);
  } catch {
    /* convenience only */
  }
};

// "7429-abcdef…", "127.0.0.1:7429/abcdef…" or "ws://127.0.0.1:7429/__caliper/ws?token=…"
export function parseCode(code) {
  const s = String(code || '').trim();
  let m = /^(\d{2,5})[-/:](\w{16,})$/.exec(s);
  if (m) return { host: '127.0.0.1', port: Number(m[1]), token: m[2] };
  m = /^(?:wss?:\/\/|https?:\/\/)?([\w.-]+):(\d{2,5})\/(?:__caliper\/ws\?token=)?(\w{16,})/.exec(s);
  if (m) return { host: m[1], port: Number(m[2]), token: m[3] };
  m = /token=(\w{16,})/.exec(s);
  const p = /:(\d{2,5})/.exec(s);
  if (m && p) return { host: '127.0.0.1', port: Number(p[1]), token: m[1] };
  return null;
}

export class BridgeLink {
  constructor({ onStatus, onCall, onResult }) {
    this.onStatus = onStatus;
    this.onCall = onCall;
    this.onResult = onResult;
    this.ws = null;
    this.addr = null;
    this.state = 'off'; // off | connecting | connected | retrying
    this.agents = [];
    this.wanted = false;
    this.retry = 0;
    this.calls = new Map(); // id -> AbortController
    this.chat = null; // what the bridge offers for the side-panel chat: { available, version, reason }
    this.chats = new Map(); // chat id -> event handler
    this.chatSeq = 0;
    window.addEventListener('focus', () => this.send({ type: 'focus' }));
  }

  status(state, detail = '') {
    this.state = state;
    this.detail = detail;
    this.onStatus?.(this);
  }

  // Finds a bridge without asking: the page served by the bridge itself, a #bridge= link, or the
  // bridge this browser connected to before.
  async discover() {
    const hash = /[#&]bridge=([\w-]+)/.exec(location.hash);
    if (hash) {
      const addr = parseCode(hash[1]);
      history.replaceState(null, '', location.pathname + location.search);
      if (addr) return this.connect(addr);
    }
    if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
      try {
        const resp = await fetch('/__caliper/bridge', { cache: 'no-store' });
        if (resp.ok) {
          const info = await resp.json();
          return this.connect({ host: location.hostname, port: info.port, token: info.token, local: true });
        }
      } catch {
        /* not served by a bridge */
      }
    }
    const saved = read();
    if (saved) this.connect(saved, { quiet: true });
  }

  connect(addr, { quiet = false } = {}) {
    this.disconnect(false);
    this.addr = addr;
    this.wanted = true;
    this.retry = 0;
    if (!addr.local) write(addr);
    this.open(quiet);
  }

  disconnect(forget = true) {
    this.wanted = false;
    clearTimeout(this.timer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.ws = null;
    this.agents = [];
    if (forget) {
      write(null);
      this.addr = null;
    }
    this.status('off');
  }

  open(quiet) {
    const { host, port, token } = this.addr;
    this.status(this.retry ? 'retrying' : 'connecting');
    let ws;
    try {
      ws = new WebSocket(`ws://${host}:${port}/__caliper/ws?role=app&token=${encodeURIComponent(token)}`);
    } catch (e) {
      this.status('off', e.message);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.chat = null;
      this.send({ type: 'hello', url: location.href.split('#')[0], title: document.title });
      this.status('connected');
      // Current bridges introduce themselves at once; silence means one from before that existed.
      clearTimeout(this.handshake);
      this.handshake = setTimeout(() => {
        if (this.ws === ws && !this.chat) {
          this.chat = OUTDATED;
          this.onStatus?.(this);
        }
      }, 4000);
    };
    ws.onmessage = (ev) => this.receive(ev.data);
    ws.onclose = (ev) => {
      this.ws = null;
      this.agents = [];
      this.chat = null;
      for (const h of this.chats.values()) h({ kind: 'error', message: 'Lost the connection to the Caliper bridge.' });
      this.chats.clear();
      for (const c of this.calls.values()) c.abort();
      this.calls.clear();
      if (ev.code === 4401) {
        this.wanted = false;
        write(null);
        this.status('off', 'The bridge refused the connection code. Copy a fresh one from your agent (open_caliper) and try again.');
        return;
      }
      if (!this.wanted) return this.status('off');
      // The bridge restarts whenever the agent does; keep trying quietly.
      this.retry++;
      const delay = Math.min(15000, 600 * 2 ** Math.min(this.retry, 5));
      this.status('retrying', quiet && this.retry === 1 ? '' : 'Waiting for the Caliper bridge…');
      this.timer = setTimeout(() => this.wanted && this.open(quiet), delay);
    };
  }

  // Ask Claude Code on this computer (through the bridge). onEvent gets start/text/tool/break/done/
  // error/cancelled events; returns a function that cancels the run.
  chatRequest({ text, sessionId, model }, onEvent) {
    if (this.state !== 'connected' || !this.chat?.available) {
      onEvent({ kind: 'error', message: 'Claude Code is not connected. Open the Agent menu to connect it.' });
      return () => {};
    }
    const id = `c${++this.chatSeq}`;
    this.chats.set(id, onEvent);
    this.send({ type: 'chat', id, text, sessionId, model });
    return () => this.send({ type: 'chat-cancel', id });
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  async receive(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'bridge') {
      clearTimeout(this.handshake);
      this.bridgeVersion = msg.version;
      this.chat = (msg.protocol || 1) < PROTOCOL ? OUTDATED : msg.chat || null;
      this.onStatus?.(this);
    } else if (msg.type === 'chat-event') {
      this.chats.get(msg.id)?.(msg.event);
      if (['done', 'error', 'cancelled'].includes(msg.event?.kind)) this.chats.delete(msg.id);
    } else if (msg.type === 'agents') {
      this.agents = msg.agents || [];
      this.onStatus?.(this);
    } else if (msg.type === 'cancel') {
      this.calls.get(msg.id)?.abort();
    } else if (msg.type === 'call') {
      const ctl = new AbortController();
      this.calls.set(msg.id, ctl);
      const by = msg.agent || 'Agent';
      this.onCall?.({ tool: msg.tool, args: msg.args, by });
      let result;
      try {
        result = await runTool(msg.tool, msg.args, { by, transport: 'bridge' }, ctl.signal);
      } catch (e) {
        result = { content: [{ type: 'text', text: e.message || String(e) }], isError: true };
      }
      this.calls.delete(msg.id);
      this.onResult?.({ tool: msg.tool, by, result });
      this.send({ type: 'result', id: msg.id, result });
    }
  }
}
