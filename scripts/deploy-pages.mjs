// Publishes dist/ to the gh-pages branch, which GitHub Pages serves at https://<user>.github.io/<repo>/.
// The branch holds only build output, so each deploy replaces it with a single fresh commit.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
const sh = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

for (const f of ['index.html', 'kernel.wasm', 'mesh.wasm', 'font.ttf']) {
  if (!fs.existsSync(path.join(dist, f))) throw new Error(`dist/${f} is missing. Run "npm run bundle" first.`);
}
const remote = sh('git remote get-url origin');
const rev = sh('git rev-parse --short HEAD');
const dirty = sh('git status --porcelain') ? ' (with uncommitted changes)' : '';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'caliper-pages-'));
for (const f of ['index.html', 'kernel.wasm', 'mesh.wasm', 'font.ttf']) fs.copyFileSync(path.join(dist, f), path.join(out, f));
fs.writeFileSync(path.join(out, '.nojekyll'), ''); // serve the files as they are, no Jekyll pass

sh('git init -q -b gh-pages', out);
sh('git add -A', out);
sh(`git commit -q -m "Deploy ${rev}${dirty}"`, out);
sh(`git push -f "${remote}" gh-pages`, out);
fs.rmSync(out, { recursive: true, force: true });
console.log(`Published ${rev}${dirty} to the gh-pages branch of ${remote}`);
