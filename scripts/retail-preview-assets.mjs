import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'public');
const output = join(root, 'dist', 'retail-preview');
const assets = new Set(['shop', 'theme.css', 'logo.svg', 'mark.svg']);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all([...assets].map(path => cp(join(source, path), join(output, path), { recursive: true })));

if (process.argv[2] === '--dev') {
  const child = spawn(process.execPath, [
    join(root, 'node_modules/wrangler/bin/wrangler.js'),
    'dev', '--config', 'wrangler.retail-preview.jsonc', ...process.argv.slice(3),
  ], { cwd: root, stdio: 'inherit' });
  let changes = Promise.resolve();
  const watcher = watch(source, { recursive: true }, (_event, path) => {
    if (!path || !assets.has(path.split(sep)[0])) return;
    changes = changes.then(async () => {
      const target = join(output, path);
      await mkdir(dirname(target), { recursive: true });
      try {
        await cp(join(source, path), target, { recursive: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await rm(target, { recursive: true, force: true });
      }
    }).catch(error => console.error('Could not sync the preview asset', path, error));
  });
  child.once('exit', code => {
    watcher.close();
    process.exitCode = code ?? 0;
  });
}
