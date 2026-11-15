// The side-panel chat. It has no model of its own: messages go through AI Connect to the AI the
// person connected (Claude Code, Codex, Claude or ChatGPT…), which listens to this panel, works on the
// model with Caliper's tools and answers here. It runs on the person's own AI; there is no API key.
import { store, on, featureById } from './store.js';
import * as act from './actions.js';
import { h } from './ui.js';
import { agentLink, openAgentMenu } from './agent/panel.js';
import { setAttachments } from './agent/connect.js';

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
  get_attachments: 'Looking at your images',
  place_parts: 'Placing parts',
  route_board: 'Routing',
  check_board: 'Checking the board',
};

const $ = (id) => document.getElementById(id);
const state = {
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

// The chat needs an AI that answers this panel: through the relay or the private hub it listens for
// messages; a bridge on this computer only takes requests in the AI's own window.
const connected = () => {
  const ai = agentLink();
  return !!(ai && ai.status === 'connected' && ai.agent?.chat);
};

function ask(text, turn, signal, onText) {
  return new Promise((resolve, reject) => {
    const ai = agentLink();
    const before = ai.messages.length;
    let msg = null;
    let off = null;
    const seen = new Set();
    const update = () => {
      msg ||= ai.messages.slice(before).find((m) => m.role === 'assistant') || null;
      if (!msg) return;
      for (const t of msg.tools) {
        if (seen.has(`${t.callId}:${t.status}`)) continue;
        seen.add(`${t.callId}:${t.status}`);
        if (t.status === 'running') turn.onStep(STEP_LABEL[t.name] || t.name);
      }
      if (msg.text) onText(msg.text);
      if (msg.pending) return;
      off?.();
      if (signal.aborted) reject(Object.assign(new Error(''), { cancelled: true, text: msg.text }));
      else if (msg.error) reject(Object.assign(new Error(msg.error), { text: msg.text }));
      else resolve(msg.text.trim());
    };
    off = ai.on('messages', update);
    signal.addEventListener('abort', () => ai.cancel());
    ai.send(text).then(update, (e) => {
      off?.();
      reject(e);
    });
  });
}

// ---------- UI ----------
// New text follows the bottom of the log only while the person is there, so reading back up is not yanked down.
const atBottom = (log) => log.scrollHeight - log.scrollTop - log.clientHeight < 48;

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
  // Read-only rather than disabled: disabling would throw the focus out of the box, and the next
  // keys typed would land on the model's shortcuts (E extrudes, F fillets…).
  $('chat-input').readOnly = on;
  $('assistant').classList.toggle('running', on);
}

async function send(text) {
  text = text.trim();
  if ((!text && !state.attachments.length) || state.running) return;
  if (!connected()) {
    renderStatus();
    openAgentMenu();
    return;
  }
  const ai = agentLink();
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
  setAttachments(images);
  if (images.length) notes.push(`The person attached ${images.length === 1 ? 'an image' : `${images.length} images`} (${images.map((a) => a.name).join(', ')}). Look at ${images.length === 1 ? 'it' : 'them'} with the get_attachments tool.`);
  for (const p of parts) notes.push(`The person dropped ${p.name} into the chat. Now in the model: ${p.files.join(', ')}.`);
  if (texts.length) notes.push(`The person attached ${texts.length === 1 ? 'a file' : `${texts.length} files`} for reference; ${texts.length === 1 ? 'it is' : 'they are'} at the end of this message.`);
  const files = texts.map((t) => `--- ${t.name}${t.cut ? ' (only the first part; the file is longer)' : ''} ---\n${t.text}\n--- end of ${t.name} ---`);
  const message = [...notes, text || (images.length ? 'Here is what I mean.' : 'What can you do with this?'), ...files].join('\n\n');
  const out = bubble('assistant', ai.listening ? 'Thinking…' : 'Waiting for your AI to pick this up…');
  if (!ai.listening) out.steps.append(h('span', { class: 'step warn' }, 'Your AI is not listening to this chat right now: see the Agent menu'));
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
  // Your AI's edits arrive as tool calls; count them by the undo history.
  const depth0 = store.undoStack.length;
  let got = '';
  const onText = (whole) => {
    got = whole;
    const follow = atBottom($('chat-log'));
    out.el.classList.remove('pending');
    out.body.textContent = whole;
    if (follow) $('chat-log').scrollTop = $('chat-log').scrollHeight;
  };
  try {
    const answer = await ask(message, turn, ctl.signal, onText);
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
  const ai = agentLink();
  const ok = connected();
  let note;
  if (ok) note = ai.listening ? 'Your own AI is listening here, through AI Connect. It sees what you see and can only use Caliper\'s tools.' : 'Your AI is connected but not listening to this chat. Open the Agent menu for the sentence that brings it back.';
  else if (ai?.status === 'connected') note = 'Your AI is connected on this computer. Ask it in its own window; what it does shows up here. To chat from Caliper, connect by pasting a prompt instead (Agent menu).';
  else note = 'The chat runs on the AI you already use (Claude Code, Codex, Claude or ChatGPT…). Connect it from the Agent menu.';
  $('chat-note').textContent = note;
  $('chat-connect').hidden = ok || ai?.status === 'connected';
  $('chat-input').placeholder = ok ? 'Describe a part, or a change to this one' : 'Connect your AI to start';
}

export function initAssistant() {
  if (window.claude?.use) {
    // Inside a Claude artifact the page cannot open AI Connect's connections.
    $('chat-form').hidden = true;
    $('chat-suggest').hidden = true;
    $('chat-empty').textContent = 'The Caliper chat connects to your own AI through AI Connect, which a claude.ai artifact cannot open. Open Caliper at fabioelia.github.io/3d-ai to chat. Modelling by hand works here as usual.';
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
    agentLink()?.reset(); // a fresh conversation
    $('chat-log').replaceChildren();
    $('chat-suggest').hidden = false;
    $('chat-empty').hidden = false;
  });
  $('chat-connect').addEventListener('click', openAgentMenu);
  // Clicking the note's hint opens the menu too.
  $('chat-note').addEventListener('click', () => !connected() && openAgentMenu());

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
