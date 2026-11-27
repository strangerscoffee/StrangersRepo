import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const { outputFiles } = await build({
  stdin: { resolveDir: root, contents: `
    import { ensureSchema } from "./src/schema";
    import { staffLabelEligibility, staffLabelEligibilityGuard } from "./src/wholesale/staffLabelEligibility";
    export default { async fetch(req, env) {
      await ensureSchema(env);
      const order = await req.json();
      if (req.method === "PUT") {
        const guard = staffLabelEligibilityGuard(order);
        const result = await env.DB.prepare("UPDATE wholesale_preview SET version=version+1 WHERE kind='order' AND id=?" + guard.sql)
          .bind(order.id, ...guard.args).run();
        return Response.json({ claimed: result.meta.changes > 0 });
      }
      return Response.json(await staffLabelEligibility(env, order));
    }};
  ` },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
});

test("staff label finance policy uses the saved order, current account and authoritative evidence", async t => {
  const worker = new Miniflare({ host: "127.0.0.1", port: 0, telemetry: { enabled: false }, cf: false, workers: [{ config: {
    name: "label-eligibility",
    compatibilityDate: "2026-10-01",
    manifest: { modulesRoot: root, mainModule: "index.js", modules: {
      "index.js": { type: "esm", contents: outputFiles[0].text },
    } },
    env: { DB: { type: "d1", name: "label-eligibility-test" } },
  } }] });
  t.after(() => worker.dispose());
  const account = "customer-1";
  const orderId = "WS-111";
  const order = { id: orderId, customerId: account };
  const call = async (data = order, method = "POST") => {
    const response = await worker.dispatchFetch("http://example.test/eligibility", { method, body: JSON.stringify(data) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const outcome = async (code, data) => {
    const result = await call(data);
    if (code) {
      assert.deepEqual(Object.keys(result).sort(), ["code", "eligible", "message"]);
      assert.equal(result.eligible, false);
      assert.equal(result.code, code);
      assert.doesNotMatch(result.message, /WS-|customer-1|invoice-1|9876/);
    } else {
      assert.deepEqual(result, { eligible: true });
    }
    assert.deepEqual(await call(data ?? order, "PUT"), { claimed: !code });
  };

  await outcome("royal_mail_payment_review");
  const db = await worker.getD1Database("DB");
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  const customer = (id, status = "Active", extra = {}) => run(
    "INSERT INTO wholesale_preview(kind,id,data,updated_at) VALUES('customer',?,?,0) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
    id, JSON.stringify({ status, business: "Same display name", ...extra }));
  const terms = (id, historical = false) => run(
    "INSERT INTO wholesale_preview(kind,id,data,updated_at) VALUES('order',?,?,0) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
    orderId, JSON.stringify({ customerId: account, ...(id && (historical ? { customerSnapshot: { paymentTerms: { id } } } : { paymentTerms: { id } })) }));
  const invoice = async (number, ids, { due = "2099-01-01", paid = 0, total = 9876, owner = account } = {}) => {
    const row = await db.prepare(`INSERT INTO wholesale_invoices(invoice_number,order_id,customer_id,request_key,data,issued_at,issued_by,paid)
      VALUES(?,?,?,?,?,0,'admin-fixture',?) RETURNING seq`).bind("invoice-" + number, "TAB-" + number, owner, "request-" + number,
        JSON.stringify({ orderIds: ids, dueDate: due, totals: { grossPence: total } }), paid).first();
    return row.seq;
  };
  await customer(account, "Active", { paymentTerms: "net-30" });
  await customer("unrelated");
  await terms("net-30", true);
  await invoice(0, ["WS-000"], { due: "2000-01-01", owner: "unrelated" });
  await outcome(null);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const dueToday = await invoice(4, ["WS-555"], { due: today });
  await outcome(null);
  await run("UPDATE wholesale_invoices SET data=json_set(data,'$.dueDate','2099-02-30') WHERE seq=?", dueToday);
  await outcome("royal_mail_payment_review");
  await run("UPDATE wholesale_invoices SET paid=1 WHERE seq=?", dueToday);
  await outcome("royal_mail_payment_review", { ...order, customerId: "unrelated" });
  await customer(account, "On hold");
  await outcome("royal_mail_account_on_hold");
  await customer(account);
  const historical = await invoice(1, ["WS-222"], { due: "2000-01-01" });
  await outcome("royal_mail_account_overdue");
  await run("UPDATE wholesale_invoices SET paid=1 WHERE seq=?", historical);
  await terms("before-dispatch");
  await outcome("royal_mail_payment_required");
  for (const flag of ["noInvoice", "hidePrices"]) {
    await customer(account, "Active", { [flag]: true });
    await terms("before-dispatch");
    await outcome("royal_mail_payment_required");
    for (const term of ["custom", "to-agree", null]) {
      await terms(term);
      await outcome("royal_mail_payment_review");
    }
    await terms("net-30");
    await outcome(null);
  }
  await customer(account, "Active", { paymentTerms: "net-30" });
  await terms(null);
  await outcome("royal_mail_payment_review");
  await terms("before-dispatch");
  const current = await invoice(2, [orderId, "WS-333"]);
  await outcome("royal_mail_payment_required");
  await run("UPDATE wholesale_invoices SET paid=1 WHERE seq=?", current);
  await outcome(null);

  const exportInvoice = async (invoiceId, environment, state = "linked") => {
    const row = await db.prepare(`INSERT INTO quickbooks_exports(environment,realm_id,company_name,company_vat,invoice_id,request_id,fingerprint,
      payload,payload_hash,source_hash,created_by,preview,profiles,connection_generation,mapping_version,created_at,updated_at,state,remote_id)
      VALUES(?,'realm-1','','',?,'request-1','','','','','','','','generation-1','',0,0,?,'remote-1') RETURNING id`)
      .bind(environment, invoiceId, state).first();
    return row.id;
  };
  const liveCompany = state => run("UPDATE quickbooks_connections SET status=?,realm_id='realm-1' WHERE environment='production'", state);
  const now = Date.now();
  const observe = (id, status, outstanding, due, read = now, voided = 0) => run(
    "INSERT OR REPLACE INTO quickbooks_observations(export_id,status,outstanding_pence,due_date,read_started_at,observed_at,payment_voided) VALUES(?,?,?,?,?,?,?)",
    id, status, outstanding, due, read, read, voided);
  const sandbox = await exportInvoice(current, "sandbox");
  await observe(sandbox, "review", null, null);
  await outcome(null);
  const live = await exportInvoice(current, "production", "uncertain");
  await outcome("royal_mail_payment_review");
  await run("UPDATE quickbooks_exports SET state='linked' WHERE id=?", live);
  await liveCompany("connected");
  await outcome("royal_mail_payment_review");
  await observe(live, "part-paid", 4321, "2000-01-01");
  await outcome("royal_mail_account_overdue");
  await observe(live, "part-paid", 4321, "2099-01-01");
  await outcome("royal_mail_payment_required");
  await observe(live, "paid", 0, null, now - 25 * 60 * 60 * 1000);
  await outcome("royal_mail_payment_review");
  await observe(live, "paid", 0, null);
  await outcome(null);
  await liveCompany("disconnected");
  await outcome("royal_mail_payment_review");
  await liveCompany("connected");
  await run("UPDATE quickbooks_connections SET realm_id='realm-2' WHERE environment='production'");
  await outcome("royal_mail_payment_review");
  await liveCompany("connected");
  await run("INSERT INTO quickbooks_payment_links(export_id,payment_id) VALUES(?,'payment-1')", live);
  await run(`INSERT INTO quickbooks_events(event_key,environment,realm_id,entity,entity_id,operation,event_at,created_at)
    VALUES('payment-fixture','production','realm-1','Payment','payment-1','void',?,?)`, now + 10, now + 10);
  await outcome("royal_mail_payment_review");
  await run("UPDATE quickbooks_events SET state='done'");
  await run("INSERT INTO quickbooks_payment_voids(environment,realm_id,payment_id,confirmed_at) VALUES('production','realm-1','payment-1',?)", now + 20);
  await outcome("royal_mail_payment_review");
  await observe(live, "paid", 0, null, now + 30, 1);
  await outcome(null);
  await run(`INSERT INTO quickbooks_events(event_key,environment,realm_id,entity,entity_id,operation,event_at,created_at)
    VALUES('cdc:fixture','production','realm-1','Invoice','remote-1','refresh',?,?)`, now + 40, now + 40);
  await outcome("royal_mail_payment_review");
  for (const state of ["processing", "review", "paused"]) {
    await run("UPDATE quickbooks_events SET state=? WHERE event_key='cdc:fixture'", state);
    await outcome("royal_mail_payment_review");
  }
  await run("UPDATE quickbooks_events SET state='done'");
  await outcome(null);
  await observe(live, "voided", 0, null, now + 50);
  await outcome("royal_mail_payment_review");
  await run("DELETE FROM wholesale_invoice_coverage WHERE order_id=?", orderId);
  await terms("net-30");
  await outcome(null);

  const linkElsewhere = (id, owner = account) => run(`INSERT INTO wholesale_invoiced_elsewhere(order_id,customer_id,environment,realm_id,remote_id,doc_number,
    txn_date,total_pence,order_total_pence,actor,created_at) VALUES(?,?,'production','realm-1','external-1','','',9876,9876,'admin-fixture',0)`, id, owner);
  await linkElsewhere("WS-444", "unrelated");
  await outcome(null);
  await linkElsewhere("WS-999");
  await outcome("royal_mail_payment_review");
  await run("DELETE FROM wholesale_invoiced_elsewhere WHERE order_id='WS-999'");
  await linkElsewhere(orderId);
  await outcome("royal_mail_payment_review");
  await run("UPDATE wholesale_invoiced_elsewhere SET remote_id='remote-1' WHERE order_id=?", orderId);
  await observe(live, "paid", 0, null, now + 50, 1);
  await terms("before-dispatch");
  await outcome(null);
});
