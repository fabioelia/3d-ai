// The tools Caliper offers to AI agents. Plain data, served by the MCP bridge (bridge/server.mjs), so
// every agent sees the same surface. Implementations: src/agent/tools.js.

const selector = {
  description:
    'Which faces or edges. Refs from get_state, query_geometry or screenshot labels ("extrude1:F3", or a list of them), or a selector: "all", "top", {"on":"top"}, {"parallel":"z"}, {"kind":"circle"}, {"near":[x,y,z]}, {"face":"top"} (edges around a face), {"at":{"z":10}}, {"box":[[x0,y0,z0],[x1,y1,z1]]}, {"body":"Body 2"}; a list means "any of these".',
};
const vec3 = { type: 'array', items: { type: ['number', 'string'] }, minItems: 3, maxItems: 3 };
const VIEWS = ['current', 'iso', 'top', 'bottom', 'front', 'back', 'right', 'left'];
const PART_CHANGE = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: 'Part reference, e.g. "U4".' },
    x: { type: ['number', 'string'], description: 'Package origin X on the board (mm; Eagle coordinates).' },
    y: { type: ['number', 'string'] },
    center: { ...vec3, minItems: 2, maxItems: 2, description: 'Put the centre of the body here instead of setting x/y.' },
    rot: { type: ['number', 'string'], description: 'Absolute rotation in degrees (counter-clockwise seen from the top).' },
    turn: { type: 'number', description: 'Turn by this many degrees about the body centre.' },
    side: { type: 'string', enum: ['top', 'bottom'], description: 'Flipping keeps the body where it is.' },
    off: { type: 'boolean', description: 'true takes the part off the board (it waits beside it); false puts it back.' },
    h: { type: ['number', 'string'], description: 'Body height in mm.' },
    lift: { type: ['number', 'string'], description: 'Gap under the body (about 8.5 for a module on pin headers).' },
    body: { type: 'object', properties: { w: { type: 'number' }, d: { type: 'number' }, cx: { type: 'number' }, cy: { type: 'number' } }, description: 'Body size and centre in package coordinates.' },
    shape: { type: 'string', enum: ['box', 'cylinder'] },
    value: { type: 'string' },
    color: { type: 'string' },
    add: { type: 'boolean', description: 'Create the part as a plain block if it does not exist.' },
    remove: { type: 'boolean' },
  },
  required: ['ref'],
};

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
        view: { type: 'string', enum: [...VIEWS, 'all', 'board'], default: 'current', description: '"board" is the 2D placement view of a circuit board (what the person sees in the placement editor).' },
        board: { type: 'string', description: 'With view "board": which board feature (default: the open or only one).' },
        from_below: { type: 'boolean', description: 'With view "board": look from the bottom side.' },
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
    name: 'import_file',
    title: 'Import a 3D file or a circuit board',
    description:
      'Bring a file from the local disk into the model. Eagle / Fusion Electronics schematics (.sch) and boards (.brd) become a board feature: every part with its footprint, pads, body size and an estimated height, the nets (shown as airwires), and for a .brd the outline, holes and placement; a schematic gets its parts arranged on a board drawn to fit. 3D files become Import features: STL, STEP/STP, OBJ or 3MF, or a .zip of them (as model sites deliver). STEP files with real surfaces come in as exact solids. Meshes (STL, OBJ, 3MF, and STEP files that only hold a mesh, as Fusion\'s tessellated export does) are repaired, then small clean ones become exact solids whose flat faces can be sketched on, filleted and shelled, larger ones mesh bodies (moved, joined, cut, patterned), and ones that still are not closed reference meshes (shown, moved, measured and exported, but never cut or joined). One file is centred on the bed; several keep the layout they share, centred as a group. Read the notes in the report: they say how each file came in and what was repaired.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .stl, .step, .stp, .obj, .3mf, .sch, .brd or .zip file on this computer.' },
        name: { type: 'string', description: 'Name for the part in the timeline (single file only).' },
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
      'Do what the person could do with the mouse: open a sketch for editing (edit_sketch + feature) so they can draw in it, finish_sketch, edit_board (open the placement editor for a board feature), exit_mode (leave sketching, picking or the placement editor), focus_feature (open a feature in the inspector), show_panel (timeline, inspector or assistant, on small screens), undo / redo (steps).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['edit_sketch', 'finish_sketch', 'edit_board', 'exit_mode', 'focus_feature', 'show_panel', 'undo', 'redo'] },
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
      'Export the model: STL (binary, millimetres; quality draft/standard/fine; circuit boards and their parts are left out unless named in bodies), STEP (exact solids, boards and parts included; mesh bodies are left out), the Caliper project (.caliper.json, with imported files embedded), or eagle_script: a .scr that moves, turns and flips every placed part, and draws the outline and holes, in the Eagle / Fusion Electronics board editor. Through the MCP bridge the file is written to `path` on this computer (default: ./caliper-exports/<part name>.<ext>).',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['stl', 'step', 'project', 'eagle_script'] },
        board: { type: 'string', description: 'With eagle_script: which board (default: the open or only one).' },
        path: { type: 'string' },
        quality: { type: 'string', enum: ['draft', 'standard', 'fine'], default: 'standard' },
        bodies: { type: 'array', items: { type: 'string' }, description: 'Body ids to include (default: all).' },
      },
      required: ['format'],
    },
  },
  {
    name: 'place_parts',
    title: 'Place parts on a circuit board',
    description:
      'Lay out a board feature (from an Eagle .sch/.brd or written by hand): move, turn, flip (top/bottom), lift, resize or take parts off the board; set the outline (rect {w,h,r}, circle {d}, or path {pts}), thickness, holes and where the board sits in 3D (at, rot); or let Caliper arrange parts automatically (arrange "all", "rest" or a list of refs; sides ["top"] or ["top","bottom"]). Parts that would hang off the board wait beside it with off: true. Coordinates are the board\'s own millimetres seen from the top (Eagle coordinates); a bottom part is mirrored. Returns the placement problems (overlaps, edge, holes, unplaced) and the airwire length to route.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Board feature id (default: the open or only one).' },
        parts: { type: 'array', items: PART_CHANGE },
        arrange: { description: '"all", "rest" (the parts not on the board) or a list of refs to place automatically, biggest first.', anyOf: [{ type: 'string', enum: ['all', 'rest'] }, { type: 'array', items: { type: 'string' } }] },
        sides: { type: 'array', items: { type: 'string', enum: ['top', 'bottom'] }, description: 'Sides to fill when arranging, in order (default ["top"]).' },
        gap: { type: 'number', default: 1, description: 'Space between parts when arranging (mm).' },
        margin: { type: 'number', default: 1, description: 'Space from the board edge when arranging (mm).' },
        outline: { type: 'object', description: '{"kind":"rect","w":60,"h":40,"r":2} or {"kind":"circle","d":58} or {"kind":"path","pts":[[x,y],…]}; x/y shift rect and circle.' },
        thickness: { type: ['number', 'string'] },
        holes: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, d: { type: 'number' } } }, description: 'Replaces all mounting holes.' },
        at: { ...vec3, description: 'Where the board origin sits in the model; its underside is at z.' },
        rot: { ...vec3, description: 'Board rotation in degrees about x, y, z (e.g. [90,0,0] stands it upright).' },
      },
    },
  },
  {
    name: 'check_board',
    title: 'Check a board layout',
    description:
      'Placement check for a board: parts that collide (same side, footprints overlap and heights overlap), hang off the edge or come too close to it, sit over mounting holes, or are not on the board; then a 3D check of every part and the board against the other bodies (the enclosure): collisions with overlap volume and anything closer than `clearance`. Also the longest nets by airwire length and every part with its position, side and size.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string' },
        clearance: { type: 'number', default: 0.5, description: 'Report parts closer than this to the enclosure (mm).' },
        edge_clearance: { type: 'number', default: 0.5 },
        hole_clearance: { type: 'number', default: 0.5 },
        enclosure: { type: 'boolean', default: true, description: 'false skips the 3D check.' },
        parts: { type: 'boolean', default: true, description: 'false leaves out the part list.' },
      },
    },
    annotations: { readOnlyHint: true },
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
