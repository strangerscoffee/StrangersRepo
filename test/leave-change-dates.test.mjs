// Admins change the dates of a booked or requested absence (POST /api/rota/leave/requests/<id>/dates, the owner's
// request of 18 Nov 2026): the charge is worked out again and checked like a new booking, the same booking keeps
// its history, the person is emailed, and nobody else can. Run with `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, SETUP_CODE } from './harness.mjs';

let srv, mock, ADMIN, MGR;
const S = {}, ids = {}, sent = [];
const cookie = r => (r.headers.getSetCookie().find(c => /^sfbb_session=[\w-]/.test(c)) || '').split(';')[0];
async function call(method, path, body, session = ADMIN) {
    const r = await fetch(srv.base + '/api/' + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie: session }, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch {}
    return { status: r.status, data };
}
async function ok(method, path, body, session) { const r = await call(method, path, body, session); assert.equal(r.status, 200, JSON.stringify(r)); return r.data; }
async function user(name, role = 'staff') {
    const r = await call('POST', 'admin/users', { name, username: name.toLowerCase(), role, password: 'temporary-password', email: name.toLowerCase() + '@example.test' });
    ids[name] = r.data.user.id;
    const c = await fetch(srv.base + '/api/auth/change', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name.toLowerCase(), password: 'temporary-password', newPassword: 'personal-password-' + name }) });
    return cookie(c);
}
async function book(session, from, to, extra = {}) {
    const body = { kind: 'annual', from, to, reason: 'PRIVATE REASON', ...extra };
    const p = await ok('POST', 'rota/leave/preview', body, session);
    return (await ok('POST', 'rota/leave/requests', { ...body, requestKey: crypto.randomUUID(), expectedCharges: p.days }, session)).absence;
}
const get = async (id) => (await ok('GET', 'rota/leave/requests/' + id)).absence;
const change = (id, body, session) => call('POST', `rota/leave/requests/${id}/dates`, body, session);
async function waitFor(n) { const end = Date.now() + 8000; while (sent.length < n && Date.now() < end) await new Promise(r => setTimeout(r, 100)); }

before(async () => {
    mock = createServer((rq, rs) => { let b = ''; rq.on('data', d => b += d); rq.on('end', () => { try { sent.push(JSON.parse(b)); } catch {} rs.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'test-' + sent.length })); }); });
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    srv = await startServer({ writeLimit: 4000, vars: { RESEND_API_KEY: 're_test_key', RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails` } });
    const r = await fetch(srv.base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Leave Owner', username: 'owner', password: 'leave-owner-password', code: SETUP_CODE }) });
    ADMIN = cookie(r);
    await call('POST', 'db/set', { path: 'settings/main', data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } });
    for (const name of ['Alice', 'Beth']) S[name] = await user(name);
    MGR = await user('Manager', 'manager');
    const p = await ok('GET', 'rota/leave/admin');
    await ok('PUT', 'rota/leave/settings', { enabled: true, yearStart: '04-01', bankHolidayPolicy: 'credit-worked', limits: {}, ifVersion: p.version });
    for (const name of ['Alice', 'Beth']) await ok('PUT', 'rota/leave/allowances', { userId: ids[name], from: '2030-04-01', to: '2031-03-31', unit: 'days', entitlement: 20, carry: 0, openingUsed: 0, weekly: [1, 1, 1, 1, 1, 0, 0], excludedDates: [], bankHolidays: [], changeReason: 'Agreed', ifVersion: 0 });
});
after(async () => { await srv?.stop(); mock?.close(); });

test('an admin moves a requested holiday: charge worked out again, history kept, person emailed', async () => {
    const a = await book(S.Alice, '2031-01-15', '2031-01-17'); // Wed–Fri: 3 days
    // Nobody but an admin, even the person themselves.
    for (const s of [S.Alice, MGR]) assert.equal((await change(a.id, { from: '2031-01-20', to: '2031-01-21', preview: true }, s)).status, 403);
    const preview = await ok('POST', `rota/leave/requests/${a.id}/dates`, { from: '2031-01-20', to: '2031-01-24', preview: true });
    assert.equal(preview.days.length, 5);
    assert.equal((await get(a.id)).from, '2031-01-15', 'a preview changes nothing');
    assert.equal((await change(a.id, { from: '2031-01-20', to: '2031-01-24', ifVersion: a.version })).status, 409, 'the charge must have been reviewed');
    assert.equal((await change(a.id, { from: '2031-01-20', to: '2031-01-24', ifVersion: a.version - 1, expectedCharges: preview.days })).status, 409, 'stale version');
    assert.equal((await change(a.id, { from: '2031-01-15', to: '2031-01-17', ifVersion: a.version, expectedCharges: [] })).status, 400, 'same dates');
    sent.length = 0;
    const saved = await ok('POST', `rota/leave/requests/${a.id}/dates`, { from: '2031-01-20', to: '2031-01-24', ifVersion: a.version, expectedCharges: preview.days });
    assert.equal(saved.absence.id, a.id, 'the same booking');
    assert.deepEqual([saved.absence.from, saved.absence.to, saved.absence.status], ['2031-01-20', '2031-01-24', 'requested']);
    assert.equal(saved.absence.days.length, 5);
    const bal = (await ok('GET', 'rota/leave/dashboard?userId=' + ids.Alice)).balances.find(b => b.from === '2030-04-01');
    assert.equal(bal.pending, 5, 'the old days no longer count');
    const events = srv.sql(`SELECT action, data FROM rota_leave_events WHERE time_off_id = '${a.id}' AND action = 'dates_changed'`);
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].data).before, { from: '2031-01-15', to: '2031-01-17', fromTime: null, toTime: null });
    await waitFor(1);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ['alice@example.test']);
    assert.match(sent[0].subject, /holiday dates have changed/);
    assert.match(sent[0].text, /20 January[\s\S]*was[\s\S]*15 January[\s\S]*still needs approving/);
    assert.doesNotMatch(JSON.stringify(sent[0]), /PRIVATE REASON/);
});

test('booked holiday: checked like a new booking, with an admin exception for blocked days', async () => {
    const b = await book(ADMIN, '2031-02-03', '2031-02-04', { userId: ids.Beth, approved: true });
    // Clashing with Beth's own other booking is refused.
    await book(ADMIN, '2031-02-10', '2031-02-10', { userId: ids.Beth, approved: true });
    assert.equal((await change(b.id, { from: '2031-02-10', to: '2031-02-11', preview: true })).status, 409);
    // More than the balance is refused.
    assert.equal((await change(b.id, { from: '2031-02-16', to: '2031-03-31', preview: true })).status, 409);
    // A blackout needs an exception with a reason.
    await ok('POST', 'rota/leave/blocks', { from: '2031-02-17', to: '2031-02-17', title: 'Stocktake', ifVersion: (await ok('GET', 'rota/leave/admin')).version });
    const blocked = await change(b.id, { from: '2031-02-17', to: '2031-02-18', preview: true });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, 'leave_blocked');
    const over = { from: '2031-02-17', to: '2031-02-18', overrideBlocked: true, overrideReason: 'Agreed with Beth' };
    const p = await ok('POST', `rota/leave/requests/${b.id}/dates`, { ...over, preview: true });
    const saved = await ok('POST', `rota/leave/requests/${b.id}/dates`, { ...over, ifVersion: b.version, expectedCharges: p.days });
    assert.deepEqual([saved.absence.from, saved.absence.status], ['2031-02-17', 'approved']);
    // To a half day.
    const p2 = await ok('POST', `rota/leave/requests/${b.id}/dates`, { from: '2031-02-19', to: '2031-02-19', portion: 0.5, fromTime: '09:00', toTime: '13:00', preview: true });
    const half = await ok('POST', `rota/leave/requests/${b.id}/dates`, { from: '2031-02-19', to: '2031-02-19', portion: 0.5, fromTime: '09:00', toTime: '13:00', ifVersion: saved.absence.version, expectedCharges: p2.days });
    assert.deepEqual([half.absence.fromTime, half.absence.toTime], ['09:00', '13:00']);
    // Settled absences can't be moved.
    await ok('PATCH', 'rota/leave/requests/' + b.id, { status: 'cancelled', ifVersion: half.absence.version });
    assert.equal((await change(b.id, { from: '2031-02-24', to: '2031-02-24', preview: true })).status, 409);
});
