// KiCad files are S-expressions: (head item item (child …) …). Each list becomes an array whose first
// element is its head symbol; strings and symbols are JS strings, numbers stay strings until asked.
export function parseSexpr(src) {
  let i = 0;
  const n = src.length;
  const stack = [[]];
  while (i < n) {
    const c = src[i];
    if (c === '(') {
      stack.push([]);
      i++;
    } else if (c === ')') {
      const list = stack.pop();
      if (!stack.length) throw new Error('Unbalanced parentheses.');
      stack[stack.length - 1].push(list);
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          j += 2;
        } else out += src[j++];
      }
      stack[stack.length - 1].push(out);
      i = j + 1;
    } else if (c === ' ' || c === '\n' || c === '\r' || c === '\t') i++;
    else {
      let j = i;
      while (j < n && !' \n\r\t()"'.includes(src[j])) j++;
      stack[stack.length - 1].push(src.slice(i, j));
      i = j;
    }
  }
  if (stack.length !== 1) throw new Error('Unbalanced parentheses.');
  return stack[0][0];
}

export const isList = (x) => Array.isArray(x);
export const head = (x) => (isList(x) ? x[0] : null);
// Child lists with this head.
export const all = (node, name) => (isList(node) ? node.filter((c) => isList(c) && c[0] === name) : []);
export const one = (node, name) => all(node, name)[0] || null;
// Value(s) of a child: one(node,'at') -> ['at','1','2'] -> nums -> [1, 2].
export const nums = (node, name) => {
  const c = one(node, name);
  return c ? c.slice(1).filter((v) => !isList(v)).map(Number) : null;
};
export const str = (node, name) => {
  const c = one(node, name);
  return c ? c[1] : null;
};
// KiCad 6+ properties: (property "Reference" "R1" …); KiCad 5 / fp_text: (fp_text reference "R1" …).
export function prop(node, key) {
  for (const p of all(node, 'property')) if (p[1] === key) return p[2];
  const t = all(node, 'fp_text').find((x) => x[1] === key.toLowerCase());
  return t ? t[2] : null;
}
