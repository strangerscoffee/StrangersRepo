// Who else is off, beside an absence an admin reviews (`teamOff` on GET /api/rota/leave/requests/<id>, the owner's
// request of 18 Nov 2026): other people's approved holiday and unpaid leave that overlaps the request, then bookings
// within a week either side that don't. Admins only. Run with `npm test`.
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
    const r = await fetch(srv.base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Leave Owner', username: 'owner', password: 'leave-owner-password', code: SETUP_CODE }) });
    ADMIN = cookie(r);
    await call('POST', 'db/set', { path: 'settings/main', data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } });
    for (const name of ['Alice', 'Beth', 'Carol', 'Dan']) S[name] = await user(name);
    MGR = await user('Manager', 'manager');
    const p = await ok('GET', 'admin');
    await ok('PUT', 'settings', { enabled: true, yearStart: '04-01', bankHolidayPolicy: 'credit-worked', limits: {}, ifVersion: p.version });
    for (const name of ['Alice', 'Beth', 'Carol', 'Dan']) await ok('PUT', 'allowances', { userId: ids[name], from: '2030-04-01', to: '2031-03-31', unit: 'days', entitlement: 25, carry: 0, openingUsed: 0, weekly: [1, 1, 1, 1, 1, 1, 1], excludedDates: [], bankHolidays: [], changeReason: 'Agreed entitlement', ifVersion: 0 });
});
after(async () => { await srv?.stop(); });

test('admins see who else is off: overlapping first, nearby ones apart, nothing private', async () => {
    // Alice asks for Wed 15 – Fri 17 Jan 2031.
    const asked = await book(S.Alice, '2031-01-15', '2031-01-17');
    // Already approved: Beth's holiday overlaps two days, Carol's unpaid leave ends five days before, Dan's holiday
    // starts three days after, and one of Dan's is too far away to matter.
    await book(ADMIN, '2031-01-16', '2031-01-20', { userId: ids.Beth, approved: true });
    await book(ADMIN, '2031-01-08', '2031-01-10', { kind: 'unpaid', userId: ids.Carol, approved: true });
    await book(ADMIN, '2031-01-20', '2031-01-21', { userId: ids.Dan, approved: true });
    await book(ADMIN, '2031-02-10', '2031-02-10', { userId: ids.Dan, approved: true });
    // Not counted: Dan's pending request, Beth's sickness, a declined request, and Alice's own other holiday.
    await book(S.Dan, '2031-01-15', '2031-01-15');
    await book(ADMIN, '2031-01-15', '2031-01-15', { kind: 'sick', userId: ids.Beth, approved: true });
    const declined = await book(S.Carol, '2031-01-16', '2031-01-16');
    await ok('PATCH', 'requests/' + declined.id, { status: 'declined', ifVersion: declined.version });
    await book(ADMIN, '2031-01-13', '2031-01-13', { userId: ids.Alice, approved: true });

    const r = await ok('GET', 'requests/' + asked.id);
    assert.deepEqual(r.teamOff, [
        { name: 'Carol', kind: 'unpaid', from: '2031-01-08', to: '2031-01-10', partDay: false, overlaps: false, daysBefore: 5 },
        { name: 'Beth', kind: 'annual', from: '2031-01-16', to: '2031-01-20', partDay: false, overlaps: true, shared: { from: '2031-01-16', to: '2031-01-17' } },
        { name: 'Dan', kind: 'annual', from: '2031-01-20', to: '2031-01-21', partDay: false, overlaps: false, daysAfter: 3 },
    ]);
    assert.doesNotMatch(JSON.stringify(r.teamOff), /PRIVATE REASON|user_?[iI]d/, 'names, dates and kind only');

    // Staff get their own request back without it; managers can't open someone else's.
    const own = await ok('GET', 'requests/' + asked.id, undefined, S.Alice);
    assert.equal(own.teamOff, undefined);
    assert.equal((await call('GET', 'rota/leave/requests/' + asked.id, undefined, MGR)).status, 404);
    assert.equal((await call('GET', 'rota/leave/requests/' + asked.id, undefined, S.Beth)).status, 404);
});

test('nobody else off gives an empty list', async () => {
    const asked = await book(S.Carol, '2031-03-03', '2031-03-03');
    assert.deepEqual((await ok('GET', 'requests/' + asked.id)).teamOff, []);
});

test('recording an absence: admins see who else is off around the chosen dates before saving anything', async () => {
    // The owner's request of 25 Nov 2026: GET /api/rota/leave/team-off for the dates an admin is choosing for someone.
    const q = (who, from, to) => `team-off?userId=${encodeURIComponent(ids[who])}&from=${from}&to=${to}`;
    const r = await ok('GET', q('Alice', '2031-01-16', '2031-01-17'));
    assert.deepEqual(r.teamOff.map(o => [o.name, o.overlaps]), [['Carol', false], ['Beth', true], ['Dan', false]]);
    assert.deepEqual(r.teamOff.find(o => o.name === 'Beth').shared, { from: '2031-01-16', to: '2031-01-17' });
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE REASON|user_?[iI]d/, 'names, dates and kind only');
    // The person's own bookings are left out; others see theirs.
    assert.ok(!(await ok('GET', q('Beth', '2031-01-16', '2031-01-17'))).teamOff.some(o => o.name === 'Beth'));
    // Admins only, and sensible dates.
    for (const session of [MGR, S.Alice]) assert.equal((await call('GET', 'rota/leave/' + q('Alice', '2031-01-16', '2031-01-17'), undefined, session)).status, 403);
    for (const [from, to] of [['2031-01-17', '2031-01-16'], ['2031-01-01', '2031-04-01'], ['soon', '2031-01-16']])
        assert.equal((await call('GET', 'rota/leave/' + q('Alice', from, to))).status, 400);
});
