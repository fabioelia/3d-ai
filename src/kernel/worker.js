// Geometry worker: owns OpenCascade (exact solids) and Manifold (mesh bodies), so the page never
// blocks while the model rebuilds.
import opencascade from 'replicad-opencascadejs';
import Manifold from 'manifold-3d';
import * as replicad from 'replicad';
import { createKernel } from './evaluate.js';
import { isZip, readZip, inflateRawWeb } from '../zip.js';

let kernel = null;

// Both modules accept their WebAssembly bytes through the instantiate hook.
const withBytes = (bytes) => ({
  instantiateWasm(imports, done) {
    WebAssembly.instantiate(bytes, imports).then(({ instance }) => done(instance));
    return {};
  },
});

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    let result = true;
    const transfer = [];
    if (type === 'init') {
      const [OC, M] = await Promise.all([opencascade(withBytes(data.wasm)), Manifold(withBytes(data.meshWasm))]);
      M.setup();
      replicad.setOC(OC);
      replicad.setManifold(M);
      kernel = createKernel(replicad);
    } else if (type === 'font') {
      await replicad.loadFont(data.font);
    } else if (type === 'file') {
      let bytes = new Uint8Array(data.bytes);
      // A 3MF is a zip; the kernel reads its model XML.
      if (isZip(bytes)) {
        const models = await readZip(bytes, inflateRawWeb, { accept: (n) => /\.model$/i.test(n) });
        const main = models.find((e) => /3dmodel\.model$/i.test(e.path)) || models[0];
        if (main) bytes = main.bytes;
      }
      kernel.addFile(data.fileId, bytes);
    } else if (type === 'evaluate') {
      const t = performance.now();
      const out = kernel.evaluate(data.doc);
      result = out.result;
      result.ms = Math.round(performance.now() - t);
      transfer.push(...out.transfer);
    } else if (type === 'query') {
      result = kernel.query(data.sel, data.kind);
    } else if (type === 'list') {
      result = kernel.listElements(data.kind, data.sel, data.limit);
    } else if (type === 'measure') {
      result = kernel.measure(data.a, data.b);
    } else if (type === 'stl') {
      result = kernel.exportSTL(data.bodies, data.quality);
      transfer.push(result.buffer);
    } else if (type === 'step') {
      result = await kernel.exportSTEP(data.bodies);
      transfer.push(result.buffer);
    }
    self.postMessage({ id, result }, transfer);
  } catch (e) {
    self.postMessage({ id, error: (e && e.message) || 'The geometry kernel hit an error.' });
  }
};
