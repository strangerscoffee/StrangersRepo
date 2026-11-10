// Real shared-browser identity changes, cached private screens, quarantined offline writes and failed logout.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, browser, admin, alice, bob, secondAdmin;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value)) || "").split(";")[0];
async function api(path, body, cookie = admin, method = body ? "POST" : "GET") {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", cookie: cookie || "" }, body: body && JSON.stringify(body) });
  const data = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`);
  return { data, cookie: cookieOf(response) };
}
async function employee(name, username, role) {
  const created = await api("/api/admin/users", { name, username, role, password: "temporary-pass", email: username + "@example.test" });
  const login = await api("/api/auth/change", { username, password: "temporary-pass", newPassword: username + "-own-password" }, "");
  return { ...created.data.user, username, password: username + "-own-password", cookie: login.cookie };
}
async function setIdentity(context, cookie) {
  const [name, value] = cookie.split("="); await context.addCookies([{ name, value, url: srv.base }]);
}
async function pageAs(cookie, path = "/") {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(30000);
  await setIdentity(context, cookie);
  const page = await context.newPage(); await page.goto(srv.base + path);
  return { context, page };
}
before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  admin = (await api("/api/auth/setup", { name: "Privacy Owner", username: "privacy.owner", password: "owner-password", code: SETUP_CODE }, "")).cookie;
  alice = await employee("Private Alice", "privacy.alice", "staff");
  bob = await employee("Private Bob", "privacy.bob", "manager");
  secondAdmin = await employee("Temporary Admin", "privacy.temporary", "admin");
  await api("/api/db/set", { path: "settings/main", data: { units: [], opening: [], closing: [], weekly: [], closedDays: [], info: {}, startDate: "2020-01-01", startSet: true } });
  for (const person of [alice, bob]) await api("/api/db/set", { path: "staff/" + person.id, data: { name: person.name, ownerUserId: person.id, notes: "Private note for " + person.username, topics: {}, sites: ["roastery"] } });
  await api("/api/db/set", { path: "maintenance/owner-queue", data: { title: "Operational queue task", details: "Original operational detail", status: "open", priority: "soon", area: "Counter" } });
});
after(async () => { await browser?.close(); await srv?.stop(); });

test("an Admin cache is shielded before focus verification and erased after another tab signs in as manager", async () => {
  const { context, page } = await pageAs(admin, "/admin#people");
  let release;
  try {
    await page.locator('[data-person="' + alice.id + '"]').click();
    await page.getByText(alice.username + "@example.test", { exact: true }).waitFor();
    let captured, responseHeaders;
    const held = new Promise((resolve) => { release = resolve; });
    const snapshot = new Promise((resolve) => { captured = resolve; });
    let first = true;
    await page.route("**/api/auth/me", async (route) => {
      if (!first) { await route.continue(); return; }
      first = false;
      const response = await route.fetch();
      responseHeaders = response.headers();
      captured(); await held; await route.fulfill({ response });
    });
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await snapshot; // An old Admin /me reply is now in flight while the shared cookie changes.
    assert.equal(responseHeaders["set-cookie"], undefined, "an identity read never carries an old session cookie");
    const peer = await context.newPage(); await peer.goto(srv.base + "/signin#change");
    await peer.evaluate(async (person) => { const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: person.username, password: person.password }) }); if (!response.ok) throw new Error("login failed"); }, bob);
    const leaked = [];
    await page.exposeFunction("identityLeak", (text) => leaked.push(text));
    await page.evaluate((email) => new MutationObserver(() => {
      if (!document.documentElement.hasAttribute("data-sc-session-locked") && document.body.innerText.includes(email)) window.identityLeak(email);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-sc-session-locked"] }), alice.username + "@example.test");
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await page.locator("#sc-session-shield").waitFor();
    assert.equal(await page.getByText(alice.username + "@example.test", { exact: true }).isVisible(), false, "old private cache is shielded before the server answers");
    release();
    await page.waitForURL((url) => !url.pathname.startsWith("/admin"));
    await page.waitForFunction((id) => typeof S !== "undefined" && S.myUserId === id, bob.id);
    assert.equal(await page.evaluate(async () => (await (await fetch("/api/auth/me")).json()).user.id), bob.id, "the delayed Admin reply cannot restore its cookie");
    assert.deepEqual(leaked, [], "an old verification reply cannot unlock the former Admin cache");
    assert.ok(!(await page.locator("body").innerText()).includes(alice.username + "@example.test"));
  } finally { release?.(); await context.close(); }
});

test("same-account role downgrade and persisted page restoration cannot retain Admin screens", async () => {
  const { context, page } = await pageAs(secondAdmin.cookie, "/admin#people");
  try {
    await page.locator('[data-person="' + alice.id + '"]').click();
    await page.getByText(alice.username + "@example.test", { exact: true }).waitFor();
    await api("/api/admin/users/" + secondAdmin.id, { role: "manager" }, admin, "PATCH");
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await page.waitForURL((url) => !url.pathname.startsWith("/admin"));
    assert.ok(!(await page.locator("body").innerText()).includes(alice.username + "@example.test"));
  } finally { await context.close(); }
});

test("a frozen staff page restored for a different employee reloads its private subscriptions", async () => {
  const { context, page } = await pageAs(alice.cookie, "/#staff");
  try {
    await page.waitForFunction((id) => typeof S !== "undefined" && S.myUserId === id && S.staff.length > 0, alice.id);
    assert.equal(await page.evaluate(() => S.staff[0].notes), "Private note for " + alice.username);
    await setIdentity(context, bob.cookie);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await page.waitForFunction((id) => typeof S !== "undefined" && S.myUserId === id && S.staff.length > 0, bob.id);
    assert.ok(await page.evaluate((id) => S.staff.every((record) => record.ownerUserId === id), bob.id));
    assert.ok(!(await page.locator("body").innerText()).includes("Private note for " + alice.username));
  } finally { await context.close(); }
});

test("offline operational writes remain quarantined across another employee's session and replay only for their owner", async () => {
  const { context, page } = await pageAs(alice.cookie, "/#staff");
  const queueKey = "sfbb.queue." + alice.id, note = "Owner offline operational draft";
  try {
    await page.waitForFunction((id) => typeof S !== "undefined" && S.myUserId === id && S.staff.length > 0, alice.id);
    await context.setOffline(true);
    await page.evaluate(async (note) => { await S.db.doc("maintenance/owner-queue").update({ details: note }); }, note);
    assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).length, queueKey), 1);
    await setIdentity(context, bob.cookie);
    const replayedAsBob = [];
    page.on("request", (request) => { if (request.url().endsWith("/api/db/update") && request.headers()["x-expected-user-id"] === bob.id && request.postData()?.includes(note)) replayedAsBob.push(request.postData()); });
    await context.setOffline(false);
    await page.waitForFunction((id) => typeof S !== "undefined" && S.myUserId === id, bob.id);
    assert.deepEqual(replayedAsBob, []);
    assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).length, queueKey), 1, "old owner's queue is preserved");
    assert.equal((await api("/api/db/get", { path: "maintenance/owner-queue" }, alice.cookie)).data.data.details, "Original operational detail");
    await setIdentity(context, alice.cookie); await page.reload();
    await page.waitForFunction((key) => !localStorage.getItem(key), queueKey);
    assert.equal((await api("/api/db/get", { path: "maintenance/owner-queue" }, alice.cookie)).data.data.details, note);
  } finally { await context.close(); }
});

test("new private saves stay in the form when offline and never enter localStorage or optimistic data", async () => {
  const { context, page } = await pageAs(alice.cookie, "/#staff");
  const draft = "Unsent confidential training draft";
  try {
    await page.waitForFunction((id) => typeof S !== "undefined" && S.myUserId === id && S.staff.length > 0, alice.id);
    await page.evaluate(() => { editStaff(S.staff[0]); setForm("staff", true); });
    await page.locator("#tNotes").fill(draft);
    await context.setOffline(true);
    const error = await page.evaluate(async (draft) => {
      try { await S.db.doc("staff/" + S.myUserId).update({ notes: draft }); return null; }
      catch (error) { return { code: error.code, message: error.message }; }
    }, draft);
    assert.equal(error.code, "unavailable");
    assert.match(error.message, /connection|draft|reconnect/i);
    assert.equal(await page.locator("#tNotes").inputValue(), draft, "the unsaved form remains intact");
    assert.ok(await page.evaluate((draft) => Object.values(localStorage).every((value) => !value.includes(draft)), draft), "confidential payload is not persisted");
    assert.ok(await page.evaluate((draft) => S.staff.every((record) => record.notes !== draft), draft), "no optimistic private projection");
    await context.setOffline(false); await page.evaluate(() => SC.ensureSession({ force: true }));
    assert.equal((await api("/api/db/get", { path: "staff/" + alice.id }, alice.cookie)).data.data.notes, "Private note for " + alice.username);
  } finally { await context.close(); }
});

test("a stale first identity reply cannot load another employee's saved queue or unlock their screen", async () => {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
  context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(30000);
  await setIdentity(context, alice.cookie);
  const page = await context.newPage(), queueKey = "sfbb.queue." + alice.id;
  let releaseFirst, releaseProof, firstCaptured, proofCaptured;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; }), proofHeld = new Promise((resolve) => { releaseProof = resolve; });
  const firstReady = new Promise((resolve) => { firstCaptured = resolve; }), proofReady = new Promise((resolve) => { proofCaptured = resolve; });
  try {
    await page.addInitScript(({ key, id }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify([{ op: "update", path: "staff/" + id, patch: { notes: "Legacy owner-only queue" } }])); }, { key: queueKey, id: alice.id });
    let reads = 0;
    await page.route("**/api/auth/me", async (route) => {
      const read = ++reads;
      if (read > 2) { await route.continue(); return; }
      const response = await route.fetch();
      if (read === 1) { firstCaptured(); await firstHeld; } else { proofCaptured(); await proofHeld; }
      await route.fulfill({ response });
    });
    await page.goto(srv.base + "/#staff"); await firstReady;
    await setIdentity(context, bob.cookie); releaseFirst(); await proofReady;
    assert.equal(await page.locator("#sc-session-shield").isVisible(), true, "a startup reply cannot authorize display by itself");
    assert.notEqual(await page.evaluate(() => S.myUserId), alice.id);
    assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).length, queueKey), 1);
    releaseProof();
    await page.waitForFunction((id) => typeof S !== "undefined" && S.myUserId === id && S.staff.length > 0, bob.id);
    assert.ok(!(await page.locator("body").innerText()).includes("Legacy owner-only queue"));
    assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).length, queueKey), 1);
  } finally { releaseFirst?.(); releaseProof?.(); await context.close(); }
});

test("a protected JSON body resolving after an identity clear cannot repopulate a former Admin cache", async () => {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(30000);
  await setIdentity(context, admin);
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (window.holdPrivateBody && url === "/api/admin/people") {
          window.holdPrivateBody = false;
          const response = await nativeFetch(input, init), body = new Uint8Array(await response.arrayBuffer());
          return new Response(new ReadableStream({ start(controller) { window.privateBodyHeld = true; window.releasePrivateBody = () => { controller.enqueue(body); controller.close(); }; } }), { status: response.status, headers: response.headers });
        }
        return nativeFetch(input, init);
      };
    });
    await page.goto(srv.base + "/admin#people"); await page.locator('[data-person="' + alice.id + '"]').waitFor();
    // Cancel the reload to retain the old realm, as a failed navigation would. Holding navigation open makes
    // Playwright wait for it before evaluating, which would deadlock this deliberately stalled-body probe.
    await page.route("**/admin", (route) => route.request().isNavigationRequest() ? route.abort("aborted") : route.continue());
    await page.evaluate(() => {
      window.holdPrivateBody = true;
      fetch("/api/admin/people").then((response) => response.json()).then((data) => { window.privateBodyResult = { data }; }, (error) => { window.privateBodyResult = { code: error.code }; });
    });
    await page.waitForFunction(() => window.privateBodyHeld);
    await setIdentity(context, bob.cookie); await page.evaluate(() => dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-sc-session-locked") && !document.querySelector("#main").textContent.trim());
    await page.evaluate(() => window.releasePrivateBody());
    await page.waitForFunction(() => window.privateBodyResult);
    assert.deepEqual(await page.evaluate(() => window.privateBodyResult), { code: "session_changed" }, "parsed old data is rejected after invalidation");
  } finally { await page.evaluate(() => window.releasePrivateBody?.()).catch(() => {}); await context.close(); }
});

test("failed sign-out stays protected across navigation and reconnect, never automatically resumes the old cookie", async () => {
  const { context, page } = await pageAs(alice.cookie);
  let blockLogout = true;
  const queueKey = "sfbb.queue." + alice.id;
  try {
    await page.waitForFunction((id) => typeof S !== "undefined" && S.myUserId === id, alice.id);
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify([{ op: "update", path: "staff/deferred", patch: { notes: "owner-only unsent draft" } }])), queueKey);
    await page.route("**/api/auth/logout", (route) => blockLogout ? route.abort("internetdisconnected") : route.continue());
    await page.evaluate(() => SC.signOut());
    await page.locator("#sc-session-shield").waitFor();
    assert.ok(!new URL(page.url()).pathname.startsWith("/signin"));
    assert.equal(await page.evaluate(() => localStorage.getItem("sc.logout.pending")), alice.id);
    await page.goto(srv.base + "/signin");
    await page.locator("#err", { hasText: /Sign out hasn't finished/ }).waitFor();
    assert.equal(await page.locator('#signin button[type="submit"]').isDisabled(), true);
    assert.ok(new URL(page.url()).pathname.startsWith("/signin"));
    blockLogout = false; await page.evaluate(() => dispatchEvent(new Event("online")));
    await page.locator("#err", { hasText: "Signed out. Sign in to continue." }).waitFor();
    assert.equal(await page.locator('#signin button[type="submit"]').isEnabled(), true);
    assert.equal(await page.evaluate(async () => (await (await fetch("/api/auth/me")).json()).user), null);
    assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).length, queueKey), 1, "sign-out preserves unsent work for its owner");
  } finally { await context.close(); }
});

test("successful logout clears private state synchronously and performs one sign-in navigation", async () => {
  const login = await api("/api/auth/login", { username: alice.username, password: alice.password }, "");
  const { context, page } = await pageAs(login.cookie, "/#staff");
  const navigations = [];
  let cleared;
  try {
    await page.waitForFunction((id) => typeof S !== "undefined" && S.myUserId === id && S.staff.length > 0, alice.id);
    await page.evaluate(() => { editStaff(S.staff[0]); setForm("staff", true); });
    await page.locator("#tNotes").fill("Private draft before logout");
    await page.exposeFunction("captureLogoutClear", (state) => { cleared = state; });
    await page.evaluate(() => addEventListener("sc:session-invalid", () => window.captureLogoutClear({
      shielded: document.documentElement.hasAttribute("data-sc-session-locked"),
      staff: S.staff.length, contacts: S.contacts.length, onboarding: S.onboarding.length,
      editorEmpty: document.querySelector("#tNotes").value === "",
      listEmpty: document.querySelector("#tList").textContent === "",
    }), { once: true }));
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && new URL(request.url()).pathname === "/signin") navigations.push(request.url());
    });
    await Promise.all([page.waitForURL(/\/signin(?:\?|$)/), page.evaluate(() => { void SC.signOut(); })]);
    await page.locator("#signin").waitFor();
    await page.waitForLoadState("networkidle");
    assert.equal(navigations.length, 1, "logout has one navigation, without a competing local identity check");
    assert.deepEqual(cleared, { shielded: true, staff: 0, contacts: 0, onboarding: 0, editorEmpty: true, listEmpty: true });
    assert.equal(await page.evaluate(async () => (await (await fetch("/api/auth/me")).json()).user), null);
  } finally { await context.close(); }
});
