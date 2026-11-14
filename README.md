# Caliper

A browser CAD tool for 3D-printable parts, in the spirit of Fusion's sketch → extrude → fillet workflow but with far fewer knobs. Any AI agent can plug in over MCP and see, measure and edit the same model you are looking at, while you watch.

**Live:** https://fabioelia.github.io/3d-ai/

- **Real solid modelling.** The geometry kernel is OpenCascade compiled to WebAssembly (through [replicad](https://replicad.xyz)), running in a worker. Fillets, chamfers, shells and booleans are exact B-rep operations, not mesh tricks, and STEP export keeps them exact.
- **Parametric timeline.** Every feature stays editable. Any number can be an expression over named parameters (`width/2 - wall`), and the model rebuilds as you type.
- **Sketching without constraints.** Rectangles, circles, polygons, slots, line paths and text snap to a grid and to each other; exact sizes go in the inspector. A shape drawn inside another becomes a cut-out.
- **Direct manipulation.** Click a face to sketch on it or push/pull it; click edges to fillet or chamfer them; click a face and Shell to hollow the part.
- **Agents over MCP.** Claude Code, Claude Desktop, Cursor or any MCP client gets the whole app as tools: the full state, screenshots of what you see, exact geometry and measurements, printability checks, every edit, your selection, your camera, import and export. See [Use it with an AI agent](#use-it-with-an-ai-agent-mcp).
- **Built-in assistant.** The same tools, in a side panel, with your own Claude account (as a Claude artifact) or an API key.
- **STL import.** Drop STL files on the window. Small clean meshes become exact solids whose flat faces you can sketch on, fillet and shell; large ones become mesh bodies you can move, cut, join and pattern.
- **Export.** Binary STL (three mesh qualities) and STEP. Projects save as JSON, with imported STLs embedded, and autosave in the browser.

## Use it with an AI agent (MCP)

The Caliper bridge is a small MCP server that runs on your computer. The agent talks MCP to it; Caliper, open in your browser, connects to it over a local WebSocket. Every tool call runs against the live model in your tab, so you see each change land in the timeline and the agent sees what you see.

**Claude Code**

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

- Run from a built checkout (`npm run build` first), the bridge serves Caliper itself at `http://127.0.0.1:7429/`, and that page connects automatically.
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
| `import_stl`, `export_file` | Read an STL from disk into the model; write STL, STEP or the project to disk. |
| `select`, `set_view`, `ui_action` | Point at things in your view, move your camera, open sketches, undo and redo. |
| `ask_user`, `show_message` | Ask you to click the faces or edges it should use (or confirm, or type an answer), and tell you things in Caliper. |

Faces and edges are referred to by refs like `extrude1:F3`, which the agent gets from `get_state`, `query_geometry` or screenshot labels. Refs it writes into features are stored with their geometry, so they keep pointing at the same edge when earlier dimensions change.

Security: the bridge listens on 127.0.0.1 only, rejects other host names and browser origins, and the page must present a per-user secret (kept in `~/.config/caliper/bridge.json`) to connect. `import_stl` and `export_file` read and write files with the agent's permissions, relative to its working directory.

## Run it

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # dist/: index.html (single file), kernel.wasm, mesh.wasm, font.ttf
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

Outside claude.ai the built-in assistant calls the Claude API directly from the browser with a key you paste into its settings (stored in that browser only). `npm run artifact` additionally writes `dist/artifact.html`, the body-only page for publishing as a Claude artifact, where the assistant uses the viewer's own Claude instead of a key and exports go through the viewer's save prompt (as a `.zip`, because artifacts cannot save `.stl` directly).

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
| Bring in an STL | **Import**, File → Import STL, or drop files on the window. Set units, scale, placement and whether it comes in as an exact solid or a mesh in the inspector. |

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
| `src/agent/catalog.js` | The agent tools: names, descriptions, input schemas. Shared by the bridge and the built-in assistant. |
| `src/agent/tools.js` | What each tool does inside the page; results are MCP content (text and PNG images). |
| `src/agent/link.js`, `panel.js` | The page's WebSocket to the bridge, the Agent menu, agent activity, and the prompt bar for `ask_user`. |
| `bridge/server.mjs` | The MCP server (stdio and Streamable HTTP), the local web server and WebSocket hub, file import/export on disk. |
| `src/assistant.js`, `guide.js` | The built-in chat, and the briefing every agent gets (the document format and how to work). |
| `src/export.js` | Saving files (direct download, or zipped through the artifact save prompt). |

Picked faces and edges are stored with their position in the body *and* a geometric signature. When an earlier dimension changes, the kernel re-finds them and refreshes the signature, so a fillet follows its edge as the part grows. If the edge truly disappears, the feature reports that instead of silently filleting something else.

## Tests

```bash
npm test                 # kernel and STL import: documents checked against hand-computed volumes and bounds
npm run build && node scripts/make-artifact.mjs && npm run preview &
npm run test:e2e         # headless Chromium: modelling flows, import, exports, built-in assistant plumbing
npm run test:bridge      # real MCP clients (stdio and HTTP) driving a real browser tab through the bridge
```

The end-to-end scripts need Playwright with Chromium available to `require('playwright')`. The assistant tests stub Claude (both the artifact capability and the API), so they check the plumbing — prompt contents, tool execution, build reports, undo — not the quality of Claude's designs.

## Limits worth knowing

- Sketches have no geometric constraints; shapes are positioned by numbers and snapping.
- A shell fails when the wall is thicker than a fillet or chamfer already on the body. Shell first, fillet after.
- No lofts, sweeps, threads or drafts yet, and no assemblies. Units are millimetres.
- Text uses one font (DejaVu Sans Bold) and shows as a placeholder box until extruded.
- Imported STLs: curved areas of exact-solid imports stay faceted; mesh bodies have no selectable faces or edges, cannot be filleted, chamfered or shelled, and are left out of STEP files. Combining a mesh body with a solid gives a mesh body. STLs must be closed (watertight).
- Safari may refuse the hosted page's connection to the local bridge; use the page the bridge serves (`http://127.0.0.1:7429/`) or another browser.

OpenCascade is LGPL-2.1; replicad, three.js and the MCP SDK are MIT; Manifold is Apache-2.0; DejaVu fonts are under the Bitstream Vera licence.
