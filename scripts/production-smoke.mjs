import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';

const sha = process.env.GITHUB_SHA;
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const api = process.env.GITHUB_API_URL || 'https://api.github.com';
assert.match(sha || '', /^[0-9a-f]{40}$/);
assert.equal(repository, 'strangerscoffee/StrangersRepo');
assert.ok(token, 'Missing GitHub check access');

async function github(path) {
  const result = await fetch(api + '/repos/' + repository + path, {
    headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!result.ok) throw new Error('GitHub returned ' + result.status);
  return result.json();
}

let built = false;
for (let attempt = 0; attempt < 60; attempt++) {
  if ((await github('/commits/main')).sha !== sha) {
    console.log('A newer main commit has its own production smoke check.');
    process.exit(0);
  }
  const checks = await github('/commits/' + sha + '/check-runs');
  const build = checks.check_runs.find(check => check.name === 'Workers Builds: strangersrepo');
  if (build?.status === 'completed') {
    assert.equal(build.conclusion, 'success', 'Cloudflare Workers build');
    built = true;
    break;
  }
  await pause(10000);
}
assert.ok(built, 'Cloudflare Workers build did not report success');

async function check(host, path, status, kind) {
  const url = new URL(path, 'https://' + host);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, status, url.href);
  if (kind) assert.match(response.headers.get('content-type') || '', kind, url.href);
  if (kind?.test('text/html')) {
    const html = await response.text();
    assert.ok(html.includes(`<meta name="sc-release" content="${sha}">`), 'Release marker on ' + url.href);
    const asset = html.match(/(?:href|src)="(\/_releases\/[a-f0-9]{20}\/[-\w/]+\.(?:js|css))"/)?.[1];
    assert.ok(asset, 'Missing versioned assets on ' + url.href);
    await check(host, asset, 200, asset.endsWith('.css') ? /text\/css/ : /javascript/);
    return;
  }
  await response.body?.cancel();
}

const staff = 'staffstrangerscoffee.com';
const trade = 'strangerscoffee.trade';
const preview = 'preview.staffstrangerscoffee.com';
for (let attempt = 0; ; attempt++) {
  try {
    await Promise.all([
      check(staff, '/signin', 200, /text\/html/),
      check('admin.' + staff, '/signin', 302),
      check('rota.' + staff, '/signin', 302),
      check(trade, '/signin', 200, /text\/html/),
      check(trade, '/api/wholesale/catalogue', 401),
      check(preview, '/shop/', 200, /text\/html/),
      check(trade, '/shop/', 404),
    ]);
    console.log('Production sign-in, retail and wholesale boundaries passed for ' + sha.slice(0, 12));
    break;
  } catch (error) {
    if (attempt >= 5) throw error;
    await pause(5000);
  }
}
