// Browser test of the real page + shim against `wrangler dev`. Needs Playwright with Chromium:
//   npm i -D playwright && npx playwright install chromium     (then: npm run test:e2e)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, browser, COOKIE = "";
before(async () => {
  srv = await startServer();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function api(op, body) {
  const r = await fetch(`${srv.base}/api/db/${op}`, {
    method: "POST", headers: { "content-type": "application/json", cookie: COOKIE }, body: JSON.stringify(body),
  });
  return r.json();
}

const settings = (address) => ({
  units: [{ id: "u1", name: "Fridge 1", kind: "fridge" }],
  opening: [{ id: "o1", t: "Hands washed" }, { id: "o2", t: "Surfaces sanitised" }],
  closing: [{ id: "c1", t: "Bins emptied" }],
  weekly: [{ id: "w1", t: "Deep clean fridges" }],
  closedDays: [], hide: {}, info: { address }, updatedBy: "web:Seeder", updatedAt: Date.now(),
});

test("staff journey on the real page", async () => {
  // A phone-sized screen: the tab bar, the Records and More lists, the site sheet and the account menu.
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // Signed out, the diary sends you to sign-in. With no accounts yet, that's the first-admin setup.
  await page.goto(srv.base + "/");
  await page.waitForURL(/\/signin(?:\?[^#]*)?$/);
  await page.locator("#setup").waitFor();
  await page.fill("#sname", "Sam Patel");
  assert.equal(await page.inputValue("#suser"), "sam.patel", "username suggested from the name");
  await page.fill("#spw", "admin-pass-1");
  await page.fill("#spw2", "admin-pass-1");
  await page.fill("#scode", "wrong code");
  await page.click("#setup button[type=submit]");
  await page.locator("#serr", { hasText: "setup code isn't right" }).waitFor();
  await page.fill("#scode", SETUP_CODE);
  await page.click("#setup button[type=submit]");

  // The admin section: add a member of staff, with a temporary password created for them.
  await page.waitForURL(/\/admin(#\w+)?$/);
  await page.locator(".ov-heading h1", { hasText: "Overview" }).waitFor();
  await page.goto(srv.base + "/admin#people");
  await page.locator("[data-person]", { hasText: "Sam Patel (you)" }).waitFor();
  await page.click("[data-act=add]");
  await page.fill("#fName", "Alex Brown");
  assert.equal(await page.inputValue("#fUser"), "alex.brown");
  await page.click("#sheet button[type=submit]");
  await page.locator("#pwText").waitFor();
  const [alexUser, alexTemp] = (await page.locator("#sheet .secret b").allTextContents()).map((t) => t.trim());
  assert.equal(alexUser, "alex.brown");
  assert.match(alexTemp, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  await page.click("#sheet button:has-text('Done')");
  assert.equal(await page.locator("#scrim").isHidden(), true, "the password sheet closes");
  await page.locator("[data-person]", { hasText: "Alex Brown" }).waitFor();

  // The test's own session for checking the database (signing out in the browser ends the browser's session).
  const own = await fetch(srv.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "sam.patel", password: "admin-pass-1" }) });
  COOKIE = (own.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
  await api("set", { path: "settings/main", data: settings("10 Dove Street") });
  await api("set", { path: "sites/cafe/settings/main", data: settings("21 Pottergate") });
  await api("set", { path: "suppliers/s1", data: { name: "Northern Dairy", supplies: "Milk, cream" } });
  await api("set", { path: "sites/cafe/cleaning/job1", data: { name: "Clean coffee machine", how: "Backflush", freq: "daily", who: "Barista", createdAt: Date.now(), log: [] } });
  await api("set", { path: "days/2026-10-01", data: { date: "2026-10-01", opening: { items: { o1: true }, by: "web:Seeder", at: Date.now() } } });

  await page.goto(srv.base + "/");
  await page.locator("#avatarBtn", { hasText: "SP" }).waitFor();
  assert.deepEqual(await accountMenu(page), ["Switch person", "Change password", "Admin", "Sign out"]);

  // Switch to the Cafe and tick an opening check.
  await switchSite(page, "Cafe");
  await page.locator("#openList label", { hasText: "Hands washed" }).waitFor();
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  await page.locator("#openList label", { hasText: "Hands washed" }).click();
  await assert.doesNotReject(waitFor(async () => {
    const d = await api("get", { path: `sites/cafe/days/${today}` });
    return d.exists && d.data.opening?.items?.o1 === true && d.data.opening.by === "web:Sam Patel";
  }), "opening check saved with the person's name");

  // Second tab sees changes from the first within ~10 s.
  const page2 = await ctx.newPage();
  await page2.goto(srv.base + "/");
  await page2.locator("#openList label", { hasText: "Surfaces sanitised" }).waitFor();
  assert.match(await page2.locator("[data-sitebtn]:visible").innerText(), /Cafe/);
  const t0 = Date.now();
  await page.locator("#openList label", { hasText: "Surfaces sanitised" }).click();
  await page2.locator("#openList input:checked").nth(1).waitFor({ state: "attached", timeout: 10000 });
  console.log(`  second tab updated after ${Date.now() - t0} ms`);
  await page2.close();

  // Sign-off stays locked until the day is done, then signs as the signed-in person.
  assert.equal(await page.locator("#signFab").isHidden(), true);
  await page.locator("#signCard", { hasText: "Still to do: temperatures, closing checks" }).waitFor();
  await page.fill("#t_u1", "3.5");
  await page.locator("#t_u1").blur();
  await page.locator("#closeFoot button", { hasText: "Tick all" }).click();
  await page.locator("#signFab", { hasText: "Sign off as Sam" }).click();
  await page.locator("#signCard", { hasText: "By Sam Patel" }).waitFor();
  const day = await api("get", { path: `sites/cafe/days/${today}` });
  assert.equal(day.data.signed.name, "Sam Patel");
  assert.equal(day.data.signed.by, "web:Sam Patel");
  assert.deepEqual(day.data.opening.items, { o1: true, o2: true });
  assert.equal(day.data.temps.u1.am.v, 3.5);
  assert.ok(day.data.closing.allDone, "Tick all records who confirmed");

  // Records → Temperature log: today's reading shows; add yesterday's missed reading, then correct it (a reason is
  // needed for a past day, and the first value is kept).
  await openSection(page, "templog");
  await page.locator("#tlList .xrow", { hasText: "Today" }).locator(".pill", { hasText: "Fridge 1: 3.5°" }).waitFor();
  const yIso = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  const yRow = page.locator("#tlList .xrow").nth(1);
  await yRow.locator(".xmain").click();
  await yRow.locator(`#tl_${yIso}_u1`).fill("4");
  await yRow.locator(".btn", { hasText: "Save changes" }).click();
  await assert.doesNotReject(waitFor(async () => (await api("get", { path: `sites/cafe/days/${yIso}` })).data?.temps?.u1?.am?.v === 4), "missed reading added");
  assert.equal((await api("get", { path: `sites/cafe/days/${yIso}` })).data.temps.u1.am.late, true, "marked as added later");
  // Wait for the page to show it (as a person would) before changing it again: until then it doesn't know
  // there's a reading to change.
  await page.locator("#tlList .xrow").nth(1).locator(".pill", { hasText: "Fridge 1: 4°" }).waitFor();
  const yRow2 = page.locator("#tlList .xrow").nth(1);
  if (!(await yRow2.locator(`#tl_${yIso}_u1`).isVisible())) await yRow2.locator(".xmain").click();
  await yRow2.locator(`#tl_${yIso}_u1`).fill("4.5");
  await yRow2.locator(".btn", { hasText: "Save changes" }).click();
  await page.locator("#toast", { hasText: "Say why the reading is being changed" }).waitFor();
  await yRow2.locator("input[placeholder^=\"Reason\"]").fill("Misread the display");
  await yRow2.locator(".btn", { hasText: "Save changes" }).click();
  await assert.doesNotReject(waitFor(async () => (await api("get", { path: `sites/cafe/days/${yIso}` })).data.temps.u1.am.v === 4.5), "reading corrected");
  const yAm = (await api("get", { path: `sites/cafe/days/${yIso}` })).data.temps.u1.am;
  assert.equal(yAm.was.v, 4, "first value kept");
  assert.equal(yAm.note, "Misread the display");
  assert.equal(yAm.by, "web:Sam Patel");
  await page.locator("#tlList .xrow").nth(1).locator(".tlh", { hasText: "First recorded as 4°C" }).waitFor();

  // Closed days: mark yesterday closed from Today with a reason; it stops counting as incomplete.
  await openSection(page, "day");
  await page.fill("#dayDate", yIso); await page.locator("#dayDate").dispatchEvent("change");
  await page.locator("#closeDay summary").click();
  await page.locator("#closeDay .fchip", { hasText: "Maintenance or repairs" }).click();
  await page.fill("#cdReason", "Boiler broken, engineer booked");
  await page.locator("#closeDay .btn", { hasText: "Mark as closed" }).click();
  await page.locator("#closedNote", { hasText: "Closed: Boiler broken, engineer booked" }).waitFor();
  assert.equal((await api("get", { path: `sites/cafe/days/${yIso}` })).data.closed.reason, "Boiler broken, engineer booked");
  await openSection(page, "history");
  const yLabel = await page.evaluate((d) => new Date(d + "T12:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }), yIso);
  assert.match(await page.locator(`#strip .cd[aria-label="${yLabel}"]`).getAttribute("class"), /\bclosed\b/, "shown as closed, not incomplete");
  await page.locator("#excList .lrow", { hasText: "Closed: Boiler broken" }).waitFor();
  // Setup → Closures & holidays: Christmas at all four sites, then remove Boxing Day here.
  await openSection(page, "setup");
  await page.fill("#clFrom", "2026-12-25"); await page.fill("#clTo", "2026-12-26");
  await page.locator("#clChips .fchip", { hasText: "Christmas" }).click();
  await page.locator('label[for="clAll"]').click();
  await page.click("#clAdd");
  await page.locator("#toast", { hasText: "at all four sites" }).waitFor();
  await page.locator("#clList .lrow", { hasText: "Fri 25 Dec 2026" }).waitFor();
  for (const base of ["days", "sites/cafe/days", "sites/asg/days", "sites/factory/days"])
    for (const d of ["2026-12-25", "2026-12-26"]) assert.equal((await api("get", { path: `${base}/${d}` })).data?.closed?.reason, "Christmas", `${base}/${d}`);
  const boxing = page.locator("#clList .lrow", { hasText: "Sat 26 Dec 2026" }).locator(".btn.danger");
  await boxing.click(); await boxing.click();
  await assert.doesNotReject(waitFor(async () => (await api("get", { path: "sites/cafe/days/2026-12-26" })).data.closed === null), "closure removed");
  assert.equal((await api("get", { path: "sites/asg/days/2026-12-26" })).data.closed.reason, "Christmas", "other sites keep theirs");

  // Sign off the week.
  await openSection(page, "week");
  await page.locator("#wkFoot button", { hasText: "Tick all" }).click();
  await page.locator("#wkSignFab", { hasText: "Sign off week as Sam" }).click();
  await page.locator("#wkSignCard", { hasText: "By Sam Patel" }).waitFor();
  const weeks = await api("query", { path: "sites/cafe/weeks" });
  assert.equal(weeks.docs[0].data.signed.name, "Sam Patel");

  // Mark a cleaning job done.
  await openSection(page, "cleaning");
  const job1 = page.locator("#kList .xrow", { hasText: "Clean coffee machine" });
  await job1.locator(".xhead .btn", { hasText: "Done" }).click();
  await page.locator("#kList .xrow", { hasText: "you" }).waitFor();
  const job = await api("get", { path: "sites/cafe/cleaning/job1" });
  assert.equal(job.data.lastBy, "web:Sam Patel");
  assert.equal(job.data.log.length, 1);

  // Set the date it was last done by hand.
  const past = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() - 3);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  if (!(await job1.locator("input[type=date]").isVisible())) await job1.locator(".xmain").click();
  await job1.locator("input[type=date]").fill(past);
  await job1.locator(".btn", { hasText: "Save date" }).click();
  await assert.doesNotReject(waitFor(async () => {
    const j = await api("get", { path: "sites/cafe/cleaning/job1" });
    return j.data.lastSet === true && j.data.log.length === 2 && j.data.log[0].set === true;
  }), "hand-entered last-done date saved");
  const jobSet = await api("get", { path: "sites/cafe/cleaning/job1" });
  const savedDay = await page.evaluate((at) => {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, jobSet.data.lastAt);
  assert.equal(savedDay, past);
  assert.equal(jobSet.data.lastBy, "web:Sam Patel");
  await page.locator("#kList .xrow", { hasText: "Clean coffee machine" }).locator(".pill.bad").waitFor();

  // Delete the hand-entered entry: the last-done date goes back to the tick before it, and Undo restores it.
  const jobRow = page.locator("#kList .xrow", { hasText: "Clean coffee machine" });
  if (!(await jobRow.locator(".hist").isVisible())) await jobRow.locator(".xmain").click();
  const firstDel = jobRow.locator(".hist li").first().locator(".btn.danger");
  await firstDel.click(); await firstDel.click();
  await assert.doesNotReject(waitFor(async () => (await api("get", { path: "sites/cafe/cleaning/job1" })).data.log.length === 1), "entry deleted");
  const jobDel = (await api("get", { path: "sites/cafe/cleaning/job1" })).data;
  assert.equal(jobDel.lastAt, jobDel.log[0].at, "last done goes back to the remaining entry");
  assert.equal(jobDel.lastSet, false);
  await page.locator("#toast button", { hasText: "Undo" }).click();
  await assert.doesNotReject(waitFor(async () => (await api("get", { path: "sites/cafe/cleaning/job1" })).data.lastSet === true), "Undo brings it back");

  // Prove it: Undo straight after saving, and Delete this record (then Undo) from a record's details.
  await openSection(page, "prove");
  const proveOnce = async (food) => {
    await page.fill("#pFood", food); await page.fill("#pReading", "80"); await page.click("#pSave");
    await page.locator("#pList .xrow", { hasText: food }).waitFor();
  };
  await proveOnce("Typo toastie");
  await page.locator("#toast button", { hasText: "Undo" }).click();
  await page.locator("#pList .xrow", { hasText: "Typo toastie" }).waitFor({ state: "detached" });
  await proveOnce("Cheese toastie");
  const pRow = page.locator("#pList .xrow", { hasText: "Cheese toastie" });
  await pRow.locator(".xmain").click();
  const pDel = pRow.locator(".btn", { hasText: "Delete this record" });
  await pDel.click(); await page.locator("#pList .btn", { hasText: "Tap again to remove" }).click();
  await page.locator("#pList .xrow", { hasText: "Cheese toastie" }).waitFor({ state: "detached" });
  await page.locator("#toast button", { hasText: "Undo" }).click();
  await page.locator("#pList .xrow", { hasText: "Cheese toastie" }).waitFor();
  assert.equal((await api("query", { path: "sites/cafe/proveit" })).docs.filter((d) => /toastie/.test(d.data.food)).length, 1);
  await openSection(page, "cleaning");

  // Add an allergen item from the Add button.
  await openSection(page, "allergens");
  assert.equal(await page.locator("#algFormPanel").isHidden(), true, "form closed until Add");
  await page.click("#addBtn");
  await page.fill("#algName", "Almond croissant");
  await page.locator("#algChecks label", { hasText: /nuts/i }).first().click();
  // Save to the ASG as well as the Cafe.
  assert.equal(await page.locator("#alg_sites_cafe").isChecked(), true, "current site always included");
  assert.equal(await page.locator("#alg_sites_cafe").isDisabled(), true);
  await page.locator('label[for="alg_sites_asg"]').click();
  await page.click("#algSave");
  await page.locator("#algList .xrow", { hasText: "Almond croissant" }).waitFor();
  const alg = await api("query", { path: "sites/cafe/allergens" });
  assert.equal(alg.docs[0].data.name, "Almond croissant");
  // The Cafe keeps Drinks and Food separately; the cakes & bakes from its allergen sheet go into Food in one tap.
  assert.equal(alg.docs[0].data.kind, "drink", "added from the main Add button: a drink");
  await page.locator("#algsec-food .btn", { hasText: "Add the 15 cakes & bakes" }).click();
  await page.locator("#algsec-food .xrow", { hasText: "Cheese Twist" }).waitFor();
  assert.equal(await page.locator("#algsec-food .xrow").count(), 15);
  const bakes = (await api("query", { path: "sites/cafe/allergens" })).docs.filter((d) => d.data.kind === "food");
  assert.equal(bakes.length, 15);
  const smores = bakes.find((d) => d.data.name === "S'mores Bar").data;
  assert.equal(smores.notes, "Contains pork gelatine.");
  assert.equal(smores.source, "Cakesmiths · 2293");
  assert.deepEqual([...smores.contains].sort(), ["Cereals with gluten", "Eggs", "Milk", "Peanuts", "Sesame", "Soya", "Sulphites", "Tree nuts"]);
  const foodSum = await page.locator("#algsec-food .algsum").innerText();
  assert.match(foodSum, /In every item[\s\S]*Peanuts/i);
  assert.match(foodSum, /Not used[\s\S]*Celery[\s\S]*Mustard/i);
  assert.equal(await page.locator("#algsec-food .btn", { hasText: "Add the 15 cakes" }).count(), 0, "import offered only while Food is empty");
  assert.equal(alg.docs[0].data.by, "web:Sam Patel");
  assert.deepEqual(alg.docs[0].data.sites, ["cafe", "asg"]);
  await assert.doesNotReject(waitFor(async () => {
    const a2 = await api("query", { path: "sites/asg/allergens" });
    return a2.docs.length === 1 && a2.docs[0].data.linkId === alg.docs[0].data.linkId && a2.docs[0].data.contains.length === 1;
  }), "allergen item copied to the ASG");
  assert.equal((await api("query", { path: "allergens" })).docs.length, 0, "not copied to unticked sites");

  // A cleaning job sent to all sites; editing it again keeps each site's own done-date.
  await openSection(page, "cleaning");
  await page.click("#addBtn");
  await page.fill("#cleaning_f_name", "Descale kettle");
  assert.deepEqual(await page.locator("#cleaning_f_freq option").allTextContents(),
    ["After use", "Daily", "Weekly", "Fortnightly", "Monthly", "Quarterly", "Six-monthly", "Yearly"]);
  await page.locator('label[for="cleaning_sites_all"]').click();
  await page.locator("#kFormPanel .btn", { hasText: /^Save$/ }).click();
  await page.locator("#kList .xrow", { hasText: "Descale kettle" }).waitFor();
  const findJob = async (base) => (await api("query", { path: base })).docs.find((d) => d.data.name === "Descale kettle");
  await assert.doesNotReject(waitFor(async () => !!(await findJob("sites/factory/cleaning")) && !!(await findJob("cleaning")) && !!(await findJob("sites/asg/cleaning"))),
    "cleaning job copied to every site");
  const factoryJob = await findJob("sites/factory/cleaning");
  await api("update", { path: `sites/factory/cleaning/${factoryJob.id}`, patch: { lastAt: 1760000000000, lastBy: "web:Factory Person" } });
  await page.locator("#kList .xrow", { hasText: "Descale kettle" }).locator(".xmain").click();
  await page.locator("#kList .xrow", { hasText: "Descale kettle" }).locator(".btn", { hasText: "Edit cleaning task" }).click();
  assert.equal(await page.locator("#cleaning_sites_all").isChecked(), true, "edit form shows the sites it was sent to");
  await page.fill("#cleaning_f_how", "Citric acid, rinse twice");
  await page.locator("#kFormPanel .btn", { hasText: /^Save$/ }).click();
  await assert.doesNotReject(waitFor(async () => (await findJob("sites/factory/cleaning"))?.data.how === "Citric acid, rinse twice"), "edit reaches the other sites");
  const factoryAfter = await findJob("sites/factory/cleaning");
  assert.equal(factoryAfter.id, factoryJob.id, "the linked copy is updated, not duplicated");
  assert.equal(factoryAfter.data.lastAt, 1760000000000, "each site keeps its own done-date");
  await openSection(page, "allergens");

  // The allergen matrix is generated as a PDF from the Cafe's items; a PDF uploaded before is still listed.
  assert.equal(await page.locator("#adFile").count(), 0, "no upload option");
  await api("set", { path: "sites/cafe/allergenDocs/old1", data: { title: "Summer allergen sheet", fileName: "summer.pdf", assetId: "0123456789abcdef0123456789abcdef", size: 1000, by: "web:Sam Patel", at: Date.now() - 864e5 } });
  await page.locator("#adList .pdfcard", { hasText: "Summer allergen sheet" }).waitFor();
  const [algDl] = await Promise.all([page.waitForEvent("download"), page.locator("#adList .btn", { hasText: "Generate PDF" }).click()]);
  assert.match(algDl.suggestedFilename(), /^Allergen matrix - Strangers Cafe - \d{4}-\d{2}-\d{2}\.pdf$/);
  const algPdf = await fs.readFile(await algDl.path());
  assert.equal(algPdf.subarray(0, 8).toString("latin1"), "%PDF-1.4");
  assert.ok(algPdf.toString("latin1").includes(Buffer.from("Almond croissant", "latin1").toString("hex")), "matrix lists the items");
  assert.ok(algPdf.toString("latin1").includes(Buffer.from("Tree nuts", "latin1").toString("hex")), "with the 14 allergens");

  // Records show names: switch to the Roastery, whose seeded day was ticked by "Seeder".
  await switchSite(page, "Roastery");
  await openSection(page, "day");
  await page.fill("#dayDate", "2026-10-01");
  await page.locator("#dayDate").dispatchEvent("change");
  await page.locator("#openFoot", { hasText: "Seeder" }).waitFor();
  assert.equal(await page.locator("#pageTitle").innerText(), "Diary");

  // Managers' sections are in More.
  await openSection(page, "plans");
  assert.equal(await page.locator("#pageTitle").innerText(), "HACCP & risk");
  assert.doesNotMatch(await page.locator('[data-panel="plans"]').innerText(), /Claude/);
  // A risk assessment shows the numbered, colour-coded scoring key, and the scales label the score menus.
  await api("set", { path: "plans/risk1", data: { type: "risk", title: "Risk assessment: Roaster", area: "Roaster", date: "2026-10-01", reviewDate: "2027-10-01",
    rows: [{ hazard: "Hot surfaces", whoHarmed: "Staff", existingControls: "Guards", likelihood: 3, severity: 5, furtherAction: "", actionBy: "", dueDate: "", done: false }], notes: "", history: [], updatedAt: 1 } });
  await page.locator("#plList .lrow", { hasText: "Risk assessment: Roaster" }).click();
  const key = page.locator("#planEditView .riskkey");
  await key.waitFor();
  const keyText = await key.innerText();
  for (const t of ["Risk = likelihood × severity", "Almost certain", "Severe", "1–4 Low", "5–12 Medium", "15–25 High"]) assert.ok(keyText.includes(t), "key shows " + t);
  assert.equal(await key.locator("table.rk-grid td.rate.bad").count(), 6, "15, 16, 20 (twice) and 25 are high");
  assert.equal(await page.locator("#planEditView select").first().locator("option:checked").innerText(), "3 Possible");
  assert.match(await page.locator("#planEditView .doc-table .rate.bad").first().innerText(), /15 High/);
  await page.locator("#plBack").click();

  // Staff training: accounts not on the list yet can be added in one go (untick anyone not wanted).
  await openSection(page, "staff");
  await page.locator("#tImport #tImpList label", { hasText: "Alex Brown" }).waitFor();
  assert.match(await page.locator("#tImpList").innerText(), /Sam Patel/);
  await page.locator("#tImpList label", { hasText: "Sam Patel" }).click();
  await page.locator("#tImpGo", { hasText: "Add 1 person to the staff list" }).click();
  await page.locator("#tList .xrow", { hasText: "Alex Brown" }).waitFor();
  assert.equal((await api("query", { path: "staff" })).docs.filter((d) => d.data.name === "Sam Patel").length, 0, "unticked person not added");
  await page.locator("#tImpList label", { hasText: "Sam Patel" }).waitFor();
  assert.equal(await page.locator("#tImpList label", { hasText: "Alex Brown" }).count(), 0, "added person leaves the import list");

  // Staff training: one date applied to every topic, then a topic the Roastery doesn't need switched off.
  await page.click("#addBtn");
  await page.fill("#tName", "Jo Smith");
  await page.fill("#tAllDate", "2026-10-20");
  await page.click("#tAllApply");
  for (const v of await page.locator("#tTopics input[type=date]").evaluateAll((ns) => ns.map((n) => n.value)))
    assert.equal(v, "2026-10-20", "apply to all fills every topic");
  await page.click("#tSave");
  await page.locator("#tList .xrow", { hasText: "Jo Smith" }).locator(".pill.ok", { hasText: "Trained" }).waitFor();
  const jo = (await api("query", { path: "staff" })).docs.find((d) => d.data.name === "Jo Smith");
  assert.equal(Object.keys(jo.data.topics).length, 8);
  assert.ok(Object.values(jo.data.topics).every((t) => t.date === "2026-10-20"));
  await page.locator("#tTopicToggles label", { hasText: "Level 2 Food Hygiene certificate" }).click();
  await assert.doesNotReject(waitFor(async () => (await api("get", { path: "settings/main" })).data.trainingOff?.includes("l2")),
    "switched-off topic saved to the site's settings");
  assert.equal(await page.locator('#tTopics [data-topic="l2"]').isHidden(), true, "switched-off topic hidden from the form");
  assert.equal((await api("query", { path: "staff" })).docs.find((d) => d.data.name === "Jo Smith").data.topics.l2.date, "2026-10-20",
    "dates already recorded are kept");

  // Setup: drag the second opening check above the first, move it back down with the keyboard, drag again, save.
  await openSection(page, "setup");
  const openRows = page.locator("#ceOpening .chk-row");
  const rowText = async () => openRows.locator("input[type=text]").evaluateAll((ns) => ns.map((n) => n.value));
  assert.deepEqual(await rowText(), ["Hands washed", "Surfaces sanitised"]);
  const dragUp = async () => {
    await openRows.nth(0).scrollIntoViewIfNeeded();
    const g = await openRows.nth(1).locator(".grip").boundingBox();
    const t = await openRows.nth(0).boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, t.y + 4, { steps: 8 });
    await page.mouse.up();
  };
  await dragUp();
  assert.deepEqual(await rowText(), ["Surfaces sanitised", "Hands washed"], "drag moves a check up");
  await openRows.nth(0).locator(".grip").focus();
  await page.keyboard.press("ArrowDown");
  assert.deepEqual(await rowText(), ["Hands washed", "Surfaces sanitised"], "arrow keys move a check");
  await dragUp();
  await page.click("#saveSetup");
  await assert.doesNotReject(waitFor(async () => (await api("get", { path: "settings/main" })).data.opening.map((c) => c.id).join() === "o2,o1"),
    "new order saved");
  await openSection(page, "day");
  await page.fill("#dayDate", await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }));
  await page.locator("#dayDate").dispatchEvent("change");
  // Today redraws once the saved order arrives (it can first show the list from before the save).
  await page.locator("#openList label").first().filter({ hasText: "Surfaces sanitised" }).waitFor().catch(() => {});
  assert.match(await page.locator("#openList label").first().innerText(), /Surfaces sanitised/, "Today follows the new order");
  assert.match(await page.locator("#probCard").innerText(), /Problems & changes \(Corrective actions\)/);

  // Setup → Diary starts on: at the Cafe only, then a date for all four sites. Earlier days aren't counted as
  // missed, and a cleaning job's own last-done date is kept.
  await switchSite(page, "Cafe");
  const jobBefore = (await api("query", { path: "sites/cafe/cleaning" })).docs.find((d) => d.data.name === "Descale kettle");
  await openSection(page, "setup");
  const t0d = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  await page.fill("#siStart", t0d);
  await page.click("#saveSetup");
  await page.locator("#setupMsg", { hasText: "Setup saved for the Cafe." }).waitFor();
  const cafeSet = (await api("get", { path: "sites/cafe/settings/main" })).data;
  assert.equal(cafeSet.startDate, t0d);
  assert.equal(cafeSet.startSet, true);
  assert.notEqual((await api("get", { path: "settings/main" })).data.startSet, true, "other sites untouched");
  await openSection(page, "history");
  await page.locator("#strip .cd").first().waitFor();
  assert.equal(await page.locator("#strip .cd.bad").count(), 0, "no missed days before the start");
  assert.equal((await api("query", { path: "sites/cafe/cleaning" })).docs.find((d) => d.data.name === "Descale kettle").data.lastAt, jobBefore.data.lastAt, "job dates kept");
  await openSection(page, "setup");
  await page.fill("#siStart", "2026-09-01");
  await page.locator('label[for="siStartAll"]').click();
  await page.click("#saveSetup");
  await page.locator("#setupMsg", { hasText: "Start date also set at the Roastery, ASG, Factory." }).waitFor();
  for (const base of ["settings/main", "sites/cafe/settings/main", "sites/asg/settings/main", "sites/factory/settings/main"]) {
    const st = (await api("get", { path: base })).data;
    assert.equal(st.startDate, "2026-09-01", base);
    assert.equal(st.startSet, true, base);
  }
  assert.ok((await api("get", { path: "settings/main" })).data.opening.length >= 2, "the Roastery's checks are kept");
  await switchSite(page, "Roastery");

  // A closing check added today counts from today: yesterday's completed day stays complete.
  const yd = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  const rs = (await api("get", { path: "settings/main" })).data;
  await api("set", { path: `days/${yd}`, data: { date: yd, opening: { items: Object.fromEntries(rs.opening.map((c) => [c.id, true])), by: "web:Sam Patel", at: 1 },
    closing: { items: Object.fromEntries(rs.closing.map((c) => [c.id, true])), by: "web:Sam Patel", at: 1 }, temps: Object.fromEntries(rs.units.map((u) => [u.id, { am: { v: u.kind === "freezer" ? -19 : 3, by: "web:Sam Patel", at: 1 } }])),
    signed: { by: "web:Sam Patel", at: 1, name: "Sam Patel" } } });
  await openSection(page, "setup");
  await page.locator('[data-addchk="closing"]').click();
  await page.locator("#ceClosing .chk-row input[type=text]").last().fill("Coffee grounds bin emptied");
  await page.click("#saveSetup");
  await page.locator("#setupMsg", { hasText: "Setup saved for the Roastery." }).waitFor();
  const added = (await api("get", { path: "settings/main" })).data.closing.find((c) => c.t === "Coffee grounds bin emptied");
  assert.equal(added.from, t0d, "new check counts from today");
  assert.ok((await api("get", { path: "settings/main" })).data.closing.filter((c) => c.t !== "Coffee grounds bin emptied").every((c) => !c.from), "existing checks keep no date");
  await openSection(page, "history");
  assert.match(await page.locator(`#strip .cd[aria-label="${await page.evaluate((d) => new Date(d + "T12:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }), yd)}"]`).getAttribute("class"), /\bok\b/, "yesterday still complete");
  await openSection(page, "day");
  await page.fill("#dayDate", yd); await page.locator("#dayDate").dispatchEvent("change");
  await page.locator("#closeList label").first().waitFor({ state: "attached" });
  assert.equal(await page.locator("#closeList label", { hasText: "Coffee grounds bin emptied" }).count(), 0, "not on yesterday's list");
  await page.fill("#dayDate", t0d); await page.locator("#dayDate").dispatchEvent("change");
  await page.locator("#closeList label", { hasText: "Coffee grounds bin emptied" }).waitFor({ state: "attached" });

  // Sign out, then sign in as the new member of staff: username + temporary password, then their own.
  await accountMenu(page, "Sign out");
  await page.waitForURL(/\/signin(?:\?[^#]*)?$/);
  await page.fill("#username", "alex.brown");
  await page.fill("#password", "wrong-password");
  await page.click("#signin button[type=submit]");
  await page.locator("#err", { hasText: "tries left" }).waitFor();
  await page.fill("#password", alexTemp);
  await page.click("#signin button[type=submit]");
  await page.locator("#newpw", { hasText: "Hi Alex Brown" }).waitFor();
  await page.fill("#np1", "alex-own-pass");
  await page.fill("#np2", "alex-own-pass");
  await page.click("#newpw button[type=submit]");

  // Staff: no admin link, no manager sections, and the server refuses manager changes.
  await page.locator("#avatarBtn", { hasText: "AB" }).waitFor();
  assert.deepEqual(await accountMenu(page), ["Switch person", "Set a quick PIN", "Change password", "Sign out"]);
  await page.locator("#tabbar .tab", { hasText: "Records" }).click();
  assert.deepEqual(await page.locator("#recordsHub .lrow b").allTextContents(), ["Extra checks", "Cleaning", "Prove it", "Allergens", "Temperature log", "4-weekly review", "Deliveries", "Maintenance", "Staff training"]);

  // Staff check a delivery: a supplier from the Roastery's list, cream too warm, so it's rejected with a reason.
  const alexCookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  await openSection(page, "deliveries");
  await page.locator("#dvSup button", { hasText: "Northern Dairy" }).click();
  await page.fill("#dvItems", "Milk ×20, cream");
  await page.fill("#dv_chilled", "11");
  await page.locator("#dv_chilled_st", { hasText: "too warm, reject" }).waitFor();
  // Phone number pads have no minus: the − key in front of the box adds it (and takes it off again).
  await page.fill("#dv_frozen", "19");
  await page.locator(".signin:has(#dv_frozen) .minus").click();
  assert.equal(await page.inputValue("#dv_frozen"), "-19");
  await page.locator("#dv_frozen_st", { hasText: "good" }).waitFor();
  await page.locator(".signin:has(#dv_frozen) .minus").click();
  assert.equal(await page.inputValue("#dv_frozen"), "19");
  await page.fill("#dv_frozen", "");
  await page.locator(".signin:has(#dv_frozen) .minus").click();
  await page.keyboard.type("18.5");
  assert.equal(await page.inputValue("#dv_frozen"), "-18.5", "− first, then the number");
  await page.fill("#dv_frozen", "");
  await page.locator("#dvPack button", { hasText: "No" }).click();
  await page.locator("#dvOrder button", { hasText: "Yes" }).click();
  await page.locator("#dvResult", { hasText: "chilled food too warm" }).waitFor();
  await page.click("#dvAccept");
  await page.locator("#dvMsg", { hasText: "Something failed" }).waitFor();
  await page.click("#dvReject");
  await page.locator("#dvMsg", { hasText: "Write why it was rejected" }).waitFor();
  await page.fill("#dvNote", "Cream at 11°C, sent back with the driver.");
  await page.click("#dvReject");
  await page.locator("#dvList .xrow", { hasText: "Northern Dairy" }).locator(".pill.bad", { hasText: "Rejected" }).waitFor();
  const dv = (await api("query", { path: "deliveries" })).docs[0].data;
  assert.equal(dv.outcome, "rejected");
  assert.equal(dv.chilled, 11);
  assert.equal(dv.packaging, "ok", "No to \"Any damage to packaging?\" means no damage");
  assert.equal(dv.date, await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }), "today's date added");
  assert.equal(dv.by, "web:Alex Brown");
  assert.ok(dv.supplierId, "linked to the supplier");
  // A typed supplier with no chilled or frozen food, accepted.
  await page.locator("#dvSup button", { hasText: "Other supplier" }).click();
  await page.fill("#dvOther", "Local bakery");
  await page.locator('label[for="dvNoTemp"]').click();
  await page.locator("#dvPack button", { hasText: "No" }).click();
  await page.locator("#dvOrder button", { hasText: "Yes" }).click();
  await page.click("#dvAccept");
  await page.locator("#dvList .xrow", { hasText: "Local bakery" }).locator(".pill.ok", { hasText: "Accepted" }).waitFor();

  // Staff report a maintenance job here; All sites shows it with the Cafe's job.
  await fetch(`${srv.base}/api/db/set`, { method: "POST", headers: { "content-type": "application/json", cookie: alexCookie },
    body: JSON.stringify({ path: "sites/cafe/maintenance/cm1", data: { title: "Dishwasher not draining", area: "Dishwasher", priority: "urgent", status: "open", reportedBy: "web:Sam Patel", reportedAt: Date.now(), at: Date.now(), log: [] } }) });
  await openSection(page, "maintenance");
  await page.click("#addBtn");
  await page.fill("#mTitle", "Grinder burrs need replacing");
  await page.fill("#mArea", "Grinder");
  await page.locator("#mPri button", { hasText: "When possible" }).click();
  await page.locator("#mWho button", { hasText: "Sam Patel" }).click();
  await page.click("#mSave");
  await page.locator("#mList .xrow", { hasText: "Grinder burrs" }).waitFor();
  assert.match(await page.locator("#mList .xrow", { hasText: "Grinder burrs" }).innerText(), /→ Sam Patel/, "shows who it's assigned to");
  const grinder = page.locator("#mList .xrow", { hasText: "Grinder burrs" });
  await grinder.locator(".xmain").click();
  await grinder.locator(".btn", { hasText: "Assign to me" }).click();
  await assert.doesNotReject(waitFor(async () => (await api("query", { path: "maintenance" })).docs.some((d) => d.data.title === "Grinder burrs need replacing" && d.data.assignee === "web:Alex Brown")),
    "reassigned with one tap");
  await page.locator("#mList .xrow", { hasText: "Grinder burrs" }).locator(".xmain").click();
  assert.equal(await page.locator("#mList .xrow", { hasText: "Dishwasher" }).count(), 0, "this site only");
  await page.locator("#mScope button", { hasText: "All sites" }).click();
  await page.locator("#mList .xrow", { hasText: "Dishwasher not draining" }).locator(".pill.bad", { hasText: "Urgent" }).waitFor();
  assert.match(await page.locator("#mList .xrow", { hasText: "Dishwasher" }).innerText(), /Cafe/);
  // Mark the Cafe's job done from the all-sites list.
  const dish = page.locator("#mList .xrow", { hasText: "Dishwasher" });
  await dish.locator(".xmain").click();
  await dish.locator("input[type=text]").fill("Cleared the filter");
  // Team/name/live updates may redraw this list between typing and pressing Done.
  await page.evaluate(() => renderMaint());
  assert.equal(await dish.locator("input[type=text]").inputValue(), "Cleared the filter", "a live redraw keeps the unsaved completion note");
  await dish.locator(".btn", { hasText: "Mark as done" }).click();
  await assert.doesNotReject(waitFor(async () => (await api("get", { path: "sites/cafe/maintenance/cm1" })).data.status === "done"), "done at the Cafe");
  const cm = (await api("get", { path: "sites/cafe/maintenance/cm1" })).data;
  assert.equal(cm.fixNote, "Cleared the filter");
  assert.equal(cm.doneBy, "web:Alex Brown");
  await page.locator("#mScope button", { hasText: "This site" }).click();

  // EHO inspection mode (open to staff): a period, the records in one view, and a PDF.
  await page.locator("#tabbar .tab", { hasText: "More" }).click();
  await page.locator("#moreHub .lrow", { hasText: "EHO inspection mode" }).click();
  await page.locator("#inChips button", { hasText: "Last 3 months" }).click();
  await page.locator("#in-daily table").waitFor();
  const todayLong = await page.evaluate(() => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }));
  assert.match(await page.locator("#in-daily").innerText(), new RegExp(todayLong));
  assert.match(await page.locator("#in-actions").innerText(), /Northern Dairy: chilled 11°C/, "rejected delivery listed as a corrective action");
  assert.match(await page.locator("#in-deliveries").innerText(), /Rejected/);
  assert.match(await page.locator("#in-maintenance").innerText(), /Grinder burrs/);
  assert.match(await page.locator("#in-summary").innerText(), /days fully recorded/);
  // A record made while it's open (here, on another device) shows without leaving the page.
  const now = Date.now(), todayIso = await page.evaluate(() => today());
  await api("set", { path: "deliveries/live1", data: { date: todayIso, at: now, supplier: "Fenland Eggs", items: "Eggs x 30", chilled: 4, frozen: null, noTemp: false,
    packaging: "ok", order: "ok", outcome: "rejected", note: "Two trays cracked", by: "web:Sam Patel" } });
  await page.locator("#in-deliveries", { hasText: "Fenland Eggs" }).waitFor({ timeout: 15000 });
  await page.locator("#inJump .fchip", { hasText: "Temperature log" }).click();
  await page.locator("#inChips button", { hasText: "Choose dates" }).click();
  await page.fill("#inFrom", "2026-10-01"); await page.locator("#inFrom").dispatchEvent("change");
  await page.fill("#inTo", "2026-10-01"); await page.locator("#inTo").dispatchEvent("change");
  await page.locator("#inSub", { hasText: "1 Oct 2026 to 1 Oct 2026" }).waitFor();
  await page.locator("#in-daily table").waitFor();
  assert.match(await page.locator("#in-daily").innerText(), /1 Oct 2026/);
  const [inDl] = await Promise.all([page.waitForEvent("download"), page.click("#inPdf")]);
  assert.match(inDl.suggestedFilename(), /^EHO inspection records - Strangers Roastery - 2026-10-01 to 2026-10-01\.pdf$/);
  const inPdf = (await fs.readFile(await inDl.path())).toString("latin1");
  assert.ok(inPdf.startsWith("%PDF-1.4"));
  for (const t of ["Food safety records", "Daily diary", "Corrective actions", "Your training", "Allergen matrix"])
    assert.ok(inPdf.includes(Buffer.from(t, "latin1").toString("hex")), "PDF has " + t);
  await page.locator("#tabbar .tab", { hasText: "More" }).click();
  assert.deepEqual(await page.locator("#moreHub .lrow b").allTextContents(), ["Last 4 weeks", "EHO inspection mode", "Fire safety log", "Accident book", "Last EHO inspection report", "HACCP & risk", "Suppliers", "Contacts", "Onboarding", "Rota", "Report sickness", "Switch person", "Set a quick PIN", "Change password", "Sign out"]);
  assert.equal(await page.locator("#moreHub .label", { hasText: "Admin" }).count(), 0, "staff don't see Setup");
  assert.match(await page.locator("#moreHub .lrow", { hasText: "Report sickness" }).getAttribute("href"), /#sick$/, "More links to the rota's sickness form");
  // Staff can open the management sections to read them, but there's nothing to change.
  await page.locator("#moreHub .lrow", { hasText: "Suppliers" }).click();
  await page.locator("#sList").getByText("Northern Dairy").first().waitFor();
  assert.equal(await page.locator("#addBtn").isHidden(), true, "no Add for staff");
  await page.locator("#sList .xrow", { hasText: "Northern Dairy" }).locator(".xmain").click();
  assert.equal(await page.locator("#sList .btn", { hasText: "Edit supplier" }).count(), 0, "no Edit for staff");
  await openSection(page, "plans");
  await page.locator("#plList .lrow").first().click();
  await page.locator("#planEditView .riskkey, #planEditView .doc-table").first().waitFor();
  assert.equal(await page.locator("#plSaveBtn").count(), 0, "plans are read-only for staff");
  assert.equal(await page.locator("#planEditView textarea:not([disabled])").count(), 0);
  await page.locator("#plBack").click();
  await openSection(page, "staff");
  assert.equal(await page.locator("#tTopicsPanel").isHidden(), true);
  assert.equal(await page.locator("#tImport").isHidden(), true);
  // Staff training is a record staff fill in and sign themselves, choosing the sites they work at.
  assert.equal(await page.locator("#tList .xrow", { hasText: "Jo Smith" }).count(), 0, "another employee's private training is absent, including read-only details");
  await page.locator("#tMine").waitFor();
  await page.click("#tMineGo");
  assert.equal(await page.inputValue("#tName"), "Alex Brown");
  assert.equal(await page.locator("#tName").getAttribute("readonly"), "", "name is locked to their own");
  assert.equal(await page.locator("#tDelete").isHidden(), true);
  await page.fill("#tAllDate", "2026-10-22");
  await page.click("#tAllApply");
  await page.locator("#tSites label", { hasText: "Cafe" }).click();
  await page.click("#tSave");
  assert.match(await page.locator("#tMsg").innerText(), /sign your training record/);
  await page.locator("#tSignBox label").click();
  await page.click("#tSave");
  await page.locator("#tList .xrow", { hasText: "Alex Brown" }).locator(".s", { hasText: /· Signed$/ }).waitFor();
  const alex = (await api("query", { path: "staff" })).docs.find((d) => d.data.name === "Alex Brown").data;
  assert.equal(alex.signed.by, "web:Alex Brown");
  assert.deepEqual(alex.sites.sort(), ["cafe", "roastery"]);
  assert.ok(Object.values(alex.topics).every((t) => t.date === "2026-10-22"));
  assert.ok((await api("query", { path: "sites/cafe/staff" })).docs.some((d) => d.data.name === "Alex Brown" && d.data.signed), "saved to the Cafe too");
  assert.equal(await page.locator("#tMine").isHidden(), true, "prompt gone once signed");
  // The 4-weekly review is a record staff fill in: overdue here (the diary started 1 Sep), so Today reminds them.
  await openSection(page, "day");
  const revAlert = page.locator("#dayAlerts .alert", { hasText: "4-weekly review overdue" });
  await revAlert.waitFor();
  await revAlert.locator(".btn", { hasText: "Do it now" }).click();
  await page.locator('[data-panel="review"]').waitFor();
  assert.equal(await page.locator("#pageTitle").innerText(), "4-weekly review");
  for (const seg of await page.locator("#revQs .seg").all()) await seg.locator("button", { hasText: "No" }).click();
  await page.fill("#revNotes", "Nothing changed this period.");
  await page.click("#revSave");
  await assert.doesNotReject(waitFor(async () => (await api("query", { path: "reviews" })).docs.some((d) => d.data.by === "web:Alex Brown")), "staff signed the review");
  await openSection(page, "day");
  await page.locator("#dayAlerts").waitFor({ state: "attached" });
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#dayAlerts .alert", { hasText: "4-weekly review overdue" }).count(), 0, "reminder gone once signed");
  const refused = await fetch(`${srv.base}/api/db/set`, { method: "POST", headers: { "content-type": "application/json", cookie: (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
    body: JSON.stringify({ path: "suppliers/x", data: { name: "X" } }) });
  assert.equal((await refused.json()).code, "permission_denied");
  await page.goto(srv.base + "/admin");
  await page.waitForURL(srv.base + "/");
  await page.goto(srv.base + "/#setup");
  await page.locator("#openList").waitFor();
  assert.equal(await page.locator('[data-panel="day"]').isVisible(), true, "a manager section sends staff back to Today");
  assert.equal(await page.locator('[data-panel="setup"]').isVisible(), false);

  // Signing out leaves a plain sign-in form; the new password works.
  await accountMenu(page, "Sign out");
  await page.waitForURL(/\/signin(?:\?[^#]*)?$/);
  assert.equal(await page.inputValue("#username"), "");
  await page.fill("#username", "alex.brown");
  await page.fill("#password", "alex-own-pass");
  await page.click("#signin button[type=submit]");
  await page.locator("#avatarBtn", { hasText: "AB" }).waitFor();

  // Bad Wi-Fi: a tick made offline shows straight away, waits on the device, and saves once back online.
  const t1 = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  await page.locator("#weekCtl, #dayCtl").first().waitFor({ state: "attached" });
  await ctx.setOffline(true);
  await page.locator("#openList label", { hasText: "Hands washed" }).click();
  await page.locator("#conn", { hasText: "Offline · 1 change waiting" }).waitFor();
  assert.equal(await page.locator("#openList label", { hasText: "Hands washed" }).locator("input").isChecked(), true, "the tick shows while offline");
  await ctx.setOffline(false);
  await page.waitForFunction(() => document.querySelector("#conn").hidden, null, { timeout: 15000 });
  await page.locator("#toast", { hasText: "Back online" }).waitFor();
  const saved = await api("get", { path: `days/${t1}` });
  assert.equal(saved.data.opening.items.o1, true);
  assert.equal(saved.data.opening.by, "web:Alex Brown");

  // A busy server when the change is sent (429): it stays on the device and goes once the server answers,
  // rather than being dropped while the page says everything saved.
  await ctx.setOffline(true);
  await page.locator("#openList label", { hasText: "Surfaces sanitised" }).click();
  await page.locator("#conn", { hasText: "1 change waiting" }).waitFor();
  let busy = 2;
  await page.route(/\/api\/db\/(set|update)$/, (r) => (busy-- > 0 ? r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ code: "rate_limited", message: "Slow down" }) }) : r.continue()));
  await ctx.setOffline(false);
  // (Before the fix, the first 429 dropped the change for good and the page said "All changes saved".)
  await page.waitForFunction(() => document.querySelector("#conn").hidden, null, { timeout: 30000 });
  await page.unroute(/\/api\/db\/(set|update)$/);
  assert.equal((await api("get", { path: `days/${t1}` })).data.opening.items.o2, true, "saved once the server answered");

  // Quick switching: Alex sets a 4-digit PIN, signs out, then signs back in from the list with the PIN.
  await accountMenu(page, "Set a quick PIN");
  for (const pin of ["4826", "4826"]) {
    await page.locator(".pp-sheet").waitFor();
    for (const d of pin) await page.locator(".pp-key", { hasText: d }).first().click();
    await page.waitForTimeout(400);
  }
  await page.locator("#toast", { hasText: "Quick PIN set" }).waitFor();
  assert.ok((await accountMenu(page)).includes("Switch person"), "this device can switch person");
  await accountMenu(page, "Sign out");
  await page.waitForURL(/\/signin(?:\?[^#]*)?$/);
  await page.locator("#quick .person", { hasText: "Alex Brown" }).click();
  for (const d of "1357") await page.locator(".pp-key", { hasText: d }).first().click();
  await page.locator(".pp-msg", { hasText: "Wrong PIN" }).waitFor();
  for (const d of "4826") await page.locator(".pp-key", { hasText: d }).first().click();
  await page.waitForURL(srv.base + "/");
  await page.locator("#avatarBtn", { hasText: "AB" }).waitFor();

  assert.deepEqual(errors, []);
  await ctx.close();
});

// Opens a section the way staff do on a phone: Today and Week are tabs; everything else is listed
// under Records or More.
async function openSection(page, tab) {
  const tabs = { day: "Today", week: "Week" };
  if (tabs[tab]) return page.locator("#tabbar .tab", { hasText: tabs[tab] }).click();
  const name = { history: "Last 4 weeks", extras: "Extra checks", cleaning: "Cleaning", prove: "Prove it", templog: "Temperature log", allergens: "Allergens", deliveries: "Deliveries", maintenance: "Maintenance", eho: "Last EHO inspection report",
    plans: "HACCP & risk", suppliers: "Suppliers", contacts: "Contacts", staff: "Staff training", onboarding: "Onboarding", review: "4-weekly review", setup: "Setup" }[tab];
  for (const hub of ["Records", "More"]) {
    await page.locator("#tabbar .tab", { hasText: hub }).click();
    const row = page.locator(`#${hub === "Records" ? "recordsHub" : "moreHub"} .lrow`, { hasText: name });
    if (await row.count()) { await row.first().click(); return page.locator("#pageTitle", { hasText: name }).waitFor(); }
  }
  throw new Error(`No list entry for ${tab}`);
}

async function switchSite(page, name) {
  await page.locator("[data-sitebtn]:visible").click();
  await page.locator("#siteList .lrow", { hasText: name }).click();
  await page.locator("[data-sitebtn]:visible", { hasText: name }).waitFor();
}

// With an item, picks it from the account menu; without, returns the menu's items and closes it.
async function accountMenu(page, item) {
  await page.click("#avatarBtn");
  if (item) return page.locator("#acctMenu .m", { hasText: item }).click();
  const items = await page.locator("#acctMenu .m").allTextContents();
  await page.keyboard.press("Escape");
  return items.map((t) => t.trim());
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}
