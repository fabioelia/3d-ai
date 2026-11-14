// Files the person brings in (STL imports). The document refers to them by a content hash; the
// bytes live in memory and in the browser's IndexedDB, and travel inside saved project files.

const mem = new Map(); // id -> { id, name, bytes: Uint8Array }
const DB = 'caliper-files';
let dbPromise = null;

function db() {
  dbPromise ||= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // storage can be unavailable (private windows, sandboxed views)
    }
  });
  return dbPromise;
}

async function idb(mode, fn) {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function hashId(bytes) {
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return `stl_${[...digest.slice(0, 10)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    // crypto.subtle needs a secure context; fall back to a cheap content hash.
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < bytes.length; i++) {
      h1 = Math.imul(h1 ^ bytes[i], 16777619);
      h2 = Math.imul(h2 ^ bytes[i], 2246822519);
    }
    return `stl_${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}${bytes.length.toString(16)}`;
  }
}

export async function putFile(name, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const id = await hashId(bytes);
  if (!mem.has(id)) {
    const rec = { id, name: String(name || 'model.stl'), bytes };
    mem.set(id, rec);
    await idb('readwrite', (s) => s.put(rec));
  }
  return id;
}

export async function getFile(id) {
  if (mem.has(id)) return mem.get(id);
  const rec = await idb('readonly', (s) => s.get(id));
  if (rec) {
    rec.bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
    mem.set(id, rec);
  }
  return rec;
}

export const fileIdsIn = (doc) => [...new Set((doc.features || []).filter((f) => f.type === 'import' && f.file).map((f) => f.file))];

const toB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64) => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
export { toB64, fromB64 };

// Saved projects carry their imported files, so they open anywhere.
export async function embedFiles(doc) {
  const files = {};
  for (const id of fileIdsIn(doc)) {
    const f = await getFile(id);
    if (f) files[id] = { name: f.name, data: toB64(f.bytes) };
  }
  return Object.keys(files).length ? { ...doc, files } : doc;
}

export async function absorbFiles(doc) {
  for (const [id, f] of Object.entries(doc.files || {})) {
    if (!f || typeof f.data !== 'string') continue;
    const bytes = fromB64(f.data);
    const rec = { id, name: f.name || 'model.stl', bytes };
    mem.set(id, rec);
    await idb('readwrite', (s) => s.put(rec));
  }
  const { files, ...rest } = doc;
  return rest;
}
