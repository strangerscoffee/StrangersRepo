// Browser test: an admin changes the dates of a holiday request from the review sheet (Change dates), on a phone
// and an iPad in light and dark. Run with `npm run test:e2e`; SHOT_DIR=<dir> saves screenshots.
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

for (const [label, viewport, scheme] of [['phone', { width: 393, height: 852 }, 'light'], ['iPad', { width: 1180, height: 820 }, 'dark']]) test(`change dates on a ${label} (${scheme})`, { timeout: 90000 }, async () => {
    const start = label === 'phone' ? '2031-01-15' : '2031-02-12';
    const asked = await book(S.Alice, start, start.replace(/\d\d$/, (d) => String(Number(d) + 2).padStart(2, '0')));
    const target = label === 'phone' ? ['2031-01-20', '2031-01-21'] : ['2031-02-24', '2031-02-24'];
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
        await page.locator('#sheet').getByRole('button', { name: 'Change dates', exact: true }).click();
        await page.locator('#change_from').waitFor();
        assert.equal(await page.locator('#change_from').inputValue(), asked.from);
        await page.locator('#change_from').fill(target[0]);
        await page.locator('#change_to').fill(target[1]);
        assert.equal(await page.getByRole('button', { name: 'Save new dates', exact: true }).isVisible(), false, 'check first');
        await page.getByRole('button', { name: 'Check new dates', exact: true }).click();
        await page.locator('.leave-notice', { hasText: /New dates:/ }).waitFor();
        assert.match(await page.locator('.leave-notice', { hasText: /New dates:/ }).innerText(), target[0] === target[1] ? /Uses 1 day \(was 3 days\)/ : /Uses 2 days \(was 3 days\)/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.waitForTimeout(250);
        if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, `change-dates-${label}-${scheme}.png`) });
        // Changing a date again needs a new check.
        await page.locator('#change_to').fill(target[1]);
        await page.locator('#change_to').dispatchEvent('change');
        assert.equal(await page.getByRole('button', { name: 'Save new dates', exact: true }).isVisible(), false);
        await page.getByRole('button', { name: 'Check new dates', exact: true }).click();
        await page.getByRole('button', { name: 'Save new dates', exact: true }).click();
        await page.locator('#toast', { hasText: /Dates changed\. Alice has been told\./ }).waitFor();
        const now = (await ok('GET', 'requests/' + asked.id)).absence;
        assert.deepEqual([now.from, now.to], target);
        assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
});
