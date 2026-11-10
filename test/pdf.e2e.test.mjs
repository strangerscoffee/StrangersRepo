// The PDFs the diary makes (EHO inspection records and the allergen matrix) with awkward content: very long names,
// labels, notes and table cells. Every piece of text the PDF writer draws (public/pdf.js) must stay on the page,
// inside its margins, and never overlap other text. Needs Playwright with Chromium (npm run test:e2e).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, browser, COOKIE = "";
before(async () => {
  srv = await startServer({ writeLimit: 5000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const response = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: NAME, username: "bart", password: "admin-pass-1", code: SETUP_CODE }) });
  assert.equal(response.status, 200);
  COOKIE = cookieOf(response);
});
after(async () => { await browser?.close(); await srv?.stop(); });

const set = (path, data) => fetch(`${srv.base}/api/db/set`, { method: "POST", headers: { "content-type": "application/json", cookie: COOKIE }, body: JSON.stringify({ path, data }) });
const words = (n, w) => Array.from({ length: n }, (_, i) => (i % 9 ? w : w + ",")).join(" ");
const NAME = "Bartholomew Featherstonehaugh-Smythe";
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value)) || "").split(";")[0];

// The native writer uses uncompressed WinAnsi hex Tj strings. Inspect the actual downloaded PDF, without
// requiring a separate PDF renderer in CI or relying only on the text that was visible in the page.
async function downloadedPdfText(download) {
  const file = await download.path();
  assert.ok(file, "the generated PDF was downloaded locally");
  const raw = (await readFile(file)).toString("latin1");
  assert.match(raw, /^%PDF-1\.4/);
  const decoder = new TextDecoder("windows-1252");
  return [...raw.matchAll(/<([0-9a-f]+)>\s*Tj/g)].map((match) => decoder.decode(Buffer.from(match[1], "hex"))).join("\n");
}

/** Records every text box the PDF writer draws, by page, then checks them. Runs in the page. */
function watchPdfText() {
  const P = window.DiaryPDF, D = P.Doc.prototype, text = D.text;
  window.__pdfBoxes = [];
  D.text = function (s, x, y, o = {}) {
    const size = o.size || 10, w = P.width(s, size, !!o.bold);
    if (String(s).trim() && !o.rotate) {
      const x0 = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
      window.__pdfBoxes.push({ page: this.pages.indexOf(this.ops), x0, x1: x0 + w, top: y - size * 0.75, bottom: y + size * 0.2, W: this.W, H: this.H, s: String(s).slice(0, 40) });
    }
    return text.call(this, s, x, y, o);
  };
}
function problems(boxes) {
  const out = [];
  for (const b of boxes) if (b.x0 < 20 || b.x1 > b.W - 20 || b.top < 20 || b.bottom > b.H - 20) out.push(`off the page: "${b.s}" on page ${b.page + 1}`);
  const byPage = new Map();
  for (const b of boxes) byPage.set(b.page, [...(byPage.get(b.page) || []), b]);
  for (const list of byPage.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 1 && oy > 1) out.push(`overlap on page ${a.page + 1}: "${a.s}" and "${b.s}"`);
  }
  return out;
}

test("PDFs: long content wraps and carries over onto the next page, never off it or over other text", async () => {
  const today = new Date().toLocaleDateString("en-CA");
  await set("settings/main", {
    units: [{ id: "u1", name: "Walk-in dairy fridge behind the espresso bar on the left-hand side", kind: "fridge" }, { id: "u2", name: "Freezer", kind: "freezer" }],
    opening: [{ id: "o1", t: "Hands washed" }], closing: [{ id: "c1", t: "Bins emptied" }], weekly: [], closedDays: [],
    info: { address: "10 Dove Street, Norwich, NR2 1DE", manager: "Maximilian Alexander Featherstonehaugh-Ravenscroft the Third" },
  });
  await set(`days/${today}`, { date: today, temps: { u1: { am: { v: 9.5, by: "web:" + NAME, at: Date.now() } } }, problems: { text: words(120, "fridge"), by: "web:" + NAME, at: Date.now() }, signed: { by: "web:" + NAME, name: NAME, at: Date.now() } });
  // A HACCP plan with a title wider than the page, the long Scope label, notes longer than a page, a word wider
  // than its column and a table row taller than a page.
  await set("plans/h1", {
    type: "haccp", title: "HACCP Plan for Strangers Coffee Company - Roastery Serving Coffee, Filter, Cold Brew, Retail Beans, Wholesale Packing and Mobile Events",
    scope: words(60, "scope"), preparedBy: NAME, date: today, reviewDate: "2027-11-04",
    notes: Array.from({ length: 80 }, (_, i) => `Line ${i}: ` + words(i % 4 ? 3 : 30, "note")).join("\n"),
    steps: [
      { step: "Receiving", hazard: words(500, "hazard"), hazardType: "Biological", control: words(10, "control"), ccp: true, criticalLimit: "8°C", monitoring: "Probe", correctiveAction: "Reject", verification: "Weekly", records: "Log" },
      { step: "Storage", hazard: "Mould", hazardType: "Biological", control: "Dry", ccp: false, criticalLimit: "", monitoring: "", correctiveAction: "", verification: "", records: "" },
    ], history: [],
  });
  for (let i = 0; i < 12; i++) await set(`allergens/a${i}`, { name: i ? `Item ${i}` : "Oat milk flat white with an extra shot, salted caramel syrup, whipped cream and cinnamon", contains: ["Milk", "Soya"].slice(0, i % 3), notes: i % 4 ? "" : words(60, "may-contain"), kind: "drink", by: "web:" + NAME, at: Date.now() });

  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 }, acceptDownloads: true });
  await ctx.addCookies([{ name: "sfbb_session", value: COOKIE.split("=")[1], url: srv.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(srv.base + "/#allergens");
  await page.locator("#adList .btn", { hasText: "Generate PDF" }).waitFor();
  await page.evaluate(watchPdfText);
  await Promise.all([page.waitForEvent("download"), page.locator("#adList .btn", { hasText: "Generate PDF" }).click()]);
  const allergens = await page.evaluate(() => window.__pdfBoxes);
  assert.ok(allergens.length > 50, "the allergen matrix was drawn");
  assert.deepEqual(problems(allergens).slice(0, 10), [], "allergen matrix");

  await page.goto(srv.base + "/#inspect");
  await page.reload();
  await page.locator("#inChips button", { hasText: "Last 3 months" }).click();
  await page.locator("#in-daily table").waitFor();
  await page.evaluate(watchPdfText);
  await Promise.all([page.waitForEvent("download"), page.click("#inPdf")]);
  const eho = await page.evaluate(() => window.__pdfBoxes);
  const pages = new Set(eho.map((b) => b.page)).size;
  assert.ok(pages > 8, `the EHO records were drawn (${pages} pages)`);
  assert.deepEqual(problems(eho).slice(0, 10), [], "EHO inspection records");
  assert.ok(eho.some((b) => b.s.startsWith("Line 79")), "the notes carry on to their last line");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("EHO inspection screen and downloaded PDF keep employee training private to admins or its stable owner", async () => {
  const request = async (path, body, cookie = COOKIE) => {
    const response = await fetch(srv.base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const json = await response.json();
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(json)}`);
    return { body: json, cookie: cookieOf(response) };
  };
  const account = async (name, username, role) => {
    const created = await request("/api/admin/users", { name, username, role, password: "temporary-export-password" });
    const login = await request("/api/auth/change", { username, password: "temporary-export-password", newPassword: username + "-own-password" }, null);
    assert.ok(login.cookie);
    return { name, id: created.body.user.id, cookie: login.cookie, role };
  };
  const staff = await account("Staff Exportowner", "pdf.staff.owner", "staff");
  const manager = await account("Manager Exportowner", "pdf.manager.owner", "manager");
  const colleague = await account("Never Exportcolleague", "pdf.other.employee", "staff");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  await request("/api/db/set", { path: "sites/cafe/settings/main", data: {
    units: [], opening: [], closing: [], weekly: [], closedDays: [], info: { address: "Business site for privacy exports" },
    trainingOff: ["cross", "cleaning", "chilling", "cooking", "allergens", "diary", "l2"],
  } });
  await request("/api/db/set", { path: `sites/cafe/days/${today}`, data: { date: today,
    problems: { text: "Shared food safety inspection record", by: "web:" + NAME, at: Date.now() },
    signed: { by: "web:" + NAME, name: NAME, at: Date.now() },
  } });
  const record = (person, start, trainingDate, role = "Barista") => ({
    name: person.name, ownerUserId: person.id, personId: "training-" + person.id, role, start,
    topics: { hygiene: { date: trainingDate, by: "web:" + NAME } }, sites: ["cafe"], notes: "Private employee training notes", at: Date.now(),
  });
  const records = [
    { id: "staff-owned", data: record(staff, "2018-02-11", "2024-03-13") },
    { id: "manager-owned", data: record(manager, "2019-04-17", "2024-05-19") },
    { id: "colleague-private", data: record(colleague, "2020-06-23", "2024-07-29") },
    // An imported record whose display name matches the owner still has no reliable account binding.
    { id: "legacy-unbound", data: { ...record(staff, "2017-09-07", "2023-10-09", "Unbound legacy sentinel"), ownerUserId: null } },
  ];
  for (const entry of records) await request("/api/db/set", { path: "sites/cafe/staff/" + entry.id, data: entry.data });
  const dates = (entry) => [entry.data.start, entry.data.topics.hygiene.date].map((date) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(date + "T12:00:00Z")));

  for (const person of [staff, manager, { name: NAME, cookie: COOKIE, role: "admin" }]) {
    const admin = person.role === "admin", own = records.find((entry) => entry.data.ownerUserId === person.id);
    const permitted = admin ? records : [own], forbidden = admin ? [] : records.filter((entry) => entry !== own);
    const listed = (await request("/api/db/query", { path: "sites/cafe/staff" }, person.cookie)).body;
    assert.deepEqual(listed.docs.map((entry) => entry.id).sort(), permitted.map((entry) => entry.id).sort(), `${person.role}: the PDF's training source is server scoped`);
    if (!admin) {
      const hidden = (await request("/api/db/get", { path: "sites/cafe/staff/colleague-private" }, person.cookie)).body;
      assert.equal(hidden.exists, false); assert.equal(hidden.data, undefined);
      const poll = (await request("/api/db/poll", { queries: [{ key: "training", kind: "col", path: "sites/cafe/staff", delta: true, ver: 1 }] }, person.cookie)).body;
      assert.deepEqual(poll.results.training.docs.map((entry) => entry.id), [own.id]);
      assert.doesNotMatch(JSON.stringify(poll), /Never Exportcolleague|2020-06-23|2024-07-29|Unbound legacy sentinel/);
    }

    const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 }, acceptDownloads: true });
    try {
      await ctx.addCookies([{ name: "sfbb_session", value: person.cookie.split("=")[1], url: srv.base }]);
      await ctx.addInitScript(() => localStorage.setItem("sfbb.site", "cafe"));
      const page = await ctx.newPage(), errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(srv.base + "/#inspect");
      await page.locator("#in-training table", { hasText: admin ? colleague.name : person.name }).waitFor();
      // A page restored from an older, over-broad in-memory snapshot must not re-export other employees.
      if (!admin) await page.evaluate((stale) => { S.staff.push(...stale); renderInspect(); }, forbidden.map((entry) => ({ id: entry.id, ...entry.data })));
      const report = await page.locator("#inReport").innerText();
      assert.match(report, /Shared food safety inspection record/, `${person.role}: business inspection records remain available`);
      for (const entry of permitted) for (const expected of [entry.data.name, ...dates(entry)]) assert.ok(report.includes(expected), `${person.role}: screen retains authorized ${expected}`);
      for (const entry of forbidden) for (const secret of [...dates(entry), ...(entry.id === "colleague-private" ? [entry.data.name] : []), ...(entry.id === "legacy-unbound" ? [entry.data.role] : [])]) assert.ok(!report.includes(secret), `${person.role}: screen excludes ${secret}`);
      if (admin) assert.match(report, /staff fully trained/, "admins retain the full workforce inspection summary");
      else {
        assert.match(await page.locator("#in-training").innerText(), /Your training/);
        assert.match(await page.locator("#in-training").innerText(), /your|own/i, "the exported training section describes its restricted scope");
        assert.doesNotMatch(report, /staff fully trained|\b4 people\b|\b4\/4\b/, "own training is not presented as a full-workforce count");
      }
      const [download] = await Promise.all([page.waitForEvent("download"), page.click("#inPdf")]);
      const pdf = await downloadedPdfText(download);
      assert.match(pdf, /Shared food safety inspection record/);
      for (const entry of permitted) for (const expected of [entry.data.name, ...dates(entry)]) assert.ok(pdf.includes(expected), `${person.role}: PDF retains authorized ${expected}`);
      for (const entry of forbidden) for (const secret of [...dates(entry), ...(entry.id === "colleague-private" ? [entry.data.name] : []), ...(entry.id === "legacy-unbound" ? [entry.data.role] : [])]) assert.ok(!pdf.includes(secret), `${person.role}: PDF excludes ${secret}`);
      if (admin) assert.match(pdf, /staff fully trained/);
      else assert.doesNotMatch(pdf, /staff fully trained|\b4 people\b|\b4\/4\b/);
      assert.deepEqual(errors, [], `${person.role}: inspection and PDF have no script errors`);
    } finally { await ctx.close(); }
  }
});
