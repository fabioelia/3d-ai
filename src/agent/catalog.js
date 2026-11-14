// The tools Caliper offers to AI agents. Plain data, shared by the MCP bridge (bridge/server.mjs) and
// the built-in assistant, so every agent sees the same surface. Implementations: src/agent/tools.js.

const selector = {
  description:
    'Which faces or edges. Refs from get_state, query_geometry or screenshot labels ("extrude1:F3", or a list of them), or a selector: "all", "top", {"on":"top"}, {"parallel":"z"}, {"kind":"circle"}, {"near":[x,y,z]}, {"face":"top"} (edges around a face), {"at":{"z":10}}, {"box":[[x0,y0,z0],[x1,y1,z1]]}, {"body":"Body 2"}; a list means "any of these".',
};
const vec3 = { type: 'array', items: { type: ['number', 'string'] }, minItems: 3, maxItems: 3 };
const VIEWS = ['current', 'iso', 'top', 'bottom', 'front', 'back', 'right', 'left'];

export const TOOLS = [
  {
    name: 'get_state',
    title: 'Get the full Caliper state',
    description:
      'Everything the person has in front of them: the document (named parameters and the ordered feature timeline, exactly as stored), the build report (errors per feature, notes, resolved parameter values, each body with size, bounds, volume and face/edge counts), what they are doing in the UI (mode, open sketch, selected faces/edges with their geometry, selected timeline feature, hovered element, camera, open panel) and a log of recent actions by the person and by agents. Call it first, and again whenever the person says they changed something. Pass `since` (from `next_since` of the previous call) to get only new activity.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: 'Only include activity entries after this sequence number.' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['document', 'build', 'view', 'activity'] },
          description: 'Parts to include (default: all).',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'screenshot',
    title: 'See the model',
    description:
      'Render the model and return the image. "current" is exactly the person\'s view (camera, selection, open sketch); named views frame the whole part from that side; "all" returns iso, top, front and right in one 2x2 image. labels="faces"/"edges"/"all" draws ref labels (F3, E12; prefixed A, B… when there are several bodies) on visible elements, with a legend mapping each label to its ref for use in selectors and measure. Rendering never moves the person\'s camera. Look after every meaningful change to check the result.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: [...VIEWS, 'all'], default: 'current' },
        labels: { type: 'string', enum: ['none', 'faces', 'edges', 'all'], default: 'none' },
        highlight: { ...selector, description: `Faces or edges to highlight in orange in this image only. ${selector.description}` },
        size: { type: 'string', enum: ['small', 'medium', 'large'], default: 'medium', description: 'small 640x480, medium 1024x768, large 1600x1200' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'query_geometry',
    title: 'List faces, edges or bodies',
    description:
      'List the faces, edges or bodies of the built model with their refs and geometry: faces (type plane/cylinder/…, area, center, normal, radius), edges (type line/circle/…, length, start/end/mid, direction, radius and diameter), bodies (size, bounds, volume, center of mass, surface area). Filter with `where`. Use the refs in feature selectors (edges/faces), select, measure and screenshot highlights.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['face', 'edge', 'body'] },
        where: selector,
        limit: { type: 'integer', default: 60, description: 'Most items to return.' },
      },
      required: ['kind'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'measure',
    title: 'Measure',
    description:
      'Exact measurements from the solid model. One ref: its properties (a body: volume, area, bounds, center of mass; a face: area, normal, radius; an edge: length, radius/diameter). Two refs: minimum distance between them, the angle between two planes or two lines, the gap between parallel planes. Refs look like "extrude1:F3", "extrude1:E7" or a body id like "extrude1".',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'check_printability',
    title: 'Check for 3D printing',
    description:
      'FDM printability check of the current model as it sits on the bed (Z = 0): overhangs steeper than the threshold (with refs and area), bed contact area, bodies that float above the bed, separate bodies, size against a build volume, mesh triangle count. Run before export, and after changes that add overhangs.',
    inputSchema: {
      type: 'object',
      properties: {
        overhang_angle: { type: 'number', default: 45, description: 'Degrees from vertical beyond which an overhang needs support.' },
        build_volume: { ...vec3, description: 'Printer build volume in mm, e.g. [220, 220, 250].' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_model',
    title: 'Replace the model',
    description:
      'Replace the whole document (name, params, features) and rebuild. For new designs or large restructures; prefer edit_model for changes. One undo step. Returns the build report.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        params: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] } },
        features: { type: 'array', items: { type: 'object' }, description: 'The feature timeline in build order.' },
      },
      required: ['features'],
    },
  },
  {
    name: 'edit_model',
    title: 'Edit the model',
    description:
      'Change the current document and rebuild, as one undo step. set_params: {name: value}. patch: [{id, set: {field: value}, unset: [field]}] to change fields of existing features. upsert: whole feature objects that replace the one with the same id, or are added (at the end, or after the feature named in `after`). remove: feature ids. move: [{id, after}] to reorder (after: null puts it first). rename: new part name. Returns the build report with any feature errors; fix them before moving on.',
    inputSchema: {
      type: 'object',
      properties: {
        set_params: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
        patch: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, set: { type: 'object' }, unset: { type: 'array', items: { type: 'string' } } }, required: ['id'] } },
        upsert: { type: 'array', items: { type: 'object' } },
        after: { type: 'string' },
        remove: { type: 'array', items: { type: 'string' } },
        move: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, after: { type: ['string', 'null'] } }, required: ['id'] } },
        rename: { type: 'string' },
      },
    },
  },
  {
    name: 'import_stl',
    title: 'Import an STL file',
    description:
      'Bring an STL file (or a .zip of them, as model sites deliver) from the local disk into the model as Import features. Small clean meshes (up to about 6,000 triangles) become exact solids whose flat faces can be sketched on, filleted and shelled; larger ones become mesh bodies that can be moved, joined, cut and patterned; files that are not closed solids even after repair come in as reference meshes (shown, moved, measured and exported, but never cut or joined). One file is centred on the bed; several keep the layout they share, centred as a group. Read the notes in the report: they say how each file came in and what was repaired.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .stl or .zip file on this computer.' },
        name: { type: 'string', description: 'Name for the part in the timeline (single STL only).' },
        mode: { type: 'string', enum: ['auto', 'solid', 'mesh'], default: 'auto' },
        units: { type: 'string', enum: ['mm', 'cm', 'm', 'in'], default: 'mm' },
        scale: { type: 'number', default: 1 },
        align: { type: 'string', enum: ['bed', 'original'], default: 'bed' },
        at: vec3,
        rot: vec3,
        op: { type: 'string', enum: ['new', 'join', 'cut', 'intersect'], default: 'new' },
      },
      required: ['path'],
    },
  },
  {
    name: 'select',
    title: 'Select faces or edges for the person',
    description:
      'Set the person\'s selection to point at something ("this edge here") or to prepare a tool they will apply. Elements are highlighted in their view. Optionally also select a timeline feature (opens it in the inspector). Returns what was selected.',
    inputSchema: {
      type: 'object',
      properties: {
        elements: selector,
        kind: { type: 'string', enum: ['face', 'edge'], description: 'Needed when `elements` is a selector rather than refs.' },
        feature: { type: 'string', description: 'Timeline feature id to select, or "" to clear.' },
      },
    },
  },
  {
    name: 'set_view',
    title: 'Move the person\'s camera',
    description: 'Point the person\'s camera: a named view, fit the whole part, or focus on a face, edge or body ref.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: VIEWS.filter((v) => v !== 'current') },
        fit: { type: 'boolean', default: true },
        focus: { type: 'string', description: 'A ref to zoom to.' },
      },
    },
  },
  {
    name: 'ui_action',
    title: 'Operate the interface',
    description:
      'Do what the person could do with the mouse: open a sketch for editing (edit_sketch + feature) so they can draw in it, finish_sketch, exit_mode (leave sketching or picking), focus_feature (open a feature in the inspector), show_panel (timeline, inspector or assistant, on small screens), undo / redo (steps).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['edit_sketch', 'finish_sketch', 'exit_mode', 'focus_feature', 'show_panel', 'undo', 'redo'] },
        feature: { type: 'string' },
        panel: { type: 'string', enum: ['timeline', 'inspector', 'assistant'] },
        steps: { type: 'integer', default: 1 },
      },
      required: ['action'],
    },
  },
  {
    name: 'show_message',
    title: 'Tell the person something in Caliper',
    description: 'Show a short message in Caliper (a toast, and a line in its activity log), for progress or a heads-up while the person is looking at the model rather than the chat.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['info', 'warning'], default: 'info' } },
      required: ['text'],
    },
  },
  {
    name: 'ask_user',
    title: 'Ask the person to point at something',
    description:
      'Show a prompt in Caliper and wait for the person: to select faces or edges ("Click the edges you want rounded, then Done"), to confirm, or to type a short answer. Returns their selection (with refs and geometry), answer, or that they cancelled. Waits up to timeout_seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        expect: { type: 'string', enum: ['selection', 'confirm', 'text'], default: 'selection' },
        timeout_seconds: { type: 'integer', default: 180, maximum: 900 },
      },
      required: ['question'],
    },
  },
  {
    name: 'export_file',
    title: 'Export a file',
    description:
      'Export the model: STL (binary, millimetres; quality draft/standard/fine), STEP (exact solids; mesh bodies are left out) or the Caliper project (.caliper.json, with imported files embedded). Through the MCP bridge the file is written to `path` on this computer (default: ./caliper-exports/<part name>.<ext>).',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['stl', 'step', 'project'] },
        path: { type: 'string' },
        quality: { type: 'string', enum: ['draft', 'standard', 'fine'], default: 'standard' },
        bodies: { type: 'array', items: { type: 'string' }, description: 'Body ids to include (default: all).' },
      },
      required: ['format'],
    },
  },
  {
    name: 'get_guide',
    title: 'Caliper document reference',
    description: 'The full reference for Caliper documents: units and axes, every feature type and its fields, selectors and refs, and modelling advice. Read it before writing features if you have not.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

// Tools handled by the bridge itself rather than the page.
export const BRIDGE_TOOLS = [
  {
    name: 'open_caliper',
    title: 'Open Caliper',
    description:
      'Make sure Caliper is open in a browser and connected to this agent. Opens it if needed and waits for it to connect. Returns the address to give the person, and who is connected. Call this first if other tools say Caliper is not connected.',
    inputSchema: { type: 'object', properties: { wait_seconds: { type: 'integer', default: 30 } } },
  },
];

export const toolByName = (name) => TOOLS.find((t) => t.name === name);
