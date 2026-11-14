// The placement back to Eagle / Fusion Electronics, as a script (.scr) that the board editor runs:
// it draws the outline and the holes and moves, turns and flips every part placed in Caliper.
import { boardPolygon } from './geometry.js';

const f = (v) => String(Math.round(v * 1000) / 1000);

export function eagleScript(board, n = Number, { name = 'board' } = {}) {
  const lines = [
    `# Placement for ${name}, exported by Caliper.`,
    '# In the Eagle or Fusion Electronics board editor: File > Execute Script (or type SCRIPT and pick this file).',
    '# Delete the old board outline first if it has one; parts not placed in Caliper are left where they are.',
    'GRID MM;',
    'SET WIRE_BEND 2;',
    'LAYER 20;',
  ];
  const ol = board.outline || { kind: 'rect', w: 60, h: 40 };
  if (ol.kind === 'circle') {
    const r = n(ol.d) / 2;
    lines.push(`CIRCLE 0 (${f(n(ol.x ?? 0))} ${f(n(ol.y ?? 0))}) (${f(n(ol.x ?? 0) + r)} ${f(n(ol.y ?? 0))});`);
  } else {
    const pts = boardPolygon(board, n);
    lines.push(`WIRE 0 ${pts.concat([pts[0]]).map((p) => `(${f(p[0])} ${f(p[1])})`).join(' ')};`);
  }
  for (const h of board.holes || []) lines.push(`HOLE ${f(n(h.d))} (${f(n(h.x))} ${f(n(h.y))});`);
  for (const p of board.parts || []) {
    if (p.off) continue;
    lines.push(`MOVE ${p.ref} (${f(n(p.x ?? 0))} ${f(n(p.y ?? 0))});`);
    lines.push(`ROTATE =${p.side === 'bottom' ? 'M' : ''}R${f(((n(p.rot ?? 0) % 360) + 360) % 360)} ${p.ref};`);
  }
  lines.push('WINDOW FIT;');
  return `${lines.join('\n')}\n`;
}
