import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workersBuild = process.argv.includes('--workers-ci');
const root = resolve(process.env.STRANGERS_ASSETS_DIRECTORY || 'public');
if (workersBuild || root === fileURLToPath(new URL('../public', import.meta.url))) {
  execFileSync(process.execPath, [fileURLToPath(new URL('package-branded-retail.mjs', import.meta.url))], { stdio: 'inherit' });
}
if (workersBuild && !process.env.WORKERS_CI) process.exit(0);

const output = join(root, '_releases');
const work = await mkdtemp(join(tmpdir(), 'strangers-assets-'));
const staged = join(root, '._releases-build');
const releaseLimit = 16;
const historyLimit = 32;
const retained = new Set();
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
  if (retained.has(id)) return { id };
  for (const [path, body] of assets) {
    const file = join(staged, id, path);
    await mkdir(dirname(file), { recursive: true });
    // Relative imports already stay inside the release. Root-relative browser module imports need the same prefix.
    const content = path.endsWith('.js') ? body.replace(/(\b(?:from\s+|import\s*\(\s*|import\s+))(['"])\/([-\w/]+\.js)(?=['"?])/g,
      (match, prefix, quote, asset) => assets.has(asset) ? prefix + quote + '/_releases/' + id + '/' + asset : match) : body;
    await writeFile(file, content);
  }
  retained.add(id);
  return { id, files: [...assets.keys()].map(path => '/' + path) };
}

async function archivedRelease(commit) {
  const source = await mkdtemp(join(work, 'source-'));
  const archive = join(source, 'public.tar');
  try {
    execFileSync('git', ['archive', '--format=tar', '-o', archive, commit, 'public']);
    execFileSync('tar', ['-xf', archive, '-C', source]);
    return await release(join(source, 'public'));
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

try {
  const source = process.env.WORKERS_CI_COMMIT_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const current = await release(root);
  const ref = process.env.STRANGERS_PRIOR_ASSETS_REF || 'HEAD^';
  const resolveParent = () => spawnSync('git', ['rev-parse', '--verify', ref + '^{commit}'], { encoding: 'utf8' });
  if (process.env.WORKERS_CI && ref === 'HEAD^' && execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true') {
    execFileSync('git', ['fetch', '--no-tags', `--depth=${historyLimit + 1}`, 'origin', source], { stdio: 'inherit' });
  }
  const parent = resolveParent();
  if (parent.status !== 0 && process.env.WORKERS_CI) {
    throw new Error('Release assets require the previous production commit. Fetch parent history before building.');
  }
  let previous = null;
  if (parent.status === 0) {
    const commits = execFileSync('git', ['rev-list', '--first-parent', `--max-count=${historyLimit}`, parent.stdout.trim()], { encoding: 'utf8' }).trim().split('\n');
    const trees = new Set();
    for (const commit of commits) {
      const tree = spawnSync('git', ['rev-parse', '--verify', commit + ':public'], { encoding: 'utf8' });
      if (tree.status !== 0 || trees.has(tree.stdout)) continue;
      trees.add(tree.stdout);
      const archived = await archivedRelease(commit);
      if (!previous) previous = archived.id;
      if (retained.size >= releaseLimit) break;
    }
  }
  await writeFile(join(staged, 'manifest.json'), JSON.stringify({ source, current: current.id, files: current.files, previous, retained: [...retained] }));
  await rm(output, { recursive: true, force: true });
  await rename(staged, output);
  console.log('Browser assets', current.id, 'retained releases', retained.size);
} finally {
  await rm(work, { recursive: true, force: true });
  await rm(staged, { recursive: true, force: true });
}
