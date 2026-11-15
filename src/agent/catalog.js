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
    model: { description: '3D model: "auto" (drawn from the footprint), "box" (plain block), or {rot:[x,y,z], at:[x,y,z], units} to adjust a model file set with import_file board_part.', anyOf: [{ type: 'string', enum: ['auto', 'box'] }, { type: 'object' }] },
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
      'Bring a file from the local disk into the model. Circuit files become a board feature: Eagle / Fusion Electronics .sch and .brd, KiCad .kicad_pcb, .kicad_sch and .net. Every part comes with its footprint (pads, body, an estimated height; KiCad schematics and netlists get footprints from their standard library names), the nets (airwires), and for a board file also the outline, holes, placement and copper (tracks, vias); a schematic or netlist gets its parts arranged on a board drawn to fit. With board_part, a STEP/STL file becomes the 3D model of that part. 3D files become Import features: STL, STEP/STP, OBJ or 3MF, or a .zip of them (as model sites deliver). STEP files with real surfaces come in as exact solids. Meshes (STL, OBJ, 3MF, and STEP files that only hold a mesh, as Fusion\'s tessellated export does) are repaired, then small clean ones become exact solids whose flat faces can be sketched on, filleted and shelled, larger ones mesh bodies (moved, joined, cut, patterned), and ones that still are not closed reference meshes (shown, moved, measured and exported, but never cut or joined). One file is centred on the bed; several keep the layout they share, centred as a group. Read the notes in the report: they say how each file came in and what was repaired.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .stl, .step, .stp, .obj, .3mf, .sch, .brd, .kicad_pcb, .kicad_sch, .net or .zip file on this computer.' },
        board_part: { type: 'string', description: 'Use this STEP/STL/OBJ/3MF file as the 3D model of one board part (its ref, e.g. "U4") instead of importing it as a body. With "board" when there are several boards; rot/at/units adjust it.' },
        board: { type: 'string' },
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
      'Export the model: STL (binary, millimetres; quality draft/standard/fine; circuit boards and their parts are left out unless named in bodies), 3MF (each body a separate object, for slicers that arrange parts on the plate), STEP (exact solids, boards and parts included; mesh bodies are left out), the Caliper project (.caliper.json, with imported files embedded), eagle_script: a .scr that moves, turns and flips every placed part, and draws the outline and holes, in the Eagle / Fusion Electronics board editor; gerber: a zip of Gerber copper, mask, silkscreen and outline layers, Excellon drill files, a BOM and a part-positions file for a board house; or bom: the bill of materials as CSV (the note warns about unrouted connections and design-rule errors). Through the MCP bridge the file is written to `path` on this computer (default: ./caliper-exports/<part name>.<ext>).',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['stl', '3mf', 'step', 'project', 'eagle_script', 'gerber', 'bom'] },
        board: { type: 'string', description: 'With eagle_script, gerber or bom: which board (default: the open or only one).' },
        path: { type: 'string' },
        quality: { type: 'string', enum: ['draft', 'standard', 'fine'], default: 'standard' },
        bodies: { type: 'array', items: { type: 'string' }, description: 'Body ids or names to include (default: all printable bodies; bodies the person hid are still included unless you list the others).' },
      },
      required: ['format'],
    },
  },
  {
    name: 'place_parts',
    title: 'Place parts on a circuit board',
    description:
      'Lay out a board feature (from an Eagle .sch/.brd or written by hand): move, turn, flip (top/bottom), lift, resize or take parts off the board; set the outline (rect {w,h,r}, circle {d}, or path {pts}), thickness, holes and where the board sits in 3D (at, rot); or let Caliper arrange parts automatically (arrange "all", "rest" or a list of refs; sides ["top"] or ["top","bottom"]; connected parts go near each other), or optimize the current layout for shorter connections. Parts that would hang off the board wait beside it with off: true. Coordinates are the board\'s own millimetres seen from the top (Eagle coordinates); a bottom part is mirrored. Returns the placement problems (overlaps, edge, holes, unplaced) and the airwire length to route.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Board feature id (default: the open or only one).' },
        parts: { type: 'array', items: PART_CHANGE },
        arrange: { description: '"all", "rest" (the parts not on the board) or a list of refs to place automatically, biggest first.', anyOf: [{ type: 'string', enum: ['all', 'rest'] }, { type: 'array', items: { type: 'string' } }] },
        sides: { type: 'array', items: { type: 'string', enum: ['top', 'bottom'] }, description: 'Sides to fill when arranging, in order (default ["top"]).' },
        optimize: { type: 'boolean', description: 'Shorten the connections without rearranging: nudge parts toward what they connect to, turn and swap them where nothing clashes (parts in "keep" stay put).' },
        keep: { type: 'array', items: { type: 'string' }, description: 'Refs that optimize must not move (connectors at the edge, a part you placed on purpose).' },
        gap: { type: 'number', default: 1, description: 'Space between parts when arranging (mm).' },
        margin: { type: 'number', default: 1, description: 'Space from the board edge when arranging (mm).' },
        outline: { type: 'object', description: '{"kind":"rect","w":60,"h":40,"r":2} or {"kind":"circle","d":58} or {"kind":"path","pts":[[x,y],…]}; x/y shift rect and circle.' },
        fit_outline: { description: 'true, or {clearance, body}: shape the board to the inside of the enclosure (the other bodies) at the board\'s height, clearance mm (default 1) in from the wall. Runs after the other changes here (so set "at" in the same call), and before "arrange".', anyOf: [{ type: 'boolean' }, { type: 'object', properties: { clearance: { type: 'number' }, body: { type: 'string' } } }] },
        add_standoffs: { description: 'true, or {wall, screw}: add printed mounting posts (cylinder features joined to the enclosure) under each board hole, from the surface below up to the board, with a pilot hole for a self-tapping screw (default 0.78 × the hole). Do this once the board sits where it should in the enclosure.', anyOf: [{ type: 'boolean' }, { type: 'object', properties: { wall: { type: 'number' }, screw: { type: 'number' } } }] },
        thickness: { type: ['number', 'string'] },
        holes: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, d: { type: 'number' } } }, description: 'Replaces all mounting holes.' },
        at: { ...vec3, description: 'Where the board origin sits in the model; its underside is at z.' },
        rot: { ...vec3, description: 'Board rotation in degrees about x, y, z (e.g. [90,0,0] stands it upright).' },
      },
    },
  },
  {
    name: 'route_board',
    title: 'Route a circuit board',
    description:
      'Copper for a board on two layers (top and bottom): autoroute what is not routed yet (optionally only some nets, at a width), add traces ({net, layer, w, pts:[[x,y],…]}) and vias ({x, y, d, drill, net}) by hand, remove traces/vias by index (from get_state or check_board), clear copper (all, or some nets), add copper pours (a ground plane: pour GND on the bottom before autorouting), or set the design rules (trace, clearance, via, drill, edge, minTrace, minDrill in mm). Board coordinates, seen from the top. Returns what is still unrouted and the design-rule errors (clearance between nets, shorts, copper near the edge or holes, widths and drills).',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string' },
        action: { type: 'string', enum: ['autoroute', 'add', 'remove', 'clear', 'pour', 'rules'], default: 'autoroute' },
        pours: { type: 'array', items: { type: 'object', properties: { net: { type: 'string' }, layer: { type: 'string', enum: ['top', 'bottom'] }, clearance: { type: 'number' } } }, description: 'With action "pour": the copper pours (replacing any), e.g. [{"net":"GND","layer":"bottom"}]; [] removes them. A pour fills the free copper of a layer with a net, joining every pad of that net it reaches; set it before autorouting.' },
        nets: { type: 'array', items: { type: 'string' }, description: 'Limit autoroute or clear to these nets.' },
        width: { type: 'number', description: 'Trace width for this autoroute (mm).' },
        traces: { type: 'array', items: { type: 'object' } },
        vias: { type: 'array', items: { type: 'object' } },
        remove_traces: { type: 'array', items: { type: 'integer' } },
        remove_vias: { type: 'array', items: { type: 'integer' } },
        rules: { type: 'object', description: '{ "trace": 0.25, "clearance": 0.2, "via": 0.6, "drill": 0.3, "edge": 0.3, "minTrace": 0.15, "minDrill": 0.3 }' },
      },
    },
  },
  {
    name: 'check_board',
    title: 'Check a board layout',
    description:
      'Placement and copper check for a board: design-rule errors and unrouted connections when it has copper, parts that collide (same side, footprints overlap and heights overlap), hang off the edge or come too close to it, sit over mounting holes, or are not on the board; then a 3D check of every part and the board against the other bodies (the enclosure): collisions with overlap volume and anything closer than `clearance`. Also the longest nets by airwire length and every part with its position, side and size.',
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
