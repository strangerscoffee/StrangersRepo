// Security tests: every manager and admin action, tried as staff (and admin actions as a manager), is refused.
// Against `wrangler dev` with a fresh local database. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, STAFF;
before(async () => {
  srv = await startServer();
  ADMIN = await setupAdmin("Sam Patel", "sam.patel", "admin-pass-1");
  assert.equal((await admin("POST", "users", { name: "Alex Brown", username: "alex", role: "staff", password: "temp-pass-1" })).status, 200);
  STAFF = await firstSignIn("alex", "temp-pass-1", "alex-own-pass");
});
after(async () => { await srv?.stop(); });

// The session a response sets (its first Set-Cookie may remove an older, host-only copy: src/auth.ts).
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
const postJson = (url, body) => fetch(`${srv.base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function setupAdmin(name, username, password) {
  const r = await postJson("/api/auth/setup", { name, username, password, code: SETUP_CODE });
  assert.equal(r.status, 200, await r.clone().text());
  return cookieOf(r);
}
async function login(username, password) {
  const r = await postJson("/api/auth/login", { username, password });
  const body = await r.json();
  return r.status === 200 && !body.mustChange ? cookieOf(r) : { status: r.status, body };
}
/** Signs in with a temporary password and chooses a new one, as the sign-in page does. */
async function firstSignIn(username, temp, chosen) {
  const first = await login(username, temp);
  assert.equal(first.body?.mustChange, true, "a temporary password asks for a new one");
  const r = await postJson("/api/auth/change", { username, password: temp, newPassword: chosen });
  assert.equal(r.status, 200, await r.clone().text());
  return cookieOf(r);
}
async function db(op, body, cookie = ADMIN) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(`${srv.base}/api/db/${op}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function admin(method, route, body, cookie = ADMIN) {
  const r = await fetch(`${srv.base}/api/admin/${route}`, { method, headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test("security: staff can't use manager or admin features, managers can't use admin ones", async () => {
  assert.equal((await admin("POST", "users", { name: "Max Manager", username: "max", role: "manager", password: "temp-pass-1" })).status, 200);
  const MANAGER = await firstSignIn("max", "temp-pass-1", "max-own-pass");
  const send = (method, url, cookie, body) => fetch(srv.base + url, { method, redirect: "manual", headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) });
  const denied = async (res, what) => {
    assert.equal(res.status, 403, what);
    assert.equal((await res.json()).code, "permission_denied", what);
  };

  // Diary: manager-only business collections at every site. Admins explicitly classify contacts and
  // onboarding as shared business information before a manager may edit the existing document.
  const prefixes = ["", "sites/cafe/", "sites/asg/", "sites/factory/"];
  for (const pre of prefixes) for (const col of ["settings", "plans", "inspections", "suppliers", "contacts", "onboarding"]) {
    const path = `${pre}${col}/sec1`;
    const classified = col === "contacts" || col === "onboarding";
    assert.equal((await db("set", { path, data: { name: "seed", ...(classified ? { visibility: "shared-business", ownerUserId: null } : {}) } })).status, 200, "admin seeds " + path);
    for (const [op, body] of [["set", { path, data: { a: 1 } }], ["update", { path, patch: { a: 1 } }], ["delete", { path }]]) {
      const r = await db(op, body, STAFF);
      assert.equal(r.status, 403, `staff ${op} ${path}`);
      assert.equal(r.body.code, "permission_denied");
      assert.equal((await db(op, body, MANAGER)).status, 200, `manager ${op} ${path}`);
    }
    if (classified) assert.equal((await db("set", { path, data: { name: "new", visibility: "shared-business" } }, MANAGER)).status, 403, "managers cannot recreate or classify a shared business record");
  }
  for (const [op, body] of [["set", { path: "config/shared", data: { a: 1 } }], ["update", { path: "config/shared", patch: { a: 1 } }], ["delete", { path: "config/shared" }]])
    assert.equal((await db(op, body, STAFF)).body.code, "permission_denied", "staff " + op + " config/shared");
  // A badly shaped write to manager data is still refused as permission_denied (not invalid_data) for staff.
  assert.equal((await db("set", { path: "settings/main", data: { closedDays: "Sunday" } }, STAFF)).body.code, "permission_denied");

  // Diary records: staff can't delete day pages, week pages or signed reviews; managers can.
  for (const path of ["sites/cafe/days/2026-09-10", "weeks/2026-09-07", "sites/asg/reviews/2026-09-10"]) {
    assert.equal((await db("set", { path, data: { seed: "x" } })).status, 200);
    assert.equal((await db("delete", { path }, STAFF)).body.code, "permission_denied", "staff delete " + path);
    assert.equal((await db("get", { path })).body.exists, true, "still there");
    assert.equal((await db("delete", { path }, MANAGER)).status, 200, "manager delete " + path);
  }

  // A whole-page set on an existing day merges, so nobody's checks or sign-off are overwritten.
  const day = "sites/cafe/days/2026-09-11";
  await db("set", { path: day, data: { date: "2026-09-11", opening: { items: { o1: true } }, signed: { by: "web:Sam Patel", name: "Sam Patel", at: 1 } } });
  assert.equal((await db("set", { path: day, data: { date: "2026-09-11", closing: { items: { c1: true } } } }, STAFF)).status, 200);
  const merged = (await db("get", { path: day })).body.data;
  assert.deepEqual([merged.opening.items, merged.closing.items, merged.signed.name], [{ o1: true }, { c1: true }, "Sam Patel"]);

  // Signatures: staff sign in their own name only.
  assert.equal((await db("update", { path: day, patch: { signed: { by: "web:Max Manager", name: "Max Manager", at: 2 } } }, STAFF)).body.code, "permission_denied", "staff can't sign as a manager");
  assert.equal((await db("set", { path: "weeks/2026-09-14", data: { week: "2026-09-14", signed: { by: "web:Sam Patel", at: 2 } } }, STAFF)).body.code, "permission_denied");
  assert.equal((await db("set", { path: "reviews/2026-09-11", data: { date: "2026-09-11", answers: {}, by: "web:Max Manager", at: 2 } }, STAFF)).body.code, "permission_denied");
  assert.equal((await db("update", { path: day, patch: { signed: { by: "web:Alex Brown", name: "Alex Brown", at: 3 } } }, STAFF)).status, 200, "own signature");
  assert.equal((await db("update", { path: day, patch: { signed: { by: "web:Alex Brown", name: "Alex Brown", at: 3 }, problems: null } }, STAFF)).status, 200, "an unchanged signature can be sent back");
  assert.equal((await db("set", { path: "reviews/2026-09-11", data: { date: "2026-09-11", answers: {}, by: "web:Alex Brown", at: 2 } }, STAFF)).status, 200);
  assert.equal((await db("update", { path: day, patch: { signed: { by: "web:Alex Brown", name: "Alex Brown", at: 4 } } }, MANAGER)).status, 200, "managers aren't limited");

  // Undoing a sign-off: managers and admins only, on days and weeks.
  assert.equal((await db("update", { path: day, patch: { signed: null } }, STAFF)).body.code, "permission_denied", "staff can't undo a day's sign-off");
  await db("set", { path: "weeks/2026-09-07", data: { week: "2026-09-07", signed: { by: "web:Sam Patel", name: "Sam Patel", at: 1 } } });
  assert.equal((await db("update", { path: "weeks/2026-09-07", patch: { signed: null } }, STAFF)).body.code, "permission_denied", "nor a week's");
  assert.equal((await db("update", { path: day, patch: { signed: null } }, MANAGER)).status, 200, "managers can");
  assert.equal((await db("update", { path: "weeks/2026-09-07", patch: { signed: null } })).status, 200, "admins can");

  // Closed days: staff mark only today closed, in their own name, with a reason; reopening is for managers.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const mine = { reason: "Power cut", by: "web:Alex Brown", at: Date.now() };
  for (const [what, path, closed] of [
    ["an earlier day", "sites/asg/days/2026-09-01", mine],
    ["in someone else's name", `sites/asg/days/${today}`, { ...mine, by: "web:Max Manager" }],
    ["without a reason", `sites/asg/days/${today}`, { ...mine, reason: " " }],
  ]) {
    const r = await db("set", { path, data: { date: path.split("/").pop(), closed } }, STAFF);
    assert.equal(r.body.code, "permission_denied", "staff can't close " + what);
  }
  assert.equal((await db("set", { path: `sites/asg/days/${today}`, data: { date: today, closed: mine } }, STAFF)).status, 200, "staff close today");
  assert.equal((await db("update", { path: `sites/asg/days/${today}`, patch: { closed: mine, problems: { text: "x" } } }, STAFF)).status, 200, "an unchanged closure can be sent back");
  assert.equal((await db("update", { path: `sites/asg/days/${today}`, patch: { closed: null } }, STAFF)).body.code, "permission_denied", "staff can't reopen");
  const overview = (await admin("GET", "overview")).body;
  assert.ok(overview.attention.some((a) => a.title === "The ASG was marked closed today" && /By Alex Brown at \d\d:\d\d: Power cut/.test(a.detail)), "flagged for admins");
  assert.equal((await db("update", { path: `sites/asg/days/${today}`, patch: { closed: null } }, MANAGER)).status, 200, "managers reopen");
  assert.equal((await db("set", { path: "sites/asg/days/2026-09-02", data: { date: "2026-09-02", closed: { reason: "Holiday", by: "web:Max Manager", at: 1 } } }, MANAGER)).status, 200, "managers close earlier days");

  // Admin: the API, backups and the page, for staff and managers.
  const users = (await admin("GET", "users")).body.users;
  const someone = users.find((u) => u.username === "alex"), other = users.find((u) => u.username === "sam.patel");
  for (const cookie of [STAFF, MANAGER]) {
    const who = cookie === STAFF ? "staff" : "manager";
    for (const [method, route, body] of [
      ["GET", "users"], ["POST", "users", { name: "Eve Sneaky", role: "admin", password: "eve-pass-123" }],
      ["GET", `users/${someone.id}/orders-access`], ["PUT", `users/${someone.id}/orders-access`, {enabled:true,ifVersion:0}],
      ["PATCH", `users/${someone.id}`, { role: "admin" }], ["PATCH", `users/${someone.id}`, { email: "eve@example.com" }], ["POST", "email/test"], ["POST", "email/weekly-test"], ["PATCH", `users/${someone.id}`, { emailPrefs: { weekly: false } }], ["GET", "status"], ["GET", "backups"], ["POST", "backups"],
      ["GET", "overview"], ["POST", "overview/dismiss", { key: "errors" }], ["GET", "people"], ["GET", "sites"], ["POST", "sites/factory/copy-setup", { from: "roastery" }], ["POST", "sites/cafe/slack-test", { slot: "morning" }], ["GET", "activity"],
      ["GET", "security"], ["POST", "security/reset-pins"], ["POST", "security/sign-out-all"], ["GET", "export/people.csv"], ["GET", "export/shifts.csv"],
      ["GET", "wholesale/quickbooks/app-settings"], ["PUT", "wholesale/quickbooks/app-settings", {}], ["GET", "wholesale/quickbooks/status"], ["POST", "wholesale/quickbooks/connect", {}], ["GET", "wholesale/quickbooks/callback?state=none"], ["POST", "wholesale/quickbooks/confirm", {}], ["POST", "wholesale/quickbooks/disconnect", {}], ["GET", "wholesale/quickbooks/references?kind=customer"], ["GET", "wholesale/quickbooks/mappings"], ["PUT", "wholesale/quickbooks/mappings", {}], ["GET", "wholesale/quickbooks/invoices/1/preview"],
      ["GET", "wholesale/orders/print?status=New"], ["GET", "wholesale/tabs"], ["POST", "wholesale/customers/import", { customers: [{ business: "Security probe" }] }], ["GET", "wholesale/customers/invites"], ["POST", "wholesale/customers/accounts-emails", { rows: [{ company: "Security probe", emails: ["probe@example.com"] }], apply: true }], ["GET", "wholesale/customers/names"], ["POST", "wholesale/customers/invites", { customerIds: ["00000000-0000-0000-0000-000000000000"] }], ["POST", "wholesale/customers/00000000-0000-0000-0000-000000000000/invite", {}], ["PUT", "wholesale/orders/WS-00000000000000000000000000000000/lines", { ifVersion: 1, lines: [] }], ["PUT", "wholesale/orders/WS-00000000000000000000000000000000/tab", { ifVersion: 1, onTab: true }], ["POST", "wholesale/tabs/00000000-0000-0000-0000-000000000000/clear", { orderIds: ["x"] }], ["GET", "wholesale/order-emails"], ["PUT", "wholesale/order-emails", { ifVersion: 0, enabled: false, to: [] }], ["POST", "wholesale/order-emails/test", {}], ["POST", "wholesale/order-emails/slack-test", {}], ["GET", "wholesale/insights"], ["PUT", "wholesale/insights/settings", { ifVersion: 0, batchKg: 10, yieldKg: 8 }], ["GET", "wholesale/insights/history"], ["POST", "wholesale/insights/history/rows", { importId: "00000000-0000-0000-0000-000000000000", fileName: "x.csv", rows: [] }], ["PUT", "wholesale/insights/history/products", { mappings: [] }], ["DELETE", "wholesale/insights/history/imports/00000000-0000-0000-0000-000000000000"], ["GET", "wholesale/invoice-settings"], ["PUT", "wholesale/invoice-settings", {}], ["PUT", "wholesale/invoice-settings/customers", { ifVersion: 0, enabled: false }], ["GET", "wholesale/invoices"], ["GET", "wholesale/invoices/1"], ["GET", "wholesale/invoices/1/pdf"], ["PATCH", "wholesale/invoices/1/payment", {}],
      ["GET", "wholesale/orders/WS-00000000000000000000000000000000/invoice"], ["POST", "wholesale/orders/WS-00000000000000000000000000000000/invoice/preview", {}], ["POST", "wholesale/orders/WS-00000000000000000000000000000000/invoice/preview/pdf", {}], ["POST", "wholesale/orders/WS-00000000000000000000000000000000/invoice", {}],
      ["GET", "wholesale"], ["GET", "wholesale/orders"], ["GET", "wholesale/customers"], ["POST", "wholesale/customers", {}], ["PUT", "wholesale/customers/00000000-0000-0000-0000-000000000000", {}],
      ["POST", "wholesale/customers/00000000-0000-0000-0000-000000000000/account", {}], ["PUT", "wholesale/customers/00000000-0000-0000-0000-000000000000/account", {}], ["POST", "wholesale/customers/00000000-0000-0000-0000-000000000000/account/reset-password", {}],
      ["PUT", "wholesale/catalogue/brazil", {}], ["PATCH", "wholesale/orders/PREVIEW-00000000000000000000000000000000", {}], ["DELETE", "wholesale/orders/PREVIEW-00000000000000000000000000000000", { ifVersion: 1 }],
      ["POST", "wholesale/catalogue", {}], ["POST", "wholesale/catalogue/brazil/images?ifVersion=0", {}], ["PATCH", "wholesale/catalogue/brazil/images", {}], ["GET", "wholesale/images/00000000000000000000000000000000"],
    ]) await denied(await send(method, "/api/admin/" + route, cookie, body), `${who} ${method} /api/admin/${route}`);
    for (const page of ["/admin", "/admin/", "/admin.html", "/admin/index.html"]) assert.equal((await send("GET", page, cookie)).headers.get("location"), "/", `${who} ${page}`);
  }
  assert.equal((await admin("GET", "users")).body.users.find((u) => u.username === "alex").role, "staff", "still staff");

  // Rota: other employees' planning, private hours, contracts and actuals are admin-only.
  for (const cookie of [STAFF, MANAGER]) for (const [method, route, body] of [
    ["POST", "shifts", { site: "cafe", day: "2026-12-01", start: "09:00", end: "17:00" }], ["PATCH", "shifts/x", { start: "08:00" }],
    ["DELETE", "shifts/x"], ["PUT", "shifts/x/actual", { start: "09:00", end: "12:00" }], ["POST", "week/copy", { from: "2026-11-23", to: "2026-11-30" }],
    ["POST", "week/publish", { week: "2026-11-30" }], ["POST", "week/publish", { week: "2026-11-30", email: true }], ["GET", "week/emails?week=2026-11-30"], ["GET", "suggest?shift=x"], ["GET", "hours?start=2026-11-30"],
    ["GET", "hours?start=2026-11-30&format=csv"], ["PUT", `people/${someone.id}`, {}], ["PUT", `people/${someone.id}`, { contractMax: 60 }], ["PUT", "me/availability", { sites: ["cafe"] }],
    ["POST", "time-off", { userId: other.id, from: "2026-12-01", to: "2026-12-02", reason: "x" }],
    ["GET", "sickness"], ["DELETE", "sickness/x"], ["GET", `sickness/preview?userId=${other.id}&kind=off&from=2026-12-01&to=2026-12-01`],
    ["POST", "sickness", { userId: other.id, requestKey: "security-probe-1", kind: "off", from: "2026-12-01", to: "2026-12-01", category: "Other", details: "x", vomiting: false, doctor: false, workAccident: false, declared: true }],
  ]) await denied(await send(method, "/api/rota/" + route, cookie, body), `${cookie === STAFF ? "staff" : "manager"} ${method} /api/rota/${route}`);
  await denied(await send("PUT", "/api/rota/sites/cafe", STAFF, { minPeople: 0 }), "staff cannot change business site settings");

  // Stored files (allergen PDFs from before the matrix was generated) are added and removed by managers.
  await denied(await send("DELETE", "/api/assets/0123456789abcdef0123456789abcdef", STAFF), "staff DELETE /api/assets/<id>");

  // Every response says: only this site's scripts, and no framing.
  const csp = (await send("GET", "/", STAFF)).headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

