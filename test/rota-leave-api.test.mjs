import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, SETUP_CODE } from './harness.mjs';
let srv, ADMIN, A, B, MGR, ids = {}, policyVersion = 0;
const cookie = r => (r.headers.getSetCookie().find(c => /^sfbb_session=[\w-]/.test(c)) || '').split(';')[0];
async function call(method, path, body, session = ADMIN) { const r = await fetch(srv.base + '/api/' + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(session ? { cookie: session } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }); let data; try {
    data = await r.json();
}
catch {
    data = {};
} return { status: r.status, data, headers: r.headers }; }
const leave = (method, path, body, session) => call(method, 'rota/leave/' + path, body, session);
async function ok(method, path, body, session) { const r = await leave(method, path, body, session); assert.equal(r.status, 200, JSON.stringify(r)); return r.data; }
async function user(name, role = 'staff') { let r = await call('POST', 'admin/users', { name, username: name.toLowerCase(), role, password: 'temporary-password' }); ids[name] = r.data.user.id; const res = await call('POST', 'auth/change', { username: name.toLowerCase(), password: 'temporary-password', newPassword: 'personal-password-' + name }, null); assert.equal(res.status, 200, JSON.stringify(res)); return res.headers.getSetCookie ? cookie(res) : await login(name); }
async function login(name) { const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name.toLowerCase(), password: 'personal-password-' + name }) }); assert.equal(r.status, 200); return cookie(r); }
async function settings(extra = {}) { const p = await ok('GET', 'admin'); const r = await ok('PUT', 'settings', { enabled: true, yearStart: '04-01', bankHolidayPolicy: 'credit-worked', limits: {}, ...extra, ifVersion: p.version }); policyVersion = r.version; return r; }
async function allowance(name, extra = {}) { const body = { userId: ids[name], from: '2030-04-01', to: '2031-03-31', unit: 'days', entitlement: 20, carry: 0, openingUsed: 0, weekly: [1, 1, 1, 1, 1, 0, 0], excludedDates: [], bankHolidays: [], changeReason: 'Agreed individual entitlement', ifVersion: 0, ...extra }; return (await ok('PUT', 'allowances', body)).balance; }
async function request(session, from, to = from, extra = {}) { const body = { kind: 'annual', from, to, reason: 'PRIVATE HOLIDAY NOTE', ...extra }; const p = await ok('POST', 'preview', body, session); return ok('POST', 'requests', { ...body, requestKey: crypto.randomUUID(), expectedCharges: p.days }, session); }
async function dashboard(session = A) { return ok('GET', 'dashboard', undefined, session); }
before(async () => { srv = await startServer({ writeLimit: 4000 }); const r = await fetch(srv.base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Leave Owner', username: 'owner', password: 'leave-owner-password', code: SETUP_CODE }) }); ADMIN = cookie(r); assert.equal(r.status, 200); await call('POST', 'db/set', { path: 'settings/main', data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } }); A = await user('Alice'); B = await user('Beth'); MGR = await user('Manager', 'manager'); });
after(async () => { await srv?.stop(); });
test('leave starts disabled, invents no allowance, and private administration is admin-only', async () => {
    const d = await dashboard();
    assert.equal(d.enabled, false);
    assert.deepEqual(d.balances, []);
    for (const session of [A, B, MGR]) {
        for (const path of ['admin', 'events?userId=' + ids.Alice, 'bank-holidays?from=2030-04-01&to=2031-03-31'])
            assert.equal((await leave('GET', path, undefined, session)).status, 403);
        assert.equal((await leave('GET', 'dashboard?userId=' + ids.Beth, undefined, session === B ? A : session)).status, 403);
        assert.equal((await leave('PUT', 'settings', { enabled: true, ifVersion: 0 }, session)).status, 403);
    }
    assert.equal((await leave('GET', 'dashboard', undefined, null)).status, 401);
    await settings();
    await allowance('Alice');
    await allowance('Beth');
});
test('review charges only working days, reserves pending allowance, and retries are idempotent', async () => {
    const body = { kind: 'annual', from: '2030-04-05', to: '2030-04-08', reason: 'PRIVATE NOTE ALICE', requestKey: 'alice-first-holiday' };
    const p = await ok('POST', 'preview', body, A);
    assert.equal(p.days.length, 2);
    assert.equal(p.days.reduce((n, d) => n + d.amount, 0), 2);
    const saved = await ok('POST', 'requests', { ...body, expectedCharges: p.days }, A);
    ids.first = saved.absence.id;
    const d = await dashboard();
    assert.equal(d.balances[0].pending, 2);
    assert.equal(d.balances[0].available, 18);
    assert.equal((await ok('POST', 'requests', { ...body, expectedCharges: p.days }, A)).absence.id, ids.first);
    assert.equal((await leave('POST', 'requests', { ...body, to: '2030-04-09', expectedCharges: p.days }, A)).status, 409);
    const cal = await ok('GET', 'calendar?from=2030-04-01&to=2030-04-30', undefined, B);
    assert.deepEqual(cal.holidays, []);
    assert.doesNotMatch(JSON.stringify(cal), /PRIVATE|Alice|userId|"reason":|entitlement/);
    assert.equal((await leave('PATCH', 'requests/' + ids.first, { status: 'approved', ifVersion: 1 }, A)).status, 403);
    assert.equal((await leave('PATCH', 'requests/' + ids.first, { status: 'cancelled', ifVersion: 1 }, B)).status, 404);
    assert.equal((await leave('GET', 'requests/' + ids.first, undefined, B)).status, 404);
    const own = await ok('GET', 'requests/' + ids.first, undefined, A);
    assert.equal(own.absence.reason, 'PRIVATE NOTE ALICE');
});
test('approval feeds the rota and exposes only approved holiday names/dates to colleagues', async () => {
    await ok('PATCH', 'requests/' + ids.first, { status: 'approved', ifVersion: 1 });
    const d = await dashboard();
    assert.equal(d.balances[0].pending, 0);
    assert.equal(d.balances[0].booked, 2);
    assert.equal(d.balances[0].remaining, 18);
    const cal = await ok('GET', 'calendar?from=2030-04-01&to=2030-04-30', undefined, B);
    assert.equal(cal.holidays.length, 4);
    assert.ok(cal.holidays.every(h => h.name === 'Alice' && Object.keys(h).sort().join() === 'day,kind,mine,name' && h.kind === 'annual'));
    assert.doesNotMatch(JSON.stringify(cal), /PRIVATE|"reason":|entitlement|from_day|user_id/);
    const week = await call('GET', 'rota/week?start=2030-04-01');
    assert.ok(week.data.timeOff.some(t => t.id === ids.first && t.kind === 'annual'));
    const other = await call('GET', 'rota/week?start=2030-04-01', undefined, B);
    assert.ok(!other.data.timeOff.some(t => t.userId === ids.Alice));
    assert.equal((await leave('PATCH', 'requests/' + ids.first, { status: 'approved', ifVersion: 1 })).status, 409);
});
test('blackouts apply at both request and approval; cancellations refund without losing history', async () => {
    const pending = await request(A, '2030-05-06');
    const block = await ok('POST', 'blocks', { from: '2030-05-06', to: '2030-05-07', title: 'Peak trading', site: null });
    const day = (await ok('GET', 'calendar?from=2030-05-01&to=2030-05-31', undefined, B)).days.find(d => d.day === '2030-05-07');
    assert.deepEqual([day.blocked, day.blackouts, day.full], [true, ['Peak trading'], null]);
    // A blackout over holiday that's already approved leaves it booked.
    const over = await ok('POST', 'blocks', { from: '2030-04-01', to: '2030-04-30', title: 'Christmas', site: null });
    assert.equal((await dashboard()).absences.find(a => a.id === ids.first).status, 'approved');
    await ok('DELETE', 'blocks/' + over.id, { ifVersion: 1 });
    assert.equal((await leave('POST', 'preview', { kind: 'annual', from: '2030-05-07', to: '2030-05-07' }, A)).status, 409);
    assert.equal((await leave('PATCH', 'requests/' + pending.absence.id, { status: 'approved', ifVersion: 1 })).status, 409);
    await ok('DELETE', 'blocks/' + block.id, { ifVersion: 1 });
    await ok('PATCH', 'requests/' + pending.absence.id, { status: 'approved', ifVersion: 1 });
    await ok('PATCH', 'requests/' + pending.absence.id, { status: 'cancelled', ifVersion: 2 }, A);
    const d = await dashboard();
    assert.equal(d.balances[0].available, 18);
    assert.equal(d.absences.find(a => a.id === pending.absence.id).status, 'cancelled');
});
test('admins can edit a blackout (version-checked); staff cannot', async () => {
    const block = await ok('POST', 'blocks', { from: '2030-05-20', to: '2030-05-21', title: 'Christmas', site: null });
    assert.equal((await leave('PUT', 'blocks/' + block.id, { from: '2030-05-20', to: '2030-05-22', title: 'Stocktake', site: null, ifVersion: 1 }, A)).status, 403);
    const saved = await ok('PUT', 'blocks/' + block.id, { from: '2030-05-21', to: '2030-05-23', title: 'Stocktake', site: 'cafe', ifVersion: 1 });
    assert.equal(saved.version, 2);
    assert.equal((await leave('PUT', 'blocks/' + block.id, { from: '2030-05-21', to: '2030-05-23', title: 'Old copy', site: null, ifVersion: 1 })).status, 409);
    assert.equal((await leave('PUT', 'blocks/' + block.id, { from: '2030-05-21', to: '2030-05-23', title: ' ', site: null, ifVersion: 2 })).status, 400);
    const row = (await ok('GET', 'admin')).blocks.find(b => b.id === block.id);
    assert.deepEqual([row.from, row.to, row.site, row.title, row.version], ['2030-05-21', '2030-05-23', 'cafe', 'Stocktake', 2]);
    await ok('DELETE', 'blocks/' + block.id, { ifVersion: 2 });
    assert.equal((await leave('PUT', 'blocks/' + block.id, { from: '2030-05-21', to: '2030-05-23', title: 'Stocktake', site: null, ifVersion: 2 })).status, 404);
});
test('admins can make an exception to a blocked day, with a reason that is recorded; staff cannot', async () => {
    const block = await ok('POST', 'blocks', { from: '2030-05-13', to: '2030-05-14', title: 'Christmas', site: null });
    const refused = await leave('POST', 'preview', { kind: 'annual', from: '2030-05-13', to: '2030-05-13' }, A);
    assert.equal(refused.status, 409);
    assert.equal(refused.data.code, 'leave_blocked');
    assert.deepEqual(refused.data.blocked, [{ day: '2030-05-13', reasons: ['Christmas'] }]);
    // Staff can't override, even asking for it.
    assert.equal((await leave('POST', 'preview', { kind: 'annual', from: '2030-05-13', to: '2030-05-13', overrideBlocked: true, overrideReason: 'Please' }, A)).status, 403);
    // An admin booking it needs a reason.
    const base = { kind: 'annual', from: '2030-05-13', to: '2030-05-13', userId: ids.Alice, approved: true };
    assert.equal((await leave('POST', 'preview', { ...base, overrideBlocked: true, overrideReason: '  ' })).status, 400);
    const p = await ok('POST', 'preview', { ...base, overrideBlocked: true, overrideReason: 'Agreed before the blackout' });
    const booked = await ok('POST', 'requests', { ...base, overrideBlocked: true, overrideReason: 'Agreed before the blackout', expectedCharges: p.days, requestKey: crypto.randomUUID() });
    assert.equal(booked.absence.status, 'approved');
    // Approving a staff request on a blocked day: refused, then approved anyway with a reason.
    await ok('DELETE', 'blocks/' + block.id, { ifVersion: 1 });
    const asked = await request(B, '2030-05-14');
    const again = await ok('POST', 'blocks', { from: '2030-05-14', to: '2030-05-14', title: 'Stocktake', site: null });
    const no = await leave('PATCH', 'requests/' + asked.absence.id, { status: 'approved', ifVersion: 1 });
    assert.deepEqual([no.status, no.data.code], [409, 'leave_blocked']);
    assert.equal((await leave('PATCH', 'requests/' + asked.absence.id, { status: 'approved', ifVersion: 1, overrideBlocked: true })).status, 400);
    await ok('PATCH', 'requests/' + asked.absence.id, { status: 'approved', ifVersion: 1, overrideBlocked: true, overrideReason: 'Only one off that day' });
    const events = [...(await ok('GET', 'events?userId=' + ids.Alice)).events, ...(await ok('GET', 'events?userId=' + ids.Beth)).events];
    const reasons = events.map(e => JSON.parse(e.data || '{}').overrideBlocked?.reason).filter(Boolean);
    assert.ok(reasons.includes('Agreed before the blackout') && reasons.includes('Only one off that day'), JSON.stringify(events.slice(0, 3)));
    await ok('PATCH', 'requests/' + booked.absence.id, { status: 'cancelled', ifVersion: 1 });
    await ok('PATCH', 'requests/' + asked.absence.id, { status: 'cancelled', ifVersion: 2 });
    await ok('DELETE', 'blocks/' + again.id, { ifVersion: 1 });
});
test('simultaneous approvals cannot exceed holiday capacity', async () => {
    const a = await request(A, '2030-06-03'), b = await request(B, '2030-06-03');
    await settings({ limits: { all: 1 } });
    const results = await Promise.all([leave('PATCH', 'requests/' + a.absence.id, { status: 'approved', ifVersion: 1 }), leave('PATCH', 'requests/' + b.absence.id, { status: 'approved', ifVersion: 1 })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const cal = await ok('GET', 'calendar?from=2030-06-01&to=2030-06-07', undefined, B);
    assert.equal(cal.holidays.length, 1);
    assert.equal(cal.days.find(d => d.day === '2030-06-03').blocked, true);
    // A full day says why: how many are off against the limit, apart from any blackout.
    const full = cal.days.find(d => d.day === '2030-06-03');
    assert.deepEqual([full.full, full.blackouts, full.reasons], [{ off: 1, limit: 1, site: null }, [], ['Full (1 off)']]);
    // Unpaid leave can be counted towards the limit: Beth's unpaid day fills 2030-06-04 only when that's switched on.
    await request(ADMIN, '2030-06-04', '2030-06-04', { kind: 'unpaid', userId: ids.Beth, approved: true });
    assert.equal((await ok('GET', 'calendar?from=2030-06-01&to=2030-06-07', undefined, A)).days.find(d => d.day === '2030-06-04').blocked, false);
    await settings({ limits: { all: 1 }, countUnpaid: true });
    const counted = (await ok('GET', 'calendar?from=2030-06-01&to=2030-06-07', undefined, A)).days.find(d => d.day === '2030-06-04');
    assert.deepEqual(counted.full, { off: 1, limit: 1, site: null });
    assert.equal((await leave('POST', 'preview', { kind: 'annual', from: '2030-06-04', to: '2030-06-04' }, A)).status, 409);
    assert.equal((await ok('GET', 'admin')).settings.countUnpaid, true);
    await settings();
});
test('sickness and unauthorised absence are admin-only to record and never appear on the shared calendar', async () => {
    for (const kind of ['sick', 'unauthorised']) {
        const body = { kind, from: kind === 'sick' ? '2030-07-01' : '2030-07-02', to: kind === 'sick' ? '2030-07-01' : '2030-07-02', reason: 'PRIVATE MEDICAL DETAILS', userId: ids.Alice, approved: true };
        assert.equal((await leave('POST', 'requests', { ...body, requestKey: crypto.randomUUID() }, A)).status, 403);
        const saved = await request(ADMIN, body.from, body.to, body);
        assert.equal(saved.absence.status, 'approved');
        assert.equal((await leave('PATCH', 'requests/' + saved.absence.id, { status: 'cancelled', ifVersion: 1 }, A)).status, 403);
    }
    const cal = await ok('GET', 'calendar?from=2030-07-01&to=2030-07-31', undefined, B);
    assert.equal(cal.holidays.length, 0);
    assert.doesNotMatch(JSON.stringify(cal), /sick|unauthorised|MEDICAL|Alice/);
    const own = await dashboard();
    assert.ok(own.absences.some(a => a.kind === 'sick' && a.reason === 'PRIVATE MEDICAL DETAILS'));
});
test('approved unpaid leave shows on the shared calendar as unpaid, with no reason, even while requests are switched off', async () => {
    const saved = await request(ADMIN, '2031-02-10', '2031-02-11', { kind: 'unpaid', reason: 'PRIVATE UNPAID REASON', userId: ids.Alice, approved: true });
    assert.equal(saved.absence.status, 'approved');
    const cal = await ok('GET', 'calendar?from=2031-02-01&to=2031-02-28', undefined, B);
    assert.deepEqual(cal.holidays.map(h => [h.name, h.day, h.kind, h.mine]), [['Alice', '2031-02-10', 'unpaid', false], ['Alice', '2031-02-11', 'unpaid', false]]);
    assert.doesNotMatch(JSON.stringify(cal), /PRIVATE|"reason":|userId|user_id/);
    assert.equal((await ok('GET', 'calendar?from=2031-02-01&to=2031-02-28', undefined, A)).holidays.every(h => h.mine), true);
    await settings({ enabled: false });
    const off = await ok('GET', 'calendar?from=2031-02-01&to=2031-02-28', undefined, B);
    assert.equal(off.enabled, false);
    assert.equal(off.holidays.length, 2);
    await settings();
});
test('allowance edits are versioned, cannot erase bookings and keep an audit record', async () => {
    const a = (await dashboard()).balances[0];
    assert.equal((await leave('PUT', 'allowances', { userId: ids.Alice, from: a.from, to: a.to, unit: 'days', entitlement: 0, weekly: [1, 1, 1, 1, 1, 0, 0], changeReason: 'Cannot discard bookings', ifVersion: a.version })).status, 409);
    assert.equal((await leave('PUT', 'allowances', { userId: ids.Alice, from: a.from, to: a.to, unit: 'days', entitlement: 30, weekly: [1, 1, 1, 1, 1, 0, 0], changeReason: 'Stale form', ifVersion: 0 })).status, 409);
    const events = await ok('GET', 'events?userId=' + ids.Alice);
    assert.ok(events.events.some(e => e.action === 'allowance_updated'));
    assert.ok(events.events.some(e => e.action === 'approved'));
});
test('bank-holiday days in lieu release a reserved inclusive day once, without inflating entitlement', async () => {
    const today = (await dashboard()).today, year = Number(today.slice(0, 4));
    const start = (year - 1) + '-04-01', end = year + '-03-31', bank = (year - 1) + '-12-25';
    const a = await allowance('Beth', { from: start, to: end, entitlement: 28, bankHolidayEligible: true, bankHolidays: [bank] });
    assert.equal(a.total, 28);
    assert.equal(a.bankHolidayReserved, 1);
    assert.equal(a.available, 27);
    const body = { userId: ids.Beth, year: start, day: bank, confirmWorked: true, reason: 'Admin confirmed bank-holiday shift was worked', ifVersion: 1 };
    assert.equal((await leave('POST', 'credits', body, B)).status, 403);
    const c = await ok('POST', 'credits', body);
    assert.equal(c.balance.total, 28);
    assert.equal(c.balance.available, 28);
    assert.equal(c.balance.credits, 1);
    const again = await ok('POST', 'credits', body);
    assert.equal(again.replayed, true);
    assert.equal(again.balance.available, 28);
    assert.equal((await leave('POST', 'credits', { ...body, day: (year - 1) + '-12-26', ifVersion: 2 })).status, 409);
});
test('half-day leave charges half a day and blocks only overlapping shift times', async () => {
    const body = { kind: 'annual', from: '2030-08-05', to: '2030-08-05', portion: 0.5, fromTime: '09:00', toTime: '13:00' };
    const saved = await request(A, body.from, body.to, body);
    assert.equal(saved.absence.days[0].amount, 0.5);
    assert.equal(saved.absence.fromTime, '09:00');
    await ok('PATCH', 'requests/' + saved.absence.id, { status: 'approved', ifVersion: 1 });
    const shifts = [];
    for (const [start, end] of [['08:00', '12:00'], ['13:00', '17:00']]) {
        const r = await call('POST', 'rota/shifts', { site: 'roastery', day: body.from, start, end, breakMins: 0, userId: ids.Alice });
        assert.equal(r.status, 200);
        shifts.push(r.data.shift.id);
    }
    const week = await call('GET', 'rota/week?start=2030-08-05');
    const conflicts = week.data.problems.filter(p => p.kind === 'time_off');
    assert.ok(conflicts.some(p => p.shiftIds.includes(shifts[0])));
    assert.ok(!conflicts.some(p => p.shiftIds.includes(shifts[1])));
    assert.equal((await leave('POST', 'preview', { ...body, to: '2030-08-06' }, A)).status, 400);
});
test('a request crossing a leave-year boundary charges each year separately and refuses unconfigured years', async () => {
    await allowance('Alice', { from: '2031-04-01', to: '2032-03-31', entitlement: 1 });
    const saved = await request(A, '2031-03-31', '2031-04-01');
    assert.deepEqual(saved.absence.days.map(d => d.year), ['2030-04-01', '2031-04-01']);
    assert.equal((await leave('POST', 'preview', { kind: 'annual', from: '2031-04-02', to: '2031-04-02' }, A)).status, 409);
    assert.equal((await leave('POST', 'preview', { kind: 'annual', from: '2032-04-01', to: '2032-04-01' }, A)).status, 409);
});
test('old approved leave is retained, private and explicitly reconciled before it uses an allowance', async () => {
    const admin = await ok('GET', 'admin');
    await ok('PUT', 'settings', { ...admin.settings, enabled: false, ifVersion: admin.version });
    const old = await call('POST', 'rota/time-off', { userId: ids.Beth, from: '2030-09-02', to: '2030-09-02', reason: 'LEGACY PRIVATE HOLIDAY' });
    assert.equal(old.status, 200);
    await settings();
    const before = (await dashboard(B)).balances.find(b => b.from === '2030-04-01');
    assert.equal((await dashboard(B)).legacyCount, 1);
    const cal = await ok('GET', 'calendar?from=2030-09-01&to=2030-09-30', undefined, A);
    assert.equal(cal.holidays.length, 0);
    assert.equal((await leave('PATCH', 'requests/' + old.data.id + '/classify', { kind: 'annual', changeReason: 'Checked against historical record', ifVersion: 1 }, B)).status, 403);
    await ok('PATCH', 'requests/' + old.data.id + '/classify', { kind: 'annual', changeReason: 'Checked against original holiday record', ifVersion: 1 });
    const after = (await dashboard(B)).balances.find(b => b.from === '2030-04-01');
    assert.equal(after.available, before.available - 1);
    assert.equal((await leave('PATCH', 'requests/' + old.data.id + '/classify', { kind: 'annual', changeReason: 'Retry', ifVersion: 1 })).status, 409);
});
test('a changed working pattern cannot silently alter the charge after review', async () => {
    const body = { kind: 'annual', from: '2030-10-07', to: '2030-10-07' }, preview = await ok('POST', 'preview', body, A), current = (await dashboard()).balances.find(b => b.from === '2030-04-01');
    await allowance('Alice', { entitlement: 20, weekly: [0.5, 1, 1, 1, 1, 0, 0], ifVersion: current.version });
    const result = await leave('POST', 'requests', { ...body, requestKey: 'stale-reviewed-charge', expectedCharges: preview.days }, A);
    assert.equal(result.status, 409);
    assert.match(result.data.message, /charge changed/);
});
test('a worked-bank-holiday correction retains history and restores the reservation', async () => {
    const today = (await dashboard()).today, y = Number(today.slice(0, 4)), year = (y - 1) + '-04-01', day = (y - 1) + '-12-25', before = (await dashboard(B)).balances.find(b => b.from === year);
    const result = await ok('POST', 'credits/reverse', { userId: ids.Beth, year, day, reason: 'Correcting an admin recording mistake', ifVersion: before.version });
    assert.equal(result.balance.total, 28);
    assert.equal(result.balance.available, 27);
    assert.equal(result.balance.credits, 0);
    assert.ok(result.balance.creditHistory[0].reversedAt);
    assert.equal((await leave('POST', 'credits/reverse', { userId: ids.Beth, year, day, reason: 'Stale correction', ifVersion: before.version })).status, 409);
    const history = await ok('GET', 'events?userId=' + ids.Beth);
    assert.ok(history.events.some(e => e.action === 'bank_holiday_credited'));
    assert.ok(history.events.some(e => e.action === 'bank_holiday_credit_reversed'));
    const d = await leave('GET', 'dashboard', undefined, B);
    assert.match(d.headers.get('cache-control'), /\bno-store\b/);
    assert.equal(d.headers.get('cross-origin-resource-policy'), 'same-origin');
});
test('legacy leave already covered by an opening balance is classified without charging it twice', async () => {
    const today = (await dashboard()).today, ago = n => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }, from = ago(30), to = new Date(new Date(from + 'T12:00:00Z').getTime() + 364 * 864e5).toISOString().slice(0, 10);
    await allowance('Manager', { from, to, entitlement: 10, weekly: [1, 1, 1, 1, 1, 1, 1], openingUsed: 2, openingAsOf: ago(1) });
    const p = await ok('GET', 'admin');
    await ok('PUT', 'settings', { ...p.settings, enabled: false, ifVersion: p.version });
    const old = await call('POST', 'rota/time-off', { userId: ids.Manager, from: ago(7), to: ago(7), reason: 'Historical holiday in opening used total' });
    assert.equal(old.status, 200);
    await settings();
    assert.equal((await leave('PATCH', 'requests/' + old.data.id + '/classify', { kind: 'annual', changeReason: 'Needs explicit opening-balance reconciliation', ifVersion: 1 })).status, 409);
    const c = await ok('PATCH', 'requests/' + old.data.id + '/classify', { kind: 'annual', coveredByOpening: true, changeReason: 'Matched this record to the approved opening used total', ifVersion: 1 });
    assert.equal(c.absence.coveredByOpening, true);
    assert.equal(c.absence.days.length, 0);
    const own = await dashboard(MGR);
    assert.equal(own.balances[0].used, 2);
    assert.equal(own.balances[0].available, 8);
    assert.equal(own.legacyCount, 0);
    assert.equal((await leave('PATCH', 'requests/' + old.data.id, { status: 'cancelled', ifVersion: 2 }, MGR)).status, 403);
});
