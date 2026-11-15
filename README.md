# Caliper

A browser CAD tool for 3D-printable parts, in the spirit of Fusion's sketch → extrude → fillet workflow but with far fewer knobs. Bring the AI you already use (Claude Code, Codex, Cursor, Claude or ChatGPT in the browser) through [AI Connect](https://github.com/fabioelia/ai-connect): it sees, measures and edits the same model you are looking at, while you watch. Caliper calls no model and needs no API key.

**Live:** https://fabioelia.github.io/3d-ai/

- **Real solid modelling.** The geometry kernel is OpenCascade compiled to WebAssembly (through [replicad](https://replicad.xyz)), running in a worker. Fillets, chamfers, shells and booleans are exact B-rep operations, not mesh tricks, and STEP export keeps them exact.
- **Parametric timeline.** Every feature stays editable. Any number can be an expression over named parameters (`width/2 - wall`), and the model rebuilds as you type.
- **Sketching without constraints.** Rectangles, circles, polygons, slots, line paths and text snap to a grid and to each other; exact sizes go in the inspector. A shape drawn inside another becomes a cut-out.
- **Direct manipulation.** Click a face to sketch on it or push/pull it; click edges to fillet or chamfer them; click a face and Shell to hollow the part.
- **Your own AI, through AI Connect.** Your AI gets the whole app as tools: the full state, screenshots of what you see, exact geometry and measurements, printability checks, every edit, your selection, your camera, import and export. See [Use it with your own AI](#use-it-with-your-own-ai-ai-connect).
- **Chat in Caliper.** Type in the side panel; your connected AI listens there, works on the model with the same tools and answers in the panel. Drop, paste or attach images (photos, sketches), 3D files and documents (notes, CSV, schematics such as Eagle `.sch`): text goes with your message, your AI looks at images with the `get_attachments` tool, and 3D files go into the model.
- **3D import.** STL, STEP/STP, OBJ and 3MF, or the zip a model site or a colleague sent. STEP with real surfaces comes in as exact solids; meshes (including Fusion's mesh-only "tessellated" STEP) are repaired automatically (zero-area slivers, T-junctions, duplicate faces, near-miss vertices). Small clean meshes become exact solids whose flat faces you can sketch on, fillet and shell; larger ones become mesh bodies you can move, cut, join and pattern; files that still are not closed solids come in as reference meshes you can view, move, measure and export. Other files in a zip go to the chat when you drop it there.
- **Circuit boards.** Like the board editors in Fusion, Eagle or KiCad. Import an Eagle / Fusion Electronics schematic (`.sch`) or board (`.brd`), or a KiCad board (`.kicad_pcb`), schematic (`.kicad_sch`) or netlist (`.net`): every part comes in with its footprint, pads, body size and height, plus the nets (KiCad schematics and netlists get footprints from KiCad's standard footprint names), and board files also bring their outline, holes, placement and copper. Place parts in a top-down editor (drag, turn with R, flip to the bottom with F, nudge, holes, outline, automatic arrangement on one or both sides) with airwires and live clash checks. Arrange parts automatically with connected parts kept together, or tidy your own layout for shorter connections. Fit the outline to the inside of your enclosure. Route on two copper layers by hand (45° traces, vias) or with the autorouter, add a ground pour (with thermal reliefs for hand soldering), with design-rule checks (clearance, shorts, edge and hole clearance, widths, drills) as you go. Parts are drawn as real-looking 3D models by kind (banded resistors on bent leads, capacitors, headers with pins, modules on their pins, chips), or use your own STEP/STL per part; copper shows in 3D too. Model the enclosure around the board, check the fit, and add printed standoffs with screw pilot holes under the board's mounting holes. Read part heights from a sizes list or BOM text file. Export Gerber and drill files (with a BOM and part positions) for a board house, a BOM on its own, or a `.scr` script that moves the parts in Eagle / Fusion; STL export leaves the electronics out and STEP keeps them.
- **Export.** Binary STL (three mesh qualities) and STEP. Projects save as JSON, with imported STLs embedded, and autosave in the browser.

## Use it with your own AI (AI Connect)

Caliper has no AI of its own. Its tools are registered on the page (WebMCP), and [AI Connect](https://github.com/fabioelia/ai-connect) lets the AI you already use reach them. Every tool call runs against the live model in your tab, so you see each change land in the timeline (and can undo it), and your AI sees what you see. Nothing to install for the first three ways.

Click **Connect AI** in the top bar and pick a way:

| Way | Choose it when | What you do |
|---|---|---|
| **Paste a prompt** | You use Claude Code, Codex, Cursor or another AI that can make web requests. The easiest. | Click **Copy prompt for my AI** and paste it into your AI. It connects itself and starts listening to Caliper's chat panel. Goes through the AI Connect relay, which could read what passes. |
| **Private connection** | Your designs are sensitive. | Click **Open my hub**, **Allow**, then copy the hub's prompt into your AI. End-to-end encrypted: the relay only passes encrypted bytes. Keep the hub window open. |
| **Claude or ChatGPT in the browser** | You chat at claude.ai or chatgpt.com. | Click **Approve Caliper**, **Allow**, and once ever add the connector address it gives you to your chat app. |
| **On this computer only** | Your AI runs on this computer and nothing should leave it. | Once: `claude mcp add ai-connect -- npx -y github:fabioelia/ai-connect mcp` (or that command in any MCP client). Then tell your AI the sentence the menu shows ("Connect to the app with code …"). Chrome or Edge. |

Then type in Caliper's side panel (paste-a-prompt and private routes), or ask your AI in its own window. Changes your AI makes show up beside the model; one chat answer's changes undo together.

What your AI can do: read the document (`get_state`), look (`screenshot`, with labelled faces and edges), measure, query geometry, check printability, replace or edit the model (`set_model`, `edit_model`), select, move the camera, use the interface, show a message, ask you a question in a bar over the model (`ask_user`), import a file it sends as base64 (`import_file`), export (`export_file`: saved in your browser, optionally handed back to the AI), lay out and route boards (`place_parts`, `route_board`, `check_board`), and read the guide. It also gets three skills: the Caliper guide, building an enclosure around a board, and making a part printable.

Security: your AI can do only what Caliper's tools allow, on the page you have open. The prompt works once and expires after 15 minutes; **Disconnect** in the menu revokes the connection. See AI Connect's [security model](https://github.com/fabioelia/ai-connect#security-model).

## Run it

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run bundle     # dist/: index.html (single file), kernel.wasm, mesh.wasm, font.ttf
npm run preview    # serve the build on http://127.0.0.1:4173
npm run vendor:ai-connect   # refresh src/vendor/ai-connect.js from an ai-connect checkout at ../ai-connect
```

To try the AI connection against a relay on your own computer, run `npx -y github:fabioelia/ai-connect relay --port 8787` and open Caliper with `?relay=http://127.0.0.1:8787` (only local addresses are accepted there).

## Deploying

The site is served by GitHub Pages from the `gh-pages` branch, which holds only the built files.

```bash
npm run deploy     # build, then replace the gh-pages branch with the new build
```

Each deploy force-pushes one fresh commit to `gh-pages` (nothing but build output lives there). If Pages is not on yet: repository **Settings → Pages → Source: Deploy from a branch → `gh-pages` / root**.

To deploy automatically on every push to `main` instead, copy `deploy/pages.yml` to `.github/workflows/pages.yml` and switch the Pages source to **GitHub Actions**. That workflow installs, runs the kernel tests, builds and publishes; after that `npm run deploy` and the `gh-pages` branch are no longer needed.

The build uses relative URLs, so it works under `/3d-ai/` or any other path without configuration.

`dist/` is a static site; host its four files together anywhere. `index.html` also works opened straight from disk, in which case the kernel and font are fetched from a public CDN instead.

`npm run artifact` additionally writes `dist/artifact.html`, the body-only page for publishing as a Claude artifact. An artifact cannot open AI Connect's connections, so there the chat panel points to the hosted app instead; modelling works as usual, and exports go through the viewer's save prompt (as a `.zip`, because artifacts cannot save `.stl` directly).

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
| Stack parts of an assembly | Files exported one by one often come in side by side. Select one in the timeline, pick another under **Line up with**, then **Under it**, **On top** or **Centred in it**. |
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
| `src/agent/catalog.js` | The tools: names, descriptions, input schemas. |
| `src/agent/tools.js` | What each tool does inside the page; results are MCP content (text and PNG images). |
| `src/agent/connect.js` | Registers the tools and skills with AI Connect and names who is acting. |
| `src/agent/panel.js` | The Agent menu (AI Connect's ways to connect), your AI's activity in the side panel, confirmations, and the prompt bar for `ask_user`. |
| `src/vendor/ai-connect.js` | The AI Connect web SDK, vendored (`npm run vendor:ai-connect`) because Caliper builds into one self-contained file. |
| `src/assistant.js`, `guide.js` | The side-panel chat (to the AI listening through AI Connect), and the guide every AI gets (the document format and how to work). |
| `src/export.js` | Saving files (direct download, or zipped through the artifact save prompt). |
| `src/board/` | Circuit boards: Eagle reader (`eagle.js`, `xml.js`), KiCad reader (`kicad.js`, `sexpr.js`), footprints from KiCad names (`footprints.js`), placement geometry, checks and auto-arrange (`geometry.js`), copper connectivity, design rules and the autorouter (`route.js`), the 2D editor (`editor.js`), 3D part models and copper (`models.js`, `copper3d.js`), Gerber/drill (`gerber.js`) and Eagle script (`script.js`) export. |

Picked faces and edges are stored with their position in the body *and* a geometric signature. When an earlier dimension changes, the kernel re-finds them and refreshes the signature, so a fillet follows its edge as the part grows. If the edge truly disappears, the feature reports that instead of silently filleting something else.

## Tests

```bash
npm test                 # kernel, 3D import, boards and PCBs (KiCad, routing, DRC, Gerbers): checked against hand-computed values
npm run bundle && node scripts/make-artifact.mjs && npm run preview &
npm run test:e2e         # headless Chromium: modelling flows, import, exports, the board editor, bodies, focus and scroll, AI Connect
```

The end-to-end scripts need Playwright with Chromium available to `require('playwright')`. `scripts/e2e-aiconnect.cjs` starts a local AI Connect relay from an ai-connect checkout (`../ai-connect` after `npm install`, or `AI_CONNECT_DIR`) and plays the person's AI: it follows the pasted prompt, calls Caliper's tools over HTTP, listens to the chat panel and answers there.

## Limits worth knowing

- Sketches have no geometric constraints; shapes are positioned by numbers and snapping.
- A shell fails when the wall is thicker than a fillet or chamfer already on the body. Shell first, fillet after.
- No lofts, sweeps, threads or drafts yet, and no assemblies. Units are millimetres.
- Text uses one font (DejaVu Sans Bold) and shows as a placeholder box until extruded.
- Imported meshes: curved areas of exact-solid imports stay faceted; mesh bodies have no selectable faces or edges, cannot be filleted, chamfered or shelled, and are left out of STEP files. Combining a mesh body with a solid gives a mesh body. Only verifiably closed meshes become solids; anything else (faces folded through each other, internal faces, holes the repair cannot close) is kept as a reference mesh, which never takes part in cuts or joins. Its volume is shown as approximate. IGES is not supported (the bundled OpenCascade build has no IGES reader); STEP assemblies come in as one body per file.
- Boards: two copper layers (inner layers in KiCad files are left out), pours connect through-hole pads with thermal spokes (surface-mount pads solidly) and keep islands, no differential pairs or length tuning. The autorouter is a grid maze router: good for hobby boards, and it reports what it cannot route. Part models are drawn from footprint and size (heights from package descriptions like "29x17.3x4.3", else estimated); KiCad's own `.wrl` models are not read, use the STEP versions. KiCad schematics: one sheet (no hierarchical sub-sheets), footprints from KiCad's standard library names (others become plain blocks). Always check Gerbers in a viewer before ordering.
- The paste-a-prompt route needs an AI that can make web requests, and a chatting AI keeps its session busy while it listens. The on-this-computer route works in Chrome and Edge. Files your AI sends or gets back pass through the relay, which caps a message at about 1 MB.

OpenCascade is LGPL-2.1; replicad, three.js and AI Connect are MIT; Manifold is Apache-2.0; DejaVu fonts are under the Bitstream Vera licence.
