// "Start next year for everyone" (src/rota/leave/nextYear.ts): admins copy each person's allowance into the next
// leave year, people who started part way through this year are proposed at a full year and must be checked, and
// nothing is created until the confirmed POST, all at once. Run with `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, SETUP_CODE } from './harness.mjs';

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
after(async () => { await srv?.stop(); });

test('the proposal copies this year, and lifts part-year starters to a full year', async () => {
    for (const s of [S.Alice, MGR]) {
        assert.equal((await call('GET', 'rota/leave/next-year', undefined, s)).status, 403);
        assert.equal((await call('POST', 'rota/leave/next-year', { from: nextFrom, people: [] }, s)).status, 403);
    }
    const d = await ok('GET', 'rota/leave/next-year');
    assert.equal(d.from, nextFrom);
    assert.equal(d.to, nextTo);
    const by = Object.fromEntries(d.people.map(p => [p.name, p]));
    assert.equal(by.Alice.status, 'ready');
    assert.deepEqual(by.Alice.proposed, { entitlement: 28, weekly: MON_FRI, bankHolidayEligible: true, reserveBankHolidays: true });
    assert.equal(by.Alice.partYear, undefined, 'a whole year is copied as it is');
    assert.equal(by.Alice.source.carry, 3);

    const share = days(BETH_START, thisTo) / days(thisFrom, thisTo);
    assert.equal(by.Beth.partYear.scaled, Math.round(14 / share * 2) / 2);
    assert.equal(by.Beth.proposed.entitlement, Math.min(28, by.Beth.partYear.scaled), 'a full year, at most 28 days');

    const carolShare = days(CAROL_START, thisTo) / days(thisFrom, thisTo);
    const carolScaled = Math.round(10 / carolShare * 2) / 2;
    assert.equal(by.Carol.partYear.scaled, carolScaled);
    assert.equal(by.Carol.proposed.entitlement, carolScaled, 'scaled up from this year, not this year\'s part-year figure');
    assert.ok(carolScaled > 10);
    // Someone whose scaled figure would pass 28 is capped there.
    const { fullYearOf } = await import('../src/rota/leave/nextYearMath.ts');
    assert.deepEqual(fullYearOf(28, '2026-04-01', '2027-03-31', '2026-04-06'), { share: 0.986, scaled: 28.5, fullYear: 28, capped: true });
    assert.equal(fullYearOf(28, '2026-04-01', '2027-03-31', '2026-04-01'), null, 'started on the first day: a whole year');
    assert.equal(fullYearOf(28, '2026-04-01', '2027-03-31', null), null);

    assert.equal(by.Dan.status, 'no-source');
    assert.equal(by.Manager.status, 'no-source');
    assert.equal(by.Eve.status, 'exists');
});

test('nothing is created until every part-year starter is checked, then all at once', async () => {
    const d = await ok('GET', 'rota/leave/next-year');
    const by = Object.fromEntries(d.people.map(p => [p.name, p]));
    const item = (name, extra = {}) => ({ userId: ids[name], entitlement: by[name].proposed.entitlement, weekly: by[name].proposed.weekly, bankHolidayEligible: by[name].proposed.bankHolidayEligible, bankHolidays: [], ...extra });
    const banks = [`${y + 1}-12-25`, `${y + 1}-12-26`];
    const unchecked = await call('POST', 'rota/leave/next-year', { from: d.from, version: d.version, people: [item('Alice', { bankHolidays: banks }), item('Beth')] });
    assert.equal(unchecked.status, 409);
    assert.match(unchecked.data.message, /Check Beth's full-year allowance/);
    assert.equal((await call('POST', 'rota/leave/next-year', { from: d.from, version: d.version, people: [{ userId: ids.Eve, entitlement: 28, weekly: MON_FRI, bankHolidays: [] }] })).status, 409, 'already set up');
    assert.equal((await call('POST', 'rota/leave/next-year', { from: d.from, version: d.version, people: [item('Alice', { bankHolidays: ['2001-01-01'] })] })).status, 400, 'bank holidays must be in next year');
    assert.equal((await call('POST', 'rota/leave/next-year', { from: d.from, version: d.version - 1, people: [item('Alice')] })).status, 409, 'reviewed version');
    // The refused attempts created nothing.
    for (const name of ['Alice', 'Beth']) assert.ok(!(await ok('GET', 'rota/leave/dashboard?userId=' + ids[name])).balances.some(b => b.from === nextFrom));

    const done = await ok('POST', 'rota/leave/next-year', { from: d.from, version: d.version, people: [
        item('Alice', { bankHolidays: banks }), item('Beth', { partYearChecked: true }), item('Carol', { entitlement: 18, partYearChecked: true }),
    ] });
    assert.equal(done.created, 3);
    const next = async (name) => (await ok('GET', 'rota/leave/dashboard?userId=' + ids[name])).balances.find(b => b.from === nextFrom);
    const alice = await next('Alice');
    assert.equal(alice.to, nextTo);
    assert.equal(alice.entitlement, 28);
    assert.equal(alice.carry, 0, 'carry-over is never copied');
    assert.deepEqual(alice.bankHolidays, banks);
    assert.equal(alice.bankHolidayEligible, true);
    assert.equal(alice.note, 'Full-time contract');
    assert.equal((await next('Beth')).entitlement, 28);
    assert.deepEqual((await next('Carol')).weekly, [1, 0, 1, 0, 1, 0, 0]);
    assert.equal((await next('Carol')).entitlement, 18, 'the admin\'s figure');
    // This year is untouched.
    assert.equal((await ok('GET', 'rota/leave/dashboard?userId=' + ids.Beth)).balances.find(b => b.from === thisFrom).entitlement, 14);
    // Run again: everyone done is now "exists".
    const again = await ok('GET', 'rota/leave/next-year');
    assert.deepEqual(again.people.filter(p => p.status === 'exists').map(p => p.name).sort(), ['Alice', 'Beth', 'Carol', 'Eve']);
});
