// Bundles the AI Connect web SDK (github.com/fabioelia/ai-connect, packages/web) into
// src/vendor/ai-connect.js. It is not on npm yet, and Caliper builds into one self-contained file,
// so the SDK is vendored rather than loaded from another site.
// Usage: node scripts/vendor-ai-connect.mjs [path to an ai-connect checkout, after npm install] (default ../ai-connect)
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const src = resolve(process.argv[2] || resolve(root, '..', 'ai-connect'));
const out = resolve(root, 'src/vendor/ai-connect.js');
// esbuild from the ai-connect checkout (run npm install there first).
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [src] }));
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: src }).toString().trim();
} catch {
  /* not a git checkout */
}
await build({ entryPoints: [resolve(src, 'packages/web/src/index.ts')], bundle: true, format: 'esm', target: 'es2020', outfile: out, logLevel: 'warning' });
const head = `// AI Connect web SDK, vendored from github.com/fabioelia/ai-connect@${commit} (packages/web). MIT.\n// Regenerate with: node scripts/vendor-ai-connect.mjs\n/* eslint-disable */\n`;
writeFileSync(out, head + readFileSync(out, 'utf8'));
console.log(`wrote ${out} from ai-connect@${commit}`);
