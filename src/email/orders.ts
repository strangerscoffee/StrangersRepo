// An email to Strangers (sales@strangerscoffee.com unless Admin changes it) for every new customer wholesale order,
// sent from orders@staffstrangerscoffee.com (the domain the rota's emails already use with Resend) after the order
// is saved, so it never slows or blocks checkout. Staff previews, retries of an order already placed and orders
// with no RESEND_API_KEY send nothing. Failures go in audit_log as email_failed, like the rota's.
import { audit } from "../audit";
import { ApiError, Env, invalid, json, readJson } from "../http";
import { object } from "../wholesaleStore";
import { cleanEmail, emailReady, send } from "./send";
import { esc } from "./templates";

export const DEFAULT_ORDER_EMAIL = "sales@strangerscoffee.com";
const FROM = (env: Env) => env.ORDER_EMAIL_FROM || "Strangers Coffee Orders <orders@staffstrangerscoffee.com>";
const MAX_RECIPIENTS = 5;

export interface OrderEmailSettings { enabled: boolean; to: string[] }
interface Line { title: string; pack: string; packLabel?: string; grindLabel?: string; grindHint?: string; quantity: number; grams: number; pence?: number; decaf?: boolean }
interface MailOrder {
  id: string; business?: string; createdAt: number; delivery: string; reference?: string; customerNote?: string;
  pence: number; deliveryPence?: number; totalPence?: number; grams: number; lines: Line[];
  customerSnapshot?: { name?: string; contact?: string; email?: string; phone?: string; address?: string; postcode?: string; deliveryNotes?: string } | null;
  locationSnapshot?: { name?: string; contact?: string; phone?: string; address?: string; postcode?: string; deliveryNotes?: string } | null;
}

export async function orderEmailSettings(env: Env): Promise<OrderEmailSettings & { version: number; updatedAt: number | null; sending: boolean; from: string }> {
  const row = await env.DB.prepare("SELECT data, version, updated_at FROM wholesale_order_emails WHERE id = 1").first<{ data: string; version: number; updated_at: number }>();
  let saved: Partial<OrderEmailSettings> = {};
  try { saved = row ? JSON.parse(row.data) : {}; } catch {}
  return {
    enabled: saved.enabled !== false, to: Array.isArray(saved.to) && saved.to.length ? saved.to : [DEFAULT_ORDER_EMAIL],
    version: row?.version || 0, updatedAt: row?.updated_at || null, sending: emailReady(env), from: FROM(env).replace(/^.*<|>$/g, ""),
  };
}

const money = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const kg = (grams: number) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(grams / 1000)} kg`;
const packName: Record<string, string> = { quarter: "250 g", kilo: "1 kg", half: "500 g" };
const when = (at: number) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(at));

export function buildOrderEmail(order: MailOrder, orderUrl: string) {
  const place = order.locationSnapshot || order.customerSnapshot || {};
  const customer = order.customerSnapshot || {};
  const bags = { quarter: 0, kilo: 0, all: 0 };
  for (const line of order.lines) { if (line.pack === "quarter" || line.pack === "kilo") bags[line.pack] += line.quantity; bags.all += line.quantity; }
  const total = order.totalPence ?? order.pence + (order.deliveryPence || 0);
  const business = order.business || "A customer";
  const where = order.delivery === "Delivery" ? [place.name && place.name !== "Main location" ? place.name : "", place.address, place.postcode].filter(Boolean).join(", ") || "No address saved" : "Roastery collection";
  const contact = [place.contact || customer.contact, place.phone || customer.phone, customer.email].filter(Boolean).join(" · ");
  const subject = `New wholesale order: ${business} · ${bags.all} ${bags.all === 1 ? "bag" : "bags"} · ${money(total)}`;
  const lineText = (l: Line) => `${l.quantity} × ${l.title}, ${packName[l.pack] || l.packLabel || l.pack}, ${l.grindLabel || ""}${l.grindHint ? ` (${l.grindHint})` : ""}${l.decaf ? ", decaf" : ""}`;
  const text = [
    `New wholesale order from ${business}`, `${order.id} · ${when(order.createdAt)}`, "",
    ...order.lines.map(lineText), "",
    `${bags.quarter} × 250 g · ${bags.kilo} × 1 kg · ${bags.all} bags · ${kg(order.grams)}`,
    `Coffee ${money(order.pence)} · Delivery ${order.deliveryPence ? money(order.deliveryPence) : "free"} · Total ${money(total)}`, "",
    `${order.delivery === "Delivery" ? "Deliver to" : "Collection"}: ${where}`, ...(place.deliveryNotes ? [`Delivery notes: ${place.deliveryNotes}`] : []),
    ...(contact ? [`Contact: ${contact}`] : []), ...(order.reference ? [`Reference: ${order.reference}`] : []),
    ...(order.customerNote ? ["", "Customer comments:", order.customerNote] : []), "", `Open the order: ${orderUrl}`,
  ].join("\n");
  const cell = "padding:8px 10px;border-bottom:1px solid #e3e6eb;text-align:left;vertical-align:top;font-size:14px;";
  const kv = (label: string, value: string) => `<tr><td style="padding:3px 12px 3px 0;color:#5d6675;font-size:14px;white-space:nowrap;vertical-align:top;">${esc(label)}</td><td style="padding:3px 0;font-size:14px;white-space:pre-line;">${esc(value)}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14181f;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:20px 0;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:14px;border:1px solid #e3e6eb;">
<tr><td style="padding:22px 24px 6px;"><div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5d6675;">New wholesale order</div>
<h1 style="margin:4px 0 2px;font-size:22px;line-height:1.25;">${esc(business)}</h1><div style="font-size:13px;color:#5d6675;">${esc(order.id)} · ${esc(when(order.createdAt))}</div></td></tr>
<tr><td style="padding:14px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
<tr><th style="${cell}color:#5d6675;font-size:12px;">Bags</th><th style="${cell}color:#5d6675;font-size:12px;">Coffee</th><th style="${cell}color:#5d6675;font-size:12px;">Size</th><th style="${cell}color:#5d6675;font-size:12px;">Grind</th></tr>
${order.lines.map((l) => `<tr><td style="${cell}font-weight:700;">${l.quantity}</td><td style="${cell}">${esc(l.title)}${l.decaf ? " <span style=\"font-size:11px;border:1px solid #c9ccd2;border-radius:5px;padding:0 4px;\">Decaf</span>" : ""}</td><td style="${cell}white-space:nowrap;">${esc(packName[l.pack] || l.packLabel || l.pack)}</td><td style="${cell}">${esc(l.grindLabel || "")}${l.grindHint ? `<div style="font-size:12px;color:#5d6675;">${esc(l.grindHint)}</div>` : ""}</td></tr>`).join("")}
</table></td></tr>
<tr><td style="padding:12px 24px 0;font-size:14px;"><b>${bags.quarter}</b> × 250 g · <b>${bags.kilo}</b> × 1 kg · <b>${bags.all} bags</b> · ${esc(kg(order.grams))}<br>Coffee ${esc(money(order.pence))} · Delivery ${esc(order.deliveryPence ? money(order.deliveryPence) : "free")} · <b>Total ${esc(money(total))}</b></td></tr>
<tr><td style="padding:14px 24px 0;"><table role="presentation" cellpadding="0" cellspacing="0">
${kv(order.delivery === "Delivery" ? "Deliver to" : "Collection", where)}${place.deliveryNotes ? kv("Delivery notes", place.deliveryNotes) : ""}${contact ? kv("Contact", contact) : ""}${order.reference ? kv("Reference", order.reference) : ""}
</table></td></tr>
${order.customerNote ? `<tr><td style="padding:14px 24px 0;"><div style="border:1px solid #14181f;border-radius:10px;padding:10px 12px;"><div style="font-size:12px;font-weight:700;color:#5d6675;text-transform:uppercase;letter-spacing:.05em;">Customer comments</div><div style="font-size:14px;white-space:pre-line;margin-top:3px;">${esc(order.customerNote)}</div></div></td></tr>` : ""}
<tr><td style="padding:18px 24px 22px;"><a href="${esc(orderUrl)}" style="display:inline-block;background:#0062cc;color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:10px;">Open the order</a></td></tr>
</table><div style="font-size:12px;color:#5d6675;padding:12px;">Sent by the Strangers staff site for each new wholesale order. Change who gets these in Admin → Wholesale → Orders → Order emails.</div></td></tr></table></body></html>`;
  return { subject, html, text, replyTo: customer.email || undefined };
}

/** The staff Wholesale orders page (diary host, /orders), opened on this order. */
const ordersPageUrl = (diaryBase: string, id?: string) => `${diaryBase.replace(/\/$/, "")}/orders${id ? `#${encodeURIComponent(id)}` : ""}`;

/** Emails the new order to Strangers in the background of the checkout request. Never throws. */
export async function notifyNewOrder(env: Env, ctx: ExecutionContext | undefined, order: MailOrder, diaryBase: string) {
  if (!emailReady(env)) return;
  const run = (async () => {
    try {
      const settings = await orderEmailSettings(env);
      if (!settings.enabled) return;
      const mail = buildOrderEmail(order, ordersPageUrl(diaryBase, order.id));
      for (const to of settings.to) await send(env, { to: { id: "orders", name: to, email: to, email_prefs: "{}", active: 1 }, kind: "order", mail, about: `new wholesale order ${order.id} (${order.business || "customer"})`, from: FROM(env), replyTo: mail.replyTo });
    } catch (error) {
      await audit(env, "email_failed", null, `Couldn't email new wholesale order ${order.id}: ${String((error as Error)?.message || error).slice(0, 160)}`).catch(() => {});
    }
  })();
  if (ctx) ctx.waitUntil(run); else await run;
}

/** Admin: GET/PUT order-emails ({ifVersion, enabled, to}) and POST order-emails/test. */
export async function handleOrderEmailsAdmin(req: Request, env: Env, route: string, actor: string, diaryBase: string): Promise<Response | null> {
  if (route === "order-emails" && req.method === "GET") return json(await orderEmailSettings(env));
  if (route === "order-emails" && req.method === "PUT") {
    const body = object(await readJson(req, 4096));
    const expected = body.ifVersion;
    if (!Number.isSafeInteger(expected) || expected < 0) throw invalid("Reload and try again.");
    if (typeof body.enabled !== "boolean") throw invalid("Choose whether to email new orders.");
    if (!Array.isArray(body.to) || body.to.length > MAX_RECIPIENTS) throw invalid(`Add up to ${MAX_RECIPIENTS} email addresses.`);
    const to = [...new Set(body.to.map((value: unknown) => cleanEmail(value)))];
    if (to.some((value) => !value)) throw invalid("Check the email addresses: one isn't valid.");
    if (body.enabled && !to.length) throw invalid("Add an email address, or switch order emails off.");
    const data = JSON.stringify({ enabled: body.enabled, to }), at = Date.now();
    const result = expected === 0
      ? await env.DB.prepare("INSERT INTO wholesale_order_emails(id,data,version,updated_at) SELECT 1,?,1,? WHERE NOT EXISTS(SELECT 1 FROM wholesale_order_emails WHERE id=1)").bind(data, at).run()
      : await env.DB.prepare("UPDATE wholesale_order_emails SET data=?,version=version+1,updated_at=? WHERE id=1 AND version=?").bind(data, at, expected).run();
    if (!result.meta.changes) throw new ApiError(409, "conflict", "Order emails were changed on another device. Reload and try again.");
    await audit(env, "wholesale_order_emails", actor, `${actor} ${body.enabled ? `set new-order emails to ${(to as string[]).join(", ")}` : "switched new-order emails off"}.`);
    return json(await orderEmailSettings(env));
  }
  if (route === "order-emails/test" && req.method === "POST") {
    if (!emailReady(env)) throw new ApiError(409, "email_off", "Email isn't set up on this site (no RESEND_API_KEY).");
    const settings = await orderEmailSettings(env);
    const sample: MailOrder = { id: "WS-TEST", business: "Test order (no action needed)", createdAt: Date.now(), delivery: "Roastery collection", pence: 1800, deliveryPence: 0, totalPence: 1800, grams: 1000, customerNote: "This is a test of the new-order email.", lines: [{ title: "Brazil Fazenda Bom Jesus Natural", pack: "kilo", grindLabel: "Beans", quantity: 1, grams: 1000 }], customerSnapshot: null };
    const mail = buildOrderEmail(sample, ordersPageUrl(diaryBase));
    mail.subject = `Test: ${mail.subject}`;
    const results = [];
    for (const to of settings.to) results.push(await send(env, { to: { id: "orders", name: to, email: to, email_prefs: "{}", active: 1 }, kind: "test", mail, about: "test new-order email", from: FROM(env) }));
    if (results.some((r) => r !== "sent")) throw new ApiError(502, "email_failed", "The test email couldn't be sent. Admin → Activity has the reason.");
    return json({ sent: settings.to });
  }
  return null;
}
