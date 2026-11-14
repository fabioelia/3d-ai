import fs from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import Manifold from 'manifold-3d';
import * as r from 'replicad';
import { createKernel } from '../src/kernel/evaluate.js';

// Loads the geometry kernel in Node, for tests and scripts.
export async function loadKernel() {
  const wasmBinary = fs.readFileSync(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const OC = await opencascade({ wasmBinary });
  r.setOC(OC);
  const M = await Manifold({ wasmBinary: fs.readFileSync(new URL('../node_modules/manifold-3d/manifold.wasm', import.meta.url)) });
  M.setup();
  r.setManifold(M);
  return createKernel(r);
}
export { r };
