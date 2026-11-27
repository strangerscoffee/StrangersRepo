import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const script = join(repository, 'scripts', 'package-branded-retail.mjs');
const source = join(repository, 'public', 'consumer-preview');
const marker = '.branded-retail-package.json';
const run = (...args) => execFileSync(process.execPath, [script, ...args]);
const rejected = (...args) => {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.error ?? result.stderr);
  return result.stderr;
};
const inventory = async directory => (await readdir(directory, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort();

test('packages every production storefront file byte for byte into a fresh directory', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'strangers-storefront-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  run();
  const first = join(workspace, 'first');
  const second = join(workspace, 'second');
  run('--out', first);
  run('--out', second);

  const paths = await inventory(source);
  assert.deepEqual(await inventory(first), paths);
  assert.deepEqual(await inventory(second), paths);
  const manifest = JSON.parse(await readFile(join(first, marker), 'utf8'));
  assert.deepEqual(manifest.files, paths.filter(path => path !== marker));
  for (const path of [
    'account/index.html', 'checkout/index.html', 'coffee/index.html', 'product/index.html',
    'assets/account.js', 'assets/app.js', 'assets/availability.js', 'assets/beta-orders.js',
    'assets/checkout-page.js', 'assets/product-page.js', 'assets/product-paths.js', 'assets/store.js',
  ]) assert.ok(paths.includes(path), `Missing active storefront source ${path}`);

  assert.match(rejected('--dist', '/tmp/dist', '--revision', '65dd7832948df051a2a03a908d17b63f4b9889e9'), /Historical retail imports are retired/);
  assert.match(rejected('--out', join(source, 'export')), /outside the repository/);
  const alias = join(workspace, 'repo-alias');
  await symlink(repository, alias, 'dir');
  assert.match(rejected('--out', join(alias, 'export')), /outside the repository/);
  assert.match(rejected('--out', first), /EEXIST/);

  for (const path of paths) {
    const expected = await readFile(join(source, path));
    assert.deepEqual(await readFile(join(first, path)), expected, path);
    assert.deepEqual(await readFile(join(second, path)), expected, path);
  }
});


test('rejects unsupported and untracked storefront entries on update and direct builds', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'strangers-storefront-inventory-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const scripts = join(workspace, 'scripts');
  const tree = join(workspace, 'public', 'consumer-preview');
  await mkdir(scripts);
  await mkdir(join(tree, 'assets'), { recursive: true });
  await copyFile(script, join(scripts, 'package-branded-retail.mjs'));
  await copyFile(join(repository, 'scripts', 'build-assets.mjs'), join(scripts, 'build-assets.mjs'));
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args]);
  git('init', '-q');
  const canonicalManifest = '{\n  "files": [\n    "index.html"\n  ]\n}\n';
  await writeFile(join(tree, marker), canonicalManifest);
  await writeFile(join(tree, 'index.html'), '<main>Storefront</main>');
  git('add', 'public');

  const env = { ...process.env };
  delete env.WORKERS_CI;
  delete env.STRANGERS_ASSETS_DIRECTORY;
  const invoke = (entry, ...args) => spawnSync(process.execPath, [join(scripts, entry), ...args], {
    cwd: workspace, env, encoding: 'utf8',
  });
  const build = () => invoke('build-assets.mjs', '--workers-ci');
  const update = () => invoke('package-branded-retail.mjs', '--update-manifest');
  const verifyRejected = (result, pattern) => {
    assert.equal(result.status, 1, result.error ?? result.stderr);
    assert.match(result.stderr, pattern);
  };

  const cases = [
    [join(tree, '.local'), 'hidden file', /Unsupported storefront entry/],
    [join(tree, 'assets', 'key.pem'), 'unsupported extension', /Unsupported storefront entry/],
    [join(tree, 'assets', 'index.html'), 'page inside assets', /Unsupported storefront entry/],
    [join(tree, 'assets', 'local.js'), 'untracked browser script', /Untracked storefront file/],
  ];
  for (const [path, contents, reason] of cases) {
    await writeFile(path, contents);
    verifyRejected(update(), reason);
    verifyRejected(build(), reason);
    await rm(path);
  }

  const linkedAsset = join(tree, 'assets', 'linked.js');
  await symlink(join(tree, 'index.html'), linkedAsset);
  verifyRejected(update(), /Unsupported storefront entry/);
  await rm(linkedAsset);
  const linkedPage = join(tree, 'linked');
  await symlink(join(tree, 'assets'), linkedPage, 'dir');
  verifyRejected(build(), /Unsupported storefront entry/);
  await rm(linkedPage);
  const manifestPath = join(tree, marker);
  assert.equal(await readFile(manifestPath, 'utf8'), canonicalManifest);
  const outsideManifest = join(workspace, 'outside-manifest.json');
  await writeFile(outsideManifest, canonicalManifest);
  await rm(manifestPath);
  await symlink(outsideManifest, manifestPath);
  verifyRejected(update(), /Unsupported storefront entry/);
  assert.equal(await readFile(outsideManifest, 'utf8'), canonicalManifest);
  await rm(manifestPath);
  await writeFile(manifestPath, canonicalManifest);

  await writeFile(join(tree, 'assets', 'intended.js'), 'console.log("Storefront");');
  git('add', '-N', 'public/consumer-preview/assets/intended.js');
  verifyRejected(build(), /Storefront manifest is out of date/);
  const updated = update();
  assert.equal(updated.status, 0, updated.stderr);
  const built = build();
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /Verified storefront manifest/);
  assert.deepEqual(await readdir(join(workspace, 'public')), ['consumer-preview']);
});
