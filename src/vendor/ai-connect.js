// AI Connect web SDK, vendored from github.com/fabioelia/ai-connect@ccf4f05 (packages/web). MIT.
// Regenerate with: node scripts/vendor-ai-connect.mjs
/* eslint-disable */
// ../ai-connect/packages/web/src/protocol.ts
var PROTOCOL_VERSION = 1;

// ../ai-connect/packages/web/src/webmcp.ts
var PolyfillModelContext = class extends EventTarget {
  constructor() {
    super(...arguments);
    this.__aiConnectPolyfill = true;
    this.tools = /* @__PURE__ */ new Map();
    this.pending = false;
  }
  registerTool(tool, options) {
    if (!tool || typeof tool.name !== "string" || typeof tool.execute !== "function") {
      throw new TypeError("registerTool: a tool needs a name and an execute function");
    }
    if (this.tools.has(tool.name)) throw new DOMException(`Tool "${tool.name}" is already registered`, "InvalidStateError");
    if (options?.signal?.aborted) return;
    this.tools.set(tool.name, tool);
    options?.signal?.addEventListener(
      "abort",
      () => {
        if (this.tools.get(tool.name) === tool) {
          this.tools.delete(tool.name);
          this.changed();
        }
      },
      { once: true }
    );
    this.changed();
  }
  getTools() {
    return [...this.tools.values()].map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
  }
  async executeTool(tool, args, options) {
    const name = typeof tool === "string" ? tool : tool?.name;
    const t = this.tools.get(name);
    if (!t) throw new DOMException(`No tool named "${name}"`, "NotFoundError");
    return t.execute(args ?? {}, options);
  }
  changed() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this.dispatchEvent(new Event("toolchange"));
    });
  }
};
function modelContext() {
  const doc = document;
  const existing = doc.modelContext ?? navigator.modelContext;
  if (existing && typeof existing.registerTool === "function" && typeof existing.getTools === "function" && typeof existing.executeTool === "function") {
    return existing;
  }
  const mc = new PolyfillModelContext();
  try {
    Object.defineProperty(doc, "modelContext", { value: mc, configurable: true });
  } catch {
  }
  return mc;
}

// ../ai-connect/packages/web/src/client.ts
var DeclinedError = class extends Error {
  constructor() {
    super("The user declined this action.");
  }
};
var CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
var AIConnect = class {
  constructor(opts) {
    this.opts = opts;
    this.status = "idle";
    /** Cloud mode: whether the user's AI is currently waiting for messages from this page's chat. */
    this.listening = false;
    this.messages = [];
    /** AI Connect-only extras (confirm, hints) for tools registered through ai.tool(). */
    this.extras = /* @__PURE__ */ new Map();
    this.registered = [];
    this.specs = [];
    this.skills = /* @__PURE__ */ new Map();
    this.callInfo = /* @__PURE__ */ new WeakMap();
    this.pairId = randomId().replace(/-/g, "");
    this.listeners = {
      status: /* @__PURE__ */ new Set(),
      messages: /* @__PURE__ */ new Set(),
      activity: /* @__PURE__ */ new Set(),
      tools: /* @__PURE__ */ new Set()
    };
    this.retryDelay = 1e3;
    this.wantConnection = false;
    this.skillsDirty = false;
    this.app = { url: typeof location !== "undefined" ? location.origin : void 0, ...opts.app };
    this.localUrl = opts.bridgeUrl ?? "ws://127.0.0.1:7531/ws";
    this.storageKey = opts.storageKey ?? "ai-connect";
    this.pairingCode = randomCode();
    const saved = this.read("mode");
    const fallback = opts.relay && opts.defaultMode !== "local" ? "cloud" : "local";
    this._mode = saved === "local" || saved === "cloud" && opts.relay || saved === "private" && opts.hub ? saved : fallback;
    this.modelContext = modelContext();
    this.modelContext.addEventListener("toolchange", () => void this.refreshTools());
    void this.refreshTools();
    if (opts.autoConnect !== false && this.storedKey()) {
      queueMicrotask(() => this.connect());
    }
  }
  /** "cloud" (hosted relay) or "local" (bridge on this computer). */
  get mode() {
    return this._mode;
  }
  /** Whether a hub is configured, i.e. the private (end-to-end encrypted) mode is available. */
  get hasHub() {
    return !!this.opts.hub;
  }
  /** Whether a hosted relay is configured, i.e. cloud mode is available. */
  get hasRelay() {
    return !!this.opts.relay;
  }
  // ---------- tools ----------
  /**
   * Register a tool on document.modelContext (WebMCP). Returns a function that unregisters it.
   * Tools registered on document.modelContext by any other code are picked up too.
   */
  tool(def) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(def.name)) throw new Error(`Invalid tool name "${def.name}"`);
    const controller = new AbortController();
    this.extras.set(def.name, { confirm: def.confirm, readOnly: def.readOnly, destructive: def.destructive });
    const execute = async (args) => {
      const info = args && typeof args === "object" && this.callInfo.get(args) || { id: randomId(), name: def.name, args, source: "browser" };
      if (def.confirm) {
        const message = typeof def.confirm === "function" ? def.confirm(args) : `Allow the AI to run "${def.name}"?`;
        this.emit("activity", { ...info, status: "pending_confirm" });
        const ask = this.opts.confirm ?? this.confirmHandler ?? (async () => window.confirm(message));
        let allowed = false;
        try {
          allowed = await ask(info, message);
        } catch {
        }
        if (!allowed) throw new DeclinedError();
      }
      return def.execute(args, info);
    };
    const annotations = { readOnlyHint: !!def.readOnly, destructiveHint: !!def.destructive };
    Promise.resolve().then(
      () => this.modelContext.registerTool(
        { name: def.name, description: def.description, inputSchema: def.inputSchema ?? { type: "object", properties: {} }, annotations, execute },
        { signal: controller.signal }
      )
    ).then(() => this.refreshTools()).catch((e) => console.error(`[ai-connect] could not register tool "${def.name}":`, e));
    return () => {
      controller.abort();
      this.extras.delete(def.name);
      void this.refreshTools();
    };
  }
  /** Register several tools at once. Returns a function that unregisters all of them. */
  register(defs) {
    const offs = defs.map((d) => this.tool(d));
    return () => offs.forEach((f) => f());
  }
  /** Add a skill: a playbook the AI can read when a job needs several steps. Returns a remover. */
  skill(def) {
    this.skills.set(def.name, def);
    this.scheduleSkillsSync();
    return () => {
      if (this.skills.get(def.name) === def) {
        this.skills.delete(def.name);
        this.scheduleSkillsSync();
      }
    };
  }
  get toolSpecs() {
    return this.specs;
  }
  get skillSpecs() {
    return [...this.skills.values()].map((s) => ({ name: s.name, description: s.description, instructions: s.instructions, source: "app" }));
  }
  refreshTools() {
    return this.refreshing = (this.refreshing ?? Promise.resolve()).then(async () => {
      let tools;
      try {
        tools = await this.modelContext.getTools() ?? [];
      } catch {
        return;
      }
      this.registered = tools;
      const specs = tools.map((t) => {
        const x = this.extras.get(t.name);
        const hints = t.annotations ?? {};
        return {
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          confirm: !!x?.confirm,
          readOnly: x?.readOnly ?? !!hints.readOnlyHint,
          destructive: x?.destructive ?? !!hints.destructiveHint
        };
      });
      if (JSON.stringify(specs) === JSON.stringify(this.specs)) return;
      this.specs = specs;
      this.emit("tools", specs);
      if (this.status === "connected") this.post({ t: "tools", tools: specs });
    });
  }
  scheduleSkillsSync() {
    if (this.skillsDirty) return;
    this.skillsDirty = true;
    queueMicrotask(() => {
      this.skillsDirty = false;
      if (this.status === "connected") this.post({ t: "skills", skills: this.skillSpecs });
    });
  }
  // ---------- connection ----------
  /**
   * Connect. `connect()` uses the current mode; `connect('ABC-123')` pairs with a local bridge that
   * printed that code; `connect({ mode: 'cloud' })` switches mode. In cloud mode a first-time
   * connection must be approved by the user at `approvalUrl` (open it from a click handler).
   */
  connect(arg) {
    const o = typeof arg === "string" ? { code: arg, mode: "local" } : arg ?? {};
    if (o.mode) this.setMode(o.mode);
    if (o.code) this.codeOverride = o.code;
    this.wantConnection = true;
    this.retryDelay = 1e3;
    if (this._mode === "private" && !this.ws) {
      try {
        window.open(`${this.hubOrigin}/#site`, "ai-connect-hub", "popup,width=500,height=760");
      } catch {
      }
    }
    this.open();
  }
  /** Switch between the hosted relay and the local bridge without connecting. Disconnects if the mode changes. */
  setMode(mode) {
    if (mode === "cloud" && !this.opts.relay) throw new Error("No relay configured: pass { relay } to use cloud mode.");
    if (mode === "private" && !this.opts.hub) throw new Error("No hub configured: pass { hub } to use private mode.");
    this.write("mode", mode);
    if (mode === this._mode) return;
    this.disconnect();
    this._mode = mode;
  }
  /** Whether this visitor has picked a way to connect before (on this site, in this browser). */
  get modeChosen() {
    return this.read("mode") !== null;
  }
  disconnect() {
    this.wantConnection = false;
    this.closeSocket();
    this.setStatus("idle");
  }
  /** Disconnect and forget this browser's pairing for the current mode. */
  forget() {
    this.post({ t: "forget" });
    this.disconnect();
    this.write(`key:${this._mode}`, null);
  }
  get paired() {
    return !!this.storedKey();
  }
  get bridgeCommand() {
    return this.opts.bridgeCommand ?? "npx -y github:fabioelia/ai-connect";
  }
  /** Local mode, one time: the command that adds AI Connect to Claude Code. Other clients: see `ai-connect config`. */
  get setupCommand() {
    return `claude mcp add ai-connect -- ${this.bridgeCommand} mcp`;
  }
  /** Local mode: what the user tells their AI to connect this page (their AI calls the connect_pair tool). */
  get pairPhrase() {
    return `Connect to the app with code ${formatCode(this.pairingCode)}`;
  }
  /** What the user tells their AI to make it start (or resume) reading this page's chat panel. */
  get listenPhrase() {
    if (this._mode === "private") return `Listen to the chat panel in ${this.app.name} and answer me there. It is an AI Connect action, not one of the app's tools: use listen and reply on your AI Connect address (its /help page says how), or the connect_listen and connect_reply tools.`;
    const base = (this.opts.relay ?? "").replace(/\/$/, "");
    return `Listen to the chat panel in ${this.app.name} and answer me there. It is an AI Connect action, not one of the app's tools: read ${base}/help for how, then start listening.`;
  }
  /** Local mode, alternative: start a standalone bridge for this page from a terminal. */
  get command() {
    return `${this.bridgeCommand} connect ${formatCode(this.pairingCode)}`;
  }
  /**
   * Cloud mode: a prompt the user pastes into their AI. It points the AI at one-time instructions on
   * the relay; the AI claims the connection itself, with no connector setup. Call `connect({ mode:
   * 'cloud' })` when you hand it out, so the relay knows this page is waiting. Works with AIs that
   * can make web requests (Claude Code, Codex, Cursor, ...).
   */
  get setupPrompt() {
    const base = (this.opts.relay ?? "").replace(/\/$/, "");
    return `Connect yourself to the web app "${this.app.name}" that I have open in my browser, using AI Connect. Fetch ${base}/s/${this.pairId} and follow the instructions there. When you are connected, tell me briefly what you can do in the app, then keep listening to its chat panel so I can talk to you from there.`;
  }
  /** Cloud mode, alternative for chat apps that cannot make web requests (claude.ai, ChatGPT): the page where the user approves this site (and gets their connector URL the first time). */
  get approvalUrl() {
    return `${(this.opts.relay ?? "").replace(/\/$/, "")}/connect#pair=${this.pairId}`;
  }
  /** Link that opens the user's AI with a prompt about this app (for handing a request over to claude.ai or ChatGPT). */
  handoffUrl(provider, text) {
    const prompt = `Using my AIConnect connector, in the app "${this.app.name}": ${text}`;
    return provider === "claude" ? `https://claude.ai/new?q=${encodeURIComponent(prompt)}` : `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`;
  }
  closeSocket() {
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = void 0;
    ws?.close();
  }
  get url() {
    if (this._mode === "local") return this.localUrl;
    const key = this.storedKey();
    const route = `pair=${this.pairId}` + (key ? `&g=${encodeURIComponent(key.split(".")[0])}` : "");
    return this.opts.relay.replace(/^http/, "ws").replace(/\/$/, "") + "/ws?" + route;
  }
  open() {
    clearTimeout(this.retryTimer);
    if (this.ws && this.ws.readyState <= 1) return;
    const key = this.storedKey();
    const cloud = this._mode === "cloud";
    this.setStatus(key || cloud ? "connecting" : "waiting");
    if (this._mode === "private") {
      this.setStatus(key ? "offline" : "approval");
      this.listenForHub();
      return;
    }
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      return this.fail(String(e));
    }
    this.attach(ws, key, cloud);
  }
  /** Private mode: bring the user's hub window to the front (it holds their connector address). Call from a click. */
  showHub() {
    if (this.opts.hub) window.open(`${this.hubOrigin}/#site`, "ai-connect-hub", "popup,width=500,height=760");
  }
  get hubOrigin() {
    return new URL(this.opts.hub).origin;
  }
  /** Private mode: when the hub window says it is ready, give it one end of a message channel. */
  listenForHub() {
    if (this.hubListener) return;
    this.hubListener = (ev) => {
      if (ev.origin !== this.hubOrigin || ev.data?.aiConnect !== "hub-ready") return;
      if (this._mode !== "private" || !this.wantConnection || this.ws) return;
      const channel = new MessageChannel();
      ev.source.postMessage({ aiConnect: "site-hello", app: this.app }, this.hubOrigin, [channel.port2]);
      this.attach(new PortSocket(channel.port1), this.storedKey(), true);
    };
    window.addEventListener("message", this.hubListener);
  }
  attach(ws, key, cloud) {
    this.ws = ws;
    let welcomed = false;
    ws.onopen = () => {
      this.post({
        t: "hello",
        v: PROTOCOL_VERSION,
        app: this.app,
        tools: this.toolSpecs,
        skills: this.skillSpecs,
        key: key || void 0,
        ...this._mode === "private" ? {} : cloud ? { pair: this.pairId } : { code: this.codeOverride ?? this.pairingCode }
      });
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === "welcome") welcomed = true;
      void this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = void 0;
      this.listening = false;
      this.aiSeen = void 0;
      clearInterval(this.pingTimer);
      if (this.status === "connected" || welcomed) this.finishChat("Disconnected from the bridge.");
      if (!this.wantConnection) return this.setStatus("idle");
      if (this.status === "error") return;
      if (this._mode === "private") return this.setStatus("offline");
      this.setStatus(this.storedKey() || cloud ? "offline" : "waiting");
      this.retryTimer = setTimeout(() => this.open(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 1.5, this.storedKey() || cloud ? 15e3 : 3e3);
    };
  }
  fail(detail) {
    this.setStatus("error", detail);
  }
  async onMessage(msg) {
    switch (msg.t) {
      case "welcome":
        this.agent = msg.agent;
        this.codeOverride = void 0;
        this.write(`key:${this._mode}`, msg.key);
        this.aiArrivedAt = Date.now();
        this.pairId = randomId().replace(/-/g, "");
        this.retryDelay = 1e3;
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.post({ t: "ping" }), 3e4);
        this.setStatus("connected");
        this.post({ t: "tools", tools: this.toolSpecs });
        this.post({ t: "skills", skills: this.skillSpecs });
        break;
      case "granted":
        this.write(`key:${this._mode}`, msg.key);
        this.pairId = randomId().replace(/-/g, "");
        this.closeSocket();
        this.open();
        break;
      case "listening":
        if (this.listening !== msg.on || msg.ai !== void 0 && this.aiSeen !== msg.ai) {
          this.listening = msg.on;
          if (msg.ai !== void 0) {
            if (this.aiSeen === false && msg.ai) this.aiArrivedAt = Date.now();
            this.aiSeen = msg.ai;
          }
          this.emit("status", this.status, this.statusDetail);
        }
        break;
      case "pair":
        this.setStatus("approval");
        break;
      case "reject":
        if (msg.reason === "pairing_required" || msg.reason === "bad_code") {
          this.write(`key:${this._mode}`, null);
          if (msg.reason === "bad_code" && this.codeOverride) {
            this.codeOverride = void 0;
            this.fail(msg.message);
            return;
          }
          this.setStatus("waiting");
        } else {
          if (msg.reason === "denied") this.pairId = randomId().replace(/-/g, "");
          this.fail(msg.message);
        }
        break;
      case "tool_call":
        await this.runTool(msg.id, msg.name, msg.args, msg.source);
        break;
      case "chat_event":
        this.onChatEvent(msg.id, msg.event);
        break;
    }
  }
  async runTool(id, name, rawArgs, source) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    const call = { id, name, args, source };
    const reply = (ok, content, error) => this.post({ t: "tool_result", id, ok, content: ok ? serializable(content) : void 0, error });
    const tool = this.registered.find((t) => t.name === name);
    if (!tool) return reply(false, void 0, `Unknown tool "${name}"`);
    const missing = missingRequired(tool.inputSchema, args);
    if (missing.length) return reply(false, void 0, `Missing required argument(s): ${missing.join(", ")}`);
    this.callInfo.set(args, call);
    const chat = source === "chat" ? void 0 : this.messages.find((m) => m.id === this.chatId);
    const chip = chat && { callId: id, name, status: "running" };
    if (chat && chip) {
      chat.tools.push(chip);
      this.emitMessages();
    }
    const inChat = !!chat;
    this.emit("activity", { ...call, status: "running", inChat });
    try {
      const result = await this.modelContext.executeTool(tool, args);
      if (chip) chip.status = "done";
      this.emit("activity", { ...call, status: "done", inChat });
      reply(true, result);
    } catch (e) {
      const declined = e instanceof DeclinedError;
      const error = e instanceof Error ? e.message : String(e);
      if (chip) chip.status = "error";
      this.emit("activity", { ...call, status: declined ? "denied" : "error", error, inChat });
      reply(false, void 0, error);
    }
    if (chat) this.emitMessages();
  }
  // ---------- chat ----------
  get canChat() {
    return this.status === "connected" && !!this.agent?.chat;
  }
  get busy() {
    return !!this.chatId;
  }
  /** Send a chat message to the user's AI. */
  async send(text) {
    text = text.trim();
    if (!text) return;
    if (this.status !== "connected") throw new Error("Not connected to a bridge.");
    if (this.chatId) this.cancel();
    const id = randomId();
    this.chatId = id;
    this.messages.push({ id: randomId(), role: "user", text, tools: [] });
    this.messages.push({ id, role: "assistant", text: "", tools: [], pending: true });
    this.emitMessages();
    let context;
    try {
      context = await this.opts.context?.();
    } catch {
    }
    this.post({ t: "chat", id, text, context: serializable(context) });
  }
  /**
   * Hand a request to the user's AI, e.g. from a button in your UI. Call it from a click handler.
   * Returns "chat" (sent to an in-app chat backend, if one is running), "copied" (put on the
   * clipboard, ready to paste into their AI), or "unavailable" (no AI connected yet).
   */
  ask(text) {
    if (this.canChat) {
      void this.send(text);
      return "chat";
    }
    if (this.status !== "connected") return "unavailable";
    void navigator.clipboard?.writeText(`In the app "${this.app.name}" (connected through AI Connect): ${text}`);
    return "copied";
  }
  cancel() {
    if (!this.chatId) return;
    this.post({ t: "chat_cancel" });
    this.finishChat();
  }
  /** Clear the conversation (the agent starts a fresh session). */
  reset() {
    this.post({ t: "chat_reset" });
    this.chatId = void 0;
    this.messages = [];
    this.emitMessages();
  }
  onChatEvent(id, ev) {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return;
    switch (ev.type) {
      case "text":
        msg.text += ev.delta;
        break;
      case "tool_start":
        msg.tools.push({ callId: ev.callId, name: ev.name, status: "running" });
        break;
      case "tool_end": {
        const t = msg.tools.find((x) => x.callId === ev.callId);
        if (t) t.status = ev.ok ? "done" : "error";
        break;
      }
      case "error":
        msg.error = ev.message;
        break;
      case "done":
        msg.pending = false;
        msg.text = msg.text.trim();
        if (this.chatId === id) this.chatId = void 0;
        break;
    }
    this.emitMessages();
  }
  finishChat(error) {
    const msg = this.messages.find((m) => m.id === this.chatId);
    if (msg) {
      msg.pending = false;
      if (error) msg.error = error;
    }
    this.chatId = void 0;
    this.emitMessages();
  }
  // ---------- events ----------
  on(event, fn) {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }
  emit(event, ...args) {
    for (const fn of this.listeners[event]) fn(...args);
  }
  emitMessages() {
    this.emit("messages", this.messages);
  }
  setStatus(s, detail) {
    if (this.status === s && this.statusDetail === detail) return;
    this.status = s;
    this.statusDetail = detail;
    this.emit("status", s, detail);
  }
  post(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
  storedKey() {
    return this.read(`key:${this._mode}`);
  }
  read(name) {
    try {
      return localStorage.getItem(`${this.storageKey}:${name}`);
    } catch {
      return null;
    }
  }
  write(name, value) {
    try {
      if (value === null) localStorage.removeItem(`${this.storageKey}:${name}`);
      else localStorage.setItem(`${this.storageKey}:${name}`, value);
    } catch {
    }
  }
};
var PortSocket = class {
  constructor(port) {
    this.port = port;
    this.readyState = 1;
    this.last = Date.now();
    port.onmessage = (e) => {
      this.last = Date.now();
      if (e.data !== '{"t":"pong"}') this.onmessage?.({ data: String(e.data) });
    };
    port.start();
    queueMicrotask(() => this.onopen?.());
    this.timer = setInterval(() => {
      if (Date.now() - this.last > 12e3) return this.close();
      port.postMessage('{"t":"ping"}');
    }, 4e3);
  }
  send(data) {
    if (this.readyState === 1) this.port.postMessage(data);
  }
  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    clearInterval(this.timer);
    try {
      this.port.close();
    } catch {
    }
    this.onclose?.();
  }
};
function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}
function formatCode(c) {
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}
function randomId() {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
function serializable(v) {
  if (v === void 0) return void 0;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}
function missingRequired(schema, args) {
  const req = schema?.required;
  if (!Array.isArray(req)) return [];
  const a = args && typeof args === "object" ? args : {};
  return req.filter((k) => typeof k === "string" && (a[k] === void 0 || a[k] === null));
}

// ../ai-connect/packages/web/src/markdown.ts
function renderMarkdown(src) {
  const esc2 = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const parts = src.split(/```[\w-]*\n?/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return `<pre><code>${esc2(part.replace(/\n$/, ""))}</code></pre>`;
    const lines = esc2(part).split("\n");
    let html = "";
    let list = null;
    for (const line of lines) {
      const ul = /^\s*[-*]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      const kind = ul ? "ul" : ol ? "ol" : null;
      if (list && kind !== list) {
        html += `</${list}>`;
        list = null;
      }
      if (kind) {
        if (!list) html += `<${list = kind}>`;
        html += `<li>${inline((ul || ol)[1])}</li>`;
      } else if (line.trim()) {
        html += `<p>${inline(line)}</p>`;
      }
    }
    if (list) html += `</${list}>`;
    return html;
  }).join("");
}
function inline(s) {
  return s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

// ../ai-connect/packages/web/src/widget.ts
var SETTLE_MS = 9e4;
var CSS = `
:host { all: initial; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 14px;
  --t-accent: #6d5efc; --t-accent-ink: #fff; --t-bg: #ffffff; --t-panel: #f7f7f9; --t-ink: #1b1b22; --t-muted: #6b6b78;
  --t-line: #e4e4ea; --t-user: #6d5efc; --t-user-ink: #fff; --t-ok: #1f9d55; --t-warn: #c27c0e; --t-err: #d03a3a; }
@media (prefers-color-scheme: dark) { :host { --t-bg: #18181d; --t-panel: #222229; --t-ink: #ececf1; --t-muted: #9a9aa8; --t-line: #33333d; } }
* { box-sizing: border-box; }
button { font: inherit; cursor: pointer; }
.launcher { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; height: 48px; padding: 0 18px 0 14px; border-radius: 24px;
  border: 0; background: var(--t-accent); color: var(--t-accent-ink); display: flex; align-items: center; gap: 8px; font-weight: 600;
  box-shadow: 0 6px 24px rgba(0,0,0,.18); }
.launcher svg { width: 20px; height: 20px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--t-muted); flex: none; }
.dot.connected { background: var(--t-ok); } .dot.waiting, .dot.connecting, .dot.offline { background: var(--t-warn); } .dot.error { background: var(--t-err); }
.launcher .dot { box-shadow: 0 0 0 2px var(--t-accent); }
.panel { position: fixed; right: 20px; bottom: 20px; z-index: 2147483001; width: min(400px, calc(100vw - 24px)); height: min(600px, calc(100vh - 40px));
  background: var(--t-bg); color: var(--t-ink); border: 1px solid var(--t-line); border-radius: 16px; box-shadow: 0 16px 48px rgba(0,0,0,.22);
  display: flex; flex-direction: column; overflow: hidden; }
@media (max-width: 480px) { .panel { right: 12px; bottom: 12px; } }
.hidden { display: none !important; }
header { display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 16px; border-bottom: 1px solid var(--t-line); }
header .title { font-weight: 650; }
header .sub { color: var(--t-muted); font-size: 12px; display: flex; align-items: center; gap: 6px; }
header .grow { flex: 1; min-width: 0; }
.icon { border: 0; background: transparent; color: var(--t-muted); width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; }
.icon:hover { background: var(--t-panel); color: var(--t-ink); }
.icon svg { width: 16px; height: 16px; }
.body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.connect h3 { margin: 0 0 4px; font-size: 16px; }
.connect p { margin: 0 0 12px; color: var(--t-muted); line-height: 1.45; }
.opts { display: flex; flex-direction: column; gap: 8px; }
.opt { display: flex; flex-direction: column; gap: 2px; text-align: left; width: 100%; font: inherit; color: var(--t-ink); background: var(--t-bg); border: 1px solid var(--t-line); border-radius: 12px; padding: 9px 12px; cursor: pointer; }
.opt:hover, .opt:focus-visible { border-color: var(--t-accent); outline: none; }
.opt.current { border-color: var(--t-accent); box-shadow: inset 0 0 0 1px var(--t-accent); }
.opt .t { font-weight: 600; font-size: 14.5px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.opt .tag { font-size: 11px; font-weight: 600; color: var(--t-accent); border: 1px solid var(--t-accent); border-radius: 999px; padding: 1px 7px; }
.opt .d { font-size: 13px; line-height: 1.4; }
.opt .n { font-size: 12px; line-height: 1.4; color: var(--t-muted); }
.step { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--t-muted); margin: 14px 0 6px; }
.cmd { display: flex; align-items: center; gap: 8px; background: var(--t-panel); border: 1px solid var(--t-line); border-radius: 10px; padding: 10px 10px 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.cmd code { flex: 1; overflow-x: auto; white-space: nowrap; }
.cmd.wrap code { white-space: normal; font-family: inherit; font-size: 14px; font-weight: 600; }
.cmd.prompt { margin-top: 10px; } .cmd.prompt code { font-size: 12.5px; font-weight: 400; overflow-wrap: anywhere; user-select: all; }
.btn { border: 1px solid var(--t-line); background: var(--t-bg); color: var(--t-ink); border-radius: 8px; padding: 6px 12px; font-weight: 600; }
.btn.primary { background: var(--t-accent); color: var(--t-accent-ink); border-color: transparent; }
.btn:disabled { opacity: .5; cursor: default; }
.row { display: flex; gap: 8px; }
.row input { flex: 1; min-width: 0; font: inherit; padding: 7px 10px; border: 1px solid var(--t-line); border-radius: 8px; background: var(--t-bg); color: var(--t-ink);
  text-transform: uppercase; letter-spacing: .08em; font-family: ui-monospace, monospace; }
.row input::placeholder { text-transform: none; letter-spacing: normal; }
.status-line { display: flex; align-items: center; gap: 8px; color: var(--t-muted); font-size: 13px; margin-top: 14px; }
.spinner { width: 14px; height: 14px; border: 2px solid var(--t-line); border-top-color: var(--t-accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.err { color: var(--t-err); font-size: 13px; }
.fine { font-size: 12px; color: var(--t-muted); line-height: 1.45; margin-top: 16px; }
.msg { max-width: 88%; line-height: 1.5; overflow-wrap: anywhere; }
.msg.user { align-self: flex-end; background: var(--t-user); color: var(--t-user-ink); padding: 8px 12px; border-radius: 14px 14px 4px 14px; white-space: pre-wrap; }
.msg.assistant { align-self: flex-start; }
.msg p { margin: 0 0 8px; } .msg p:last-child { margin-bottom: 0; }
.msg ul, .msg ol { margin: 0 0 8px; padding-left: 20px; }
.msg code { font-family: ui-monospace, monospace; font-size: 12.5px; background: var(--t-panel); padding: 1px 4px; border-radius: 4px; }
.msg pre { background: var(--t-panel); padding: 10px; border-radius: 8px; overflow-x: auto; margin: 0 0 8px; }
.msg pre code { background: none; padding: 0; }
.msg a { color: var(--t-accent); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.chip { font-size: 12px; border: 1px solid var(--t-line); border-radius: 999px; padding: 2px 8px 2px 6px; display: inline-flex; align-items: center; gap: 5px;
  color: var(--t-muted); font-family: ui-monospace, monospace; }
.chip .dot { width: 6px; height: 6px; }
.chip.running .dot { background: var(--t-warn); } .chip.done .dot { background: var(--t-ok); } .chip.error .dot, .chip.denied .dot { background: var(--t-err); }
.typing { display: inline-flex; gap: 4px; padding: 4px 0; } .typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--t-muted); animation: blink 1.2s infinite; }
.typing i:nth-child(2) { animation-delay: .2s; } .typing i:nth-child(3) { animation-delay: .4s; }
@keyframes blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
.note { align-self: center; font-size: 12px; color: var(--t-muted); text-align: center; }
.hint { border: 1px dashed var(--t-line); border-radius: 12px; padding: 10px 12px; font-size: 13px; color: var(--t-muted); display: flex; flex-direction: column; gap: 8px; }
.hint .cmd.wrap code { font-size: 12.5px; font-weight: 400; overflow-wrap: anywhere; }
.hint a { color: var(--t-accent); }
.confirm { border: 1px solid var(--t-line); background: var(--t-panel); border-radius: 12px; padding: 12px; }
.confirm .q { font-weight: 600; margin-bottom: 6px; }
.confirm pre { font-family: ui-monospace, monospace; font-size: 12px; margin: 0 0 10px; white-space: pre-wrap; max-height: 120px; overflow: auto; color: var(--t-muted); }
.empty { margin: auto 0; text-align: center; color: var(--t-muted); }
.empty .sugs { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; align-items: center; }
.empty .sugs button { border: 1px solid var(--t-line); background: var(--t-bg); color: var(--t-ink); border-radius: 999px; padding: 6px 12px; }
footer { border-top: 1px solid var(--t-line); padding: 10px; display: flex; gap: 8px; align-items: flex-end; }
textarea { flex: 1; resize: none; font: inherit; color: var(--t-ink); background: var(--t-panel); border: 1px solid var(--t-line); border-radius: 10px;
  padding: 9px 12px; max-height: 120px; min-height: 40px; outline: none; }
textarea:focus { border-color: var(--t-accent); }
.send { width: 40px; height: 40px; border-radius: 10px; border: 0; background: var(--t-accent); color: var(--t-accent-ink); display: grid; place-items: center; }
.send:disabled { opacity: .4; cursor: default; }
.send svg { width: 18px; height: 18px; }
.btn.big { width: 100%; padding: 11px 12px; font-size: 15px; }
.fine a { color: var(--t-accent); }
.fine code { font-family: ui-monospace, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
.fine { margin: 10px 0 0; }
`;
var ICONS = {
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  unplug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.4 5.6a4 4 0 0 0-5.7 0L11 7.3l5.7 5.7 1.7-1.7a4 4 0 0 0 0-5.7z"/><path d="M5.6 18.4a4 4 0 0 0 5.7 0L13 16.7 7.3 11l-1.7 1.7a4 4 0 0 0 0 5.7z"/><path d="M3 3l18 18"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'
};
var AIConnectChatElement = class extends HTMLElement {
  constructor() {
    super(...arguments);
    this.o = {};
    this.isOpen = false;
    this.confirms = [];
    this.external = [];
    this.copied = false;
    /** The user asked to see the ways to connect again. */
    this.choosing = false;
    /** Hosted relay: by pasting a prompt, or as a connector for chat apps in the browser. */
    this.via = "prompt";
    this.promptShown = false;
  }
  bind(t, o) {
    this.t = t;
    this.o = o;
    this.root = this.attachShadow({ mode: "open" });
    this.root.innerHTML = `<style>${CSS}</style><div id="app"></div>`;
    t.confirmHandler = (call, message) => new Promise((resolve) => {
      this.confirms.push({ call, message, resolve });
      this.setOpen(true);
      this.render();
    });
    t.on("status", () => {
      if (t.status === "connected") this.choosing = false;
      this.render();
    });
    t.on("messages", () => this.render(true));
    t.on("activity", (a) => {
      if (a.source === "chat" || a.inChat) return;
      const i = this.external.findIndex((x) => x.a.id === a.id);
      if (i >= 0) this.external[i].a = a;
      else this.external.push({ a, at: Date.now() });
      this.render(true);
    });
    this.root.addEventListener("click", (e) => this.onClick(e));
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    this.root.addEventListener("input", (e) => {
      const el = e.target;
      if (el.tagName === "TEXTAREA") this.autosize(el);
    });
    this.setOpen(!!o.open);
  }
  open() {
    this.setOpen(true);
  }
  close() {
    this.setOpen(false);
  }
  setOpen(v) {
    this.isOpen = v;
    if (v && !this.showChooser() && this.t.status === "idle" && this.t.mode !== "private" && (this.t.mode === "local" || this.t.paired)) this.t.connect();
    this.render();
    if (v) queueMicrotask(() => this.root.querySelector("textarea")?.focus());
  }
  onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    if (el.tagName === "A") e.preventDefault();
    const act = el.dataset.act;
    if (act === "open") this.setOpen(true);
    else if (act === "close") this.setOpen(false);
    else if (act === "copy") {
      const which = el.dataset.copy ?? "pair";
      void navigator.clipboard?.writeText(which === "setup" ? this.t.setupCommand : which === "listen" ? this.t.listenPhrase : this.t.pairPhrase).then(() => {
        this.copied = which;
        this.render();
        setTimeout(() => (this.copied = false, this.render()), 1500);
      });
    } else if (act === "retry") this.t.connect();
    else if (act === "reprompt") {
      this.t.forget();
      this.t.connect({ mode: "cloud" });
      this.promptShown = true;
      void navigator.clipboard?.writeText(this.t.setupPrompt).then(() => {
        this.copied = "prompt";
        this.render();
        setTimeout(() => (this.copied = false, this.render()), 1500);
      });
      this.render();
    } else if (act === "prompt") {
      this.t.connect({ mode: "cloud" });
      this.promptShown = true;
      void navigator.clipboard?.writeText(this.t.setupPrompt).then(() => {
        this.copied = "prompt";
        this.render();
        setTimeout(() => (this.copied = false, this.render()), 1500);
      });
      this.render();
    } else if (act === "cloud") {
      window.open(this.t.approvalUrl, "ai-connect-connect", "popup,width=460,height=640");
      this.t.connect({ mode: "cloud" });
    } else if (act === "choose") {
      this.choosing = true;
      this.render();
    } else if (act === "pick") {
      const route = el.dataset.route;
      this.choosing = false;
      this.promptShown = false;
      this.via = route === "connector" ? "connector" : "prompt";
      if (route === "local") this.t.connect({ mode: "local" });
      else this.t.setMode(route === "private" ? "private" : "cloud");
      this.render();
    } else if (act === "showhub") this.t.showHub();
    else if (act === "usehub") this.t.connect({ mode: "private" });
    else if (act === "reset") {
      this.external = [];
      this.t.reset();
    } else if (act === "disconnect") {
      if (confirm("Disconnect and un-pair this browser from your AI bridge?")) this.t.forget();
    } else if (act === "send") this.submit();
    else if (act === "stop") this.t.cancel();
    else if (act === "sug") {
      void this.t.send(el.dataset.text || "");
    } else if (act === "allow" || act === "deny") {
      const c = this.confirms.shift();
      c?.resolve(act === "allow");
      this.render();
    }
  }
  onKey(e) {
    const el = e.target;
    if (el.tagName === "TEXTAREA" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.submit();
    } else if (e.key === "Escape") this.setOpen(false);
  }
  submit() {
    const ta = this.root.querySelector("textarea");
    if (!ta || !ta.value.trim()) return;
    if (!this.t.canChat) return;
    const v = ta.value;
    ta.value = "";
    this.autosize(ta);
    void this.t.send(v);
  }
  autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  }
  render(scroll = false) {
    const app = this.root.getElementById("app");
    const t = this.t;
    const title = esc(this.o.title ?? "Ask your AI");
    if (!this.isOpen) {
      app.innerHTML = `<button class="launcher" data-act="open" aria-label="${title}">${ICONS.spark}<span>${title}</span><span class="dot ${t.status}"></span></button>`;
      return;
    }
    const draft = this.root.querySelector("textarea")?.value ?? "";
    const bodyEl = this.root.querySelector(".body");
    const atBottom = !bodyEl || bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 40;
    const connected = t.status === "connected";
    const sub = connected ? `<span class="dot ${t.agent?.mode === "cloud" && !t.listening ? "waiting" : "connected"}"></span>${esc(
      t.agent?.mode === "cloud" ? t.listening ? "your AI is listening" : t.aiSeen === false ? "connected to your hub \xB7 no AI yet" : t.aiArrivedAt && !t.busy && Date.now() - t.aiArrivedAt < SETTLE_MS ? "connected \xB7 your AI is getting ready" : "connected \xB7 your AI is not listening" : t.agent?.chat ? `via ${t.agent.label}` : "controlled from your AI client"
    )}` : `<span class="dot ${t.status}"></span>${esc(statusLabel(t.status))}`;
    const header = `<header><div class="grow"><div class="title">${title}</div><div class="sub">${sub}</div></div>
      ${connected && t.agent?.chat ? `<button class="icon" data-act="reset" title="New chat">${ICONS.reset}</button>` : ""}
      ${t.paired || connected ? `<button class="icon" data-act="disconnect" title="Disconnect">${ICONS.unplug}</button>` : ""}
      <button class="icon" data-act="close" title="Close">${ICONS.close}</button></header>`;
    let body;
    let footer = "";
    if (!connected) body = this.connectView();
    else {
      body = this.feedView();
      if (t.agent?.chat) {
        footer = `<footer><textarea rows="1" placeholder="${esc(this.o.placeholder ?? "Ask anything about this app...")}"></textarea>
          ${t.busy ? `<button class="send" data-act="stop" title="Stop">${ICONS.stop}</button>` : `<button class="send" data-act="send" title="Send">${ICONS.send}</button>`}</footer>`;
      }
    }
    app.innerHTML = `<div class="panel" role="dialog" aria-label="${title}">${header}<div class="body">${body}</div>${footer}</div>`;
    const ta = this.root.querySelector("textarea");
    if (ta) {
      ta.value = draft;
      this.autosize(ta);
      if (this.root.activeElement === null) ta.focus();
    }
    const b = this.root.querySelector(".body");
    if (!connected) b.scrollTop = bodyEl && this.lastView === "connect" ? bodyEl.scrollTop : 0;
    else if (scroll ? atBottom : true) b.scrollTop = b.scrollHeight;
    this.lastView = connected ? "chat" : "connect";
  }
  /** The ways this app can be connected, each with when to choose it and what it costs. */
  routes() {
    const t = this.t, app = esc(t.app.name);
    const all = [
      t.hasRelay && {
        id: "prompt",
        title: "Paste a prompt",
        tag: "Easiest",
        when: "you use Claude Code, Codex, Cursor or a similar AI that can make web requests.",
        note: "Nothing to install. Goes through the AI Connect relay, which could read what your AI does here."
      },
      t.hasHub && {
        id: "private",
        title: "Private connection",
        tag: "End-to-end encrypted",
        when: `what you do in ${app} is sensitive. Works with Claude Code, Codex, Cursor, and Claude or ChatGPT in the browser.`,
        note: "Nobody in between can read it. Needs an extra window kept open while you work."
      },
      t.hasRelay && {
        id: "connector",
        title: "Claude or ChatGPT in the browser",
        when: "you chat at claude.ai or chatgpt.com, which cannot follow a prompt.",
        note: "You add a connector address once. Goes through the AI Connect relay."
      },
      {
        id: "local",
        title: "On this computer only",
        when: "your AI runs on this computer and nothing should leave it.",
        note: "No relay. One-time setup: a command to add to Claude Code, Claude Desktop or Cursor."
      }
    ];
    return all.filter(Boolean);
  }
  /** First visit with more than one way to connect, or the user asked to see them again. */
  showChooser() {
    const t = this.t;
    if (t.status === "connected" || this.routes().length < 2) return false;
    return this.choosing || !t.modeChosen && !t.paired && t.status === "idle";
  }
  chooserView() {
    const t = this.t;
    const current = t.modeChosen || t.paired ? t.mode === "cloud" ? this.via : t.mode : void 0;
    return `<div class="connect"><h3>Connect your own AI</h3>
      <p>Let the AI you already use work in ${esc(t.app.name)} for you. Pick the way that fits. Each one lets your AI use only what ${esc(t.app.name)} exposes, and asks you before sensitive actions.</p>
      <div class="opts">${this.routes().map((r) => `<button class="opt${r.id === current ? " current" : ""}" data-act="pick" data-route="${r.id}">
        <span class="t">${r.title}${r.tag ? `<span class="tag">${r.tag}</span>` : ""}</span>
        <span class="d"><b>Choose this if</b> ${r.when}</span>
        <span class="n">${r.note}</span></button>`).join("")}</div></div>`;
  }
  connectView() {
    const t = this.t;
    if (this.showChooser()) return this.chooserView();
    const others = this.routes().length > 1 ? '<p class="fine"><a href="#" data-act="choose">Other ways to connect</a></p>' : "";
    if (t.mode === "local" && (t.status === "offline" || t.paired && t.status === "connecting")) {
      return `<div class="connect"><h3>Your AI isn't running</h3>
        <p>This site is already connected to your AI. It reconnects as soon as your AI app is open.</p>
        <div class="status-line"><span class="spinner"></span>Looking for it...</div>
        <p class="fine">Open your AI app (the one you added AI Connect to). It starts the bridge by itself.</p>${others}</div>`;
    }
    const err = t.status === "error" ? `<p class="err">${esc(t.statusDetail || "Something went wrong.")}</p>${t.mode === "local" ? '<button class="btn" data-act="retry">Try again</button>' : ""}` : "";
    if (t.mode === "private") {
      return `<div class="connect"><h3>Private connection</h3>
        <p>Your AI reaches ${esc(t.app.name)} through a hub that runs in your own browser. The relay in between only passes encrypted data and cannot read it.</p>
        ${err}
        <button class="btn primary big" data-act="usehub">${t.status === "idle" ? "Open my hub" : "Open my hub again"}</button>
        ${t.status === "approval" || t.status === "offline" ? `<div class="status-line"><span class="spinner"></span>${t.status === "approval" ? "Approve this site in the hub window..." : "Waiting for your hub tab. Keep it open while you work."}</div>` : ""}
        <p class="fine">The hub window holds your key and must stay open. The first time, it gives you a prompt to paste into your AI (or a connector address for Claude or ChatGPT in the browser). After that, one click here is enough.</p>
        ${others}</div>`;
    }
    if (t.mode === "cloud" && this.via === "connector") {
      const waiting = t.status === "approval" || t.status === "connecting";
      return `<div class="connect"><h3>Claude or ChatGPT in the browser</h3>
        <p>These chat apps reach ${esc(t.app.name)} through a connector. You approve this site in a small window, and the first time it gives you an address to add to your chat app.</p>
        ${err}
        <button class="btn primary big" data-act="cloud">${waiting ? "Open the approval window again" : "Approve this site"}</button>
        ${waiting ? '<div class="status-line"><span class="spinner"></span>Waiting for you to click Allow in the window...</div>' : ""}
        <p class="fine">You add the address once; it then covers every site you approve. Afterwards you talk to your AI in its own chat window, and what it does shows up here.</p>
        ${others}</div>`;
    }
    if (t.mode === "cloud") {
      const waiting = t.status === "approval" || t.status === "connecting" || t.status === "offline";
      const copied = this.promptShown && waiting;
      return `<div class="connect"><h3>Paste a prompt</h3>
        <p>Copy this prompt into the AI you already use. It connects itself to ${esc(t.app.name)}: nothing to install or set up.</p>
        ${err}
        <button class="btn primary big" data-act="prompt">${this.copied === "prompt" ? "Copied" : copied ? "Copy the prompt again" : "Copy prompt for my AI"}</button>
        ${copied ? `<div class="cmd wrap prompt"><code>${esc(t.setupPrompt)}</code></div>
        <div class="status-line"><span class="spinner"></span>Paste it into your AI. Waiting for it to connect...</div>` : ""}
        <p class="fine">For AIs that can make web requests: Claude Code, Codex, Cursor and similar. The prompt works once and expires after 15 minutes.</p>
        ${others}</div>`;
    }
    return `<div class="connect"><h3>On this computer only</h3>
      <p>Let the AI you already use on this computer (Claude Code, Claude Desktop, Cursor, ...) work in ${esc(t.app.name)} for you.</p>
      ${err}
      <div class="step">Tell your AI</div>
      <div class="cmd wrap"><code>${esc(t.pairPhrase)}</code><button class="btn" data-act="copy" data-copy="pair">${this.copied === "pair" ? "Copied" : "Copy"}</button></div>
      ${t.status === "waiting" || t.status === "connecting" ? `<div class="status-line"><span class="spinner"></span>Waiting for your AI...</div>` : ""}
      <div class="step">First time? Add AI Connect to your AI</div>
      <div class="cmd"><code>${esc(t.setupCommand)}</code><button class="btn" data-act="copy" data-copy="setup">${this.copied === "setup" ? "Copied" : "Copy"}</button></div>
      <p class="fine">That line is for Claude Code. Any MCP client works: add the server command <code>${esc(t.setupCommand.split(" -- ")[1])}</code>.</p>
      <p class="fine">It runs only on this computer (127.0.0.1).</p>
      ${others}</div>`;
  }
  feedView() {
    const t = this.t;
    const items = [
      ...t.messages.map((msg) => ({ kind: "msg", msg })),
      ...this.external.map((x) => ({ kind: "activity", a: x.a, at: x.at }))
    ];
    let html = "";
    if (!t.agent?.chat && this.external.length) {
    } else if (!t.agent?.chat && t.agent?.mode === "cloud") {
      html += `<div class="empty">Connected. Ask your AI to do something in ${esc(t.app.name)}. What it does shows up here.</div>`;
    } else if (!t.agent?.chat) {
      html += `<div class="empty">Connected. Ask your AI to do something in ${esc(t.app.name)}. What it does shows up here.</div>`;
    } else if (!t.messages.length) {
      const sugs = (this.o.suggestions ?? []).map((s) => `<button data-act="sug" data-text="${esc(s)}">${esc(s)}</button>`).join("");
      html += `<div class="empty">Ask ${esc(t.agent.label)} to do something in ${esc(t.app.name)}.${sugs ? `<div class="sugs">${sugs}</div>` : ""}</div>`;
    }
    for (const it of items) {
      if (it.kind === "msg") html += messageView(it.msg);
      else html += `<div class="note"><span class="chip ${it.a.status}"><span class="dot"></span>${esc(it.a.source)} \xB7 ${esc(it.a.name)}</span></div>`;
    }
    const settling = !t.listening && !t.busy && t.aiSeen !== false && !!t.aiArrivedAt && Date.now() - t.aiArrivedAt < SETTLE_MS;
    clearTimeout(this.settleTimer);
    if (settling) this.settleTimer = setTimeout(() => this.render(), t.aiArrivedAt + SETTLE_MS - Date.now() + 50);
    if (t.agent?.chat && t.agent.mode === "cloud" && settling) {
      html += `<div class="hint"><div><b>Your AI is connected.</b> It is getting ready and should start listening here in a moment.</div></div>`;
    } else if (t.agent?.chat && t.agent.mode === "cloud" && !t.listening) {
      const copy = `<div class="cmd wrap"><code>${esc(t.listenPhrase)}</code><button class="btn" data-act="copy" data-copy="listen">${this.copied === "listen" ? "Copied" : "Copy"}</button></div>`;
      if (t.aiSeen === false) {
        html += `<div class="hint"><div><b>One step left: connect your AI.</b> In <a href="#" data-act="showhub">your hub window</a>, click <b>Copy prompt for my AI</b> and paste it into the AI you use. It connects itself and can then work in ${esc(t.app.name)} and answer you here.</div></div>`;
      } else {
        html += `<div class="hint"><div>${t.busy ? "Your message is waiting." : "Your AI is not reading this chat right now."} Tell your AI:</div>${copy}
          ${t.mode === "private" ? '<div>Using a new AI conversation? Copy a fresh prompt in <a href="#" data-act="showhub">your hub window</a> instead.</div>' : '<div>Started a new AI conversation since you connected? <a href="#" data-act="reprompt">Copy a fresh connect prompt</a> instead.</div>'}</div>`;
      }
    }
    const c = this.confirms[0];
    if (c) {
      html += `<div class="confirm"><div class="q">${esc(c.message)}</div><pre>${esc(JSON.stringify(c.call.args, null, 2))}</pre>
        <div class="row"><button class="btn primary" data-act="allow">Allow</button><button class="btn" data-act="deny">Deny</button></div></div>`;
    }
    return html;
  }
};
function messageView(m) {
  if (m.role === "user") return `<div class="msg user">${esc(m.text)}</div>`;
  const chips = m.tools.length ? `<div class="chips">${m.tools.map((x) => `<span class="chip ${x.status}"><span class="dot"></span>${esc(x.name)}</span>`).join("")}</div>` : "";
  const body = m.text ? renderMarkdown(m.text) : m.pending ? '<span class="typing"><i></i><i></i><i></i></span>' : "";
  const err = m.error ? `<p class="err">${esc(m.error)}</p>` : "";
  return `<div class="msg assistant">${chips}${body}${err}</div>`;
}
function statusLabel(s) {
  return { idle: "Not connected", waiting: "Waiting for your AI", approval: "Waiting for your AI", connecting: "Connecting...", offline: "Bridge offline", error: "Connection problem" }[s] ?? s;
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function mountChat(t, o = {}) {
  if (!customElements.get("ai-connect-chat")) customElements.define("ai-connect-chat", AIConnectChatElement);
  const el = document.createElement("ai-connect-chat");
  (o.container ?? document.body).appendChild(el);
  el.bind(t, o);
  return el;
}
export {
  AIConnect,
  AIConnectChatElement,
  formatCode,
  modelContext,
  mountChat
};
