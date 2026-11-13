import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { startServer, SETUP_CODE } from './harness.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
let srv, browser, ADMIN, today, yearFrom, yearTo, holiday, bankDay, index = 0;
const cookieOf = r => (r.headers.getSetCookie().find(c => /^sfbb_session=[\w-]/.test(c)) || '').split(';')[0];
async function api(method, path, body, cookie = ADMIN) { const r = await fetch(srv.base + '/api/' + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); return data; }
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
async function user() { const name = 'Holiday Buyer ' + (++index), username = 'holiday.' + index; const u = (await api('POST', 'admin/users', { name, username, role: 'staff', password: 'temporary-holiday-password' })).user; const r = await fetch(srv.base + '/api/auth/change', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'temporary-holiday-password', newPassword: 'personal-holiday-password' }) }); assert.equal(r.status, 200); return { ...u, cookie: cookieOf(r) }; }
async function context(viewport, colorScheme, cookie) { const c = await browser.newContext({ viewport, colorScheme }); const [name, value] = cookie.split('='); await c.addCookies([{ name, value, url: srv.base }]); const page = await c.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message)); return { c, page, errors }; }
before(async () => {
    srv = await startServer({ writeLimit: 5000 });
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const r = await fetch(srv.base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Holiday Admin', username: 'owner', password: 'holiday-admin-password', code: SETUP_CODE }) });
    ADMIN = cookieOf(r);
    today = (await api('GET', 'rota/me')).today;
    const y = Number(today.slice(0, 4)) - (today.slice(5) < '04-01' ? 1 : 0);
    yearFrom = y + '-04-01';
    yearTo = (y + 1) + '-03-31';
    holiday = addDays(today, 14);
    while ([0, 6].includes(new Date(holiday + 'T12:00:00Z').getUTCDay()))
        holiday = addDays(holiday, 1);
    const firstMay = Number(today.slice(0, 4)) + '-05-01';
    bankDay = firstMay;
    while (new Date(bankDay + 'T12:00:00Z').getUTCDay() !== 1)
        bankDay = addDays(bankDay, 1);
    if (bankDay > today)
        bankDay = today.slice(0, 4) + '-01-01';
    await api('PUT', 'rota/leave/settings', { enabled: true, yearStart: '04-01', bankHolidayPolicy: 'credit-worked', limits: {}, ifVersion: 0 });
});
after(async () => { await browser?.close(); await srv?.stop(); });
for (const [device, viewport] of [['smallphone', { width: 320, height: 740 }], ['phone', { width: 393, height: 852 }], ['portrait iPad', { width: 820, height: 1180 }], ['iPad', { width: 1180, height: 820 }], ['desktop', { width: 1440, height: 1000 }]])
    for (const colorScheme of ['light', 'dark'])
        test(`holiday management ${device} ${colorScheme}: individual allowance, half-day approval, rota calendar and bank-holiday lieu`, { timeout: 120000 }, async () => {
            const u = await user(), admin = await context(viewport, colorScheme, ADMIN), staff = await context(viewport, colorScheme, u.cookie);
            try {
                const p = admin.page;
                await p.goto(srv.base + '/rota/#leave-admin');
                await p.locator('#pageTitle', { hasText: 'Holiday management' }).waitFor();
                await p.locator('#leave_employee').selectOption(u.id);
                await p.getByRole('button', { name: 'Set up a leave year', exact: true }).click();
                await p.locator('#allow_from').fill(yearFrom);
                await p.locator('#allow_to').fill(yearTo);
                await p.locator('#allow_entitlement').fill('28');
                await p.locator('#allow_carry').fill('2');
                for (let i = 0; i < 7; i++)
                    await p.locator('#allow_week_' + i).fill(i < 5 ? '1' : '0');
                await p.locator('input[name="bankHolidayEligible"]').check();
                let lookupUnavailable = true;
                await p.route('**/api/rota/leave/bank-holidays?*', route => lookupUnavailable
                    ? route.fulfill({status:503,json:{code:'unavailable',message:'Government calendar unavailable; enter dates manually.'}})
                    : route.fulfill({ json: { region: 'England and Wales', holidays: [{ day: bankDay, title: 'Bank holiday fixture' }] } }));
                await p.getByRole('button', { name: 'Load England/Wales bank holidays', exact: true }).click();
                await p.locator('#sheet .smsg').filter({hasText:'Government calendar unavailable'}).waitFor();
                assert.equal(await p.locator('#conn').isVisible(),false,'an optional date feed failure must not mark the rota offline');
                assert.equal(await p.locator('#allow_entitlement').inputValue(),'28');
                assert.equal(await p.locator('#allow_banks').inputValue(),'');
                lookupUnavailable=false;
                await p.getByRole('button', { name: 'Load England/Wales bank holidays', exact: true }).click();
                await p.waitForFunction(day => document.getElementById('allow_banks')?.value === day, bankDay);
        assert.equal(await p.locator('#allow_banks').inputValue(), bankDay);
                await p.locator('#allow_reason').fill('Individual contract plus admin-approved exceptional carry-over');
                await p.getByRole('button', { name: 'Save allowance', exact: true }).click();
                await p.locator('#sheet').waitFor({ state: 'hidden' });
                const s = staff.page;
                await s.goto(srv.base + '/rota/#leave');
                await s.locator('#pageTitle', { hasText: 'Holidays' }).waitFor();
                await s.locator('.leave-stats .stat').first().waitFor();
                assert.match(await s.locator('.leave-stats .stat').first().innerText(), /29/);
                assert.equal(await s.locator('#snav a[href="#leave-admin"]').count(), 0);
                await s.getByRole('button', { name: 'Request leave', exact: true }).click();
                await s.locator('#leave_from').fill(holiday);
                await s.locator('#leave_to').fill(holiday);
                await s.locator('#leave_portion').selectOption('0.5');
                await s.locator('#leave_from_time').fill('09:00');
                await s.locator('#leave_to_time').fill('13:00');
                await s.locator('#leave_reason').fill('PRIVATE HOLIDAY NOTE <script>');
                await s.getByRole('button', { name: 'Review request', exact: true }).click();
                await s.getByRole('button', { name: 'Submit request', exact: true }).waitFor();
                assert.match(await s.locator('#sheet').innerText(), /0.5 days/);
                await s.getByRole('button', { name: 'Submit request', exact: true }).click();
                await s.locator('#sheet').waitFor({ state: 'hidden' });
                const d = await api('GET', 'rota/leave/dashboard', undefined, u.cookie), absence = d.absences.find(a => a.from === holiday);
                assert.equal(absence.days[0].amount, 0.5);
                assert.equal(d.balances[0].available, 28.5);
                await p.reload();
                await p.locator('[data-absence="' + absence.id + '"]').getByRole('button', { name: 'Review', exact: true }).click();
                await p.getByRole('button', { name: 'Approve', exact: true }).click();
                await p.locator('#sheet').waitFor({ state: 'hidden' });
                await s.reload();
                await s.locator('.leave-stats .stat').first().waitFor();
                assert.match(await s.locator('.leave-record[data-absence="' + absence.id + '"]').innerText(), /Approved/);
                const live = await api('GET', 'rota/week?start=' + addDays(holiday, -((new Date(holiday + 'T12:00:00Z').getUTCDay() + 6) % 7)));
                assert.ok(live.timeOff.some(t => t.id === absence.id && t.fromTime === '09:00'));
                await p.locator('#leave_employee').selectOption(u.id);
                await p.getByRole('button', { name: 'Bank holiday worked', exact: true }).click();
                await p.locator('#credit_day').fill(bankDay);
                await p.locator('#credit_reason').fill('Confirmed full-time employee worked this bank holiday');
                await p.locator('input[name="credit_worked"]').check();
                await p.getByRole('button', { name: 'Release one day', exact: true }).click();
                await p.locator('#sheet').waitFor({ state: 'hidden' });
                const after = await api('GET', 'rota/leave/dashboard', undefined, u.cookie);
                assert.equal(after.balances[0].available, 29.5);
                assert.equal(after.balances[0].total, 30);
                assert.equal(after.balances[0].bankHolidayReserved, 0);
                const layout = await s.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, targets: [...document.querySelectorAll('.leave-day,#pageAction button,.leave-calendar-head button')].filter(n => n.getClientRects().length).map(n => ({ w: n.getBoundingClientRect().width, h: n.getBoundingClientRect().height })) }));
                assert.equal(layout.overflow, 0);
                assert.ok(layout.targets.every(b => b.w >= 44 && b.h >= 44), JSON.stringify(layout));
                if (process.env.LEAVE_QA_DIR) {
                    await mkdir(process.env.LEAVE_QA_DIR, { recursive: true });
                    await s.screenshot({ path: `${process.env.LEAVE_QA_DIR}/${device}-${colorScheme}-staff.png`, fullPage: true });
                    await p.screenshot({ path: `${process.env.LEAVE_QA_DIR}/${device}-${colorScheme}-admin.png`, fullPage: true });
                }
                assert.deepEqual(admin.errors, []);
                assert.deepEqual(staff.errors, []);
            }
            catch (e) {
                if (process.env.LEAVE_QA_DIR) {
                    await mkdir(process.env.LEAVE_QA_DIR, { recursive: true });
                    await admin.page.screenshot({ path: `${process.env.LEAVE_QA_DIR}/${device}-${colorScheme}-failure.png`, fullPage: true });
                }
                throw e;
            }
            finally {
                await admin.c.close();
                await staff.c.close();
            }
        });
test('holiday dashboard and unsaved private note are erased when another employee signs in', { timeout: 60000 }, async () => {
    const a = await user(), b = await user();
    await api('PUT', 'rota/leave/allowances', { userId: a.id, from: yearFrom, to: yearTo, unit: 'days', entitlement: 23, weekly: [1, 1, 1, 1, 1, 0, 0], changeReason: 'Private test allowance', ifVersion: 0 });
    const x = await context({ width: 393, height: 852 }, 'light', a.cookie), page = x.page;
    try {
        await page.goto(srv.base + '/rota/#leave');
        await page.locator('.leave-stats').waitFor();
        await page.getByRole('button', { name: 'Request leave', exact: true }).click();
        await page.locator('#leave_reason').fill('PRIVATE UNSAVED HOLIDAY NOTE');
        await page.route('**/rota/', route => route.request().isNavigationRequest() ? route.abort('aborted') : route.continue());
        const [name, value] = b.cookie.split('=');
        await x.c.addCookies([{ name, value, url: srv.base }]);
        await page.evaluate(() => dispatchEvent(new Event('focus')));
        await page.waitForFunction(() => document.documentElement.hasAttribute('data-sc-session-locked') && !document.getElementById('page').textContent.trim() && !document.getElementById('sheet').textContent.trim());
        assert.equal(await page.locator('#leave_reason').count(), 0);
        assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE UNSAVED HOLIDAY NOTE'));
        assert.ok(await page.evaluate(() => Object.values(localStorage).every(v => !v.includes('PRIVATE UNSAVED HOLIDAY NOTE'))));
    }
    finally {
        await x.c.close();
    }
});
test('team calendar shows approved holiday names and blackout labels, never private absence details', { timeout: 60000 }, async () => {
    const a = await user(), b = await user();
    for (const u of [a, b])
        await api('PUT', 'rota/leave/allowances', { userId: u.id, from: yearFrom, to: yearTo, unit: 'days', entitlement: 25, weekly: [1, 1, 1, 1, 1, 0, 0], changeReason: 'Calendar test allowance', ifVersion: 0 });
    const body = { userId: a.id, kind: 'annual', from: holiday, to: holiday, reason: 'PRIVATE ANNUAL NOTE', approved: true };
    const preview = await api('POST', 'rota/leave/preview', body);
    await api('POST', 'rota/leave/requests', { ...body, expectedCharges: preview.days, requestKey: crypto.randomUUID() });
    await api('POST', 'rota/leave/requests', { userId: a.id, kind: 'sick', from: addDays(holiday, 1), to: addDays(holiday, 1), reason: 'PRIVATE MEDICAL REASON', approved: true, requestKey: crypto.randomUUID() });
    const blocked = addDays(holiday, 3), admin = await context({ width: 393, height: 852 }, 'light', ADMIN), staff = await context({ width: 393, height: 852 }, 'light', b.cookie);
    try {
        await admin.page.goto(srv.base + '/rota/#leave-admin');
        await admin.page.getByRole('button', { name: 'Add blackout dates', exact: true }).click();
        await admin.page.locator('#block_from').fill(blocked);
        await admin.page.locator('#block_to').fill(blocked);
        await admin.page.locator('#block_title').fill('Peak trading');
        await admin.page.getByRole('button', { name: 'Add blackout', exact: true }).click();
        await admin.page.locator('#sheet').waitFor({ state: 'hidden' });
        const s = staff.page;
        await s.goto(srv.base + '/rota/#leave');
        await s.locator('.leave-calendar').waitFor();
        for (let i = 0; i < 2 && !await s.locator('[data-leave-day="' + blocked + '"]').count(); i++)
            await s.getByRole('button', { name: 'Next month', exact: true }).click();
        const holidayCell=s.locator('[data-leave-day="'+holiday+'"]');
        assert.ok((await holidayCell.getAttribute('aria-label')).includes(a.name));
        await holidayCell.click();
        assert.ok((await s.locator('#sheet').innerText()).includes(a.name));
        await s.locator('#sheet').getByRole('button',{name:'Cancel',exact:true}).click();
        assert.ok(!(await s.locator('body').innerText()).includes('PRIVATE ANNUAL NOTE'));
        assert.ok(!(await s.locator('body').innerText()).includes('PRIVATE MEDICAL REASON'));
        const day = s.locator('[data-leave-day="' + blocked + '"]');
        assert.match(await day.innerText(), /Blocked/);
        await day.click();
        assert.match(await s.locator('#sheet').innerText(), /Peak trading/);
        assert.equal(await s.locator('#sheet').getByRole('button', { name: 'Request leave', exact: true }).isDisabled(), true);
    }
    finally {
        await admin.c.close();
        await staff.c.close();
    }
});
