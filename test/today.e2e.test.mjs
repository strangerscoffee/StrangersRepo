// Today on a phone: overdue reminders fold after the first two, and in the morning the closing checks wait folded
// until the opening checks are done (an iPad keeps both open side by side). Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE, serverTimeIs } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, b, C = "";
before(async () => {
  srv = await startServer();
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will M", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  C = r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
});
after(async () => { await b?.close(); await srv?.stop(); });
const dbPost = (op, data) => fetch(srv.base + "/api/db/" + op, { method: "POST", headers: { "content-type": "application/json", cookie: C }, body: JSON.stringify(data) });
const set = (path, data) => dbPost("set", { path, data });

test("Today: reminders fold after two; closing checks wait folded on a phone in the morning", async () => {
  await set("settings/main", { units: [], opening: [{ id: "o1", t: "Hands" }, { id: "o2", t: "Surfaces" }], closing: [{ id: "c1", t: "Bins" }], weekly: [], closedDays: [] });
  for (let i = 0; i < 5; i++) await set(`cleaning/c${i}`, { name: `Overdue job ${i}`, how: "", freq: "weekly", who: "", createdAt: 1, lastAt: Date.now() - (20 + i) * 864e5, log: [] });
  const nine = new Date(); nine.setHours(9, 0, 0, 0);
  const shut = (p) => p.evaluate(() => document.querySelector("#closeCard").classList.contains("shut"));

  const phone = await b.newContext({ viewport: { width: 390, height: 844 } });
  await phone.addCookies([{ name: "sfbb_session", value: C.split("=")[1], url: srv.base }]);
  const p = await phone.newPage();
  await p.clock.setFixedTime(nine);
  await serverTimeIs(p, nine.getTime());
  await p.goto(srv.base + "/#day");
  await p.locator("#openList label").first().waitFor();
  await p.locator(".alertmore", { hasText: "3 more overdue" }).waitFor();
  assert.equal(await p.locator("#dayAlerts .alert").count(), 2, "two reminders shown");
  await p.locator(".alertmore").click();
  await p.locator("#dayAlerts .alert", { hasText: "Overdue job 4" }).waitFor();
  assert.equal(await p.locator("#dayAlerts .alert").count(), 5, "all five after Show");
  assert.equal(await shut(p), true, "closing checks folded at 9am while opening is to do");
  for (const t of ["Hands", "Surfaces"]) await p.locator("#openList label", { hasText: t }).click();
  await p.waitForFunction(() => !document.querySelector("#closeCard").classList.contains("shut"));
  await phone.close();

  const ipad = await b.newContext({ viewport: { width: 1194, height: 834 } });
  await ipad.addCookies([{ name: "sfbb_session", value: C.split("=")[1], url: srv.base }]);
  const q = await ipad.newPage();
  await q.clock.setFixedTime(nine);
  await serverTimeIs(q, nine.getTime());
  await set(`days/${nine.toLocaleDateString("en-CA")}`, { date: nine.toLocaleDateString("en-CA") });
  await q.goto(srv.base + "/#day");
  await q.locator("#closeList label").first().waitFor();
  assert.equal(await shut(q), false, "an iPad keeps closing checks open beside opening");
  await ipad.close();

  const short = await b.newContext({ viewport: { width: 320, height: 548 }, reducedMotion: "reduce" });
  try {
    await short.addCookies([{ name: "sfbb_session", value: C.split("=")[1], url: srv.base }]);
    const week = await short.newPage();
    await week.goto(srv.base + "/#week");
    const signOff = week.locator("#wkSignFab");
    await signOff.waitFor();
    for (const viewport of [{ width: 320, height: 548 }, { width: 1023, height: 640 }]) {
      await week.setViewportSize(viewport);
      await week.evaluate(() => window.scrollTo(0, 0));
      assert.ok(await signOff.evaluate(button => button.getBoundingClientRect().top >= document.getElementById("wkNoteCard").getBoundingClientRect().bottom), "week sign-off cannot obscure the weekly checks or notes on a short screen");
      await signOff.evaluate(button => button.scrollIntoView({ block: "center" }));
      assert.ok(await signOff.evaluate(button => {
        const bounds = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      }), "sign-off remains reachable above the mobile dock");
    }
  } finally { await short.close(); }
});

async function checklistPage() {
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const path = "days/" + date;
  assert.equal((await set("settings/main", { units: [], opening: [{ id: "o1", t: "Hands" }, { id: "o2", t: "Surfaces" }, { id: "o3", t: "Equipment" }], closing: [], weekly: [], closedDays: [] })).status, 200);
  assert.equal((await set(path, { date, opening: { items: { o1: false, o2: true, o3: false } } })).status, 200);
  const context = await b.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  await context.addCookies([{ name: "sfbb_session", value: C.split("=")[1], url: srv.base }]);
  const page = await context.newPage();
  await page.goto(srv.base + "/#day");
  await page.locator('[data-panel="day"][aria-busy="false"]').waitFor();
  const check = page.getByRole("checkbox", { name: "Hands", exact: true });
  await check.waitFor();
  await page.evaluate(() => {
    window.checklistPending = 0;
    window.addEventListener("diary:connection", (event) => { window.checklistPending = event.detail.pending; });
  });
  return { context, page, check, date, path };
}

test("A delayed checklist refresh cannot undo a newer tap", { timeout: 30000 }, async () => {
  const { context, page, check, date, path } = await checklistPage();
  const oldRead = Promise.withResolvers();
  const releaseOld = Promise.withResolvers();
  const releaseFresh = Promise.withResolvers();
  let held = false;
  try {
    await page.route("**/api/db/poll", async (route) => {
      if (held) { await releaseFresh.promise; return route.continue(); }
      const response = await route.fetch();
      const value = await response.json();
      if (Object.values(value.results || {}).some((result) => (result.docs || result.delta || []).some((doc) => doc.id === date && doc.data?.opening?.items?.o1 === true))) {
        held = true;
        oldRead.resolve();
        await releaseOld.promise;
      }
      await route.fulfill({ response });
    });
    await check.tap();
    await oldRead.promise;
    assert.equal(await check.isChecked(), true);
    const saved = page.waitForResponse((response) => {
      if (!response.ok() || !/\/api\/db\/(set|update)$/.test(response.url())) return false;
      const request = response.request().postDataJSON();
      return request.path === path && (request.patch ?? request.data).opening?.items?.o1 === false;
    }, { timeout: 8000 });
    await check.tap();
    assert.equal(await check.isChecked(), false);
    await (await saved).finished();
    await page.waitForFunction(() => window.checklistPending === 0, null, { timeout: 8000 });
    assert.equal((await (await dbPost("get", { path })).json()).data.opening.items.o1, false);
    const freshRead = page.waitForRequest("**/api/db/poll", { timeout: 8000 });
    releaseOld.resolve();
    await freshRead;
    assert.equal(await check.isChecked(), false, "the intermediate checked snapshot must not be painted");
    const freshResponse = page.waitForResponse("**/api/db/poll", { timeout: 8000 });
    releaseFresh.resolve();
    await freshResponse;
    assert.equal(await page.getByRole("checkbox", { name: "Surfaces", exact: true }).isChecked(), true);
    assert.equal((await dbPost("update", { path, patch: { opening: { items: { o1: true } } } })).status, 200);
    await page.waitForFunction(() => document.querySelector("#opening_o1")?.checked, null, { timeout: 8000 });
  } finally {
    releaseOld.resolve();
    releaseFresh.resolve();
    await context.close();
  }
});

test("A lost checklist request cannot reapply an older tap after reconnect", { timeout: 30000 }, async () => {
  const { context, page, check, path } = await checklistPage();
  const firstSent = Promise.withResolvers();
  const breakConnection = Promise.withResolvers();
  let disconnected = true;
  let otherDeviceSaved = false;
  let oldest;
  try {
    await page.route(/\/api\/db\/(set|update)$/, async (route) => {
      const body = route.request().postDataJSON();
      if (body.path !== path) return route.continue();
      if (!disconnected) {
        if (!otherDeviceSaved) {
          otherDeviceSaved = true;
          assert.equal((await dbPost("update", { path, patch: { opening: { items: { o3: true } } } })).status, 200);
        }
        return route.continue();
      }
      if (!oldest) {
        oldest = { op: new URL(route.request().url()).pathname.split("/").at(-1), body };
        firstSent.resolve();
        await breakConnection.promise;
        return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":' });
      }
      await route.fulfill({ status: 504, json: { code: "unavailable", message: "Delayed test connection" } });
    });
    await check.tap();
    await firstSent.promise;
    await check.tap();
    await page.waitForFunction(() => window.checklistPending === 2, null, { timeout: 8000 });
    assert.equal(await check.isChecked(), false);
    assert.equal(await page.locator("#conn").evaluate((banner) => banner.hidden), true, "ordinary saves do not move the checklist");
    breakConnection.resolve();
    await page.locator("#conn", { hasText: "2 changes waiting" }).waitFor();
    assert.equal(await check.isChecked(), false);
    assert.equal(oldest.body.patch?.opening?.items?.o1 ?? oldest.body.data?.opening?.items?.o1, true);
    disconnected = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(() => window.checklistPending === 0, null, { timeout: 8000 });
    assert.equal(await check.isChecked(), false);

    const late = await dbPost(oldest.op, oldest.body);
    assert.equal(late.status, 409, "the original checked write must be refused after its retry and the untick");
    const { data } = await (await dbPost("get", { path })).json();
    assert.deepEqual(data.opening.items, { o1: false, o2: true, o3: true });
  } finally {
    breakConnection.resolve();
    await context.close();
  }
});
