// The side-panel chat. It has no model of its own: every message goes over MCP, through the Caliper
// bridge, to Claude Code on the person's computer, which works on the model with the same Caliper tools
// any agent gets and replies here. It runs on the person's own Claude login; there is no API key.
import { store, on } from './store.js';
import * as act from './actions.js';
import { h } from './ui.js';
import { agentLink } from './agent/panel.js';

const SUGGESTIONS = [
  'Make the plate 80 mm wide and add two more holes along the long edges',
  'A 70 × 45 × 25 mm open box with 2 mm walls and rounded corners',
  'A phone stand that holds the phone at 65°',
  'Will this print without supports? Fix what would not.',
];
const STEP_LABEL = {
  get_state: 'Reading the model',
  screenshot: 'Looking at the model',
  query_geometry: 'Reading geometry',
  measure: 'Measuring',
  check_printability: 'Checking printability',
  set_model: 'Building the model',
  edit_model: 'Editing the model',
  import_stl: 'Importing',
  select: 'Selecting',
  set_view: 'Moving the camera',
  ui_action: 'Using the interface',
  ask_user: 'Waiting for you',
  export_file: 'Exporting',
  get_guide: 'Reading the guide',
};

const $ = (id) => document.getElementById(id);
const state = {
  session: null, // Claude Code session id, resumed so follow-ups keep the conversation
  running: null, // AbortController
};

const connected = () => {
  const l = agentLink();
  return !!(l && l.state === 'connected' && l.chat?.available);
};

function ask(text, turn, signal, onText) {
  return new Promise((resolve, reject) => {
    let said = '';
    let gap = false;
    const cancel = agentLink().chatRequest({ text, sessionId: state.session }, (ev) => {
      if (ev.kind === 'start') {
        if (ev.sessionId) state.session = ev.sessionId;
        if (ev.caliper && ev.caliper !== 'connected') turn.onStep('Claude Code could not reach Caliper');
      } else if (ev.kind === 'text') {
        if (gap && said) said += '\n\n';
        gap = false;
        said += ev.delta;
        onText(said);
      } else if (ev.kind === 'break') gap = true;
      else if (ev.kind === 'tool') turn.onStep(STEP_LABEL[ev.name] || ev.name);
      else if (ev.kind === 'done') {
        if (ev.sessionId) state.session = ev.sessionId;
        resolve(said.trim());
      } else if (ev.kind === 'cancelled') reject(Object.assign(new Error(''), { cancelled: true, text: said }));
      else if (ev.kind === 'error') reject(Object.assign(new Error(friendly(ev.message)), { text: said }));
    });
    signal.addEventListener('abort', cancel);
  });
}

function friendly(msg = '') {
  if (/not logged in|\/login|authenticat|invalid api key|oauth/i.test(msg)) return 'Claude Code is not signed in on this computer. Run "claude" in a terminal once and sign in, then send again.';
  if (/rate limit|usage limit|limit reached/i.test(msg)) return `Claude Code hit a usage limit: ${msg}`;
  return `Claude Code: ${msg}`;
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

function openAgentMenu() {
  const btn = $('agent-btn');
  if (btn && !btn.parentElement.hidden && $('agent-menu').hidden) setTimeout(() => btn.click(), 0);
}

async function send(text) {
  text = text.trim();
  if (!text || state.running) return;
  if (!connected()) {
    renderStatus();
    openAgentMenu();
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
    onStep: (label) => {
      if (!chip.isConnected) out.steps.append(chip);
      chip.textContent = label;
      chip.classList.toggle('warn', /could not/.test(label));
    },
  };
  // Claude Code's edits arrive through the bridge; count them by the undo history.
  const depth0 = store.undoStack.length;
  let got = '';
  const onText = (whole) => {
    got = whole;
    out.el.classList.remove('pending');
    out.body.textContent = whole;
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
  };
  try {
    const answer = await ask(text, turn, ctl.signal, onText);
    out.el.classList.remove('pending');
    out.body.textContent = answer || got || 'Done.';
  } catch (e) {
    out.el.classList.remove('pending');
    out.body.textContent = e.text || got || (e.cancelled ? 'Stopped.' : '');
    if (!e.cancelled) out.el.append(h('div', { class: 'msg-error', role: 'alert' }, e.message));
  } finally {
    const steps = store.undoStack.length - depth0;
    if (steps > 0) {
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
                  for (let i = 0; i < steps; i++) m.undo();
                });
                ev.target.replaceWith(h('span', { class: 'muted' }, steps > 1 ? 'Changes undone' : 'Change undone'));
              },
            },
            steps > 1 ? 'Undo these changes' : 'Undo this change',
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

function renderStatus() {
  const l = agentLink();
  const ok = connected();
  const version = l?.chat?.version?.replace(/\s*\(Claude Code\)/, '');
  let note;
  if (ok) note = `Runs on Claude Code on this computer${version ? ` (${version})` : ''}, with your Claude login. It sees what you see and can only use Caliper's tools.`;
  else if (l?.state === 'connected') note = l.chat?.outdated ? l.chat.reason : l.chat?.reason ? `${l.chat.reason} The chat runs on Claude Code; install it and sign in, then restart the bridge.` : 'Checking for Claude Code on this computer…';
  else note = 'The chat runs on Claude Code on your computer, over MCP. Open the Agent menu to connect it.';
  $('chat-note').textContent = note;
  $('chat-connect').hidden = ok || l?.state === 'connected';
  $('chat-input').placeholder = ok ? 'Describe a part, or a change to this one' : 'Connect Claude Code to start';
}

export function initAssistant() {
  if (window.claude?.use) {
    // Inside a Claude artifact the page cannot reach this computer, so there is no MCP bridge.
    $('chat-form').hidden = true;
    $('chat-suggest').hidden = true;
    $('chat-empty').textContent = 'The Caliper chat runs on Claude Code on your computer, over MCP, which a claude.ai artifact cannot reach. Open Caliper at fabioelia.github.io/3d-ai to chat. Modelling by hand works here as usual.';
    $('chat-clear').hidden = true;
    $('chat-connect').hidden = true;
    return;
  }
  $('chat-suggest').replaceChildren(...SUGGESTIONS.map((s) => h('button', { class: 'suggest', type: 'button', onclick: () => send(s) }, s)));
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
    state.session = null; // a fresh Claude Code conversation
    $('chat-log').replaceChildren();
    $('chat-suggest').hidden = false;
    $('chat-empty').hidden = false;
  });
  $('chat-connect').addEventListener('click', openAgentMenu);
  on('agent-link', renderStatus);
  renderStatus();
}
