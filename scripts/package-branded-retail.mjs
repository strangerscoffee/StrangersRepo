import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repository = fileURLToPath(new URL('../', import.meta.url));
const source = join(repository, 'public', 'consumer-preview');
const marker = '.branded-retail-package.json';
const storefrontDirectory = /^(?:assets|[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const storefrontPage = /^(?:(?!assets\/)[a-z0-9]+(?:-[a-z0-9]+)*\/)?index\.html$/;
const storefrontAsset = /^assets\/[a-z0-9][a-z0-9_.-]{0,110}\.(?:css|js|svg|webp|woff2|txt)$/i;
const storefrontTypes = 'assets/product-paths.d.ts';

if (process.argv.slice(2).some(arg => /^--(?:dist|revision)(?:=|$)/.test(arg))) {
  throw new Error('Historical retail imports are retired. Verify the current storefront with npm run package:branded-retail.');
}
const { values: { out, 'update-manifest': update } } = parseArgs({
  options: { out: { type: 'string' }, 'update-manifest': { type: 'boolean' } },
});
if (out !== undefined && (!out || update)) {
  throw new Error('Use --out <new directory outside the repository> or --update-manifest separately.');
}
if (!(await lstat(source)).isDirectory() || await realpath(source) !== join(await realpath(repository), 'public', 'consumer-preview')) {
  throw new Error('Expected a regular storefront source directory.');
}

const tracked = new Set(execFileSync('git', ['-C', source, 'ls-files', '-z', '--', '.'], { encoding: 'utf8' }).split('\0'));
const files = [];
for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
  const path = relative(source, join(entry.parentPath, entry.name)).split(sep).join('/');
  if (entry.isDirectory() && storefrontDirectory.test(path)) continue;
  const isPackageFile = path === marker || path === storefrontTypes || storefrontPage.test(path) || storefrontAsset.test(path);
  if (!entry.isFile() || !isPackageFile) {
    throw new Error(`Unsupported storefront entry at public/consumer-preview/${path}. Use storefront pages and supported assets only.`);
  }
  if (!tracked.has(path)) {
    throw new Error(`Untracked storefront file at public/consumer-preview/${path}. Add intended source files to Git before packaging.`);
  }
  if (path !== marker) files.push(path);
}
files.sort();
const manifest = JSON.stringify({ files }, null, 2) + '\n';
const manifestPath = join(source, marker);
if (update) {
  if (!(await lstat(manifestPath)).isFile()) throw new Error('Expected a regular storefront manifest.');
  await writeFile(manifestPath, manifest);
  console.log(`Updated storefront manifest (${files.length} files).`);
} else {
  if (await readFile(manifestPath, 'utf8') !== manifest) {
    throw new Error('Storefront manifest is out of date. Run npm run package:branded-retail -- --update-manifest and review the diff.');
  }
  if (out) {
    const requested = resolve(out);
    const destination = join(await realpath(dirname(requested)), basename(requested));
    const withinRepository = relative(await realpath(repository), destination);
    if (!withinRepository || (withinRepository !== '..' && !withinRepository.startsWith('..' + sep) && !isAbsolute(withinRepository))) {
      throw new Error('Choose a new storefront export directory outside the repository.');
    }
    await mkdir(destination);
    try {
      for (const path of [...files, marker]) {
        const target = join(destination, path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(source, path), target);
      }
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
    console.log(`Exported ${files.length} storefront files to ${destination}.`);
  } else {
    console.log(`Verified storefront manifest (${files.length} files).`);
  }
}
