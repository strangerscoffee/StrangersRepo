import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { appForHost, appLinks, wholesalePath, isWholesaleCode, isPublicCode } from "../src/hosts.ts";

const canonical = "strangerscoffee.trade", legacy = "preview.staffstrangerscoffee.com";
const rota = "rota.staffstrangerscoffee.com", admin = "admin.staffstrangerscoffee.com";
let srv, customerCookie;
async function call(method, path, body, cookie) {
  const response = await fetch(srv.base + path, { method, redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch {}
  return { response, data, text };
}
before(async () => { srv = await startServer({ host: canonical, vars: { PREVIEW_HOST: canonical, LEGACY_PREVIEW_HOST: legacy, ADMIN_HOST: admin } }); });
after(async () => { await srv?.stop(); });

test("wholesale domain: canonical and legacy hosts share ordering while staff links stay on the staff domain", () => {
  for (const host of [canonical, legacy, canonical.toUpperCase(), legacy.toUpperCase()]) {
    assert.equal(appForHost(host, rota, admin, canonical, legacy), "preview");
    assert.deepEqual(appLinks(new URL(`https://${host}/`), rota, admin, canonical, legacy), { rota: `https://${rota}/`, admin: `https://${admin}/`, diary: "https://staffstrangerscoffee.com/", preview: "/" });
  }
  assert.equal(appLinks(new URL(`https://${admin}/`), rota, admin, canonical, legacy).preview, `https://${canonical}/`);
  assert.equal(appForHost("strangerscoffee.trade.evil.example", rota, admin, canonical, legacy), "diary");
  assert.equal(wholesalePath("/wholesale-preview/order.js"), "/wholesale/order.js");
  assert.equal(wholesalePath("/wholesale-preview-other/order.js"), "/wholesale-preview-other/order.js");
  for (const path of ["/wholesale/catalogue.js", "/wholesale/index.html", "/wholesale/images/brazil.webp", "/admin/admin.js"]) assert.equal(isWholesaleCode(path), false, path);
  assert.equal(isPublicCode("diary", "/wholesale/catalogue.js"), false, "source prices are not public bootstrap code");
});

test("wholesale assets: expired sessions can load the entire app graph at new and cached URLs without exposing data", async () => {
  for (const prefix of ["/wholesale/", "/wholesale-preview/"]) {
    for (const file of ["wholesale.js", "order.js", "grinds.js", "shipping.js", "limits.js", "catalogue-ui.js", "signin.js", "terms.js", "wholesale.css", "catalogue.css"]) {
      const result = await call("GET", prefix + file + "?v=cached-version");
      assert.equal(result.response.status, 200, prefix + file);
      assert.match(result.response.headers.get("content-type"), file.endsWith(".js") ? /javascript/ : /text\/css/);
      assert.doesNotMatch(result.text, /<!doctype html>/i);
      assert.equal(result.response.headers.get("location"), null);
      assert.match(result.response.headers.get("cache-control"), /private.*immutable/);
      if (file === "order.js") assert.doesNotMatch(result.text, /from\s+["']\.\/catalogue\.js["']/);
    }
    for (const privateFile of ["catalogue.js", "images/brazil.webp"]) {
      const result = await call("GET", prefix + privateFile);
      assert.equal(result.response.status, 302); assert.equal(result.response.headers.get("location"), "/signin");
      assert.match(result.response.headers.get("cache-control"), /no-store/);
    }
    const head = await call("HEAD", prefix + "wholesale.js");
    assert.equal(head.response.status, 200); assert.match(head.response.headers.get("content-type"), /javascript/); assert.equal(head.text, "");
  }
  for (const path of ["/api/wholesale/catalogue", "/api/wholesale/orders", "/api/wholesale/invoices"]) assert.equal((await call("GET", path)).response.status, 401, path);
  const source = await call("GET", "/wholesale-preview/order.js?v=old");
  const canonical = await call("GET", "/wholesale/order.js?v=new");
  assert.equal(source.text, canonical.text, "one physical copy serves the compatibility alias");
});

test("wholesale paths: old page links retain reset, invitation and order queries at their new address", async () => {
  for (const suffix of ["?reset=" + "a".repeat(64), "?invite=" + "b".repeat(64), "?order=WS-existing"]) {
    const result = await call("GET", "/wholesale-preview/signin" + suffix);
    assert.equal(result.response.status, 302); assert.equal(result.response.headers.get("location"), "/wholesale/signin" + suffix);
    assert.match(result.response.headers.get("cache-control"), /no-store/);
  }
  const page = await call("GET", "/wholesale-preview/?order=WS-existing");
  assert.equal(page.response.headers.get("location"), "/wholesale/?order=WS-existing");
  const signin = await call("GET", "/signin");
  assert.doesNotMatch(signin.text, /\/wholesale-preview\//);
  assert.match(signin.text, /\/wholesale\/signin\.js\?v=/);
  assert.match(signin.text, /data-sc-app="wholesale"/);
});

test("wholesale domain: customer-only sign-in and approval work without exposing staff setup or data", async () => {
  const home = await call("GET", "/");
  assert.equal(home.response.status, 302); assert.equal(home.response.headers.get("location"), "/signin");
  const icon = await call("GET", "/favicon.ico"); assert.equal(icon.response.status,200); assert.match(icon.response.headers.get("content-type"),/^image\//);
  const signin = await call("GET", "/signin");
  assert.equal(signin.response.status, 200); assert.match(signin.text, /Wholesale sign-in/);
  const focus = await call("GET", "/shared/focus.js");
  assert.equal(focus.response.status, 200); assert.match(focus.response.headers.get("content-type"), /javascript/);
  assert.match(focus.text, /data-sc-pointer/);
  const staff = await call("GET", "/wholesale/staff-signin");
  const target = new URL(staff.response.headers.get("location"));
  assert.equal(target.origin, "https://staffstrangerscoffee.com"); assert.equal(target.pathname, "/signin"); assert.equal(target.searchParams.get("next"), `https://${legacy}/`);
  assert.equal((await call("POST", "/api/auth/setup", { name: "Owner", username: "owner", password: "owner-password", code: SETUP_CODE })).response.status, 404);
  const credentials = { username: "trade.buyer", password: "trade-buyer-password", business: "Trade café", contact: "Buyer", email: "buyer@example.com" };
  assert.equal((await call("POST", "/api/wholesale/auth/register", credentials)).response.status, 201);
  assert.equal((await call("POST", "/api/wholesale/auth/login", credentials)).data.code, "approval_pending");
  // Only this isolated test database: emulate the existing Admin approval on the staff host.
  srv.sql("UPDATE wholesale_accounts SET approval_status = 'approved', active = 1; UPDATE wholesale_preview SET data = json_set(data, '$.status', 'Active') WHERE kind = 'customer';");
  const login = await call("POST", "/api/wholesale/auth/login", credentials);
  assert.equal(login.response.status, 200, login.text);
  const cookie = login.response.headers.getSetCookie().find((value) => value.startsWith("sf_wholesale_session="));
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/); assert.doesNotMatch(cookie, /Domain=/i);
  customerCookie = cookie.split(";")[0];
  const profile = await call("GET", "/api/wholesale/session", undefined, customerCookie);
  assert.equal(profile.data.customer.business, "Trade café"); assert.equal(profile.data.me.role, "wholesale"); assert.equal(profile.data.links.admin, undefined);
  assert.equal((await call("GET", "/", undefined, customerCookie)).response.status, 200);
  assert.equal((await call("GET", "/api/wholesale/catalogue", undefined, customerCookie)).data.products.length, 14);
  for (const asset of ["catalogue.css", "catalogue-ui.js"]) {
    const loaded = await call("GET", "/wholesale/" + asset, undefined, customerCookie);
    assert.equal(loaded.response.status, 200, asset);
    assert.doesNotMatch(loaded.text, /<!doctype html>/i, asset + " serves code rather than a redirect page");
  }
  for (const path of ["/api/auth/me", "/api/admin/wholesale", "/api/admin/users", "/api/db/get", "/api/rota/week", "/api/staff-orders/orders", "/api/live"]) {
    assert.equal((await call("GET", path, undefined, customerCookie)).response.status, 404, path);
  }
  const payload = { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 1, price: 1800 }], delivery: "Roastery collection", customerVersion: profile.data.customer.version };
  const ordered = await call("POST", "/api/wholesale/orders", payload, customerCookie);
  assert.equal(ordered.response.status, 201, ordered.text); assert.equal(ordered.data.order.business, "Trade café");
  assert.equal((await call("POST", "/api/wholesale/orders", payload, customerCookie)).data.order.id, ordered.data.order.id);
  assert.equal((await call("GET", "/api/wholesale/orders", undefined, customerCookie)).data.orders.length, 1);
  assert.equal((await call("GET", "/api/wholesale/invoices", undefined, customerCookie)).response.status, 200);
  assert.equal((await call("POST", "/api/wholesale/auth/logout", {}, customerCookie)).response.status, 200);
  assert.equal((await call("GET", "/api/wholesale/catalogue", undefined, customerCookie)).response.status, 401);
});
