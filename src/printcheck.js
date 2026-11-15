// Printability for FDM printers, from the display meshes: overhangs, bed contact, floating parts,
// size against a build volume. Used by the Print check panel and by agents (check_printability).
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => (Array.isArray(v) ? v.map(r3) : Math.round(v * 1000) / 1000);

export function printCheck(all, { overhang_angle = 45, build_volume } = {}) {
  const list = all.filter((b) => !b.kind); // circuit boards and their parts are not printed
  if (!list.length) return { ok: false, note: all.length ? 'Only a circuit board and its parts are here; they are not printed. Model the enclosure first.' : 'There is nothing to print yet.' };
  const res = { min: [0, 1, 2].map((k) => Math.min(...list.map((b) => b.min[k]))), max: [0, 1, 2].map((k) => Math.max(...list.map((b) => b.max[k]))) };
  const bed = res.min[2];
  const limit = Math.sin((overhang_angle * Math.PI) / 180);
  const issues = [];
  const report = { bed_z: r3(bed), bodies: [] };
  for (const b of list) {
    const P = b.positions;
    const I = b.indices;
    const tri = new Map(); // face index -> overhang area
    let overhang = 0;
    let contact = 0;
    const faceOf = new Int32Array(I.length / 3).fill(-1);
    for (const g of b.faceGroups) for (let k = g.start; k < g.start + g.count; k += 3) faceOf[k / 3] = g.i;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3;
      const c = I[t + 1] * 3;
      const d = I[t + 2] * 3;
      const ux = P[c] - P[a];
      const uy = P[c + 1] - P[a + 1];
      const uz = P[c + 2] - P[a + 2];
      const vx = P[d] - P[a];
      const vy = P[d + 1] - P[a + 1];
      const vz = P[d + 2] - P[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (!len) continue;
      const area = len / 2;
      const zMax = Math.max(P[a + 2], P[c + 2], P[d + 2]);
      if (nz / len < -0.999 && zMax <= bed + 0.05) contact += area;
      else if (-nz / len > limit && zMax > bed + 0.05) {
        overhang += area;
        const fi = faceOf[t / 3];
        tri.set(fi, (tri.get(fi) || 0) + area);
      }
    }
    const entry = {
      body: b.id,
      name: b.name,
      size_mm: b.max.map((v, i) => r2(v - b.min[i])),
      bed_contact_mm2: r2(contact),
      overhang_mm2: r2(overhang),
    };
    if (!b.isMesh && overhang > 0.5) {
      entry.overhang_faces = [...tri.entries()]
        .filter(([fi]) => fi >= 0)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 12)
        .map(([fi, area]) => ({ ref: `${b.id}:F${fi}`, area_mm2: r2(area), center: r3(b.faces[fi]?.c) }));
    }
    if (b.isMesh) entry.triangles = b.triangles;
    if (b.min[2] < -0.05) issues.push(`${b.name} goes ${r2(-b.min[2])} mm below the bed (Z = 0). Move it up, or use Rest on the bed.`);
    else if (b.min[2] > bed + 0.05) issues.push(`${b.name} floats ${r2(b.min[2] - bed)} mm above the bed; it needs support or should be moved down.`);
    if (contact < 1) issues.push(`${b.name} has almost no flat area on the bed (${r2(contact)} mm²); it may not stick. Consider a flat base or a brim.`);
    if (overhang > 1) issues.push(`${b.name} has ${r2(overhang)} mm² of overhang steeper than ${overhang_angle}° from vertical; it needs supports there or a design change (chamfers instead of fillets on downward edges, or rotate the part).`);
    report.bodies.push(entry);
  }
  if (list.length > 1) issues.push(`There are ${list.length} separate bodies. They will print as separate parts unless joined.`);
  if (bed !== 0 && Math.abs(bed) > 0.01) issues.push(`The lowest point is at Z = ${r2(bed)}, not 0. Most slicers drop parts onto the bed anyway.`);
  if (Array.isArray(build_volume) && build_volume.length === 3) {
    const size = res.max.map((v, i) => v - res.min[i]);
    const fits = size.every((s, i) => s <= Number(build_volume[i]));
    report.fits_build_volume = fits;
    if (!fits) issues.push(`The part (${size.map(r2).join(' × ')} mm) is larger than the build volume (${build_volume.join(' × ')} mm).`);
  }
  report.issues = issues;
  report.ok = issues.length === 0;
  report.not_checked = 'Wall thickness, small holes and bridging are not checked.';
  return report;
}

