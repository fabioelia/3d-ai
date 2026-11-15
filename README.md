# Caliper

A browser CAD tool for 3D-printable parts, in the spirit of Fusion's sketch → extrude → fillet workflow but with far fewer knobs. Any AI agent can plug in over MCP and see, measure and edit the same model you are looking at, while you watch.

**Live:** https://fabioelia.github.io/3d-ai/

- **Real solid modelling.** The geometry kernel is OpenCascade compiled to WebAssembly (through [replicad](https://replicad.xyz)), running in a worker. Fillets, chamfers, shells and booleans are exact B-rep operations, not mesh tricks, and STEP export keeps them exact.
- **Parametric timeline.** Every feature stays editable. Any number can be an expression over named parameters (`width/2 - wall`), and the model rebuilds as you type.
- **Sketching without constraints.** Rectangles, circles, polygons, slots, line paths and text snap to a grid and to each other; exact sizes go in the inspector. A shape drawn inside another becomes a cut-out.
- **Direct manipulation.** Click a face to sketch on it or push/pull it; click edges to fillet or chamfer them; click a face and Shell to hollow the part.
- **Agents over MCP.** Claude Code, Claude Desktop, Cursor or any MCP client gets the whole app as tools: the full state, screenshots of what you see, exact geometry and measurements, printability checks, every edit, your selection, your camera, import and export. See [Use it with an AI agent](#use-it-with-an-ai-agent-mcp).
- **Chat in Caliper.** Type in the side panel; your message goes over MCP to Claude Code on your computer, which works on the model with the same tools and replies there. No API key: it uses your Claude login. Drop, paste or attach images (photos, sketches), 3D files and documents (notes, CSV, schematics such as Eagle `.sch`): images and text go to Claude with your message, 3D files go into the model.
- **3D import.** STL, STEP/STP, OBJ and 3MF, or the zip a model site or a colleague sent. STEP with real surfaces comes in as exact solids; meshes (including Fusion's mesh-only "tessellated" STEP) are repaired automatically (zero-area slivers, T-junctions, duplicate faces, near-miss vertices). Small clean meshes become exact solids whose flat faces you can sketch on, fillet and shell; larger ones become mesh bodies you can move, cut, join and pattern; files that still are not closed solids come in as reference meshes you can view, move, measure and export. Other files in a zip go to the chat when you drop it there.
- **Circuit boards.** Like the board editors in Fusion, Eagle or KiCad. Import an Eagle / Fusion Electronics schematic (`.sch`) or board (`.brd`), or a KiCad board (`.kicad_pcb`), schematic (`.kicad_sch`) or netlist (`.net`): every part comes in with its footprint, pads, body size and height, plus the nets (KiCad schematics and netlists get footprints from KiCad's standard footprint names), and board files also bring their outline, holes, placement and copper. Place parts in a top-down editor (drag, turn with R, flip to the bottom with F, nudge, holes, outline, automatic arrangement on one or both sides) with airwires and live clash checks. Arrange parts automatically with connected parts kept together, or tidy your own layout for shorter connections. Fit the outline to the inside of your enclosure. Route on two copper layers by hand (45° traces, vias) or with the autorouter, add a ground pour, with design-rule checks (clearance, shorts, edge and hole clearance, widths, drills) as you go. Parts are drawn as real-looking 3D models by kind (banded resistors on bent leads, capacitors, headers with pins, modules on their pins, chips), or use your own STEP/STL per part; copper shows in 3D too. Model the enclosure around the board and check the fit. Export Gerber and drill files for a board house, or a `.scr` script that moves the parts in Eagle / Fusion; STL export leaves the electronics out and STEP keeps them.
- **Export.** Binary STL (three mesh qualities) and STEP. Projects save as JSON, with imported STLs embedded, and autosave in the browser.

## Use it with an AI agent (MCP)

The Caliper bridge is a small MCP server that runs on your computer. The agent talks MCP to it; Caliper, open in your browser, connects to it over a local WebSocket. Every tool call runs against the live model in your tab, so you see each change land in the timeline and the agent sees what you see.

**Chat from Caliper's side panel** (needs [Claude Code](https://claude.com/claude-code) installed and signed in):

```bash
npx -y github:fabioelia/3d-ai --http
```

This starts the bridge and opens Caliper in your browser. Type in the side panel: each message runs Claude Code headless on your computer (`claude -p`), with only Caliper's tools enabled (no shell, files or web), and its reply and actions stream back into the panel. Follow-up messages continue the same Claude Code session; **Clear** starts a new one. One message's changes undo together.

**Or drive it from a Claude Code session**

```bash
claude mcp add caliper -- npx -y github:fabioelia/3d-ai
```

Then ask: *"Open Caliper and make me a wall bracket for a 25 mm pipe."* The agent calls `open_caliper`, which opens Caliper in your browser and connects it.

**Claude Desktop, Cursor, and other MCP clients**: add a stdio server with command `npx` and arguments `-y github:fabioelia/3d-ai`. For Claude Desktop, in `claude_desktop_config.json`:

```json
{ "mcpServers": { "caliper": { "command": "npx", "args": ["-y", "github:fabioelia/3d-ai"] } } }
```

**HTTP instead of stdio**: run `npx -y github:fabioelia/3d-ai --http` (or `npm run bridge` in a checkout) and point the client at `http://127.0.0.1:7429/mcp`, for example `claude mcp add --transport http caliper http://127.0.0.1:7429/mcp`.

How the page finds the bridge:

- Run from a built checkout (`npm run bundle` first), the bridge serves Caliper itself at `http://127.0.0.1:7429/`, and that page connects automatically.
- Otherwise it opens the hosted app with a connection code in the link (`…/3d-ai/#bridge=7429-…`). Your browser may ask once to allow the page to reach this computer.
- Or open the **Agent** menu in Caliper and paste the code the agent gives you.

The page keeps reconnecting while the agent restarts. Several agents can work in the same tab at once; the Agent button shows who is attached, and their changes appear in the side panel.

What an agent gets:

| Tool | What it does |
| --- | --- |
| `open_caliper` | Opens Caliper and waits for it to connect. |
| `get_state` | The document, build report (errors, notes, bodies), your selection, mode, open sketch, camera, and a log of what you and other agents did. |
| `screenshot` | Your exact view, or iso/top/front/… or all four at once, with optional face and edge labels and a legend of refs. |
| `query_geometry`, `measure` | Every face, edge and body with type, size, position, radius; exact distances and angles. |
| `check_printability` | Overhangs (with the faces responsible), bed contact, floating or separate bodies, fit in a build volume. |
| `set_model`, `edit_model` | Build or change the parametric timeline. One call is one undo step. |
| `import_file`, `export_file` | Read a 3D file (STL, STEP, OBJ, 3MF or a zip) or an Eagle / KiCad board, schematic or netlist from disk into the model (or a STEP as one part's 3D model); write STL, STEP, the project, Gerbers or an Eagle placement script to disk. |
| `place_parts`, `route_board`, `check_board` | Lay out a circuit board (move, turn, flip, lift, resize parts; outline, holes, auto-arrange; part 3D models), route it (autoroute, add or remove traces and vias, design rules) and check it: clashes, design-rule errors, unrouted connections, collisions with the enclosure. `screenshot` with view `board` shows the layout; `export_file` writes Gerbers. |
| `select`, `set_view`, `ui_action` | Point at things in your view, move your camera, open sketches, undo and redo. |
| `ask_user`, `show_message` | Ask you to click the faces or edges it should use (or confirm, or type an answer), and tell you things in Caliper. |

Faces and edges are referred to by refs like `extrude1:F3`, which the agent gets from `get_state`, `query_geometry` or screenshot labels. Refs it writes into features are stored with their geometry, so they keep pointing at the same edge when earlier dimensions change.

Security: the bridge listens on 127.0.0.1 only, rejects other host names and browser origins, and the page must present a per-user secret (kept in `~/.config/caliper/bridge.json`) to connect. `import_stl` and `export_file` read and write files with the agent's permissions, relative to its working directory.

## Run it

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run bundle     # dist/: index.html (single file), kernel.wasm, mesh.wasm, font.ttf
                   # (named `bundle`, not `build`, so `npx github:…` installs only the bridge)
npm run bridge     # the MCP bridge in HTTP mode, serving the build at http://127.0.0.1:7429
npm run preview    # serve the build on http://127.0.0.1:4173
```

## Deploying

The site is served by GitHub Pages from the `gh-pages` branch, which holds only the built files.

```bash
npm run deploy     # build, then replace the gh-pages branch with the new build
```

Each deploy force-pushes one fresh commit to `gh-pages` (nothing but build output lives there). If Pages is not on yet: repository **Settings → Pages → Source: Deploy from a branch → `gh-pages` / root**.

To deploy automatically on every push to `main` instead, copy `deploy/pages.yml` to `.github/workflows/pages.yml` and switch the Pages source to **GitHub Actions**. That workflow installs, runs the kernel tests, builds and publishes; after that `npm run deploy` and the `gh-pages` branch are no longer needed.

The build uses relative URLs, so it works under `/3d-ai/` or any other path without configuration.

`dist/` is a static site; host its four files together anywhere. `index.html` also works opened straight from disk, in which case the kernel and font are fetched from a public CDN instead.

`npm run artifact` additionally writes `dist/artifact.html`, the body-only page for publishing as a Claude artifact. An artifact cannot reach the bridge on your computer, so there the chat panel points to the hosted app instead; modelling works as usual, and exports go through the viewer's save prompt (as a `.zip`, because artifacts cannot save `.stl` directly).

## Using it

| To do this | Do this |
| --- | --- |
| Start a part | **Sketch** → pick a plane → drag a rectangle → **Finish sketch** → type the extrude distance. Or add a **Box** / **Cylinder**. Or ask the assistant. |
| Cut a pocket or hole | Click a flat face → **Sketch here** → draw → Finish → set Operation to **Cut** and a negative distance (or Extent: Through all). |
| Push or pull a face | Click a flat face → **Push / pull**. |
| Round or bevel | Click edges (Shift-click for more) → **Fillet** / **Chamfer**. Or click the tool first, then pick. Selecting a face stands for all the edges around it. |
| Hollow out | Click the face to open → **Shell** → wall thickness. |
| Repeat | Select a feature in the timeline → **Pattern** (rows or around an axis) or **Mirror**. |
| Change anything later | Click the feature in the timeline and edit its numbers. Double-click a sketch to reopen it. |
| Drive sizes from one place | Add a parameter (left panel) and type its name into any field. |
| Lay out and route a circuit board | **Board**, or import / drop an Eagle or KiCad file. In the editor drag parts; R turns, F flips to the bottom, Delete removes, arrows nudge, H adds holes; **Auto…** places parts for you. Press X (Route): click a pad, click corners, click the other pad; V drops a via and switches layer. **Auto… → Autoroute** routes the rest. Set the outline, rules and where the board sits in the inspector, pick a part's 3D model (drawn, block, or your STEP), model the enclosure, then **Check fit in enclosure** and **Export Gerbers**. |
| Bring in a 3D file | **Import**, File → Import 3D file, or drop files on the window: STL, STEP/STP, OBJ, 3MF, or a zip of them. A zip imports every 3D file in it; several parts keep the layout they share (or are set out in a row if they would overlap). The inspector says how each part came in and what was repaired, and lets you set units, scale, placement and solid or mesh. Drop a zip on the chat instead to also hand its other files (notes, schematics) to Claude. |

Mouse: drag orbits, right-drag pans, scroll zooms. While sketching, drag draws and right-drag orbits. Keys: `S` sketch, `E` extrude, `F` fillet, `Esc` back out, `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo; in a sketch `R` `C` `P` `O` `L` `T` `V` pick the tools.

## How it is put together

| File | Role |
| --- | --- |
| `src/kernel/evaluate.js` | Replays a document (parameters + features) into solids. Pure: runs in the worker and in Node. Caches each step, so editing feature 8 does not rebuild features 1–7. |
| `src/kernel/stl.js` | STL parsing, turning meshes into exact solids or Manifold mesh bodies, and display data for mesh bodies. |
| `src/kernel/worker.js`, `client.js` | The worker that owns OpenCascade and Manifold, and its main-thread handle (latest rebuild wins). |
| `src/files.js` | Imported files: IndexedDB storage and embedding in project files. |
| `src/store.js` | Document, undo/redo, selection, autosave, timeline rollback while sketching or re-picking. |
| `src/viewport.js` | three.js view: bodies, face and edge picking, highlights, camera. |
| `src/sketcher.js`, `sketchgeo.js` | Drawing and editing 2D shapes on a plane. |
| `src/actions.js`, `ui.js`, `schema.js` | Commands, panels, and the per-feature field definitions the inspector is generated from. |
| `src/agent/catalog.js` | The agent tools: names, descriptions, input schemas. Served by the bridge to every agent. |
| `src/agent/tools.js` | What each tool does inside the page; results are MCP content (text and PNG images). |
| `src/agent/link.js`, `panel.js` | The page's WebSocket to the bridge, the Agent menu, agent activity, and the prompt bar for `ask_user`. |
| `bridge/server.mjs` | The MCP server (stdio and Streamable HTTP), the local web server and WebSocket hub, file import/export on disk. |
| `src/assistant.js`, `guide.js` | The side-panel chat (relayed to Claude Code through the bridge), and the briefing every agent gets (the document format and how to work). |
| `src/export.js` | Saving files (direct download, or zipped through the artifact save prompt). |
| `src/board/` | Circuit boards: Eagle reader (`eagle.js`, `xml.js`), KiCad reader (`kicad.js`, `sexpr.js`), footprints from KiCad names (`footprints.js`), placement geometry, checks and auto-arrange (`geometry.js`), copper connectivity, design rules and the autorouter (`route.js`), the 2D editor (`editor.js`), 3D part models and copper (`models.js`, `copper3d.js`), Gerber/drill (`gerber.js`) and Eagle script (`script.js`) export. |

Picked faces and edges are stored with their position in the body *and* a geometric signature. When an earlier dimension changes, the kernel re-finds them and refreshes the signature, so a fillet follows its edge as the part grows. If the edge truly disappears, the feature reports that instead of silently filleting something else.

## Tests

```bash
npm test                 # kernel, 3D import, boards and PCBs (KiCad, routing, DRC, Gerbers): checked against hand-computed values
npm run bundle && node scripts/make-artifact.mjs && npm run preview &
npm run test:e2e         # headless Chromium: modelling flows, import, exports, the board placement editor
npm run test:bridge      # real MCP clients (stdio and HTTP) driving a real browser tab through the bridge
```

The end-to-end scripts need Playwright with Chromium available to `require('playwright')`. The bridge suite runs the side-panel chat against `scripts/fake-claude.mjs`, a stand-in for the `claude` command that speaks its stream format and calls real Caliper tools over MCP; it checks the plumbing (tool restrictions, streaming, session resume, undo, errors, Stop), not the quality of Claude's designs. Set `CALIPER_CLAUDE_BIN` to point the bridge at another `claude` executable.

## Limits worth knowing

- Sketches have no geometric constraints; shapes are positioned by numbers and snapping.
- A shell fails when the wall is thicker than a fillet or chamfer already on the body. Shell first, fillet after.
- No lofts, sweeps, threads or drafts yet, and no assemblies. Units are millimetres.
- Text uses one font (DejaVu Sans Bold) and shows as a placeholder box until extruded.
- Imported meshes: curved areas of exact-solid imports stay faceted; mesh bodies have no selectable faces or edges, cannot be filleted, chamfered or shelled, and are left out of STEP files. Combining a mesh body with a solid gives a mesh body. Only verifiably closed meshes become solids; anything else (faces folded through each other, internal faces, holes the repair cannot close) is kept as a reference mesh, which never takes part in cuts or joins. Its volume is shown as approximate. IGES is not supported (the bundled OpenCascade build has no IGES reader); STEP assemblies come in as one body per file.
- Boards: two copper layers (inner layers in KiCad files are left out), pours are solid (no thermal reliefs; islands are kept), no silkscreen text in the Gerbers, no differential pairs or length tuning. The autorouter is a grid maze router: good for hobby boards, and it reports what it cannot route. Part models are drawn from footprint and size (heights from package descriptions like "29x17.3x4.3", else estimated); KiCad's own `.wrl` models are not read, use the STEP versions. KiCad schematics: one sheet (no hierarchical sub-sheets), footprints from KiCad's standard library names (others become plain blocks). Always check Gerbers in a viewer before ordering.
- Safari may refuse the hosted page's connection to the local bridge; use the page the bridge serves (`http://127.0.0.1:7429/`) or another browser.

OpenCascade is LGPL-2.1; replicad, three.js and the MCP SDK are MIT; Manifold is Apache-2.0; DejaVu fonts are under the Bitstream Vera licence.
