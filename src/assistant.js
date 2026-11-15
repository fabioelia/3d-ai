// The side-panel chat. It has no model of its own: every message goes over MCP, through the Caliper
// bridge, to Claude Code on the person's computer, which works on the model with the same Caliper tools
// any agent gets and replies here. It runs on the person's own Claude login; there is no API key.
import { store, on, featureById } from './store.js';
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
  import_file: 'Importing',
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
  attachments: [], // for the next message: { kind: 'image', name, mediaType, data, url } | { kind: 'part', name, ids }
};
const MAX_IMAGES = 6;
const MAX_TEXT = 200 * 1024; // per file
const MAX_TEXT_TOTAL = 500 * 1024;
const MODEL_FILE = /\.(stl|step|stp|obj|3mf|zip|sch|brd|kicad_pcb|kicad_sch|net)$/i;
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;

// ---------- attachments ----------
// Images go to Claude with the message (scaled to at most 1568 px, which is what Claude looks at
// anyway). STL and zip files are imported into the model, and the message says which parts they became.
async function prepImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const hgt = Math.max(1, Math.round(bmp.height * k));
  const keep = k === 1 && file.size < 1.5e6 && IMAGE_TYPES.test(file.type);
  let blob = file;
  if (!keep) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hgt;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, hgt);
    ctx.drawImage(bmp, 0, 0, w, hgt);
    blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.88));
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { kind: 'image', name: file.name || 'image', mediaType: keep ? file.type : 'image/jpeg', data: btoa(bin), url: URL.createObjectURL(blob) };
}

// Anything else that is text (notes, CSV, JSON, schematics such as Eagle .sch, KiCad, G-code) is
// attached for Claude to read; other binary files are named but cannot be read.
function attachText(name, bytes) {
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return `${name} (not a text file)`;
  }
  if (content.includes('\u0000')) return `${name} (not a text file)`;
  const used = state.attachments.filter((a) => a.kind === 'text').reduce((n, a) => n + a.text.length, 0);
  if (used >= MAX_TEXT_TOTAL) return `${name} (too much text in one message)`;
  const limit = Math.min(MAX_TEXT, MAX_TEXT_TOTAL - used);
  const cut = content.length > limit;
  state.attachments.push({ kind: 'text', name, text: cut ? content.slice(0, limit) : content, cut });
  return null;
}

export async function attachFiles(files) {
  if (window.claude?.use) return false;
  const list = [...files];
  const images = list.filter((f) => f.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(f.name));
  const models = list.filter((f) => !images.includes(f) && MODEL_FILE.test(f.name));
  const other = list.filter((f) => !images.includes(f) && !models.includes(f));
  const unread = [];
  for (const f of other) {
    const why = attachText(f.name, new Uint8Array(await f.arrayBuffer()));
    if (why) unread.push(why);
  }
  for (const f of images) {
    if (state.attachments.filter((a) => a.kind === 'image').length >= MAX_IMAGES) {
      act.app.toast(`Up to ${MAX_IMAGES} images per message.`, 'error');
      break;
    }
    try {
      state.attachments.push(await prepImage(f));
    } catch {
      act.app.toast(`${f.name} could not be read as an image.`, 'error');
    }
  }
  if (models.length) {
    const extra = [];
    const ids = await act.importFiles(models, { others: extra });
    if (ids.length) state.attachments.push({ kind: 'part', name: models.map((f) => f.name).join(', '), ids, files: ids.map((id) => {
          const f = featureById(id);
          return f?.type === 'board' ? `${f.source || 'a board'} (board feature ${id}: ${(f.parts || []).length} parts, ${(f.nets || []).length} nets; lay it out with place_parts)` : `${f?.fileName || 'a file'} (Import feature ${id})`;
        }) });
    for (const e of extra) {
      const why = attachText(e.name, e.bytes);
      if (why) unread.push(why);
    }
  }
  if (unread.length) act.app.toast(`Could not attach ${unread.join(', ')}. The chat reads images and text files; Caliper imports STL, STEP, OBJ, 3MF and Eagle and KiCad boards.`, 'error');
  renderAttachments();
  if (state.attachments.length) $('chat-input').focus();
  return true;
}

function renderAttachments() {
  const tray = $('chat-attach');
  tray.hidden = !state.attachments.length;
  tray.replaceChildren(
    ...state.attachments.map((a, i) =>
      h(
        'span',
        { class: 'attach-chip', title: a.kind === 'part' ? `Imported into the model as ${a.ids.join(', ')}` : a.name },
        a.kind === 'image'
          ? h('img', { src: a.url, alt: '' })
          : a.kind === 'text'
            ? h('span', { class: 'attach-ico', html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>' })
            : h('span', { class: 'attach-ico', html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 4.500v9L12 21l-8-4.500v-9z"/><path d="M4 7.500l8 4.500 8-4.500M12 12v9"/></svg>' }),
        h('span', { class: 'attach-name' }, a.kind === 'part' ? `${a.name} (in the model)` : a.kind === 'text' ? `${a.name}${a.cut ? ' (first part)' : ''}` : a.name),
        h('button', {
          class: 'icon-btn',
          type: 'button',
          title: a.kind === 'part' ? 'Do not mention it in the message (it stays in the model)' : 'Remove',
          'aria-label': `Remove ${a.name}`,
          html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
          onclick: () => {
            const [gone] = state.attachments.splice(i, 1);
            if (gone?.url) URL.revokeObjectURL(gone.url);
            renderAttachments();
          },
        }),
      ),
    ),
  );
}

const connected = () => {
  const l = agentLink();
  return !!(l && l.state === 'connected' && l.chat?.available);
};

function ask(text, images, turn, signal, onText) {
  return new Promise((resolve, reject) => {
    let said = '';
    let gap = false;
    const cancel = agentLink().chatRequest({ text, sessionId: state.session, images }, (ev) => {
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
  if (/expired|could not be refreshed/i.test(msg)) return 'Claude Code\'s sign-in on this computer has expired. In a terminal, run "claude", type /login and sign in again, then send your message again.';
  if (/not logged in|\/login|authenticat|invalid api key|oauth/i.test(msg)) return 'Claude Code is not signed in on this computer. In a terminal, run "claude" and sign in (/login), then send again.';
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
  if ((!text && !state.attachments.length) || state.running) return;
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
  const attached = state.attachments.splice(0);
  renderAttachments();
  const images = attached.filter((a) => a.kind === 'image');
  const parts = attached.filter((a) => a.kind === 'part');
  const texts = attached.filter((a) => a.kind === 'text');
  const shown = bubble('user', text || (images.length ? '' : 'Here are the files.'));
  if (images.length) shown.el.prepend(h('div', { class: 'msg-images' }, images.map((a) => h('img', { src: a.url, alt: a.name }))));
  if (parts.length || texts.length) shown.el.append(h('div', { class: 'msg-steps' }, [...parts.map((p) => h('span', { class: 'step' }, `Imported ${p.name}`)), ...texts.map((t) => h('span', { class: 'step' }, t.name))]));
  // Tell Claude what came with the message; the parts themselves it can see in the model.
  const notes = [];
  if (images.length) notes.push(`The person attached ${images.length === 1 ? 'an image' : `${images.length} images`} (${images.map((a) => a.name).join(', ')}).`);
  for (const p of parts) notes.push(`The person dropped ${p.name} into the chat. Now in the model: ${p.files.join(', ')}.`);
  if (texts.length) notes.push(`The person attached ${texts.length === 1 ? 'a file' : `${texts.length} files`} for reference; ${texts.length === 1 ? 'it is' : 'they are'} at the end of this message.`);
  const files = texts.map((t) => `--- ${t.name}${t.cut ? ' (only the first part; the file is longer)' : ''} ---\n${t.text}\n--- end of ${t.name} ---`);
  const message = [...notes, text || (images.length ? 'Here is what I mean.' : 'What can you do with this?'), ...files].join('\n\n');
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
    const answer = await ask(message, images.map((a) => ({ mediaType: a.mediaType, data: a.data })), turn, ctl.signal, onText);
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

  // Attach by button, by dropping onto the chat panel, or by pasting into the message box.
  $('chat-file-btn').addEventListener('click', () => $('chat-file').click());
  $('chat-file').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) attachFiles(files);
  });
  const panel = $('assistant');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  panel.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    panel.classList.add('drop-target');
  });
  panel.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      panel.classList.remove('drop-target');
    }
  });
  panel.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
  });
  panel.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation(); // the window's own drop handler would import instead of attaching
    depth = 0;
    panel.classList.remove('drop-target');
    document.body.classList.remove('dropping');
    attachFiles(e.dataTransfer.files);
  });
  $('chat-input').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    attachFiles(files);
  });
  on('agent-link', renderStatus);
  renderStatus();
}
