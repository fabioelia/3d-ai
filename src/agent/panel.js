// The person's side of connecting their own AI: the Agent menu (the ways to connect, through AI
// Connect), what the AI does shown in the side panel, confirmations, and the prompt bar the AI uses to
// ask the person something.
import { store, on, emit, logActivity } from '../store.js';
import * as act from '../actions.js';
import { h, ICON } from '../ui.js';
import { createConnection, agentName } from './connect.js';

const $ = (id) => document.getElementById(id);
const READS = { get_state: 'read the model', screenshot: 'looked at the model', query_geometry: 'read the geometry', measure: 'measured', check_printability: 'checked printability', get_guide: 'read the guide', get_attachments: 'looked at your images' };
const VIA_KEY = 'caliper.aic.via';

let ai = null;
let choosing = false;
let promptShown = false;
let copied = '';
let via = (() => {
  try {
    return localStorage.getItem(VIA_KEY) === 'connector' ? 'connector' : 'prompt';
  } catch {
    return 'prompt';
  }
})();

function line(by, textContent, kind = '') {
  const log = $('chat-log');
  // Follow new lines only while the person is at the bottom, so reading back up is not yanked down.
  const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  const el = h('div', { class: `agent-line ${kind}` }, h('span', { class: 'agent-who' }, by), h('span', { class: 'agent-what' }, textContent));
  log.append(el);
  while (log.children.length > 400) log.firstChild.remove();
  if (follow) log.scrollTop = log.scrollHeight;
  $('chat-empty').hidden = true;
  $('chat-suggest').hidden = true;
}

// ---------- the ways to connect (as AI Connect offers them) ----------
const ROUTES = () =>
  [
    ai.hasRelay && { id: 'prompt', title: 'Paste a prompt', tag: 'Easiest', when: 'you use Claude Code, Codex, Cursor or a similar AI that can make web requests.', note: 'Nothing to install. Goes through the AI Connect relay, which could read what your AI does here.' },
    ai.hasHub && { id: 'private', title: 'Private connection', tag: 'End-to-end encrypted', when: 'your designs are sensitive. Works with Claude Code, Codex, Cursor, and Claude or ChatGPT in the browser.', note: 'Nobody in between can read it. Needs an extra window kept open while you work.' },
    ai.hasRelay && { id: 'connector', title: 'Claude or ChatGPT in the browser', when: 'you chat at claude.ai or chatgpt.com, which cannot follow a prompt.', note: 'You add a connector address once. Goes through the AI Connect relay.' },
    { id: 'local', title: 'On this computer only', when: 'your AI runs on this computer and nothing should leave it.', note: 'No relay. One-time setup: a command to add to Claude Code, Claude Desktop or Cursor.' },
  ].filter(Boolean);

const currentRoute = () => (ai.mode === 'cloud' ? via : ai.mode === 'private' ? 'private' : 'local');
const showChooser = () => ai.status !== 'connected' && (choosing || (!ai.modeChosen && !ai.paired && ai.status === 'idle'));

async function copy(which, textToCopy) {
  try {
    await navigator.clipboard.writeText(textToCopy);
    copied = which;
  } catch {
    copied = `${which}:manual`;
  }
  renderMenu();
  setTimeout(() => {
    copied = '';
    renderMenu();
  }, 1600);
}
const copyLabel = (which) => (copied === which ? 'Copied' : copied === `${which}:manual` ? 'Select and copy' : 'Copy');
const codeRow = (which, value) => h('div', { class: 'code-row' }, h('code', { class: 'aic-code' }, value), h('button', { class: 'btn small', type: 'button', onclick: () => copy(which, value) }, copyLabel(which)));
const spinner = (t) => h('p', { class: 'aic-wait' }, h('span', { class: 'aic-spin', 'aria-hidden': 'true' }), t);
const others = () => (ROUTES().length > 1 ? h('button', { class: 'link-btn', type: 'button', onclick: () => ((choosing = true), renderMenu()) }, 'Other ways to connect') : null);

function chooserView() {
  const cur = ai.modeChosen || ai.paired ? currentRoute() : null;
  return [
    h('p', { class: 'menu-note' }, 'Let the AI you already use work in Caliper: it sees the model as you do and can build, measure, check and export it while you watch. Pick the way that fits.'),
    h(
      'div',
      { class: 'aic-opts' },
      ROUTES().map((r) =>
        h(
          'button',
          {
            class: `aic-opt${r.id === cur ? ' current' : ''}`,
            type: 'button',
            'data-route': r.id,
            onclick: () => {
              choosing = false;
              promptShown = false;
              via = r.id === 'connector' ? 'connector' : 'prompt';
              try {
                localStorage.setItem(VIA_KEY, via);
              } catch {
                /* convenience */
              }
              if (r.id === 'local') ai.connect({ mode: 'local' });
              else ai.setMode(r.id === 'private' ? 'private' : 'cloud');
              renderMenu();
            },
          },
          h('span', { class: 'aic-t' }, r.title, r.tag ? h('span', { class: 'aic-tag' }, r.tag) : null),
          h('span', { class: 'aic-d' }, h('b', {}, 'Choose this if '), r.when),
          h('span', { class: 'aic-n' }, r.note),
        ),
      ),
    ),
  ];
}

function routeView() {
  const st = ai.status;
  const err = st === 'error' ? h('p', { class: 'aic-err' }, ai.statusDetail || 'Something went wrong.') : null;
  if (ai.mode === 'local') {
    if (st === 'offline' || (ai.paired && st === 'connecting'))
      return [h('h3', {}, 'Your AI is not running'), h('p', { class: 'menu-note' }, 'Caliper is already connected to the AI on this computer. It reconnects as soon as your AI app is open (it starts the bridge by itself).'), spinner('Looking for it…'), others()];
    return [
      h('h3', {}, 'On this computer only'),
      err,
      h('p', { class: 'aic-step' }, 'Tell your AI'),
      codeRow('pair', ai.pairPhrase),
      st === 'waiting' || st === 'connecting' ? spinner('Waiting for your AI…') : null,
      h('p', { class: 'aic-step' }, 'First time? Add AI Connect to your AI'),
      codeRow('setup', ai.setupCommand),
      h('p', { class: 'menu-note' }, `That line is for Claude Code. Any MCP client works with the server command ${ai.setupCommand.split(' -- ')[1]}. It runs only on this computer (127.0.0.1); use Chrome or Edge and allow the local-network prompt.`),
      st === 'error' ? h('button', { class: 'btn small', type: 'button', onclick: () => ai.connect() }, 'Try again') : null,
      others(),
    ];
  }
  if (ai.mode === 'private') {
    return [
      h('h3', {}, 'Private connection'),
      h('p', { class: 'menu-note' }, 'Your AI reaches Caliper through a hub that runs in your own browser. The relay in between only passes encrypted data.'),
      err,
      h('button', { class: 'btn primary block', type: 'button', id: 'aic-hub', onclick: () => ai.connect({ mode: 'private' }) }, st === 'idle' ? 'Open my hub' : 'Open my hub again'),
      st === 'approval' || st === 'offline' ? spinner(st === 'approval' ? 'Approve Caliper in the hub window…' : 'Waiting for your hub window. Keep it open while you work.') : null,
      h('p', { class: 'menu-note' }, 'The first time, the hub gives you a prompt to paste into your AI (or a connector address for Claude or ChatGPT in the browser). After that, one click here is enough.'),
      others(),
    ];
  }
  if (via === 'connector') {
    const waiting = st === 'approval' || st === 'connecting';
    return [
      h('h3', {}, 'Claude or ChatGPT in the browser'),
      h('p', { class: 'menu-note' }, 'These chat apps reach Caliper through a connector. Approve Caliper in a small window; the first time it gives you an address to add to your chat app (Claude: Customize, Connectors, Add custom connector).'),
      err,
      h(
        'button',
        {
          class: 'btn primary block',
          type: 'button',
          id: 'aic-approve',
          onclick: () => {
            window.open(ai.approvalUrl, 'ai-connect-connect', 'popup,width=460,height=640'); // inside the click, for popup blockers
            ai.connect({ mode: 'cloud' });
          },
        },
        waiting ? 'Open the approval window again' : 'Approve Caliper',
      ),
      waiting ? spinner('Waiting for you to click Allow in the window…') : null,
      others(),
    ];
  }
  const waiting = st === 'approval' || st === 'connecting' || st === 'offline';
  return [
    h('h3', {}, 'Paste a prompt'),
    h('p', { class: 'menu-note' }, 'Copy this prompt into the AI you already use (Claude Code, Codex, Cursor…). It connects itself to Caliper: nothing to install.'),
    err,
    h(
      'button',
      {
        class: 'btn primary block',
        type: 'button',
        id: 'aic-prompt',
        onclick: () => {
          ai.connect({ mode: 'cloud' }); // opens the waiting connection first, so the link is live when the AI fetches it
          promptShown = true;
          copy('prompt', ai.setupPrompt);
        },
      },
      copied === 'prompt' ? 'Copied' : promptShown && waiting ? 'Copy the prompt again' : 'Copy prompt for my AI',
    ),
    promptShown && waiting ? h('div', { class: 'aic-prompt' }, h('code', { id: 'aic-prompt-text' }, ai.setupPrompt)) : null,
    promptShown && waiting ? spinner('Paste it into your AI. Waiting for it to connect…') : null,
    h('p', { class: 'menu-note' }, 'The prompt works once and expires after 15 minutes.'),
    others(),
  ];
}

function connectedView() {
  const cloud = ai.agent?.mode === 'cloud';
  const settling = cloud && !ai.listening && ai.aiSeen !== false && ai.aiArrivedAt && Date.now() - ai.aiArrivedAt < 90000;
  return [
    h('h3', {}, 'Connected'),
    h('p', { class: 'menu-note' }, cloud ? 'Your AI can see and edit this part. Talk to it in the chat panel, or in its own window; what it does shows up beside the model.' : 'Your AI can see and edit this part. Ask it in its own window; what it does shows up beside the model.'),
    cloud && !ai.listening && !settling ? [h('p', { class: 'aic-step' }, 'To chat from Caliper, tell your AI'), codeRow('listen', ai.listenPhrase)] : null,
    h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        id: 'agent-disconnect',
        onclick: () => {
          ai.forget();
          promptShown = false;
          renderMenu();
        },
      },
      'Disconnect',
    ),
  ];
}

export function statusText() {
  if (!ai) return '';
  const st = ai.status;
  if (st === 'connected') {
    if (ai.agent?.mode === 'cloud') return ai.listening ? 'Connected · your AI is listening to the chat' : ai.aiSeen === false ? 'Connected to your hub · no AI yet' : 'Connected · your AI is not listening to the chat';
    return `Connected to ${ai.agent?.label && ai.agent.label !== 'MCP client' ? ai.agent.label : 'your AI'} on this computer`;
  }
  if (st === 'approval') return ai.mode === 'cloud' && via === 'prompt' ? 'Waiting for your AI to connect…' : ai.mode === 'private' ? 'Waiting for your hub…' : 'Waiting for you to approve Caliper…';
  return { idle: 'No AI connected.', waiting: 'Waiting for your AI…', connecting: 'Connecting…', offline: 'Your AI is offline.', error: 'Connection problem.' }[st] || st;
}

function renderMenu() {
  if (!ai) return;
  const st = ai.status;
  const btn = $('agent-btn');
  btn.dataset.state = st === 'connected' ? 'live' : st === 'idle' ? 'off' : st === 'error' ? 'off' : 'retrying';
  $('agent-label').textContent = st === 'connected' ? (ai.agent?.mode === 'cloud' ? (ai.listening ? 'AI listening' : 'AI connected') : 'AI connected') : 'Connect AI';
  $('agent-status').textContent = statusText();
  const body = $('agent-body');
  // Keep the menu where it is while it redraws (a status change, a "Copied" label).
  const top = body.parentElement.scrollTop;
  body.replaceChildren(...[st === 'connected' ? connectedView() : showChooser() ? chooserView() : routeView()].flat(2).filter(Boolean));
  body.parentElement.scrollTop = top;
  emit('agent-link');
}

// ---------- asking the person ----------
function ask({ question, expect = 'selection', from = 'Agent', timeout = 180000, signal }) {
  return new Promise((resolve) => {
    const bar = $('ask');
    const input = $('ask-input');
    $('ask-from').textContent = from;
    $('ask-text').textContent = question;
    $('ask-hint').textContent = expect === 'selection' ? 'Click faces or edges in the view (Shift-click for more), then press Done.' : '';
    input.hidden = expect !== 'text';
    input.value = '';
    $('ask-done').textContent = expect === 'confirm' ? 'Yes' : expect === 'text' ? 'Send' : 'Done';
    $('ask-cancel').textContent = expect === 'confirm' ? 'No' : 'Cancel';
    bar.hidden = false;
    if (expect === 'text') input.focus();
    logActivity(from, `asked: ${question}`);
    const finish = (out) => {
      bar.hidden = true;
      clearTimeout(timer);
      $('ask-done').onclick = $('ask-cancel').onclick = input.onkeydown = null;
      signal?.removeEventListener('abort', onAbort);
      if (!out.timed_out && !out.withdrawn) logActivity('user', out.cancelled ? 'declined the question' : expect === 'text' ? `answered: ${out.answer}` : 'answered the question');
      resolve(out);
    };
    const onAbort = () => finish({ withdrawn: true });
    const timer = setTimeout(() => finish({ timed_out: true, note: 'The person did not answer in time.' }), timeout);
    signal?.addEventListener('abort', onAbort);
    $('ask-done').onclick = () => finish(expect === 'confirm' ? { confirmed: true } : expect === 'text' ? { answer: input.value } : { done: true });
    $('ask-cancel').onclick = () => finish(expect === 'confirm' ? { confirmed: false } : { cancelled: true });
    input.onkeydown = (e) => {
      if (e.key === 'Enter') $('ask-done').click();
      e.stopPropagation();
    };
  });
}

// What the person has selected and is doing, sent with each chat message so "this" means something.
function context() {
  const f = store.sel.feature ? store.doc.features.find((x) => x.id === store.sel.feature) : null;
  return {
    part: store.doc.name,
    mode: store.mode.kind,
    selected_feature: f ? { id: f.id, type: f.type, name: f.name } : null,
    selected_body: store.sel.body || null,
    picked: store.sel.picks.map((p) => `${p.b}:${p.kind === 'face' ? 'F' : 'E'}${p.i}`),
    bodies: (store.results?.bodies || []).filter((b) => !b.kind || b.kind === 'board').map((b) => ({ id: b.id, name: b.name })),
  };
}

export function initAgentPanel() {
  act.app.ask = ask;
  if (window.claude?.use) {
    // Inside a Claude artifact the page cannot open the connections AI Connect needs.
    $('agent-btn').parentElement.hidden = true;
    return null;
  }
  ai = createConnection({
    context,
    // Tools marked to confirm ask in Caliper's own prompt bar.
    confirm: async (call, message) => (await ask({ question: message, expect: 'confirm', from: agentName(ai, call) })).confirmed === true,
  });
  ai.on('status', () => {
    if (ai.status === 'connected') choosing = false;
    renderMenu();
  });
  ai.on('activity', (a) => {
    // Reads show as quiet lines; changes are logged by the store (see the 'activity' handler below).
    if (a.status === 'running' && READS[a.name] && !a.inChat) line(agentName(ai, a), READS[a.name], 'muted');
    if (a.status === 'error' && !READS[a.name] && !a.inChat) line(agentName(ai, a), `${a.name} failed: ${(a.error || '').slice(0, 160)}`, 'warn');
    if (a.status === 'denied') line(agentName(ai, a), `${a.name}: you declined`, 'muted');
  });
  // Changes the AI makes show up in the side panel (unless they belong to a chat answer, which shows them itself).
  on('activity', (e) => {
    if (e.by === 'user' || e.by === 'Assistant' || $('assistant')?.classList.contains('running')) return;
    line(e.by, e.text);
  });

  const btn = $('agent-btn');
  const menu = $('agent-menu');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
    // Local mode can start looking for the bridge as soon as the menu opens; the others need a click.
    if (!menu.hidden && !showChooser() && ai.status === 'idle' && ai.mode === 'local') ai.connect();
    renderMenu();
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.addEventListener('keydown', (e) => e.stopPropagation()); // keys typed here are not modelling shortcuts
  document.addEventListener('click', () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  });
  $('agent-ico').innerHTML = ICON.agent;
  renderMenu();
  setInterval(() => ai.status === 'connected' && ai.agent?.mode === 'cloud' && renderMenu(), 15000); // the "getting ready" grace period ends
  return ai;
}

export const agentLink = () => ai;
export const openAgentMenu = () => {
  const btn = $('agent-btn');
  if (btn && !btn.parentElement.hidden && $('agent-menu').hidden) setTimeout(() => btn.click(), 0);
};
export { store };
