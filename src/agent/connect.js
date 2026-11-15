// Caliper's connection to the person's own AI, through AI Connect (github.com/fabioelia/ai-connect).
// Caliper registers its tools on the page (WebMCP); AI Connect lets the AI the person already uses
// (Claude Code, Codex, Cursor, Claude or ChatGPT in the browser) reach them by a pasted prompt, a
// private end-to-end encrypted hub, a connector, or a bridge on this computer. The tools run here, in
// the person's tab, on the live model. Caliper calls no model and needs no API key.
import { AIConnect } from '../vendor/ai-connect.js';
import { TOOLS } from './catalog.js';
import { runTool } from './tools.js';
import { GUIDE } from '../guide.js';

export const RELAY = 'https://ai-connect-relay.fabioelia.workers.dev';
export const HUB = 'https://relay.f1v.co';

// For local testing only: a relay on this computer (?relay=http://127.0.0.1:8787). Any other address
// is ignored, so a link cannot point the page at someone else's relay.
function relayOverride() {
  try {
    const q = new URLSearchParams(location.search).get('relay');
    if (q && /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/?$/.test(q)) return q.replace(/\/$/, '');
  } catch {
    /* no location */
  }
  return null;
}

// Who is acting, for the activity log and the undo history: the client's own name when it gives one.
export function agentName(ai, call) {
  const s = String(call?.source || '');
  if (/claude[-_ ]?code/i.test(s)) return 'Claude Code';
  if (/claude/i.test(s)) return 'Claude';
  if (/codex/i.test(s)) return 'Codex';
  if (/cursor/i.test(s)) return 'Cursor';
  if (/chatgpt|openai/i.test(s)) return 'ChatGPT';
  const label = String(ai.agent?.label || '').trim();
  if (!label || /^(your ai|mcp client|ai connect|relay|hub)$/i.test(label)) return 'Your AI';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const APP = {
  name: 'Caliper',
  description:
    'A browser CAD tool for 3D-printable parts: a parametric timeline (sketches, extrudes, fillets, shells, patterns, imports) on an exact OpenCascade kernel, plus circuit boards (Eagle and KiCad import, placement, routing, Gerbers) for building enclosures around electronics. The person sees every change live and can undo it.',
  instructions:
    'Read the guide first (the caliper-guide skill, or the get_guide tool): it explains the document format, units (millimetres, Z up, the bed is Z = 0) and how to pick faces and edges. Look before you change things (get_state, screenshot), make one change at a time, and check the build report each edit returns. Every edit is one undo step for the person. export_file saves the file in the person\'s browser; add return_data to also get the bytes back.',
};

// Images the person attached to their last chat message, for the get_attachments tool.
let attachments = [];
export const setAttachments = (list) => (attachments = list || []);

export function createConnection({ context, confirm } = {}) {
  const ai = new AIConnect({
    app: APP,
    relay: relayOverride() || RELAY,
    hub: relayOverride() ? undefined : HUB,
    storageKey: 'caliper.aic',
    context,
    confirm,
  });
  for (const def of TOOLS) {
    ai.tool({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      readOnly: !!def.annotations?.readOnlyHint,
      destructive: !!def.annotations?.destructiveHint,
      execute: async (args, call) => {
        const res = await runTool(def.name, args || {}, { by: agentName(ai, call), transport: 'aic' });
        if (res?.isError) throw new Error(res.content?.map((c) => c.text).filter(Boolean).join('\n') || `${def.name} failed.`);
        return { content: res.content };
      },
    });
  }
  ai.tool({
    name: 'get_attachments',
    description: 'The images the person attached to their latest message in Caliper\'s chat panel (photos, sketches, drawings of what they want).',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    execute: () => {
      if (!attachments.length) return 'No images are attached to the latest message.';
      return { content: [...attachments.map((a) => ({ type: 'image', data: a.data, mimeType: a.mediaType })), { type: 'text', text: `${attachments.length} image(s): ${attachments.map((a) => a.name).join(', ')}` }] };
    },
  });
  ai.skill({ name: 'caliper-guide', description: 'The full reference for Caliper documents: units, axes, every feature type and its fields, selectors, boards, and modelling advice. Read it before building or editing a part.', instructions: GUIDE });
  ai.skill({
    name: 'enclosure-for-a-board',
    description: 'Build a printable enclosure around a circuit board the person imported (Eagle or KiCad): fit, place, route, standoffs, fit check, export.',
    instructions:
      '1. get_state to find the board feature and any enclosure bodies.\n2. If there is an enclosure, place_parts with fit_outline so the board fits inside it; otherwise model the enclosure around the board outline (walls 2 mm, 0.5 mm clearance).\n3. place_parts arrange "all" (connected parts go together), then check_board and fix overlaps.\n4. route_board pour GND on the bottom, then autoroute; check_board until there are no unrouted connections and no design-rule errors.\n5. place_parts add_standoffs so the enclosure holds the board, then check_board for collisions with the walls.\n6. screenshot iso to show the person, then export_file gerber for the board and 3mf for the enclosure bodies.\nNever delete the person\'s bodies; ask with ask_user before big changes.',
  });
  ai.skill({
    name: 'make-it-printable',
    description: 'Check a part for FDM printing and fix what would not print well.',
    instructions:
      '1. check_printability (build_volume if the person named a printer).\n2. Bodies below or floating above the bed: add a move feature with "drop": true for those bodies.\n3. Large overhangs: prefer turning the part ("flat": a big flat face) over supports; replace fillets on downward edges with chamfers.\n4. Separate bodies that should be one part: join them; ones that are meant to print apart can stay (3MF keeps them as separate objects).\n5. Re-run check_printability and screenshot. Tell the person what changed; every change is undoable.',
  });
  return ai;
}
