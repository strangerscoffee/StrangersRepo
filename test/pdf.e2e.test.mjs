// The PDFs the diary makes (EHO inspection records and the allergen matrix) with awkward content: very long names,
// labels, notes and table cells. Every piece of text the PDF writer draws (public/pdf.js) must stay on the page,
// inside its margins, and never overlap other text. Needs Playwright with Chromium (npm run test:e2e).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, browser, COOKIE = "";
before(async () => {
  srv = await startServer({ writeLimit: 5000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });

const set = (path, data) => fetch(`${srv.base}/api/db/set`, { method: "POST", headers: { "content-type": "application/json", cookie: COOKIE }, body: JSON.stringify({ path, data }) });
const words = (n, w) => Array.from({ length: n }, (_, i) => (i % 9 ? w : w + ",")).join(" ");
const NAME = "Bartholomew Featherstonehaugh-Smythe";

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
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: NAME, username: "bart", password: "admin-pass-1", code: SETUP_CODE }) });
  COOKIE = r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
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
