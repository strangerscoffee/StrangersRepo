import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

if (process.argv.includes('--workers-ci') && !process.env.WORKERS_CI) process.exit(0);

const root = resolve(process.env.STRANGERS_ASSETS_DIRECTORY || 'public');
const output = join(root, '_releases');
const work = await mkdtemp(join(tmpdir(), 'strangers-assets-'));
const staged = join(root, '._releases-build');
await rm(staged, { recursive: true, force: true });
await mkdir(staged);

async function release(source) {
  const paths = (await readdir(source, { recursive: true, withFileTypes: true }))
    .filter(file => file.isFile())
    .map(file => relative(source, join(file.parentPath, file.name)).split(sep).join('/'))
    .filter(path => /^(?![._])[-\w/]+\.(?:css|js)$/.test(path) && path !== 'wholesale/source-prices.js')
    .sort();
  const assets = new Map(await Promise.all(paths.map(async path => [path, await readFile(join(source, path), 'utf8')])));
  if (assets.has('shop/shop.js') && assets.has('theme.css')) assets.set('shop/theme.css', assets.get('theme.css'));
  const hash = createHash('sha256').update('strangers-browser-assets-v1\0');
  for (const [path, body] of assets) hash.update(path + '\0' + body + '\0');
  const id = hash.digest('hex').slice(0, 20);
  for (const [path, body] of assets) {
    const file = join(staged, id, path);
    await mkdir(dirname(file), { recursive: true });
    // Relative imports already stay inside the release. Root-relative browser module imports need the same prefix.
    const content = path.endsWith('.js') ? body.replace(/(\b(?:from\s+|import\s*\(\s*|import\s+))(['"])\/([-\w/]+\.js)(?=['"?])/g,
      (match, prefix, quote, asset) => assets.has(asset) ? prefix + quote + '/_releases/' + id + '/' + asset : match) : body;
    await writeFile(file, content);
  }
  return { id, files: [...assets.keys()].map(path => '/' + path) };
}

try {
  const source = process.env.WORKERS_CI_COMMIT_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const current = await release(root);
  const ref = process.env.STRANGERS_PRIOR_ASSETS_REF || 'HEAD^';
  const resolveParent = () => spawnSync('git', ['rev-parse', '--verify', ref + '^{commit}'], { encoding: 'utf8' });
  let parent = resolveParent();
  if (parent.status !== 0 && process.env.WORKERS_CI && ref === 'HEAD^') {
    execFileSync('git', ['fetch', '--no-tags', '--depth=2', 'origin', source], { stdio: 'inherit' });
    parent = resolveParent();
  }
  if (parent.status !== 0 && process.env.WORKERS_CI) {
    throw new Error('Release assets require the previous production commit. Fetch parent history before building.');
  }
  let previous = null;
  if (parent.status === 0) {
    const archive = join(work, 'previous.tar');
    execFileSync('git', ['archive', '--format=tar', '-o', archive, parent.stdout.trim(), 'public']);
    execFileSync('tar', ['-xf', archive, '-C', work]);
    previous = (await release(join(work, 'public'))).id;
  }
  await writeFile(join(staged, 'manifest.json'), JSON.stringify({ source, current: current.id, files: current.files, previous }));
  await rm(output, { recursive: true, force: true });
  await rename(staged, output);
  console.log('Browser assets', current.id, 'previous', previous || 'unavailable');
} finally {
  await rm(work, { recursive: true, force: true });
  await rm(staged, { recursive: true, force: true });
}
