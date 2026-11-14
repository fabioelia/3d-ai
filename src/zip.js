// Minimal ZIP reader: lists entries and extracts stored or deflated files. Pure JS, used by the page
// (inflate via DecompressionStream) and the MCP bridge (inflate via zlib). Thingiverse, Printables and
// most model sites deliver STLs zipped.

export const isZip = (bytes) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

// inflateRaw: async (Uint8Array) => Uint8Array
export async function readZip(bytes, inflateRaw, { accept = () => true, maxBytes = 512 * 1024 * 1024 } = {}) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find the end-of-central-directory record (within the last 64 KiB + 22 bytes).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This zip file is damaged (no directory found).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  let total = 0;
  const utf8 = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('This zip file is damaged (bad directory entry).');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !accept(name)) continue;
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`This zip file is damaged (${name}).`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + csize);
    total += usize;
    if (total > maxBytes) throw new Error('This zip file unpacks to more than 512 MB.');
    let file;
    if (method === 0) file = data.slice();
    else if (method === 8) file = await inflateRaw(data);
    else throw new Error(`${name} uses a compression method Caliper cannot unpack (${method}).`);
    out.push({ name: name.split('/').pop(), path: name, bytes: file });
  }
  return out;
}

// 3D formats Caliper imports. A .3mf is itself a zip, so it is only an archive when named .zip.
export const MODEL_EXT = /\.(stl|step|stp|obj|3mf)$/i;
// For readZip's accept: every real file, skipping macOS metadata and hidden files.
export const realEntry = (name) => !/(^|\/)(__MACOSX|\.)/.test(name);
export const stlEntry = (name) => MODEL_EXT.test(name) && realEntry(name);

// Browser inflate.
export async function inflateRawWeb(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
