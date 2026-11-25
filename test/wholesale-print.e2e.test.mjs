import { selectWholesaleSection, revealAdminOptions } from "./admin-workspace-helpers.mjs";
// Admin → Wholesale → Orders: Print new orders, Select to print and Bags to process, on a phone and an iPad.
// window.print is stubbed; the printed pages are what's in #wPrintArea. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, A;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "print.buyer", password: "print-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Print Café", contact: "Buyer", email: "print@example.com" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
  for (const lines of [[{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }, { productId: "campo", pack: "quarter", grind: "filter", quantity: 12, price: 500 }], [{ productId: "house", pack: "quarter", grind: "espresso", quantity: 8, price: 500 }]]) {
    const session = (await call("GET", "/api/wholesale/session", undefined, A)).body;
    assert.equal((await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines, delivery: "Roastery collection", reference: "", customerNote: "Own labels" , customerVersion: session.customer.version }, A)).status, 201);
  }
});
after(async () => { await b?.close(); await srv?.stop(); });

for (const [screen, viewport] of [["small phone", { width: 320, height: 844 }], ["phone", { width: 393, height: 852 }], ["compact tablet", { width: 701, height: 1024 }], ["tablet", { width: 820, height: 1180 }], ["split desktop", { width: 1340, height: 900 }], ["desktop", { width: 1440, height: 900 }], ["wide toolbar", { width: 1560, height: 1000 }], ["wide desktop", { width: 1920, height: 1080 }]]) for (const colorScheme of ["light", "dark"]) {
  test(`wholesale order controls stay inside the panel on ${screen} ${colorScheme}`, async () => {
    const ctx = await b.newContext({ viewport, colorScheme, isMobile: viewport.width < 600, hasTouch: viewport.width < 1024 });
    const [name, value] = ADMIN.split("="); await ctx.addCookies([{ name, value, url: srv.base }]);
    const p = await ctx.newPage(), errors = []; p.on("pageerror", e => errors.push(e.message));
    try {
      await p.goto(srv.base + "/admin#wholesale"); await p.locator('[data-act="wh-order"]').first().waitFor();
      if (screen === "split desktop") {
        // Exercise wider system font metrics at the first split-layout width.
        await p.addStyleTag({ content: ':root { --body:"DejaVu Sans",system-ui; --display:"DejaVu Sans",system-ui; }' });
      }
      const panel = p.locator('.w-list-panel[aria-labelledby="wOrdersTitle"]');
      const geometry = await panel.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const elements = [...node.querySelectorAll('.w-list-header .btn,.search,.w-print-menu summary,[data-act="wh-totals"],.w-order,.w-order .end,[data-act="wh-next"]')];
        return { overflow: node.scrollWidth - node.clientWidth, outside: elements.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.left < bounds.left - 1 || r.right > bounds.right + 1); }).map(e => e.className + ': ' + e.textContent.trim()) };
      });
      assert.ok(geometry.overflow <= 1, `the panel must not clip its contents: ${JSON.stringify(geometry)}`);
      assert.deepEqual(geometry.outside, [], 'actions, prices and order rows fit inside the panel');
      const settings = panel.locator(".w-order-settings");
      const trigger = settings.locator("summary");
      const header = panel.locator(".w-list-header");
      await trigger.scrollIntoViewIfNeeded();
      const layout = () => panel.evaluate(node => {
        const header = node.querySelector('.w-list-header');
        const order = node.querySelector('.w-order').getBoundingClientRect();
        // Layout dimensions avoid fractional roundoff from the scrolled viewport.
        return { height: header.offsetHeight, width: header.offsetWidth, toFirstOrder: Math.round(order.top - header.getBoundingClientRect().top) };
      });
      const before = await layout();
      if (viewport.width >= 1340) {
        const slots = await header.evaluate(node => [...node.querySelectorAll("h2, .w-result-count, .w-header-actions > button, .w-new-order, summary")]
          .map(el => { const box = el.getBoundingClientRect(); return { text: el.textContent.trim(), center: box.top + box.height / 2, left: box.left, right: box.right }; }));
        const centres = slots.map(slot => slot.center);
        assert.ok(Math.max(...centres) - Math.min(...centres) < 12, `the title, count and actions share one row: ${JSON.stringify(slots)}`);
        for (const [i, slot] of slots.entries()) {
          assert.ok(slot.right > slot.left && (!i || slot.left >= slots[i - 1].right - 1), `${slot.text} has room beside the preceding control`);
        }
      }
      await revealAdminOptions(p, ".w-order-settings");
      assert.deepEqual(await layout(), before, "opening settings leaves the header size and queue position stable");
      if (process.env.WHOLESALE_SCREENSHOT_DIR) await p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/order-settings-${screen}-${colorScheme}.png`, animations: "disabled" });
      await settings.getByRole("button", { name: "Announcement" }).focus();
      await p.keyboard.press("Escape");
      assert.equal(await settings.getAttribute("open"), null);
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
      await trigger.click();
      await header.getByRole("heading", { name: "Order queue" }).click();
      assert.equal(await settings.getAttribute("open"), null, "clicking outside dismisses settings");
      for (const action of ['wh-announcement', 'wh-order-emails']) {
        await revealAdminOptions(p, ".w-order-settings");
        const button = p.locator(`[data-act="${action}"]`); await button.scrollIntoViewIfNeeded();
        const target = await button.evaluate(node => { const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { width: r.width, height: r.height, overflow: node.scrollWidth - node.clientWidth, exposed: hit === node || node.contains(hit) }; });
        assert.ok(target.width >= 44 && target.height >= 44 && target.overflow <= 1 && target.exposed, `${action} is a visible touch target with its label inside`);
        await button.click(); await p.locator(action === 'wh-announcement' ? '#wAnnForm' : '#wOrderEmailsForm').waitFor();
        assert.ok(await p.locator('#sheet').evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${action} fits the window width`);
        await p.locator('#sheet [data-sheet="close"]').first().click(); await p.locator('#scrim').waitFor({ state: 'hidden' });
        assert.equal(await settings.getAttribute("open"), null, "settings close when an action opens");
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true, "closing the sheet returns focus to Order settings");
      }
      if (viewport.width >= 1560) {
        const toolbar = p.locator(".w-order-controls");
        assert.ok(await toolbar.evaluate(node => node.scrollWidth <= node.clientWidth + 1), "the wide filter toolbar fits");
        const status = p.locator("#wOrderStatus");
        await status.selectOption("Cancelled");
        await p.getByRole("heading", { name: "No matching orders" }).waitFor();
        await status.selectOption("all");
      } else {
        const lastFilter = p.locator('[data-act="wh-status"]').last(), lastStatus = await lastFilter.getAttribute('data-id'); await lastFilter.scrollIntoViewIfNeeded(); await lastFilter.click();
        await p.locator(`[data-act="wh-status"][data-id="${lastStatus}"][aria-pressed="true"]`).waitFor();
        assert.equal(await lastFilter.getAttribute('aria-pressed'), 'true', 'the last status remains reachable in its own scroller');
        await p.locator('[data-act="wh-status"][data-id="all"]').click();
      }
      await p.locator('[data-act="wh-order"]').first().waitFor();
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
      if (process.env.WHOLESALE_SCREENSHOT_DIR) { await panel.evaluate(node => node.scrollIntoView({ block: 'start' })); await p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/orders-${screen}-${colorScheme}.png` }); }
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
}

test("print new orders, pick orders to print, and see the bags to process", async () => {
  for (const [name, viewport, isMobile] of [["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false]]) {
    const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile });
    const [n, v] = ADMIN.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    await ctx.addInitScript(() => { window.print = () => { window.__printed = document.getElementById("wPrintArea")?.innerText || ""; }; });
    const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(srv.base + "/admin#wholesale");
    await selectWholesaleSection(p, "orders"); await p.locator('[data-act="wh-order"]').first().waitFor();

    // Order alerts: the customer confirmation switch saves and comes back as saved.
    await revealAdminOptions(p, ".w-order-settings"); await p.locator('[data-act="wh-order-emails"]').click(); await p.locator("#wConfirmCustomers").waitFor();
    assert.equal(await p.locator("#wConfirmCustomers").isChecked(), true, "customer confirmations are on by default");
    await p.locator("#wConfirmCustomers").uncheck(); await p.locator('#sheet [data-sheet="save"]').click(); await p.locator("#wConfirmCustomers").waitFor({ state: "detached" });
    await revealAdminOptions(p, ".w-order-settings"); await p.locator('[data-act="wh-order-emails"]').click(); await p.locator("#wConfirmCustomers").waitFor();
    assert.equal(await p.locator("#wConfirmCustomers").isChecked(), false);
    await p.locator("#wConfirmCustomers").check();
    if (process.env.WHOLESALE_SCREENSHOT_DIR) { await p.locator("#wConfirmCustomers").scrollIntoViewIfNeeded(); await p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/order-alerts-${name}.png` }); }
    await p.locator('#sheet [data-sheet="save"]').click(); await p.locator("#wConfirmCustomers").waitFor({ state: "detached" });

    await p.locator('[data-act="wh-totals"]').click(); await p.locator(".wp-tiles").waitFor();
    assert.match((await p.locator(".wp-tiles").innerText()).replace(/\s+/g, " "), /250 g bags 20 1 kg bags 6 All bags 26 11 kg of coffee/, name);
    assert.match(await p.locator(".wp-body").innerText(), /To pack: by coffee, size and grind/);
    await p.locator('[data-sheet="close"]').first().click();

    await p.locator(".w-print-menu summary").click();
    await p.locator('[data-act="wh-print-new"]').click(); await p.waitForFunction(() => window.__printed);
    const printed = await p.evaluate(() => window.__printed);
    assert.match(printed, /Bags to process/); assert.match(printed, /Own labels/); assert.equal((printed.match(/Packed by/g) || []).length, 2, `${name}: a packing sheet per new order`);
    assert.doesNotMatch(printed, /£/, "packing sheets carry no prices");

    await p.evaluate(() => { window.__printed = ""; });
    await p.locator(".w-print-menu summary").click();
    await p.locator('.w-print-menu [data-act="wh-pick-start"]').click(); await p.locator('[data-act="wh-pick"]').first().click();
    assert.equal(await p.locator(".w-picked-count").textContent(), "1 selected");
    assert.equal(await p.locator('[data-act="wh-pick"]').first().getAttribute("aria-pressed"), "true");
    await p.locator('[data-act="wh-print-picked"]').click(); await p.waitForFunction(() => window.__printed);
    assert.equal(((await p.evaluate(() => window.__printed)).match(/Packed by/g) || []).length, 1, `${name}: only the picked order`);
    await p.locator('[data-act="wh-pick-done"]').click(); await p.locator('[data-act="wh-order"]').first().waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
