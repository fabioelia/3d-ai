// 3MF: a zip holding one XML model, with each body as its own object, so slicers (Bambu Studio,
// PrusaSlicer, Cura) put the bodies on the plate as separate parts that can be arranged and coloured.
import { zip } from './export.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const num = (v) => {
  const r = Math.round(v * 1e5) / 1e5;
  return Object.is(r, -0) ? '0' : String(r);
};

// meshes: [{ name, vertices: Float32Array (xyz…), triangles: Uint32Array }] in millimetres.
export function model3MF(meshes, title = 'Caliper part') {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">');
  out.push(`<metadata name="Title">${esc(title)}</metadata>`);
  out.push('<metadata name="Application">Caliper</metadata>');
  out.push('<resources>');
  meshes.forEach((m, k) => {
    out.push(`<object id="${k + 1}" type="model" name="${esc(m.name || `Body ${k + 1}`)}"><mesh><vertices>`);
    const v = m.vertices;
    const parts = [];
    for (let i = 0; i < v.length; i += 3) parts.push(`<vertex x="${num(v[i])}" y="${num(v[i + 1])}" z="${num(v[i + 2])}"/>`);
    out.push(parts.join(''));
    out.push('</vertices><triangles>');
    const t = m.triangles;
    const tris = [];
    for (let i = 0; i < t.length; i += 3) if (t[i] !== t[i + 1] && t[i + 1] !== t[i + 2] && t[i] !== t[i + 2]) tris.push(`<triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`);
    out.push(tris.join(''));
    out.push('</triangles></mesh></object>');
  });
  out.push('</resources><build>');
  meshes.forEach((_, k) => out.push(`<item objectid="${k + 1}"/>`));
  out.push('</build></model>');
  return out.join('\n');
}

export async function build3MF(meshes, title) {
  const enc = new TextEncoder();
  const files = [
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>') },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>') },
    { name: '3D/3dmodel.model', data: enc.encode(model3MF(meshes, title)) },
  ];
  return new Uint8Array(await zip(files).arrayBuffer());
}
