// The built-in assistant: a chat that works on the same model the person does, with the same tools
// external agents get over MCP (src/agent/catalog.js). Inside a Claude artifact it uses the viewer's
// Claude (the `sample` capability); elsewhere it calls the Claude API with a key the person keeps in
// their own browser. Each turn starts with a picture of the person's current view.
import Anthropic from '@anthropic-ai/sdk';
import { store, on } from './store.js';
import { GUIDE } from './guide.js';
import { TOOLS } from './agent/catalog.js';
import { runTool, stateSnapshot } from './agent/tools.js';
import * as act from './actions.js';
import { h } from './ui.js';

const KEY_STORE = 'caliper.apiKey';
const MODEL_STORE = 'caliper.model';
const MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-fable-5-2', 'Claude Fable 5.2'],
];
const SUGGESTIONS = [
  'Make the plate 80 mm wide and add two more holes along the long edges',
  'A 70 × 45 × 25 mm open box with 2 mm walls and rounded corners',
  'A phone stand that holds the phone at 65°',
  'Will this print without supports? Fix what would not.',
];
// External-agent tools that make no sense from inside the page's own chat.
const NOT_IN_APP = new Set(['import_stl', 'get_guide', 'show_message', 'get_state']);
// When the viewer limits how many tools a page may offer, these come first.
const PRIORITY = ['edit_model', 'set_model', 'query_geometry', 'measure', 'check_printability', 'select', 'set_view', 'ask_user', 'ui_action', 'export_file', 'screenshot'];
const STEP_LABEL = {
  screenshot: 'Looking at the model',
  query_geometry: 'Reading geometry',
  measure: 'Measuring',
  check_printability: 'Checking printability',
  set_model: 'Building the model',
  edit_model: 'Editing the model',
  select: 'Selecting',
  set_view: 'Moving the camera',
  ui_action: 'Using the interface',
  ask_user: 'Waiting for you',
  export_file: 'Exporting',
};

const $ = (id) => document.getElementById(id);
const read = (k) => {
  try {
    return localStorage.getItem(k) || '';
  } catch {
    return '';
  }
};
const write = (k, v) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
};

const state = {
  backend: 'pending', // pending | claude | key | none
  sample: null,
  sampleImages: false,
  maxTools: 0,
  apiKey: read(KEY_STORE),
  model: read(MODEL_STORE) || MODELS[0][0],
  turns: [], // text-only history for the artifact backend
  apiMessages: [], // append-only message history for the API backend
  running: null, // AbortController
};

const SYSTEM = `${GUIDE}

YOU ARE THE BUILT-IN ASSISTANT
You live in Caliper's side panel. Each request comes with the current state (the same data get_state returns) and a picture of exactly what the person sees. Reply in one or two plain sentences, with no markdown and no JSON.`;

function context() {
  return `CURRENT STATE:\n${JSON.stringify(stateSnapshot({ include: ['document', 'build', 'view'] }))}`;
}

function currentView() {
  try {
    const shot = act.app.viewport.capture({ view: 'current', width: 1024, height: 768 });
    return shot.dataUrl.split(',')[1];
  } catch {
    return null;
  }
}
const b64ToBlob = (b64) => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return new Blob([out], { type: 'image/png' });
};

function toolList(max = Infinity, noImages = false) {
  const list = TOOLS.filter((t) => !NOT_IN_APP.has(t.name) && !(noImages && t.name === 'screenshot'));
  list.sort((a, b) => (PRIORITY.indexOf(a.name) + 1 || 99) - (PRIORITY.indexOf(b.name) + 1 || 99));
  return list.slice(0, max);
}

async function call(name, input, turn, ctx) {
  turn.onStep?.(STEP_LABEL[name] || name);
  const depth = store.undoStack.length;
  const res = await runTool(name, input, { by: 'Assistant', transport: ctx.transport, noImages: ctx.noImages }, turn.signal);
  if (store.undoStack.length !== depth) {
    turn.changed = true;
    turn.undoSteps += store.undoStack.length - depth;
  }
  if (name === 'set_model' || name === 'edit_model') {
    const report = (() => {
      try {
        return JSON.parse(res.content.find((c) => c.type === 'text')?.text || '{}');
      } catch {
        return {};
      }
    })();
    const n = (report.errors?.length || 0) + (report.parameter_errors?.length || 0);
    turn.onStep?.(n ? `Model updated, ${n} problem${n === 1 ? '' : 's'} to fix` : 'Model updated');
  }
  return res;
}

// ---------- backends ----------
async function askClaudeArtifact(text, turn, signal, onText) {
  const view = state.sampleImages ? currentView() : null;
  const turns = [{ role: 'user', content: SYSTEM }, ...state.turns.slice(-12), { role: 'user', content: `${context()}\n\n${view ? 'The attached image is what the person sees right now.\n\n' : ''}REQUEST: ${text}` }];
  const ctx = { transport: 'artifact', noImages: true };
  const tools = toolList(state.maxTools || 8, true).map((t) => ({
    name: t.name,
    description: t.description.slice(0, 1000),
    inputSchema: t.inputSchema,
    execute: async (input) => {
      const res = await call(t.name, input || {}, turn, ctx);
      const out = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').slice(0, 30000);
      if (res.isError) throw new Error(out);
      return out;
    },
  }));
  const opts = { tools, signal, onText: ({ text: whole }) => onText(whole) };
  if (view) opts.images = [b64ToBlob(view)];
  const out = await state.sample(turns, opts);
  state.turns.push({ role: 'user', content: text }, { role: 'assistant', content: out.text });
  return out.text;
}

const apiContent = (res) => res.content.map((c) => (c.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: c.mimeType || 'image/png', data: c.data } } : { type: 'text', text: c.text || '' }));

async function askClaudeApi(text, turn, signal, onText) {
  const client = new Anthropic({ apiKey: state.apiKey, dangerouslyAllowBrowser: true });
  const tools = toolList().map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const messages = state.apiMessages;
  const mark = messages.length;
  const view = currentView();
  messages.push({
    role: 'user',
    content: [
      ...(view ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: view } }, { type: 'text', text: 'Above: what the person sees right now.' }] : []),
      { type: 'text', text: `${context()}\n\nREQUEST: ${text}` },
    ],
  });
  const ctx = { transport: 'inapp', noImages: false };
  let shown = '';
  try {
    for (let round = 0; round < 16; round++) {
      const stream = client.beta.messages.stream(
        {
          model: state.model,
          max_tokens: 64000,
          system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          // If a safety classifier declines, let the API retry on a fallback model instead of stopping.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
          tools,
          messages,
        },
        { signal },
      );
      const base = shown;
      let cur = '';
      stream.on('text', (delta) => {
        cur += delta;
        onText(base + cur);
      });
      const message = await stream.finalMessage();
      shown = base + cur + (cur ? '\n\n' : '');
      messages.push({ role: 'assistant', content: message.content });
      if (message.stop_reason === 'refusal') {
        messages.length = mark;
        throw Object.assign(new Error('Claude declined this request. Try describing the part differently.'), { handled: true });
      }
      if (message.stop_reason === 'max_tokens') throw Object.assign(new Error('The reply was cut off for length. Ask for a smaller change.'), { handled: true });
      if (message.stop_reason === 'pause_turn') continue;
      const calls = message.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) break;
      const results = [];
      for (const c of calls) {
        const res = await call(c.name, c.input || {}, turn, ctx);
        results.push({ type: 'tool_result', tool_use_id: c.id, content: apiContent(res), ...(res.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (e) {
    // Never leave the history ending on an unanswered tool call.
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_use')) messages.length = mark;
    else if (last && last.role === 'user' && messages.length === mark + 1) messages.length = mark;
    throw e;
  }
  return shown.trim();
}

function explain(e) {
  if (e?.handled) return e.message;
  // Artifact capability errors carry a code; API errors are typed SDK classes.
  switch (e?.code) {
    case 'cancelled':
      return '';
    case 'not_granted':
    case 'sampling_disabled':
    case 'not_declared':
    case 'capability_disabled':
    case 'capability_removed':
      return 'The assistant is not allowed to use Claude in this view. You can still model by hand.';
    case 'tools_unavailable':
      return 'This view cannot let the assistant edit the model. Open the page in claude.ai to use it.';
    case 'rate_limited':
      return 'Claude is rate limited right now. Wait a moment, then send again.';
    case 'session_expired':
      return 'Your Claude session expired. Sign in again, then send again.';
    case 'refused':
      return 'Claude declined this request. Try describing the part differently.';
    case 'prompt_too_large':
      return 'This model is too large to send to the assistant. Clear the chat or simplify the model.';
    default:
  }
  if (e instanceof Anthropic.APIUserAbortError) return '';
  if (e instanceof Anthropic.AuthenticationError) return 'That API key was rejected. Check it in the assistant settings.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use that model. Pick another model in the assistant settings.';
  if (e instanceof Anthropic.RateLimitError) return 'The API is rate limited right now. Wait a moment, then send again.';
  if (e instanceof Anthropic.BadRequestError) return `The API rejected the request: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check your connection, then send again.';
  if (e instanceof Anthropic.APIError) return `The Claude API returned an error (${e.status}). Send again in a moment.`;
  return 'Something went wrong while asking Claude. Send again.';
}

// ---------- UI ----------
function bubble(role, text) {
  const body = h('div', { class: 'msg-text' }, text);
  const steps = h('div', { class: 'msg-steps' });
  const el = h('div', { class: `msg ${role === 'assistant' ? 'from-claude' : 'from-user'}` }, role === 'assistant' ? steps : null, body);
  $('chat-log').append(el);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return { el, body, steps };
}

function setRunning(on) {
  $('chat-send').hidden = on;
  $('chat-stop').hidden = !on;
  $('chat-input').disabled = on;
  $('assistant').classList.toggle('running', on);
}

async function send(text) {
  text = text.trim();
  if (!text || state.running) return;
  if (state.backend === 'pending') return;
  if (state.backend === 'key' && !state.apiKey) {
    $('chat-settings').hidden = false;
    $('api-key').focus();
    return;
  }
  if (store.kernel.state !== 'ready') {
    act.app.toast('The geometry kernel is still loading. Try again in a moment.');
    return;
  }
  $('chat-suggest').hidden = true;
  $('chat-empty').hidden = true;
  $('chat-input').value = '';
  bubble('user', text);
  const out = bubble('assistant', 'Thinking…');
  out.el.classList.add('pending');
  const ctl = new AbortController();
  state.running = ctl;
  setRunning(true);
  const chip = h('span', { class: 'step' }, '');
  const turn = {
    changed: false,
    undoSteps: 0,
    signal: ctl.signal,
    onStep: (label) => {
      if (!chip.isConnected) out.steps.append(chip);
      chip.textContent = label;
      chip.classList.toggle('warn', /problem/.test(label));
    },
  };
  let got = '';
  const onText = (whole) => {
    got = whole;
    out.el.classList.remove('pending');
    out.body.textContent = whole;
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
  };
  try {
    const answer = state.backend === 'claude' ? await askClaudeArtifact(text, turn, ctl.signal, onText) : await askClaudeApi(text, turn, ctl.signal, onText);
    out.el.classList.remove('pending');
    out.body.textContent = answer || got || (turn.changed ? 'Done.' : 'No reply.');
  } catch (e) {
    const msg = explain(e);
    out.el.classList.remove('pending');
    const partial = (e && e.code !== 'refused' && (e.text || got)) || '';
    out.body.textContent = partial || (msg ? '' : 'Stopped.');
    if (msg) out.el.append(h('div', { class: 'msg-error', role: 'alert' }, msg));
    if (!partial && !msg) out.body.textContent = 'Stopped.';
    if (e?.code && ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'tools_unavailable'].includes(e.code)) $('chat-form').hidden = true;
  } finally {
    if (turn.changed) {
      out.el.append(
        h(
          'div',
          { class: 'msg-foot' },
          h(
            'button',
            {
              class: 'link-btn',
              type: 'button',
              onclick: (ev) => {
                import('./store.js').then((m) => {
                  for (let i = 0; i < turn.undoSteps; i++) m.undo();
                });
                ev.target.replaceWith(h('span', { class: 'muted' }, turn.undoSteps > 1 ? 'Changes undone' : 'Change undone'));
              },
            },
            turn.undoSteps > 1 ? 'Undo these changes' : 'Undo this change',
          ),
        ),
      );
      act.app.viewport.fit();
    }
    state.running = null;
    setRunning(false);
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
    if (window.matchMedia('(min-width: 821px)').matches) $('chat-input').focus();
  }
}

function renderBackend() {
  const key = state.backend === 'key';
  $('chat-settings-btn').hidden = !key;
  $('chat-note').textContent =
    state.backend === 'claude'
      ? 'Uses your Claude account. It sees the model and what you have selected.'
      : key
        ? state.apiKey
          ? `Using ${MODELS.find((m) => m[0] === state.model)?.[1] || state.model} with your API key.`
          : 'Add a Claude API key to turn the assistant on.'
        : '';
  $('chat-input').placeholder = key && !state.apiKey ? 'Add an API key above to start' : 'Describe a part, or a change to this one';
}

export async function initAssistant() {
  const box = $('chat-suggest');
  box.replaceChildren(...SUGGESTIONS.map((s) => h('button', { class: 'suggest', type: 'button', onclick: () => send(s) }, s)));
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    send($('chat-input').value);
  });
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send($('chat-input').value);
    }
    e.stopPropagation();
  });
  $('chat-stop').addEventListener('click', () => state.running?.abort());
  $('chat-clear').addEventListener('click', () => {
    if (state.running) return;
    state.turns = [];
    state.apiMessages = [];
    $('chat-log').replaceChildren();
    $('chat-suggest').hidden = false;
    $('chat-empty').hidden = false;
  });
  $('chat-settings-btn').addEventListener('click', () => ($('chat-settings').hidden = !$('chat-settings').hidden));
  const modelSel = $('api-model');
  modelSel.replaceChildren(...MODELS.map(([v, label]) => h('option', { value: v }, label)));
  modelSel.value = state.model;
  $('api-key').value = state.apiKey;
  $('api-save').addEventListener('click', () => {
    state.apiKey = $('api-key').value.trim();
    state.model = modelSel.value;
    write(KEY_STORE, state.apiKey);
    write(MODEL_STORE, state.model);
    state.apiMessages = [];
    $('chat-settings').hidden = !!state.apiKey;
    renderBackend();
  });
  on('kernel', () => {});

  // Inside a Claude artifact the viewer lends the page Claude; resolve that first.
  let sample = null;
  try {
    sample = (await window.claude?.use?.('sample')) || null;
    if (sample) {
      const limits = await sample.limits().catch(() => null);
      if (limits && !limits.tools) sample = null;
      state.sampleImages = !!limits?.images;
      state.maxTools = limits?.tools?.maxCount || 8;
    }
  } catch {
    sample = null;
  }
  state.sample = sample;
  state.backend = sample ? 'claude' : 'key';
  if (!sample && window.claude?.use) {
    // In a Claude viewer without the capability (signed out, shared link): no key prompt there either.
    $('chat-note').textContent = 'The assistant needs Claude, which is not available in this view. Modelling by hand works as usual.';
    $('chat-form').hidden = true;
    $('chat-suggest').hidden = true;
    state.backend = 'none';
    return;
  }
  renderBackend();
}
