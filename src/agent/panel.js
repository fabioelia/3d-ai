// The person's side of agent integration: the Agent menu (status, setup, connection code), agent
// activity in the side panel, and the prompt bar agents use to ask the person something.
import { store, on, emit, logActivity } from '../store.js';
import * as act from '../actions.js';
import { h, ICON } from '../ui.js';
import { BridgeLink, parseCode } from './link.js';

const $ = (id) => document.getElementById(id);
export const INSTALL = 'claude mcp add caliper -- npx -y github:fabioelia/3d-ai';
const READS = { get_state: 'read the model', screenshot: 'looked at the model', query_geometry: 'read the geometry', measure: 'measured', check_printability: 'checked printability', get_guide: 'read the guide' };

let link = null;

function line(by, textContent, kind = '') {
  const log = $('chat-log');
  const el = h('div', { class: `agent-line ${kind}` }, h('span', { class: 'agent-who' }, by), h('span', { class: 'agent-what' }, textContent));
  log.append(el);
  while (log.children.length > 400) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  $('chat-empty').hidden = true;
  $('chat-suggest').hidden = true;
}

function renderStatus() {
  emit('agent-link');
  const btn = $('agent-btn');
  const st = link.state;
  const agents = link.agents || [];
  btn.dataset.state = st === 'connected' ? (agents.length ? 'live' : 'bridge') : st;
  $('agent-label').textContent = st === 'connected' && agents.length ? agents.map((a) => a.name).join(', ') : 'Agent';
  const status = $('agent-status');
  if (st === 'connected') {
    status.textContent = agents.length
      ? `Connected. ${agents.map((a) => a.name).join(' and ')} can see and edit this part.`
      : `Connected to the Caliper bridge on ${link.addr.host}:${link.addr.port}. Waiting for an agent to attach.`;
  } else if (st === 'connecting') status.textContent = 'Connecting to the Caliper bridge…';
  else if (st === 'retrying') status.textContent = link.detail || 'Waiting for the Caliper bridge. It starts when your agent does.';
  else status.textContent = link.detail || 'No agent connected.';
  $('agent-disconnect').hidden = st === 'off';
  $('agent-connect-row').hidden = st === 'connected';
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

export function initAgentPanel() {
  act.app.ask = ask;
  if (window.claude?.use) {
    // Inside a Claude artifact the page cannot reach this computer; the built-in assistant covers it.
    $('agent-btn').parentElement.hidden = true;
    return null;
  }
  link = new BridgeLink({
    onStatus: renderStatus,
    onCall: ({ tool, args, by }) => {
      if (READS[tool]) line(by, `${READS[tool]}${tool === 'screenshot' && args?.view && args.view !== 'current' ? ` (${args.view})` : ''}`, 'muted');
    },
    onResult: ({ tool, by, result }) => {
      if (result?.isError && !READS[tool]) line(by, `${tool} failed: ${(result.content?.[0]?.text || '').slice(0, 160)}`, 'warn');
    },
  });
  // Changes agents make show up in the side panel, so the person sees what happened.
  on('activity', (e) => {
    if (e.by === 'user' || e.by === 'Assistant') return;
    line(e.by, e.text);
  });

  const btn = $('agent-btn');
  const menu = $('agent-menu');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  });
  $('agent-install').textContent = INSTALL;
  $('agent-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(INSTALL);
      $('agent-copy').textContent = 'Copied';
    } catch {
      const r = document.createRange();
      r.selectNodeContents($('agent-install'));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      $('agent-copy').textContent = 'Press Ctrl+C';
    }
    setTimeout(() => ($('agent-copy').textContent = 'Copy'), 1800);
  });
  const connect = () => {
    const addr = parseCode($('agent-code').value);
    if (!addr) {
      link.detail = 'That is not a connection code. It looks like 7429-1a2b3c… and comes from your agent (ask it to open Caliper).';
      renderStatus();
      return;
    }
    $('agent-code').value = '';
    link.connect(addr);
  };
  $('agent-connect').addEventListener('click', connect);
  $('agent-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connect();
    e.stopPropagation();
  });
  $('agent-disconnect').addEventListener('click', () => link.disconnect());
  $('agent-ico').innerHTML = ICON.agent;
  renderStatus();
  link.discover();
  return link;
}

export const agentLink = () => link;
export { store };
