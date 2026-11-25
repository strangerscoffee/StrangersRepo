import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import { ROOT, SETUP_CODE, startServer } from './harness.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

test('asset builds keep older browser versions across commits with identical assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'strangers-asset-history-'));
  const assets = join(dir, 'public'), file = join(assets, 'theme.css');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    git('init', '-q');
    await mkdir(assets);
    for (const version of ['old', 'middle', 'middle', 'new']) {
      await writeFile(file, `/* ${version} */`);
      git('add', 'public/theme.css');
      git('-c', 'user.name=Test', '-c', 'user.email=assets@example.test', 'commit', '--allow-empty', '-qm', version);
    }
    const env = { ...process.env, STRANGERS_ASSETS_DIRECTORY: assets, STRANGERS_PRIOR_ASSETS_REF: 'HEAD^' };
    execFileSync(process.execPath, [join(ROOT, 'scripts/build-assets.mjs')], { cwd: dir, env });
    const { retained, current, previous } = JSON.parse(await readFile(join(assets, '_releases', 'manifest.json'), 'utf8'));
    assert.deepEqual(retained.slice(0, 2), [current, previous]);
    assert.equal(retained.length, 3);
    assert.deepEqual(await Promise.all(retained.map(id => readFile(join(assets, '_releases', id, 'theme.css'), 'utf8'))),
      ['/* new */', '/* middle */', '/* old */']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('versioned assets keep the previous release and keep the retail host boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'strangers-versioned-assets-'));
  let server, staff, browser;
  try {
    const assets = join(dir, 'public');
    const config = ts.parseConfigFileTextToJson('wrangler.jsonc', await readFile(join(ROOT, 'wrangler.jsonc'), 'utf8')).config;
    delete config.build;
    config.main = join(ROOT, config.main);
    config.assets.directory = assets;
    const file = join(dir, 'wrangler.json');
    await writeFile(file, JSON.stringify(config));
    await cp(join(ROOT, 'public'), assets, { recursive: true });
    await writeFile(join(assets, 'shop/shop.css'), '\n/* versioned fixture */', { flag: 'a' });
    execFileSync(process.execPath, ['scripts/build-assets.mjs'], {
      cwd: ROOT, env: { ...process.env, STRANGERS_ASSETS_DIRECTORY: assets, STRANGERS_PRIOR_ASSETS_REF: 'HEAD' },
    });
    const { current, previous, source } = JSON.parse(await readFile(join(assets, '_releases', 'manifest.json'), 'utf8'));
    assert.notEqual(current, previous);
    const oldCss = `/_releases/${previous}/shop/shop.css`;
    const newCss = `/_releases/${current}/shop/shop.css`;
    const legacy = 'preview.staffstrangerscoffee.com';
    server = await startServer({ config: file, host: legacy, vars: { LEGACY_PREVIEW_HOST: legacy } });
    const home = await fetch(server.base + '/shop/');
    const html = await home.text();
    assert.ok(html.includes(`name="sc-release" content="${source}"`));
    assert.ok(html.includes(newCss));
    const old = await fetch(server.base + oldCss);
    assert.equal(old.status, 200);
    assert.match(old.headers.get('cache-control'), /immutable/);
    assert.doesNotMatch(await old.text(), /versioned fixture/);
    assert.match(await (await fetch(server.base + newCss)).text(), /versioned fixture/);
    const expired = "/_releases/ffffffffffffffffffff";
    const reporter = await fetch(server.base + expired + "/errors.js");
    assert.equal(reporter.status, 200);
    assert.match(reporter.headers.get("cache-control"), /no-store/);
    assert.equal(await reporter.text(), await readFile(join(assets, "errors.js"), "utf8"));
    assert.equal((await fetch(server.base + expired + "/shop/shop.js")).status, 404);
    for (const path of [`/_releases/${current}/admin/admin.js`, `/_releases/${current}/wholesale/source-prices.js`, '/_releases/manifest.json']) {
      assert.equal((await fetch(server.base + path)).status, 404, path);
    }
    assert.match(await readFile(join(assets, '_releases', current, 'admin/wholesale-insights.js'), 'utf8'), new RegExp('/_releases/' + current + '/shared/csv.js'));
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/shop/instagram.json', route => route.fulfill({ json: { posts: [] } }));
    await page.goto(server.base + '/shop/');
    await page.getByRole('heading', { name: 'Coffee from the heart of Norwich.' }).waitFor();
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Shop coffee' }).waitFor();
    assert.deepEqual(errors, []);

    staff = await startServer({ config: file, readyPath: '/robots.txt', vars: { SETUP_CODE, ADMIN_HOST: '', PREVIEW_HOST: '' } });
    const setup = await fetch(staff.base + '/api/auth/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin', username: 'owner', password: 'owner-password', code: SETUP_CODE }),
    });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.getSetCookie().find(value => /^sfbb_session=[\w-]/.test(value)).split(';')[0];
    const admin = await browser.newPage();
    const adminErrors = [];
    admin.on('pageerror', error => adminErrors.push(String(error)));
    admin.on('response', response => {
      if (response.status() >= 400) adminErrors.push(response.status() + ' ' + new URL(response.url()).pathname);
    });
    await admin.context().addCookies([{ name: 'sfbb_session', value: cookie.slice('sfbb_session='.length), url: staff.base }]);
    await admin.goto(staff.base + '/admin#overview');
    try {
      await admin.locator('#main[aria-busy="false"] .admin-overview').waitFor({ timeout: 10000 });
    } catch (error) {
      throw new Error('Versioned Admin failed to start at ' + admin.url() + '\n' + adminErrors.join('\n') + '\n' + await admin.locator('body').innerText(), { cause: error });
    }
  } finally {
    await browser?.close();
    await server?.stop();
    await staff?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
