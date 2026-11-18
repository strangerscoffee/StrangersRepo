// Browser test: an admin reviewing a holiday request sees who else is off, overlapping and nearby kept apart, on a
// phone and an iPad in light and dark. Run with `npm run test:e2e`; SHOT_DIR=<dir> saves screenshots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, SETUP_CODE } from './harness.mjs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
let browser;

let srv, ADMIN, MGR;
const S = {}, ids = {};
const cookie = r => (r.headers.getSetCookie().find(c => /^sfbb_session=[\w-]/.test(c)) || '').split(';')[0];
async function call(method, path, body, session = ADMIN) {
    const r = await fetch(srv.base + '/api/' + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie: session }, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch {}
    return { status: r.status, data };
}
async function ok(method, path, body, session) { const r = await call(method, 'rota/leave/' + path, body, session); assert.equal(r.status, 200, JSON.stringify(r)); return r.data; }
async function user(name, role = 'staff') {
    const r = await call('POST', 'admin/users', { name, username: name.toLowerCase(), role, password: 'temporary-password' });
    ids[name] = r.data.user.id;
    const c = await fetch(srv.base + '/api/auth/change', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name.toLowerCase(), password: 'temporary-password', newPassword: 'personal-password-' + name }) });
    return cookie(c);
}
async function book(session, from, to, extra = {}) {
    const body = { kind: 'annual', from, to, reason: 'PRIVATE REASON ' + from, ...extra };
    const p = await ok('POST', 'preview', body, session);
    return (await ok('POST', 'requests', { ...body, requestKey: crypto.randomUUID(), expectedCharges: p.days }, session)).absence;
}

before(async () => {
    srv = await startServer({ writeLimit: 4000 });
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const r = await fetch(srv.base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Leave Owner', username: 'owner', password: 'leave-owner-password', code: SETUP_CODE }) });
    ADMIN = cookie(r);
    await call('POST', 'db/set', { path: 'settings/main', data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } });
    for (const name of ['Alice', 'Beth', 'Carol', 'Dan']) S[name] = await user(name);
    MGR = await user('Manager', 'manager');
    const p = await ok('GET', 'admin');
    await ok('PUT', 'settings', { enabled: true, yearStart: '04-01', bankHolidayPolicy: 'credit-worked', limits: {}, ifVersion: p.version });
    for (const name of ['Alice', 'Beth', 'Carol', 'Dan']) await ok('PUT', 'allowances', { userId: ids[name], from: '2030-04-01', to: '2031-03-31', unit: 'days', entitlement: 25, carry: 0, openingUsed: 0, weekly: [1, 1, 1, 1, 1, 1, 1], excludedDates: [], bankHolidays: [], changeReason: 'Agreed entitlement', ifVersion: 0 });
});
after(async () => { await browser?.close(); await srv?.stop(); });

let asked;
for (const [label, viewport] of [['phone', { width: 393, height: 852 }], ['iPad', { width: 1180, height: 820 }]]) for (const scheme of ['light', 'dark']) test(`who else is off on a ${label} (${scheme})`, { timeout: 90000 }, async () => {
    if (!asked) {
        asked = await book(S.Alice, '2031-01-15', '2031-01-17');
        await book(ADMIN, '2031-01-16', '2031-01-20', { userId: ids.Beth, approved: true });
        await book(ADMIN, '2031-01-08', '2031-01-10', { kind: 'unpaid', userId: ids.Carol, approved: true });
        await book(ADMIN, '2031-01-20', '2031-01-21', { userId: ids.Dan, approved: true });
    }
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, hasTouch: true, isMobile: viewport.width < 1024 });
    const [name, value] = ADMIN.split('=');
    await ctx.addCookies([{ name, value, url: srv.base }]);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
        await page.goto(srv.base + '/rota/#requests');
        const card = page.locator(`[data-leave-request="${asked.id}"]`);
        await card.waitFor();
        await card.getByRole('button', { name: 'Review request', exact: true }).click();
        const panel = page.locator('#sheet section[aria-label="Who else is off"]');
        await panel.waitFor();
        const overlap = panel.locator('.team-off-group.overlap'), nearby = panel.locator('.team-off-group.nearby');
        assert.match(await overlap.innerText(), /1 person is already off on these dates/);
        assert.match(await overlap.innerText(), /Beth[\s\S]*Holiday · Thu 16 Jan – Mon 20 Jan[\s\S]*Overlaps Thu 16 Jan – Fri 17 Jan/);
        assert.doesNotMatch(await overlap.innerText(), /Carol|Dan/);
        const near = await nearby.innerText();
        assert.match(near, /Nearby, not overlapping/);
        assert.match(near, /Carol[\s\S]*Unpaid leave · Wed 8 Jan – Fri 10 Jan[\s\S]*Back 5 days before this starts/);
        assert.match(near, /Dan[\s\S]*Holiday · Mon 20 Jan – Tue 21 Jan[\s\S]*Starts 3 days after this ends/);
        await page.locator('#sheet').evaluate(s => Promise.all(s.getAnimations().map(a => a.finished.catch(() => {}))));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        // The decision buttons are still there.
        await page.locator('#sheet').getByRole('button', { name: 'Approve', exact: true }).waitFor();
        if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, `team-off-${label}-${scheme}.png`) });
        assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
});
