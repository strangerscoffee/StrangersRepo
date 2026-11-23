import { selectWholesaleSection } from "./admin-workspace-helpers.mjs";
// Admin → Wholesale → Invoicing → Automatic invoicing: three switches (each needing the one before), what's waiting with
// its reason, Try again / Do by hand. Phone, iPad and desktop, light and dark. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${text}`);
  return { body: data, cookie: cookieOf(r) };
}
before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const current = (await call("GET", "/api/admin/wholesale/invoice-settings")).body;
  await call("PUT", "/api/admin/wholesale/invoice-settings", { ...current.settings, ifVersion: current.version, seller: { legalName: "TEST Supplier Limited", address: "1 Test Street\nNorwich NR1 1AA", vatNumber: "TEST-GB123456789", companyNumber: "", email: "", phone: "" }, priceBasis: "inclusive", vatRates: [{ id: "zero", label: "Zero", basisPoints: 0 }, { id: "standard", label: "Standard", basisPoints: 2000 }], defaultCoffeeRateId: "zero", deliveryRateId: "standard", invoicePrefix: "TEST-", firstInvoiceNumber: 1000, paymentInstructions: "TEST instructions only.", confirmed: true });
  // Something held, to show with its reason.
  const at = Date.now();
  srv.sql(`INSERT INTO wholesale_auto_invoices(source,customer_id,business,state,reason,retry_at,created_at,updated_at) VALUES('order:WS-${"A".repeat(32)}','x','Held Up Café','held','QuickBooks: Review valid invoice, supply and explicit due dates before exporting.',${at + 3600000},${at},${at})`);
});
after(async () => { await b?.close(); await srv?.stop(); });

for (const [screen, viewport, isMobile] of [["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false], ["desktop", { width: 1440, height: 900 }, false]]) for (const scheme of ["light", "dark"]) {
  test(`Automatic invoicing switches on a ${screen} (${scheme})`, async () => {
    const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, colorScheme: scheme });
    const [n, v] = ADMIN.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
    p.on("dialog", (d) => d.accept());
    await p.goto(srv.base + "/admin#wholesale");
    await selectWholesaleSection(p, "invoices");
    const panel = p.locator(".wi-auto");
    await panel.waitFor();
    const sw = (id) => p.locator(`[data-act="wh-invoice-auto"][data-id="${id}"]`);
    // Start from off (each run).
    const s = (await call("GET", "/api/admin/wholesale/auto-invoicing")).body;
    if (s.settings.issue) { await call("PUT", "/api/admin/wholesale/auto-invoicing", { ifVersion: s.version, issue: false, quickbooks: false, email: false }); await p.reload(); await selectWholesaleSection(p, "invoices"); await panel.waitFor(); }
    assert.equal(await sw("issue").getAttribute("aria-checked"), "false");
    assert.ok(await sw("quickbooks").isDisabled(), "needs invoices on first");
    assert.ok(await sw("email").isDisabled());
    await sw("issue").click();
    await p.locator('[data-act="wh-invoice-auto"][data-id="issue"][aria-checked="true"]').waitFor();
    assert.match(await panel.textContent(), /Orders dispatched since/);
    assert.ok(!(await sw("quickbooks").isDisabled()));
    await sw("quickbooks").click();
    await p.locator('[data-act="wh-invoice-auto"][data-id="quickbooks"][aria-checked="true"]').waitFor();
    assert.match(await panel.textContent(), /Sent as Admin/);
    // The held one shows why, with its buttons.
    const held = p.locator('.wi-auto-item[data-state="held"]');
    assert.match(await held.textContent(), /Held Up Café/); assert.match(await held.textContent(), /due dates/);
    for (const name of ["Try again", "Do by hand"]) { const box = await held.getByRole("button", { name }).boundingBox(); assert.ok(box && box.x + box.width <= viewport.width + 1 && box.height >= 30, name + " fits"); }
    const panelBox = await panel.boundingBox(); assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= viewport.width + 1, "panel fits");
    if (process.env.SHOT_DIR) { await panel.scrollIntoViewIfNeeded(); await p.screenshot({ path: `${process.env.SHOT_DIR}/auto-invoicing-${screen}-${scheme}.png`, fullPage: true }); }
    // Switching invoices off switches the rest off.
    await sw("issue").click();
    await p.locator('[data-act="wh-invoice-auto"][data-id="issue"][aria-checked="false"]').waitFor();
    assert.equal(await sw("quickbooks").getAttribute("aria-checked"), "false");
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
