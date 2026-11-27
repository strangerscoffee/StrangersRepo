import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { SETUP_CODE } from "./harness.mjs";
import { startPasskeyServer } from "./passkeys-fixture.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

const OWNER_PASSWORD = "owner-password-1";
const ADMIN_PASSWORD = "admin-password-1";
const STAFF_PASSWORD = "staff-password-1";
const TEMP_PASSWORD = "staff-temporary-1";
let srv, base, browser, ownerCookie, adminId, staffId;

async function call(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path} (${response.status}): ${JSON.stringify(data)}`);
  return { response, data };
}

async function createPerson(name, username, role, password) {
  const { data } = await call("/api/admin/users", {
    method: "POST", cookie: ownerCookie, body: { name, username, role, password: TEMP_PASSWORD },
  });
  await call("/api/auth/change", {
    method: "POST", body: { username, password: TEMP_PASSWORD, newPassword: password },
  });
  return data.user.id;
}

before(async () => {
  srv = await startPasskeyServer();
  base = srv.origin;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const { response } = await call("/api/auth/setup", {
    method: "POST", body: { name: "Owner Example", username: "owner", password: OWNER_PASSWORD, code: SETUP_CODE },
  });
  ownerCookie = response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value))?.split(";")[0];
  assert.ok(ownerCookie);
  staffId = await createPerson("Staff Example", "staffer", "staff", STAFF_PASSWORD);
  adminId = await createPerson("Admin Example", "administrator", "admin", ADMIN_PASSWORD);
});

after(async () => { await browser?.close(); await srv?.stop(); });

async function authenticator(t, viewport) {
  const context = await browser.newContext({ baseURL: base, viewport });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => t.diagnostic(error.stack));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  const credentials = async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
  return { context, page, cdp, authenticatorId, credentials };
}

async function browserPassword(page, username, password, next) {
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname === next),
    page.locator("#signin button[type=submit]").click(),
  ]);
}

async function browserResponse(page, path, action) {
  const [response] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === `/api/auth/passkeys/${path}`),
    action(),
  ]);
  return response;
}

async function browserAccount(page, role) {
  const admin = role === "admin";
  if (admin) {
    await page.locator("#whoName", { hasText: "Admin Example" }).waitFor();
    await page.locator("#whoBtn").click();
  } else {
    await page.locator("#avatarBtn", { hasText: "SE" }).click();
  }
  return page.locator(admin ? "#sheet" : "#acctMenu");
}

async function enroll(page, role, password, name) {
  const account = await browserAccount(page, role);
  await account.getByText("Passkeys", { exact: true }).click();
  await page.waitForURL((url) => url.hash === "#passkeys");
  await page.locator("#passkeyName").fill(name);
  await page.locator("#passkeyPassword").fill(password);
  const registered = await browserResponse(page, "register/verify", () => page.locator("#passkeyAdd").click());
  assert.ok(registered.ok(), await registered.text());
  const { passkey } = await registered.json();
  await page.getByText(name, { exact: true }).waitFor();
  return passkey;
}

async function browserSignOut(page, role) {
  const account = await browserAccount(page, role);
  await account.getByText("Sign out", { exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/signin");
  assert.equal((await (await page.request.get("/api/auth/me")).json()).user, null);
}

async function passkeySignIn(page, next, expectedRole) {
  assert.equal(await page.locator("#username").inputValue(), "", "the authenticator discovers the account");
  const verify = await browserResponse(page, "login/verify", () => page.locator("#passkeySignIn").click());
  if (!verify.ok()) assert.fail(await verify.text());
  await page.waitForURL((url) => url.pathname === next);
  const me = await (await page.request.get("/api/auth/me")).json();
  assert.equal(me.user.role, expectedRole);
  assert.equal(me.quickSwitch, false, "passkey sign-in does not authorize quick PIN switching on a new device");
  return me.user;
}

test("staff enrolls a discoverable passkey, falls back after cancellation, and removes it", { timeout: 90000 }, async (t) => {
  const { context, page, cdp, authenticatorId, credentials } = await authenticator(t, { width: 393, height: 852 });
  await page.goto(base + "/signin");
  await browserPassword(page, "staffer", STAFF_PASSWORD, "/");
  const { id } = await enroll(page, "staff", STAFF_PASSWORD, "Personal device");
  const enrolled = await credentials();
  assert.equal(enrolled.length, 1);
  assert.equal(enrolled[0].isResidentCredential, true);
  const { data: { backup } } = await call("/api/admin/backups", {
    method: "POST", body: {}, cookie: ownerCookie,
  });
  const { data: snapshot } = await call("/api/admin/backups/" + backup.id, { cookie: ownerCookie });
  const json = JSON.stringify(snapshot);
  assert.ok(snapshot.users.some((user) => user.id === staffId));
  for (const value of [id, enrolled[0].credentialId, "Personal device"]) {
    assert.ok(value && !json.includes(value), "backup excludes passkey material and metadata");
  }
  if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, "staff-passkeys-mobile.png") });
  await page.locator("#passkeysBack").click();
  await page.waitForURL((url) => url.pathname === "/");
  await browserSignOut(page, "staff");
  await context.clearCookies({ name: "sfbb_device" });
  await page.goto(base + "/signin");

  // Stop the virtual device satisfying presence so the browser's pending request can be cancelled.
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: false });
  await page.evaluate(() => {
    const original = navigator.credentials.get;
    navigator.credentials.get = function (options) {
      navigator.credentials.get = original;
      const cancellation = new AbortController();
      setTimeout(() => cancellation.abort(), 350);
      return original.call(this, { ...options, signal: cancellation.signal });
    };
  });
  await page.locator("#passkeySignIn").click();
  await page.locator("#err", { hasText: /cancelled|timed out/i }).waitFor();
  assert.equal((await (await page.request.get("/api/auth/me")).json()).user, null);
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: true });

  const staff = await passkeySignIn(page, "/", "staff");
  assert.equal(staff.id, staffId);
  assert.equal((await page.request.get("/api/admin/users")).status(), 403);
  const account = await browserAccount(page, "staff");
  await account.getByText("Passkeys", { exact: true }).click();
  const listed = await (await page.request.get("/api/auth/passkeys")).json();
  assert.equal(listed.passkeys[0].id, id);
  assert.ok(listed.passkeys[0].lastUsedAt, "successful authentication updates the last-use time");

  await page.locator("[data-remove-passkey]").click();
  await page.locator("#passkeyRemovePassword").fill(STAFF_PASSWORD);
  await page.locator("#passkeyRemoveConfirm").click();
  await page.locator("#passkeysStatus", { hasText: "Passkey removed." }).waitFor();
  assert.deepEqual(await (await page.request.get("/api/auth/passkeys")).json(), { passkeys: [] });

  await page.locator("#passkeysBack").click();
  await page.waitForURL((url) => url.pathname === "/");
  await browserSignOut(page, "staff");
  const revoked = await browserResponse(page, "login/verify", () => page.locator("#passkeySignIn").click());
  assert.equal(revoked.status(), 401);
  await browserPassword(page, "staffer", STAFF_PASSWORD, "/");

  await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
  await enroll(page, "staff", STAFF_PASSWORD, "Replacement device");
  await call(`/api/admin/users/${staffId}`, { method: "PATCH", cookie: ownerCookie, body: { password: TEMP_PASSWORD } });
  await call("/api/auth/change", {
    method: "POST", body: { username: "staffer", password: TEMP_PASSWORD, newPassword: "staff-new-password-1" },
  });
  await page.goto(base + "/signin");
  const reset = await browserResponse(page, "login/verify", () => page.locator("#passkeySignIn").click());
  assert.equal(reset.status(), 401, "password reset permanently removes the previous passkey");
});

test("an administrator signs back into Admin and their passkey follows their current role", { timeout: 90000 }, async (t) => {
  const { context, page } = await authenticator(t, { width: 1440, height: 900 });
  await page.goto(base + "/signin?next=/admin");
  await browserPassword(page, "administrator", ADMIN_PASSWORD, "/admin");
  await enroll(page, "admin", ADMIN_PASSWORD, "Admin device");
  await page.locator("#passkeysBack").click();
  await page.waitForURL((url) => url.pathname === "/admin");
  await browserSignOut(page, "admin");
  await context.clearCookies({ name: "sfbb_device" });
  await page.goto(base + "/admin");
  await page.waitForURL((url) => url.pathname === "/signin");
  assert.equal(new URL(page.url()).searchParams.get("next"), "/admin");
  assert.equal((await passkeySignIn(page, "/admin", "admin")).id, adminId);
  assert.ok((await page.request.get("/api/admin/users")).ok());

  await browserSignOut(page, "admin");
  await call(`/api/admin/users/${adminId}`, { method: "PATCH", cookie: ownerCookie, body: { role: "staff" } });
  await page.goto(base + "/signin");
  assert.equal((await passkeySignIn(page, "/", "staff")).id, adminId);
  assert.equal((await page.request.get("/api/admin/users")).status(), 403);
  await call(`/api/admin/users/${adminId}`, { method: "PATCH", cookie: ownerCookie, body: { active: false } });
  await call(`/api/admin/users/${adminId}`, { method: "PATCH", cookie: ownerCookie, body: { active: true } });
  await page.goto(base + "/signin");
  const disabled = await browserResponse(page, "login/verify", () => page.locator("#passkeySignIn").click());
  assert.equal(disabled.status(), 401, "re-enabling an account does not bring back its credentials");
});
