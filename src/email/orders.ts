// An email to Strangers (sales@strangerscoffee.com unless Admin changes it) for every new customer wholesale order,
// sent from orders@staffstrangerscoffee.com (the domain the rota's emails already use with Resend) after the order
// is saved, so it never slows or blocks checkout. Staff previews, retries of an order already placed and orders
// with no RESEND_API_KEY send nothing. Failures go in audit_log as email_failed, like the rota's.
import { audit } from "../audit";
import { ApiError, Env, invalid, json, readJson } from "../http";
import { object } from "../wholesaleStore";
import { cleanEmail, emailReady, send } from "./send";
import { esc } from "./templates";
import { sendSlackTest, slackReady } from "../slackOrders";

export const DEFAULT_ORDER_EMAIL = "sales@strangerscoffee.com";
const FROM = (env: Env) => env.ORDER_EMAIL_FROM || "Strangers Coffee Orders <orders@staffstrangerscoffee.com>";
const MAX_RECIPIENTS = 5;

/** `confirmCustomers`: also email each customer a confirmation of their own order (absent = on). */
export interface OrderEmailSettings { enabled: boolean; to: string[]; confirmCustomers?: boolean }
interface Line { price?: number; title: string; pack: string; packLabel?: string; grindLabel?: string; grindHint?: string; quantity: number; grams: number; pence?: number; decaf?: boolean }
interface MailOrder {
  id: string; business?: string; createdAt: number; delivery: string; reference?: string; customerNote?: string;
  pence: number; deliveryPence?: number; totalPence?: number; grams: number; lines: Line[];
  customerSnapshot?: { name?: string; contact?: string; email?: string; phone?: string; address?: string; postcode?: string; deliveryNotes?: string } | null;
  paymentTerms?: { label?: string; note?: string } | null;
  trackingUrl?: string;
  locationSnapshot?: { name?: string; contact?: string; phone?: string; address?: string; postcode?: string; deliveryNotes?: string } | null;
}

export async function orderEmailSettings(env: Env): Promise<OrderEmailSettings & { version: number; updatedAt: number | null; sending: boolean; from: string; slack: boolean }> {
  const row = await env.DB.prepare("SELECT data, version, updated_at FROM wholesale_order_emails WHERE id = 1").first<{ data: string; version: number; updated_at: number }>();
  let saved: Partial<OrderEmailSettings> = {};
  try { saved = row ? JSON.parse(row.data) : {}; } catch {}
  return {
    enabled: saved.enabled !== false, confirmCustomers: saved.confirmCustomers !== false, to: Array.isArray(saved.to) && saved.to.length ? saved.to : [DEFAULT_ORDER_EMAIL],
    version: row?.version || 0, updatedAt: row?.updated_at || null, sending: emailReady(env), from: FROM(env).replace(/^.*<|>$/g, ""), slack: slackReady(env),
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

/** The customer's own confirmation: what they ordered, where it's going, the totals (unless Strangers hides prices
 *  from this business) and their payment terms, with a link to My orders. Replies go to Strangers' order address. */
export function buildCustomerConfirmation(order: MailOrder, { showPrices, ordersUrl }: { showPrices: boolean; ordersUrl: string }) {
  const place = order.locationSnapshot || order.customerSnapshot || {};
  const customer = order.customerSnapshot || {};
  const bags = order.lines.reduce((t, l) => t + l.quantity, 0);
  const total = order.totalPence ?? order.pence + (order.deliveryPence || 0);
  const where = order.delivery === "Delivery" ? [place.name && place.name !== "Main location" ? place.name : "", place.address, place.postcode].filter(Boolean).join(", ") || "Your saved address" : "Collection from the Strangers Roastery, 10 Dove Street, Norwich NR2 1DE";
  const hello = (place.contact || customer.contact || "").split(/\s+/)[0];
  const terms = order.paymentTerms?.label ? `${order.paymentTerms.label}${order.paymentTerms.note ? `\n${order.paymentTerms.note}` : ""}` : "";
  const subject = `Order confirmed: ${bags} ${bags === 1 ? "bag" : "bags"} of Strangers Coffee (${order.id.slice(0, 11)})`;
  const lineText = (l: Line) => `${l.quantity} × ${l.title}, ${packName[l.pack] || l.packLabel || l.pack}, ${l.grindLabel || ""}${l.decaf ? ", decaf" : ""}${showPrices && Number.isInteger(l.price) ? ` · ${money(l.price! * l.quantity)}` : ""}`;
  const text = [
    `${hello ? `Hi ${hello},` : "Hello,"}`, "", `Thanks for your order${order.business ? ` for ${order.business}` : ""}. We've received it and will be in touch if anything changes.`, "",
    `Order ${order.id} · ${when(order.createdAt)}`, "", ...order.lines.map(lineText), "",
    `${bags} ${bags === 1 ? "bag" : "bags"} · ${kg(order.grams)}`,
    ...(showPrices ? [`Coffee ${money(order.pence)} · ${order.delivery === "Delivery" ? `Delivery ${order.deliveryPence ? money(order.deliveryPence) : "free"}` : "Collection, no charge"} · Total ${money(total)}`] : []), "",
    `${order.delivery === "Delivery" ? "Delivering to" : "Collection"}: ${where}`, ...(order.reference ? [`Your reference: ${order.reference}`] : []),
    ...(order.customerNote ? ["", "Your comments:", order.customerNote] : []), ...(terms ? ["", `Payment terms: ${terms}`] : []), "",
    "By placing this order, you accepted the payment terms and conditions set up for your account.", "",
    `See your orders: ${ordersUrl}`, "", "Strangers Coffee",
  ].join("\n");
  const cell = "padding:8px 10px;border-bottom:1px solid #e3e6eb;text-align:left;vertical-align:top;font-size:14px;";
  const kv = (label: string, value: string) => `<tr><td style="padding:3px 12px 3px 0;color:#5d6675;font-size:14px;white-space:nowrap;vertical-align:top;">${esc(label)}</td><td style="padding:3px 0;font-size:14px;white-space:pre-line;">${esc(value)}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14181f;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:20px 0;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:14px;border:1px solid #e3e6eb;">
<tr><td style="padding:22px 24px 6px;"><div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5d6675;">Strangers Coffee · Wholesale</div>
<h1 style="margin:4px 0 6px;font-size:22px;line-height:1.25;">Thanks, your order is confirmed</h1>
<p style="margin:0;font-size:15px;line-height:1.5;">${hello ? `Hi ${esc(hello)}, thanks` : "Thanks"} for your order${order.business ? ` for ${esc(order.business)}` : ""}. We've received it and will be in touch if anything changes.</p>
<div style="font-size:13px;color:#5d6675;margin-top:8px;">Order ${esc(order.id)} · ${esc(when(order.createdAt))}</div></td></tr>
<tr><td style="padding:14px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
<tr><th style="${cell}color:#5d6675;font-size:12px;">Bags</th><th style="${cell}color:#5d6675;font-size:12px;">Coffee</th><th style="${cell}color:#5d6675;font-size:12px;">Size</th><th style="${cell}color:#5d6675;font-size:12px;">Grind</th>${showPrices ? `<th style="${cell}color:#5d6675;font-size:12px;text-align:right;">Price</th>` : ""}</tr>
${order.lines.map((l) => `<tr><td style="${cell}font-weight:700;">${l.quantity}</td><td style="${cell}">${esc(l.title)}${l.decaf ? " (decaf)" : ""}</td><td style="${cell}white-space:nowrap;">${esc(packName[l.pack] || l.packLabel || l.pack)}</td><td style="${cell}">${esc(l.grindLabel || "")}</td>${showPrices ? `<td style="${cell}text-align:right;white-space:nowrap;">${Number.isInteger(l.price) ? esc(money(l.price! * l.quantity)) : ""}</td>` : ""}</tr>`).join("")}
</table></td></tr>
<tr><td style="padding:12px 24px 0;font-size:14px;line-height:1.6;"><b>${bags} ${bags === 1 ? "bag" : "bags"}</b> · ${esc(kg(order.grams))}${showPrices ? `<br>Coffee ${esc(money(order.pence))} · ${order.delivery === "Delivery" ? `Delivery ${esc(order.deliveryPence ? money(order.deliveryPence) : "free")}` : "Collection, no charge"}<br><b style="font-size:16px;">Total ${esc(money(total))}</b>` : ""}</td></tr>
<tr><td style="padding:14px 24px 0;"><table role="presentation" cellpadding="0" cellspacing="0">
${kv(order.delivery === "Delivery" ? "Delivering to" : "Collection", where)}${order.reference ? kv("Your reference", order.reference) : ""}${order.customerNote ? kv("Your comments", order.customerNote) : ""}${terms ? kv("Payment terms", terms) : ""}
</table></td></tr>
<tr><td style="padding:14px 24px 0;font-size:13px;color:#5d6675;line-height:1.5;">By placing this order, you accepted the payment terms and conditions set up for your account.</td></tr>
<tr><td style="padding:18px 24px 22px;"><a href="${esc(ordersUrl)}" style="display:inline-block;background:#0062cc;color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:10px;">See your orders</a></td></tr>
</table><div style="font-size:12px;color:#5d6675;padding:12px;">Strangers Coffee · 10 Dove Street, Norwich NR2 1DE. Questions about this order? Just reply to this email.</div></td></tr></table></body></html>`;
  return { subject, html, text };
}

/** Emails the customer a confirmation of the order they just placed (background; never throws). Sent to the business's
 *  email on the order; replies go to the first Strangers order address. */
export async function confirmToCustomer(env: Env, ctx: ExecutionContext | undefined, order: MailOrder, opts: { showPrices: boolean; ordersUrl: string }) {
  const email = cleanEmail(order.customerSnapshot?.email);
  if (!emailReady(env) || !email) return;
  const run = (async () => {
    try {
      const settings = await orderEmailSettings(env);
      if (!settings.confirmCustomers) return;
      const mail = buildCustomerConfirmation(order, opts), name = order.business || "a wholesale customer";
      await send(env, { to: { id: "customer", name, email, email_prefs: "{}", active: 1 }, kind: "order", mail, about: `order confirmation ${order.id} to ${name}`, from: FROM(env), replyTo: settings.to[0] || DEFAULT_ORDER_EMAIL });
    } catch (error) {
      await audit(env, "email_failed", null, `Couldn't email the confirmation of wholesale order ${order.id}: ${String((error as Error)?.message || error).slice(0, 160)}`).catch(() => {});
    }
  })();
  if (ctx) ctx.waitUntil(run); else await run;
}

/** The customer's second email, when Strangers marks the order dispatched: shipped to their address (with the
 *  tracking link if one was added) or collected from the Roastery, said plainly at the top. */
export function buildDispatchEmail(order: MailOrder, ordersUrl: string) {
  const place = order.locationSnapshot || order.customerSnapshot || {};
  const customer = order.customerSnapshot || {};
  const shipped = order.delivery === "Delivery";
  const bags = order.lines.reduce((t, l) => t + l.quantity, 0);
  const hello = (place.contact || customer.contact || "").split(/\s+/)[0];
  const where = [place.name && place.name !== "Main location" ? place.name : "", place.address, place.postcode].filter(Boolean).join(", ") || "your saved address";
  const tracking = typeof order.trackingUrl === "string" && /^https?:\/\//i.test(order.trackingUrl) ? order.trackingUrl : "";
  const ref = order.id.slice(0, 11);
  const headline = shipped ? "Your order has been shipped" : "Your order has been collected from the Roastery";
  const subject = shipped ? `Shipped: your Strangers Coffee order (${ref})` : `Collected: your Strangers Coffee order (${ref})`;
  const lead = shipped ? `Your order of ${bags} ${bags === 1 ? "bag" : "bags"} is on its way to ${where}.` : `Your order of ${bags} ${bags === 1 ? "bag" : "bags"} has been collected from the Strangers Roastery, 10 Dove Street, Norwich.`;
  const lineText = (l: Line) => `${l.quantity} × ${l.title}, ${packName[l.pack] || l.packLabel || l.pack}, ${l.grindLabel || ""}${l.decaf ? ", decaf" : ""}`;
  const text = [
    hello ? `Hi ${hello},` : "Hello,", "", `${shipped ? "SHIPPED" : "COLLECTED FROM THE ROASTERY"}`, lead, ...(tracking ? ["", `Track your delivery: ${tracking}`] : []), "",
    `Order ${order.id}${order.reference ? ` · your reference ${order.reference}` : ""}`, ...order.lines.map(lineText), "",
    shipped ? "If anything's missing or damaged when it arrives, just reply to this email." : "If anything's missing or not right, just reply to this email.", "",
    `See your orders: ${ordersUrl}`, "", "Strangers Coffee",
  ].join("\n");
  const tone = shipped ? { bg: "#e8f1fd", fg: "#0b4f9c", label: "Shipped" } : { bg: "#e9f6ee", fg: "#1d6b3a", label: "Collected from the Roastery" };
  const cell = "padding:7px 10px;border-bottom:1px solid #e3e6eb;text-align:left;vertical-align:top;font-size:14px;";
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14181f;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:20px 0;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:14px;border:1px solid #e3e6eb;">
<tr><td style="padding:22px 24px 6px;"><div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5d6675;">Strangers Coffee · Wholesale</div>
<div style="display:inline-block;margin:12px 0 4px;padding:6px 12px;border-radius:999px;background:${tone.bg};color:${tone.fg};font-size:13px;font-weight:700;letter-spacing:.02em;">${shipped ? "&#128666;" : "&#9749;"} ${esc(tone.label)}</div>
<h1 style="margin:6px 0 6px;font-size:22px;line-height:1.25;">${esc(headline)}</h1>
<p style="margin:0;font-size:15px;line-height:1.5;">${hello ? `Hi ${esc(hello)}, ` : ""}${esc(lead)}</p></td></tr>
${tracking ? `<tr><td style="padding:14px 24px 0;"><a href="${esc(tracking)}" style="display:inline-block;background:#0062cc;color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:10px;">Track your delivery</a></td></tr>` : ""}
<tr><td style="padding:16px 24px 0;font-size:13px;color:#5d6675;">Order ${esc(order.id)}${order.reference ? ` · your reference ${esc(order.reference)}` : ""}</td></tr>
<tr><td style="padding:6px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
${order.lines.map((l) => `<tr><td style="${cell}font-weight:700;width:40px;">${l.quantity}</td><td style="${cell}">${esc(l.title)}${l.decaf ? " (decaf)" : ""}</td><td style="${cell}white-space:nowrap;">${esc(packName[l.pack] || l.packLabel || l.pack)}</td><td style="${cell}">${esc(l.grindLabel || "")}</td></tr>`).join("")}
</table></td></tr>
<tr><td style="padding:14px 24px 0;font-size:14px;line-height:1.5;">${shipped ? "If anything's missing or damaged when it arrives, just reply to this email." : "If anything's missing or not right, just reply to this email."}</td></tr>
<tr><td style="padding:16px 24px 22px;"><a href="${esc(ordersUrl)}" style="color:#0062cc;font-weight:600;text-decoration:none;">See your orders</a></td></tr>
</table><div style="font-size:12px;color:#5d6675;padding:12px;">Strangers Coffee · 10 Dove Street, Norwich NR2 1DE.</div></td></tr></table></body></html>`;
  return { subject, html, text };
}

/** Emails the customer that their order went out (background; never throws). Same switch as the confirmation. */
export async function dispatchToCustomer(env: Env, ctx: ExecutionContext | undefined, order: MailOrder, ordersUrl: string) {
  const email = cleanEmail(order.customerSnapshot?.email);
  if (!emailReady(env) || !email) return;
  const run = (async () => {
    try {
      const settings = await orderEmailSettings(env);
      if (!settings.confirmCustomers) return;
      const mail = buildDispatchEmail(order, ordersUrl), name = order.business || "a wholesale customer";
      await send(env, { to: { id: "customer", name, email, email_prefs: "{}", active: 1 }, kind: "order", mail, about: `${order.delivery === "Delivery" ? "shipped" : "collected"} email for ${order.id} to ${name}`, from: FROM(env), replyTo: settings.to[0] || DEFAULT_ORDER_EMAIL });
    } catch (error) {
      await audit(env, "email_failed", null, `Couldn't email the dispatch of wholesale order ${order.id}: ${String((error as Error)?.message || error).slice(0, 160)}`).catch(() => {});
    }
  })();
  if (ctx) ctx.waitUntil(run); else await run;
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
    if (body.confirmCustomers !== undefined && typeof body.confirmCustomers !== "boolean") throw invalid("Choose whether customers get a confirmation email.");
    const current = await orderEmailSettings(env);
    const data = JSON.stringify({ enabled: body.enabled, to, confirmCustomers: body.confirmCustomers ?? current.confirmCustomers }), at = Date.now();
    const result = expected === 0
      ? await env.DB.prepare("INSERT INTO wholesale_order_emails(id,data,version,updated_at) SELECT 1,?,1,? WHERE NOT EXISTS(SELECT 1 FROM wholesale_order_emails WHERE id=1)").bind(data, at).run()
      : await env.DB.prepare("UPDATE wholesale_order_emails SET data=?,version=version+1,updated_at=? WHERE id=1 AND version=?").bind(data, at, expected).run();
    if (!result.meta.changes) throw new ApiError(409, "conflict", "Order emails were changed on another device. Reload and try again.");
    await audit(env, "wholesale_order_emails", actor, `${actor} ${body.enabled ? `set new-order emails to ${(to as string[]).join(", ")}` : "switched new-order emails off"}.`);
    return json(await orderEmailSettings(env));
  }
  if (route === "order-emails/slack-test" && req.method === "POST") {
    if (!slackReady(env)) throw new ApiError(409, "slack_off", "Slack isn't set up on this site (no SLACK_ORDERS_WEBHOOK_URL).");
    try { await sendSlackTest(env, diaryBase); } catch (error) { throw new ApiError(502, "slack_failed", `Slack didn't accept the test post. ${String((error as Error)?.message || "").slice(0, 120)}`); }
    return json({ sent: true });
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
