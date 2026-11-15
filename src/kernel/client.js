// Main-thread handle on the geometry worker.
import KernelWorker from './worker.js?worker&inline';
import { getFile, fileIdsIn } from '../files.js';

const CDN_MESH_WASM = 'https://unpkg.com/manifold-3d@3.5.4/manifold.wasm';
const CDN_FONT = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf';
const CDN_WASM = 'https://unpkg.com/replicad-opencascadejs@1.2.1/dist/replicad_single.wasm';

async function readAll(resp, onProgress, total) {
  const reader = resp.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(Math.min(0.99, got / total));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// The WebAssembly modules ship gzipped (7 MB instead of 23 MB for OpenCascade) under .wasm names so
// any static host serves them. What arrives is checked by its magic bytes, so plain .wasm works too.
async function fetchWasm(name, cdn, onProgress, expect) {
  let bytes;
  try {
    const resp = await fetch(new URL(name, document.baseURI));
    if (!resp.ok) throw new Error(`${name} ${resp.status}`);
    bytes = await readAll(resp, onProgress, Number(resp.headers.get('content-length')) || expect);
  } catch (local) {
    // Opened straight from disk, or served without the files: fall back to the public CDN copy.
    const resp = await fetch(cdn);
    if (!resp.ok) throw new Error('Could not download the geometry kernel.');
    bytes = await readAll(resp, onProgress, expect * 3);
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  return bytes.buffer;
}

export class Kernel {
  constructor() {
    this.worker = new KernelWorker();
    this.pending = new Map();
    this.seq = 0;
    this.busy = false;
    this.queued = null;
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'The geometry worker crashed.'));
      this.pending.clear();
    };
  }

  call(type, payload = {}, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload }, transfer);
    });
  }

  async init(onProgress) {
    const [wasm, meshWasm] = await Promise.all([fetchWasm('kernel.wasm', CDN_WASM, onProgress, 7.3e6), fetchWasm('mesh.wasm', CDN_MESH_WASM, null, 2.1e5)]);
    await this.call('init', { wasm, meshWasm }, [wasm, meshWasm]);
  }

  // Imported files live in the main thread (and the browser's storage); the worker gets a copy of
  // each the first time a document needs it.
  async syncFiles(doc) {
    this.sent ||= new Set();
    const ids = new Set(fileIdsIn({ features: (doc.features || []).filter((f) => !f.suppressed) }));
    for (const fileId of ids) {
      if (this.sent.has(fileId)) continue;
      const file = await getFile(fileId);
      if (!file) continue;
      await this.call('file', { fileId, bytes: file.bytes.slice() });
      this.sent.add(fileId);
    }
  }

  query(sel, kind) {
    return this.call('query', { sel, kind });
  }

  listElements(kind, sel, limit) {
    return this.call('list', { kind, sel, limit });
  }

  // The board must be numeric (numericBoard); returns { traces, vias, routed, failed, total }.
  autoroute(board, opts) {
    return this.call('autoroute', { board, opts });
  }

  interference(opts) {
    return this.call('interference', { opts });
  }

  measure(a, b) {
    return this.call('measure', { a, b });
  }

  // Sketch text needs a font; it loads after the kernel so it never delays the first render.
  async loadFont() {
    let buf = null;
    for (const url of [new URL('font.ttf', document.baseURI), CDN_FONT]) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          buf = await resp.arrayBuffer();
          break;
        }
      } catch {
        /* try the next source */
      }
    }
    if (!buf) return false;
    await this.call('font', { font: buf }, [buf]);
    return true;
  }

  // Latest wins: while one rebuild runs, only the newest waiting document is kept.
  evaluate(doc) {
    return new Promise((resolve, reject) => {
      const job = { doc, resolve, reject };
      if (this.busy) {
        this.queued?.resolve(null);
        this.queued = job;
        return;
      }
      this.run(job);
    });
  }

  async run(job) {
    this.busy = true;
    try {
      await this.syncFiles(job.doc);
      job.resolve(await this.call('evaluate', { doc: job.doc }));
    } catch (e) {
      job.reject(e);
    }
    this.busy = false;
    if (this.queued) {
      const next = this.queued;
      this.queued = null;
      this.run(next);
    }
  }

  exportSTL(bodies, quality) {
    return this.call('stl', { bodies, quality });
  }

  exportSTEP(bodies) {
    return this.call('step', { bodies });
  }
}
