// A small XML reader (elements and attributes; text is ignored). Eagle files are well-formed XML, and
// this works in the page, the worker and Node alike, where DOMParser is not always available.
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m));

export function parseXML(src) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/\s*([\w:.-]+)\s*>|<\s*([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) {
      // closing tag: pop to the matching element (tolerates small mistakes)
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === m[1]) {
          stack.length = i;
          break;
        }
      }
    } else if (m[2]) {
      const attrs = {};
      for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescape(a[2] ?? a[3]);
      const el = { tag: m[2], attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      if (!m[4]) stack.push(el);
    }
  }
  return root;
}

export const kids = (el, tag) => (el ? el.children.filter((c) => !tag || c.tag === tag) : []);
export const kid = (el, tag) => (el ? el.children.find((c) => c.tag === tag) || null : null);
export function path(el, ...tags) {
  let cur = el;
  for (const t of tags) cur = kid(cur, t);
  return cur;
}
export function* walk(el, tag) {
  for (const c of el?.children || []) {
    if (c.tag === tag) yield c;
    yield* walk(c, tag);
  }
}
