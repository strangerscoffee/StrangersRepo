// "Couldn't load" reports for files the site serves normally (the owner's report of 19 Nov 2026: an email system's
// link checker kept failing to load the sign-in pages' stylesheet and logo) are kept and marked, but don't flag the
// Admin Overview; a file the site really doesn't serve still does. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN;
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
const send = (body) => fetch(`${srv.base}/api/errors`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36" }, body: JSON.stringify(body) });
const overview = async () => (await (await fetch(`${srv.base}/api/admin/overview`, { headers: { cookie: ADMIN } })).json()).attention;
const flagged = async () => (await overview()).some((a) => /errors? on the site in the last day/.test(a.title));

before(async () => {
  srv = await startServer({});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
});
after(async () => { await srv?.stop(); });

test("a file the site serves isn't flagged; a missing one is", async () => {
  // What the sign-in pages link now: the release copy of the stylesheet, and the ordering logo.
  const html = await (await fetch(srv.base + "/signin")).text();
  const sheet = /href="(\/_releases\/[a-f0-9]{20}\/theme\.css)"/.exec(html)?.[1] || "/theme.css";
  for (const [app, file] of [["signin", sheet], ["wholesale", "/wholesale/images/logo.svg"]]) {
    assert.equal((await send({ app, page: "/signin", message: "Couldn't load " + file })).status, 200);
  }
  assert.equal(await flagged(), false, "nothing to fix");
  // Not a way to probe for other paths: anything that isn't a plain file name is checked as missing.
  await send({ app: "signin", page: "/signin", message: "Couldn't load /../wrangler.jsonc" });
  await send({ app: "diary", page: "/", message: "Couldn't load /diary/not-here.js" });
  assert.equal(await flagged(), true, "a missing file is a real fault");
});
