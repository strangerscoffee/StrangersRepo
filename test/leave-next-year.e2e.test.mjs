// Browser test of "Start next year for everyone" (Holiday management): the review, the part-year check, the summary
// and creating the years, on a phone and an iPad in light and dark. Run with `npm run test:e2e`; SHOT_DIR saves screenshots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startServer, SETUP_CODE } from './harness.mjs';
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
async function ok(method, path, body, session) { const r = await call(method, path, body, session); assert.equal(r.status, 200, JSON.stringify(r)); return r.data; }
async function user(name, role = 'staff') {
    const r = await call('POST', 'admin/users', { name, username: name.toLowerCase(), role, password: 'temporary-password' });
    ids[name] = r.data.user.id;
    const c = await fetch(srv.base + '/api/auth/change', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name.toLowerCase(), password: 'temporary-password', newPassword: 'personal-password-' + name }) });
    return cookie(c);
}
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const thisFrom = (today.slice(5) < '04-01' ? Number(today.slice(0, 4)) - 1 : Number(today.slice(0, 4))) + '-04-01';
const y = Number(thisFrom.slice(0, 4));
const thisTo = `${y + 1}-03-31`, nextFrom = `${y + 1}-04-01`, nextTo = `${y + 2}-03-31`;
const days = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5) + 1;
const MON_FRI = [1, 1, 1, 1, 1, 0, 0];
const allowance = (name, extra) => ok('PUT', 'rota/leave/allowances', { userId: ids[name], from: thisFrom, to: thisTo, unit: 'days', entitlement: 28, carry: 0, openingUsed: 0, weekly: MON_FRI, excludedDates: [], bankHolidays: [], changeReason: 'Agreed entitlement', ifVersion: 0, ...extra });
const BETH_START = `${y}-10-01`, CAROL_START = `${y}-07-01`;

before(async () => {
    srv = await startServer({ writeLimit: 4000 });
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const r = await fetch(srv.base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Leave Owner', username: 'owner', password: 'leave-owner-password', code: SETUP_CODE }) });
    ADMIN = cookie(r);
    for (const name of ['Alice', 'Beth', 'Carol', 'Dan', 'Eve']) S[name] = await user(name);
    MGR = await user('Manager', 'manager');
    const p = await ok('GET', 'rota/leave/admin');
    await ok('PUT', 'rota/leave/settings', { enabled: true, yearStart: '04-01', bankHolidayPolicy: 'credit-worked', limits: {}, ifVersion: p.version });
    // Alice: a whole year, 28 days, bank holidays reserved, days in lieu. Beth started in October on 14 days.
    // Carol works three days a week and started in July on 10 days. Dan has no allowance. Eve already has next year.
    await ok('PATCH', `admin/users/${ids.Alice}`, { startDate: '2019-05-13' });
    await ok('PATCH', `admin/users/${ids.Beth}`, { startDate: BETH_START });
    await ok('PATCH', `admin/users/${ids.Carol}`, { startDate: CAROL_START });
    await allowance('Alice', { bankHolidays: [`${y + 1}-01-01`], bankHolidayEligible: true, carry: 3, note: 'Full-time contract' });
    await allowance('Beth', { entitlement: 14 });
    await allowance('Carol', { entitlement: 10, weekly: [1, 0, 1, 0, 1, 0, 0] });
    await allowance('Eve', {});
    await ok('PUT', 'rota/leave/allowances', { userId: ids.Eve, from: nextFrom, to: nextTo, unit: 'days', entitlement: 30, weekly: MON_FRI, changeReason: 'Agreed already', ifVersion: 0 });
});
after(async () => { await browser?.close(); await srv?.stop(); });


const shot = (page, name) => process.env.SHOT_DIR ? page.screenshot({ path: join(process.env.SHOT_DIR, name + '.png') }) : null;
const runs = [['phone', { width: 393, height: 852 }, 'light'], ['iPad', { width: 1180, height: 820 }, 'dark']];
for (const [label, viewport, scheme] of runs) test(`start next year on a ${label} (${scheme})`, { timeout: 120000 }, async () => {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, hasTouch: true, isMobile: viewport.width < 1024 });
    const [name, value] = ADMIN.split('=');
    await ctx.addCookies([{ name, value, url: srv.base }]);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
        await page.goto(srv.base + '/rota/#leave-admin');
        const launcher = page.getByRole('button', { name: 'Start next year for everyone', exact: true });
        await launcher.click();
        const sheet = page.locator('#sheet');
        await sheet.locator('.ny-person').first().waitFor();
        await page.keyboard.press('Escape');
        await sheet.waitFor({ state: 'hidden' });
        assert.equal(await launcher.evaluate(node => node === document.activeElement), true);
        await launcher.click();
        await sheet.locator('.ny-person').first().waitFor();
        assert.match(await sheet.innerText(), /Dan[\s\S]*No allowance this year to start from/);
        assert.match(await sheet.innerText(), /Eve[\s\S]*Next year already set up/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (label === 'phone') {
            const beth = sheet.locator(`[data-next-year="${ids.Beth}"]`);
            assert.match(await beth.innerText(), /Started part way through this leave year/);
            assert.match(await beth.innerText(), /This year: 14 days · Mon–Fri/);
            assert.equal(await beth.locator('input[type=number]').inputValue(), '28');
            await shot(page, `next-year-${label}-${scheme}`);
            await beth.locator('.ny-part').scrollIntoViewIfNeeded();
            await shot(page, `next-year-part-${label}-${scheme}`);
            // Bank holidays, then Check and confirm: Beth and Carol's full years must be ticked first.
            await sheet.locator('#ny_banks').fill(`${y + 1}-12-25, ${y + 1}-12-26`);
            await sheet.getByRole('button', { name: 'Check and confirm', exact: true }).click();
            await sheet.locator('.smsg', { hasText: /Tick that you've checked (Beth|Carol)'s full-year allowance/ }).waitFor();
            for (const who of ['Beth', 'Carol']) await sheet.locator(`[data-next-year="${ids[who]}"]`).getByText(`I've checked ${who}'s full-year allowance`).click();
            await sheet.locator(`[data-next-year="${ids.Carol}"] input[type=number]`).fill('18');
            // Leave Alice out, to show unticked people are left alone (the iPad run does her).
            await sheet.locator(`[data-next-year="${ids.Alice}"] .leave-check input`).first().uncheck();
        } else {
            assert.match(await sheet.innerText(), /Beth[\s\S]*Next year already set up/);
            const alice = sheet.locator(`[data-next-year="${ids.Alice}"]`);
            assert.match(await alice.innerText(), /This year: 28 days · Mon–Fri · bank holidays reserved · 3 carried over \(not copied\)/);
            await alice.locator('summary').click();
            await alice.locator('select').nth(4).selectOption('0.5');
            assert.match(await alice.innerText(), /Mon, Tue, Wed, Thu, Fri ½/);
            await page.waitForTimeout(600);
            await shot(page, `next-year-${label}-${scheme}`);
        }
        await sheet.getByRole('button', { name: 'Check and confirm', exact: true }).click();
        const summary = sheet.locator('.ny-summary');
        await summary.waitFor();
        assert.equal(await summary.evaluate(node => node === document.activeElement), true);
        await sheet.getByRole('button', { name: 'Back to edit', exact: true }).click();
        const confirm = sheet.getByRole('button', { name: 'Check and confirm', exact: true });
        assert.equal(await confirm.evaluate(node => node === document.activeElement), true);
        await confirm.click();
        await summary.waitFor();
        assert.match(await summary.innerText(), /Nothing has been saved yet/);
        if (label === 'phone') {
            assert.match(await summary.innerText(), /Carol[\s\S]*was 10 days[\s\S]*18 days/);
            assert.match(await summary.innerText(), /Beth[\s\S]*started part way through this year, checked[\s\S]*28 days/);
            assert.match(await summary.innerText(), /Not ticked, so left alone: Alice/);
            assert.equal((await ok('GET', 'rota/leave/dashboard?userId=' + ids.Beth)).balances.some(b => b.from === nextFrom), false, 'nothing saved before Create');
        } else assert.match(await summary.innerText(), /Alice[\s\S]*week changed from Mon–Fri/);
        await page.waitForTimeout(300);
        await shot(page, `next-year-confirm-${label}-${scheme}`);
        await sheet.getByRole('button', { name: label === 'phone' ? 'Create 2 leave years' : 'Create 1 leave year', exact: true }).click();
        await page.locator('#toast', { hasText: /Next leave year set up for/ }).waitFor();
        const next = async (who) => (await ok('GET', 'rota/leave/dashboard?userId=' + ids[who])).balances.find(b => b.from === nextFrom);
        if (label === 'phone') { assert.equal((await next('Carol')).entitlement, 18); assert.equal(await next('Alice'), undefined); }
        else assert.deepEqual((await next('Alice')).weekly, [1, 1, 1, 1, 0.5, 0, 0]);
        assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
});
