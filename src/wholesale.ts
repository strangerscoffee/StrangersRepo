import { handleQuickBooks } from "./quickbooks/index";
// Wholesale beta: real customer orders and isolated staff test orders. Payments and fulfilment are managed by the team.
import { validGrindId } from "../public/wholesale/grinds.js";
import { isWholesaleDelivery, shippingFor } from "../public/wholesale/shipping.js";
import { MAX_QUANTITY, MINIMUM_ORDER_GRAMS } from "../public/wholesale/limits.js";
import { catalogueRetrievedAt } from "./wholesale/catalogue.js";
import { staffSessionForWrite, type User } from "./auth";
import { object, text, version, decode, get, save, type Row, type Versioned } from "./wholesaleStore";
import { catalogue, handleCatalogueAdmin, serveCatalogueImage, packsOf, catalogueRevisions, CATALOGUE_REVISIONS_MATCH_SQL } from "./wholesaleCatalogue";
import { adminWholesalePage, adminWholesaleStats } from "./wholesaleAdminLists";
import { packingTotals } from "./wholesalePacking";
import { audit } from "./audit";
import { ApiError, type Env, invalid, json, readJson, SQL_NOW_MS } from "./http";
import { handleAutoInvoiceAdmin, startAutoInvoice } from "./autoInvoice";
import { manageWholesaleAccount, publicCustomer, wholesaleAccounts, wholesaleCustomer, paymentTermsFor, PAYMENT_TERMS, WHOLESALE_SESSION_SQL, wholesaleSessionHash, type Customer, type OrderingUser } from "./wholesaleAccounts";
import { customerLocations, editedCustomerLocations, locationDefaults, validLocationId, type CustomerLocation } from "./wholesaleCustomers";
import { notifyCustomerChange, standingChangeToCustomer, confirmToCustomer, prepareDispatchEmail, prepareReadyEmail, handleOrderEmailsAdmin, notifyNewOrder } from "./email/orders";
import { DEFAULT_ORDER_EMAIL, orderEmailSettings } from "./email/orderSettings";
import { dispatchEvent, deliverDispatchEmails } from "./email/outbox";
import { wakeIntegration } from "./integrationSignals";
import { notifySlackChange, notifySlackNewOrder } from "./slackOrders";
import { handleInsights } from "./insights";
import { autoTabFor, clearTab, listTabs, setOnTab } from "./wholesaleTabs";
import { importCustomers, inviteCustomer, inviteStates, matchAccountsEmails } from "./wholesaleImport";
import { canOrder, catalogueFor, customerLines, recipeText } from "./wholesaleWhiteLabel";
import { activeAnnouncement, handleAnnouncementAdmin } from "./wholesaleAnnouncement";
import { amendLines, rollStanding, scheduleFields, skipRun, type Standing } from "./wholesaleStanding";
import { customersSeeInvoices, handleInvoiceAdmin, handleInvoiceCustomer, invoiceLinks } from "./wholesaleInvoices";
import { handleInvoiceReminders } from "./wholesaleInvoiceReminders";
import { handleBillingAccounts } from "./invoicing/accounts";
import { handleBatches } from "./invoicing/batches";
import { handleReconciliation } from "./invoicing/reconciliation";
import { handleQuickBooksMatches } from "./invoicing/quickbooksMatches";
import { handleRoyalMailSettings } from "./royalMailAppSettings";
import { handleWholesaleRoyalMail, resolveWholesaleHandover, ROYAL_MAIL_ORDER_ROUTE } from "./wholesaleRoyalMail";

type Pack = "quarter" | "half" | "kilo";
/** The minimum this business must order, in grams of coffee (0 when Admin has exempted it). */
const standardMinimum = (env: Env) => /^\d+$/.test(env.WHOLESALE_MINIMUM_ORDER_GRAMS || "") ? Number(env.WHOLESALE_MINIMUM_ORDER_GRAMS) : MINIMUM_ORDER_GRAMS;
export const minimumOrderGrams = (env: Env, customer: { noMinimumOrder?: boolean } | null | undefined) => customer?.noMinimumOrder ? 0 : standardMinimum(env);
const kg = (grams: number) => `${(grams / 1000).toLocaleString("en-GB", { maximumFractionDigits: 2 })} kg`;
const PACKS: Record<Pack, { label: string; grams: number }> = { quarter: { label: "250 g bag", grams: 250 }, half: { label: "500 g bag", grams: 500 }, kilo: { label: "1 kg bag", grams: 1000 } };
// 500 g bags are no longer sold or priced: kept above only so past orders and their exact retries still read; refused for new orders.
const ORDERABLE_PACKS: Pack[] = ["quarter", "kilo"]; // checked before any price is read (the catalogue has none for 500 g)
const STATUSES = ["New", "Preparing", "Ready", "Dispatched", "Cancelled"];
interface Line { productId: string; title: string; pack: Pack; packLabel: string; grind: string; grindLabel: string; grindHint?: string; decaf?: boolean; quantity: number; price: number; grams: number; recipe?: string }
interface Order {
  createdBy: string; createdName: string; business: string; reference: string; delivery: string;
  customerId: string | null; status: string; note: string; date: string; createdAt: number;
  requestKey: string; lines: Line[]; pence: number; grams: number; packs: number;
  /** Skipped (a standing delivery): by whom (a name, admin only) and whether the customer did it. */
  skipped?: { by: string; customer: boolean; at: number };
  /** Checked line indices for this run only. Order amendments invalidate them. */
  packedLines?: number[];
  /** Standing order changed for one delivery only: the usual bags, which the next run goes back to. */
  repeatLines?: Line[];
  amendedByCustomer?: boolean;
  /** Taken by staff for the customer (it came by email, phone or in person); who took it is createdName. */
  takenFor?: { source: string; at: number };
  /** Delivery charge in pence including VAT, fixed when the order was placed (absent on orders from before it was automatic). */
  deliveryPence?: number; totalPence?: number;
  /** Placed for a business with Free delivery: no delivery charge, now or when its bags change. */
  freeDelivery?: boolean;
  preview?: boolean; customerSnapshot?: Omit<ReturnType<typeof publicCustomer>, "locations" | "defaultLocationId">; deliveryNotes?: string;
  paymentTerms?: ReturnType<typeof paymentTermsFor>;
  locationId?: string; locationSnapshot?: CustomerLocation;
  deletedAt?: number; deletedBy?: string;
  trackingUrl?: string;
  /** The customer's own optional note at checkout ("Use our own custom labels"); shown back to them, unlike the internal `note`. */
  customerNote?: string;
  /** Legacy marker retained for historical dispatch mail. New mail uses the durable outbox. */
  dispatchEmailedAt?: number;
  /** When it was last marked Dispatched (cleared if it's moved back): sorts the Dispatched list newest first. */
  dispatchedAt?: number;
  /** On the customer's open tab (src/wholesaleTabs.ts), and the cleared tab it went into. Staff/admin only. */
  tab?: { at: number; by: string; auto?: boolean }; tabClearedId?: string;
  /** Admin only to set (src/wholesaleStanding.ts): the day it's due to go out, and the standing order it belongs to. */
  standingIssue?: { code: string; at: number }; standingRetryAt?: number;
  dispatchDate?: string; standing?: Standing; nextRunId?: string; previousRunId?: string;
  /** When an admin changed the bags; `originalLines` are the bags as first placed. */
  amendedAt?: number; amendedBy?: string; originalLines?: Line[];
}
type Links = { admin: string; diary: string; preview?: string };
/** My orders on the customer ordering site, for links in customers' emails (…/#orders opens it). */
export function customerOrdersUrl(env: Env, links: { preview?: string }, req: Request) {
  const site = /^https?:\/\//.test(links.preview || "") ? links.preview! : env.PREVIEW_HOST ? `https://${env.PREVIEW_HOST}/` : new URL("/wholesale/", req.url).href;
  return site.replace(/\/?$/, "/") + "#orders";
}

/** After a standing delivery is changed or skipped: what kind of change, and (for a skip) the next run's dispatch day. */
async function standingChange(env: Env, saved: Record<string, any>, kind: "lines" | "skip", body: unknown) {
  const change: "skipped" | "once" | "ongoing" = kind === "skip" ? "skipped" : (body as any)?.scope === "once" ? "once" : "ongoing";
  const next = kind === "skip" && typeof saved.nextRunId === "string" ? await get<Record<string, any>>(env, "order", saved.nextRunId) : null;
  return { change, nextDispatchDate: typeof next?.dispatchDate === "string" ? next.dispatchDate : undefined };
}

/** Strangers (staff with wholesale orders access, or an admin) changed or skipped a standing delivery for the
 *  customer: the customer is emailed (one-off orders aren't), and the Order alerts addresses and the orders Slack
 *  channel hear who did it (the owner's decision, 17 Nov 2026). Background; never throws. */
export async function tellCustomerStandingChange(env: Env, ctx: ExecutionContext | undefined, saved: Record<string, any>, kind: "lines" | "skip", body: unknown, ordersUrl: string, diaryBase: string, by: string) {
  if (!saved.standing) return;
  try {
    const { change, nextDispatchDate } = await standingChange(env, saved, kind, body);
    await standingChangeToCustomer(env, ctx, saved as any, change, ordersUrl, nextDispatchDate);
    await notifyCustomerChange(env, ctx, saved as any, change, diaryBase, undefined, by);
    await notifySlackChange(env, ctx, { ...(saved as any), nextDispatchDate, by }, change, diaryBase);
  } catch {}
}
const denied = () => new ApiError(403, "permission_denied", "Only admins can manage wholesale ordering.");
export function visibleOrder(order: Order & Versioned, admin = false) {
  const { requestKey, note, tab, tabClearedId, amendedBy, packedLines, ...visible } = order;
  if (admin) return { ...visible, ...(packedLines ? { packedLines } : {}), trackingUrl: order.trackingUrl || "", note, ...(tab ? { tab } : {}), ...(tabClearedId ? { tabClearedId } : {}), ...(amendedBy ? { amendedBy } : {}) };
  // Customers never see which member of staff took, changed or skipped an order: only whether they did it themselves.
  const { createdBy, createdName, skipped, ...rest } = visible as typeof visible & { createdBy?: string; createdName?: string; skipped?: { customer?: boolean; at?: number } };
  const own = order.takenFor ? rest : { ...rest, ...(createdBy !== undefined ? { createdBy } : {}), ...(createdName !== undefined ? { createdName } : {}) };
  return {
    ...own, lines: customerLines(rest.lines)!, ...(rest.originalLines ? { originalLines: customerLines(rest.originalLines) } : {}),
    ...((rest as any).repeatLines ? { repeatLines: customerLines((rest as any).repeatLines) } : {}),
    ...(skipped ? { skipped: { customer: !!skipped.customer, at: skipped.at } } : {}), trackingUrl: order.trackingUrl || "",
  };
}
function trackingUrl(value: unknown): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) throw invalid("Use a tracking link without control characters.");
  const link = value.trim();
  if (!link) return "";
  if (link.length > 2000 || !/^https?:\/\//i.test(link)) throw invalid("Use a full http or https tracking link, up to 2,000 characters.");
  let url: URL;
  try { url = new URL(link); } catch { throw invalid("Check the tracking link."); }
  const authority = link.slice(link.indexOf("//") + 2).split(/[/?#]/, 1)[0];
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || authority.includes("@") || url.href.length > 2000) throw invalid("Use a tracking link without a username or password.");
  return url.href;
}
function orderBody(value: unknown, priced = true) {
  const body = object(value);
  if (typeof body.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId)) throw invalid("Send a unique requestId for this order.");
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 150) throw invalid("Choose from 1 to 150 coffee variants.");
  const lines: { productId: string; pack: Pack; grind: string; quantity: number; price: number }[] = [];
  for (const value of body.lines) {
    const line = object(value);
    if ((typeof line.productId !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(line.productId)) || typeof line.pack !== "string" || !Object.hasOwn(PACKS, line.pack) || typeof line.grind !== "string" || !validGrindId(line.grind)) throw invalid("Choose a listed coffee, bag size and grind.");
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY) throw invalid(`Choose a whole number of bags from 1 to ${MAX_QUANTITY}.`);
    // Orders staff take for a customer carry no prices (the staff page shows none): the catalogue's prices apply.
    if (!priced) line.price = 0;
    else if (!Number.isInteger(line.price) || line.price < 1 || line.price > 1000000) throw invalid("Check the quoted coffee price.");
    const previous = lines.find((item) => item.productId === line.productId && item.pack === line.pack && item.grind === line.grind);
    if (previous) {
      if (previous.price !== line.price || previous.quantity + line.quantity > MAX_QUANTITY) throw invalid(`Each coffee, weight and grind can have at most ${MAX_QUANTITY} bags at one price.`);
      previous.quantity += line.quantity;
    } else lines.push({ productId: line.productId, pack: line.pack as Pack, grind: line.grind, quantity: line.quantity, price: line.price });
  }
  if (body.delivery !== "Delivery" && body.delivery !== "Roastery collection") throw invalid("Choose delivery or roastery collection.");
  const locationId = body.locationId === undefined ? undefined : text(body.locationId, "location", 36, true);
  if (locationId !== undefined && !validLocationId(locationId)) throw invalid("Choose a saved business location.");
  const customerNote = text(body.customerNote, "order comments", 1000);
  return {
    id: `PREVIEW-${body.requestId.replaceAll("-", "").toUpperCase()}`,
    lines: lines.sort((a, b) => `${a.productId}:${a.pack}:${a.grind}`.localeCompare(`${b.productId}:${b.pack}:${b.grind}`)),
    delivery: body.delivery as string, reference: text(body.reference, "purchase reference", 80), business: text(body.business, "business name", 120),
    ...(locationId === undefined ? {} : { locationId }),
    // Only present when written, so requests from before the comments box keep their original requestKey.
    ...(customerNote ? { customerNote } : {}),
  };
}
/** How an order taken by staff for a customer reached Strangers. */
export const TAKEN_SOURCES = ["Email", "In person", "Phone", "Other"] as const;
/** An order staff take for a customer (it came by email, phone or at the door): a real customer order. */
interface TakenFor { customerId: string; source: string; emailCustomer: boolean; onTab: boolean }

async function createOrder(req: Request, env: Env, user: OrderingUser, links: Links, ctx?: ExecutionContext, takenFor?: TakenFor): Promise<Response> {
  const saved = await placeOrder(req, env, user, links, ctx, takenFor);
  return json({ order: visibleOrder(saved.order), preview: saved.order.preview !== false }, saved.created ? 201 : 200);
}

/** Staff with wholesale orders access (and admins) take an order for a customer. */
export async function takeOrderFor(req: Request, env: Env, staff: User, links: Links, ctx?: ExecutionContext) {
  const submitted = object(await readJson(req, 32 * 1024));
  const customerId = text(submitted.customerId, "customer", 36, true);
  const source = TAKEN_SOURCES.find((s) => s === submitted.source);
  if (!source) throw invalid("Choose how the order came in: email, in person, phone or other.");
  if (submitted.emailCustomer !== undefined && typeof submitted.emailCustomer !== "boolean") throw invalid("Choose whether to email the customer.");
  if (submitted.onTab !== undefined && typeof submitted.onTab !== "boolean") throw invalid("Choose whether to put the order on the customer's tab.");
  return placeOrder(req, env, staff, links, ctx, { customerId, source, emailCustomer: submitted.emailCustomer === true, onTab: submitted.onTab === true }, submitted);
}

async function placeOrder(req: Request, env: Env, user: OrderingUser, links: Links, ctx: ExecutionContext | undefined, takenFor?: TakenFor, already?: Record<string, any>): Promise<{ order: Order & Versioned; created: boolean }> {
  const submitted = already || object(await readJson(req, 32 * 1024));
  if (!takenFor && submitted.orderingIdentity !== undefined && submitted.orderingIdentity !== user.id) throw new ApiError(409, "account_changed", "The signed-in account changed. Reload ordering before placing an order.");
  const body = orderBody(submitted, !takenFor);
  const customer = takenFor ? await wholesaleCustomer(env, takenFor.customerId) : user.role === "wholesale" ? await wholesaleCustomer(env, user.customerId) : null;
  if (takenFor && !customer) throw new ApiError(404, "not_found", "That customer wasn't found. Reload the customer list.");
  if (user.role === "wholesale" && !customer) throw new ApiError(403, "permission_denied", "Your wholesale account is unavailable. Contact Strangers.");
  if (customer) {
    body.id = body.id.replace("PREVIEW-", "WS-");
    body.business = customer.business;
  }
  // Retrying a customer request still finds its original snapshot if business details changed meanwhile.
  const request = takenFor ? { ...body, business: takenFor.customerId, takenBy: user.id, source: takenFor.source, onTab: takenFor.onTab } : user.role === "wholesale" ? { ...body, business: user.customerId } : body;
  const requestKey = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(request))))].map((n) => n.toString(16).padStart(2, "0")).join("");
  const existing = await get<Order>(env, "order", body.id);
  if (existing) {
    if (existing.createdBy !== user.id || existing.requestKey !== requestKey) throw new ApiError(409, "conflict", "That requestId has already been used for another order.");
    if (existing.deletedAt != null) throw new ApiError(410, "order_deleted", "This order was removed by Strangers. Close this review and review your basket before placing a new order.");
    return { order: existing, created: false };
  }
  if (customer?.status === "On hold") throw new ApiError(403, "account_on_hold", takenFor ? `${customer.business} is on hold. An admin can take them off hold in Admin → Wholesale → Customers.` : "Your account is on hold. Contact Strangers before placing an order.");
  const location = customer ? customerLocations(customer).find((location) => location.id === (body.locationId || (takenFor ? customer.defaultLocationId || "primary" : "primary"))) || (takenFor && !body.locationId ? customerLocations(customer)[0] : null) : null;
  if (customer && location && body.delivery === "Delivery" && (!location.address.trim() || !location.postcode.trim())) throw invalid(takenFor ? `${location.name} has no delivery address and postcode saved. Choose collection, or ask an admin to add the address.` : "Add the selected location's delivery address and postcode in My account before ordering delivery.");
  if (customer && !takenFor && !Number.isSafeInteger(submitted.customerVersion)) throw new ApiError(409, "account_changed", "Reload the page to update ordering, then review your basket again.");
  if (customer && !takenFor && submitted.customerVersion !== customer.version) throw new ApiError(409, "account_changed", "Your business details or payment terms changed. Close this review and review your basket again.");
  if (customer && !location) throw invalid("Choose a location saved to your business.");
  if (!customer && body.locationId !== undefined) throw invalid("Saved locations are available for wholesale customer accounts.");
  const coffees = await catalogue(env);
  const lines = body.lines.map((line): Line => {
    const product = coffees.find((product) => product.id === line.productId);
    if (!product || !canOrder(product, customer?.id || null)) throw invalid("Choose a listed coffee.");
    if (!product.inStock) throw new ApiError(409, "out_of_stock", `${product.name} is out of stock. Remove it from your basket to continue.`);
    if (!ORDERABLE_PACKS.includes(line.pack)) throw new ApiError(409, "pack_unavailable", `${PACKS[line.pack].label}s are no longer available. Remove the ${PACKS[line.pack].label} of ${product.name} from your basket and choose 250 g or 1 kg.`);
    if (!packsOf(product).includes(line.pack as "quarter" | "kilo")) throw new ApiError(409, "pack_unavailable", `${product.name} is sold in ${PACKS[packsOf(product)[0]].label}s only. Remove the ${PACKS[line.pack].label} of ${product.name} from your basket and choose a ${PACKS[packsOf(product)[0]].label}.`);
    if (!product.active) throw new ApiError(409, "conflict", `${product.name} is no longer in the catalogue. Reload your basket.`);
    if (!takenFor && line.price !== product.prices[line.pack as "quarter" | "kilo"]) throw new ApiError(409, "conflict", "The prices have changed. Reload and review your order again.");
    const grind = product.grindOptions.find(option => option.id === line.grind && option.enabled);
    if (!grind) throw new ApiError(409, "grind_unavailable", `${product.name} no longer offers this grind. Remove it from your basket and choose an available option.`);
    return { ...line, title: product.title, packLabel: PACKS[line.pack].label, grindLabel: grind.label, grindHint: grind.hint || "", decaf: product.categories.includes("decaf"), price: product.prices[line.pack as "quarter" | "kilo"], grams: PACKS[line.pack].grams, ...(product.recipe?.length ? { recipe: recipeText(product) } : {}) };
  });
  // After the retry check above, so an order already placed is still returned if the minimum changes later.
  // Orders staff take for a customer skip the minimum (the owner's decision): a few bags at the door are fine.
  const minimum = takenFor ? 0 : minimumOrderGrams(env, customer), grams = lines.reduce((sum, line) => sum + line.grams * line.quantity, 0);
  if (grams < minimum) throw new ApiError(409, "below_minimum", `The minimum order is ${kg(minimum)} of coffee. Add ${kg(minimum - grams)} more to your basket.`);
  const at = Date.now();
  const customerSnapshot = customer && location ? (() => {
    const { locations, defaultLocationId, ...profile } = publicCustomer(customer);
    return { ...profile, contact: location.contact, phone: location.phone, address: location.address, postcode: location.postcode, deliveryNotes: location.deliveryNotes };
  })() : undefined;
  const order: Order = {
    createdBy: user.id, createdName: user.name, business: body.business, reference: body.reference, delivery: body.delivery,
    customerId: customer?.id || null, status: "New", note: "", trackingUrl: "", preview: !customer, ...(customer && location ? { customerSnapshot, deliveryNotes: location.deliveryNotes, paymentTerms: paymentTermsFor(customer), locationId: location.id, locationSnapshot: { ...location } } : {}), date: new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(new Date(at)),
    createdAt: at, requestKey, lines, ...(body.customerNote ? { customerNote: body.customerNote } : {}), ...autoTabFor(customer),
    // Staff may put an order they take straight on the customer's tab (a customer set to go on automatically already is).
    ...(takenFor?.onTab && !customer?.autoTab ? { tab: { at: Date.now(), by: user.name } } : {}),
    ...(takenFor ? { takenFor: { source: takenFor.source, at } } : {}),
    pence: lines.reduce((sum, line) => sum + line.price * line.quantity, 0), grams: lines.reduce((sum, line) => sum + line.grams * line.quantity, 0), packs: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
  // A business with Free delivery (Admin, the owner's request of 26 Nov 2026) pays no delivery charge; the order keeps a
  // note of it so later changes to its bags (amendLines) stay free too.
  if (customer?.freeDelivery && order.delivery === "Delivery") order.freeDelivery = true;
  order.deliveryPence = order.freeDelivery ? 0 : shippingFor(order.delivery, order.pence);
  order.totalPence = order.pence + order.deliveryPence;
  const staffSession = user.role === "wholesale" ? null : await staffSessionForWrite(req, env);
  const identity = user.role === "wholesale"
    ? { sql: `AND EXISTS (SELECT 1 ${WHOLESALE_SESSION_SQL} AND a.id = ? AND a.customer_id = ?)`, args: [await wholesaleSessionHash(req), user.accountId, user.customerId] }
    : {
      sql: `AND EXISTS (
        SELECT 1 FROM users u WHERE u.id = ? AND u.role = ? AND u.active = 1 AND u.session_ver = ?
        AND ? >= ${SQL_NOW_MS} AND NOT EXISTS (SELECT 1 FROM revoked_sessions WHERE sid = ?)
        ${takenFor ? "AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM staff_order_access WHERE user_id = u.id AND enabled = 1))" : ""}
      )`,
      args: [staffSession?.user.id === user.id ? user.id : null, user.role, staffSession?.sessionVersion ?? null, staffSession?.exp ?? null, staffSession?.sid ?? null],
    };
  // Compare the records read during validation in the same statement that creates the order.
  // Bundled coffees without a saved override have version zero.
  const result = await env.DB.prepare(`
    INSERT INTO wholesale_preview (kind, id, data, version, updated_at)
    SELECT 'order', ?, ?, 1, ?
    WHERE (? IS NULL OR EXISTS (
      SELECT 1 FROM wholesale_preview WHERE kind = 'customer' AND id = ? AND version = ? AND updated_at = ?
    ))
    AND ${CATALOGUE_REVISIONS_MATCH_SQL}
    ${identity.sql}
    ON CONFLICT(kind, id) DO NOTHING`)
    .bind(body.id, JSON.stringify(order), at, customer?.id ?? null, customer?.id ?? null,
      customer?.version ?? null, customer?.updatedAt ?? null, catalogueRevisions(coffees, lines), ...identity.args).run();
  if (!result.meta.changes) {
    const raced = await get<Order>(env, "order", body.id);
    if (!raced) throw new ApiError(409, "conflict", "The catalogue or account changed. Reload and review your order again.");
    if (raced.createdBy !== user.id || raced.requestKey !== requestKey) throw new ApiError(409, "conflict", "That requestId has already been used for another order.");
    if (raced.deletedAt != null) throw new ApiError(410, "order_deleted", "This order was removed by Strangers. Close this review and review your basket before placing a new order.");
    return { order: raced, created: false };
  }
  const saved = { ...order, id: body.id, version: 1, updatedAt: at };
  await audit(env, customer ? "wholesale_order" : "wholesale_preview_order", user.name, takenFor
    ? `${user.name} took order ${body.id} for ${customer!.business} (${takenFor.source.toLowerCase()}).`
    : `${user.name} placed ${customer ? "wholesale" : "staff preview"} order ${body.id}.`);
  // A new customer order (never a staff preview or a retry, which returned above) is emailed to Strangers and posted
  // to Slack, including one staff entered for the customer (the email says who entered it and how it came in).
  if (customer) {
    // Emails and Slack open links from elsewhere, so the staff orders page needs its full address (on the diary's own
    // host links.diary is just "/").
    const diary = new URL(links.diary || "/", req.url).href;
    await notifyNewOrder(env, ctx, saved, diary);
    await notifySlackNewOrder(env, ctx, saved, diary);
    // The customer gets their own confirmation, linking back to My orders (for a taken order, only when asked).
    if (!takenFor || takenFor.emailCustomer) await confirmToCustomer(env, ctx, saved, { showPrices: !customer.hidePrices, ordersUrl: customerOrdersUrl(env, links, req) });
  }
  return { order: saved, created: true };
}

/** All staff can browse the signed-in catalogue and save preview orders. They cannot read others' records. */
/** A separate accounts email (invoices and statements), or "" when it's the same as the order email. Undefined keeps the saved one. */
function accountsEmailFrom(value: unknown, current: string | undefined): string {
  if (value === undefined) return current || "";
  const email = text(value, "accounts email", 150);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("Check the accounts email.");
  return email;
}
export async function handleWholesale(req: Request, env: Env, route: string, user: OrderingUser, links: Links, ctx?: ExecutionContext): Promise<Response> {
  const expected=req.headers.get('x-expected-ordering-id'),role=req.headers.get('x-expected-ordering-role');
  if((expected&&expected!==user.id)||(role&&role!==user.role))throw new ApiError(409,'session_changed','The signed-in account changed. Reload to continue.');
  if(route==='session'&&req.method==='GET'&&req.headers.get('x-sc-session-check')==='1')return json({user:{id:user.id,role:user.role},...(user.role!=='wholesale'&&env.COOKIE_DOMAIN?{cookieDomain:env.COOKIE_DOMAIN}:{})});
  const invoiceResponse = await handleInvoiceCustomer(req, env, route, user);
  if (invoiceResponse) return invoiceResponse;
  const customer = user.role === "wholesale" ? await wholesaleCustomer(env, user.customerId) : null;
  if ((route === "catalogue" || route === "session") && req.method === "GET") return json({ ...(route === "catalogue" ? { products: catalogueFor(await catalogue(env), user.role === "wholesale" ? user.customerId : null), sourceDate: catalogueRetrievedAt } : {}), stage: "beta", invoices: !customer?.hidePrices && await customersSeeInvoices(env), minimumOrderGrams: minimumOrderGrams(env, customer), showPrices: !customer?.hidePrices, ...(customer?.freeDelivery ? { freeDelivery: true } : {}), announcement: await activeAnnouncement(env), me: user, customer: customer ? publicCustomer(customer) : null, links: { ...(user.role === "wholesale" ? {} : links), preview: links.preview || "/wholesale/" }, preview: user.role !== "wholesale" });
  if (route === "account" && req.method === "PUT" && customer) {
    const body = object(await readJson(req, 64 * 1024));
    if (body.orderingIdentity !== undefined && body.orderingIdentity !== user.id) throw new ApiError(409, "account_changed", "The signed-in account changed. Reload ordering before saving business details.");
    if (body.business !== undefined && text(body.business, "business name", 120, true) !== customer.business) throw new ApiError(403, "permission_denied", "Only Strangers admins can change the registered business name. Contact the team to update it.");
    const expected = version(body.ifVersion);
    if (expected !== customer.version) throw new ApiError(409, "conflict", "This business changed on another device. Reload it before saving.");
    const email = body.email === undefined ? customer.email : text(body.email, "email", 150);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("Check the contact email.");
    const accountsEmail = accountsEmailFrom(body.accountsEmail, customer.accountsEmail);
    const { id, version: oldVersion, updatedAt, accountsEmail: _old, ...current } = customer;
    const data = editedCustomerLocations({ ...current, business: customer.business, contact: body.contact === undefined ? customer.contact : text(body.contact, "contact name", 120), email, ...(accountsEmail ? { accountsEmail } : {}), phone: body.phone === undefined ? customer.phone || "" : text(body.phone, "phone number", 40), address: body.address === undefined ? customer.address || "" : text(body.address, "delivery address", 500), postcode: body.postcode === undefined ? customer.postcode || "" : text(body.postcode, "postcode", 20), deliveryNotes: body.deliveryNotes === undefined ? customer.deliveryNotes || "" : text(body.deliveryNotes, "delivery notes", 1000) }, body);
    const saved = await save(env, "customer", id, data, expected);
    await audit(env, "wholesale_profile", user.name, `${user.name} updated their wholesale business details.`);
    return json({ customer: publicCustomer(saved) });
  }
  if (route === "orders" && req.method === "GET") {
    const owner = user.role === "wholesale" ? user.customerId : user.id;
    const scope = user.role === "wholesale"
      ? "kind = 'order' AND json_extract(data, '$.deletedAt') IS NULL AND json_extract(data, '$.customerId') = ? AND json_extract(data, '$.preview') = 0"
      : "kind = 'order' AND json_extract(data, '$.deletedAt') IS NULL AND json_extract(data, '$.createdBy') = ?";
    const cursor = new URL(req.url).searchParams.get("cursor");
    let after = "";
    const values: (string | number)[] = [owner];
    if (cursor) {
      const match = /^(\d{1,16}):([a-zA-Z0-9-]{1,80})$/.exec(cursor);
      if (!match || !Number.isSafeInteger(Number(match[1]))) throw invalid("Refresh your order history before loading more orders.");
      after = " AND (updated_at < ? OR (updated_at = ? AND id > ?))";
      values.push(Number(match[1]), Number(match[1]), match[2]);
    }
    const [rows, total] = await Promise.all([
      env.DB.prepare(`SELECT id, data, version, updated_at FROM wholesale_preview WHERE ${scope}${after} ORDER BY updated_at DESC, id LIMIT 201`).bind(...values).all<Row>(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM wholesale_preview WHERE ${scope}`).bind(owner).first<{ n: number }>(),
    ]);
    const page = rows.results.slice(0, 200);
    const last = page.at(-1);
    // Invoice links are found from the full orders (an order invoiced with its tab links to the tab's invoice), then
    // only the link is kept with what the customer sees.
    const decoded = page.map((row) => decode<Order>(row) as Order & { id: string; tabClearedId?: string });
    const linked = !customer?.hidePrices && await customersSeeInvoices(env) ? await invoiceLinks(env, decoded) : decoded;
    const visible = linked.map((order) => { const shown = visibleOrder(order as Order & Versioned); const invoice = (order as { invoice?: unknown }).invoice; return invoice ? { ...shown, invoice } : shown; });
    return json({ orders: visible, count: total?.n || 0, nextCursor: rows.results.length > 200 && last ? `${last.updated_at}:${last.id}` : null });
  }
  if (/^images\/[a-f0-9]{32}$/.test(route) && req.method === "GET") return serveCatalogueImage(env, route.slice("images/".length), user.role === "wholesale" ? user.customerId : null);
  if (route === "orders" && req.method === "POST") return createOrder(req, env, user, links, ctx);
  // A customer changes or skips a delivery of their own standing order while it's still New.
  const changeMatch = /^orders\/(WS-[A-F0-9]{32})\/(lines|skip)$/.exec(route);
  if (changeMatch && user.role === "wholesale" && ((changeMatch[2] === "lines" && req.method === "PUT") || (changeMatch[2] === "skip" && req.method === "POST"))) {
    const owner = await wholesaleCustomer(env, user.customerId);
    if (!owner || owner.status === "On hold") throw new ApiError(403, "account_on_hold", "Your account is on hold. Contact Strangers about this order.");
    const body = await readJson(req, 32 * 1024), id = changeMatch[1], by = { customerId: user.customerId, minimumGrams: minimumOrderGrams(env, owner) };
    // Strangers is warned when the delivery was already being prepared or was ready to go.
    const wasStatus = (await get<Order>(env, "order", id))?.status;
    const already = wasStatus === "Preparing" || wasStatus === "Ready" ? wasStatus : undefined;
    const saved = changeMatch[2] === "lines"
      ? await amendLines(env, id, body, user.name, by)
      : await skipRun(env, id, body, user.name, by, ctx);
    const { change, nextDispatchDate } = await standingChange(env, saved as any, changeMatch[2] as "lines" | "skip", body);
    const diary = new URL(links.diary || "/", req.url).href;
    await notifyCustomerChange(env, ctx, saved as any, change, diary, already);
    await notifySlackChange(env, ctx, { ...(saved as any), nextDispatchDate, already }, change, diary);
    return json({ order: visibleOrder(saved as Order & Versioned) });
  }
  const match = /^orders\/((?:PREVIEW|WS)-[A-F0-9]{32})$/.exec(route);
  if (match && req.method === "GET") {
    const order = await get<Order>(env, "order", match[1]);
    const permitted = order && (user.role === "wholesale" ? order.customerId === user.customerId && order.preview === false : order.createdBy === user.id || user.role === "admin");
    if (!order || order.deletedAt != null || !permitted) throw new ApiError(404, "not_found", "Order not found.");
    return json({ order: visibleOrder(order, user.role === "admin"), preview: order.preview !== false });
  }
  throw new ApiError(404, "not_found", "Unknown wholesale ordering route.");
}

/** Management is part of the existing admin app and uses its admin-only API boundary. */
/** Orders to print or count: customer orders with the given statuses (no previews or removed orders, oldest first, up
 * to 500), or exactly the picked ids (up to 200, in the order given). Shared by Admin and the staff orders page. */
export async function ordersToPrint(env: Env, query: URLSearchParams, { customerOnly = false } = {}): Promise<(Order & Versioned)[]> {
  const ids = (query.get("ids") || "").split(",").filter(Boolean), statuses = (query.get("status") || "").split(",").filter(Boolean);
  if (ids.length > 200 || ids.some((id) => !/^(?:PREVIEW|WS)-[A-F0-9]{32}$/.test(id))) throw invalid("Choose up to 200 orders to print.");
  if (!ids.length && (!statuses.length || statuses.some((value) => !STATUSES.includes(value)))) throw invalid("Choose which orders to print.");
  const rows = ids.length
    ? await env.DB.prepare(`SELECT id, data, version, updated_at FROM wholesale_preview WHERE kind = 'order' AND id IN (SELECT value FROM json_each(?)) AND json_extract(data, '$.deletedAt') IS NULL${customerOnly ? " AND json_extract(data, '$.preview') = 0" : ""}`).bind(JSON.stringify(ids)).all<Row>()
    : await env.DB.prepare(`SELECT id, data, version, updated_at FROM wholesale_preview WHERE kind = 'order' AND json_extract(data, '$.preview') = 0 AND json_extract(data, '$.deletedAt') IS NULL AND json_extract(data, '$.status') IN (${statuses.map(() => "?").join(",")}) ORDER BY json_extract(data, '$.createdAt') LIMIT 501`).bind(...statuses).all<Row>();
  if (rows.results.length > 500) throw invalid("There are more than 500 orders to print. Choose fewer.");
  const orders = rows.results.map((row) => decode<Order>(row) as Order & Versioned);
  if (ids.length) orders.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  return orders;
}

/** Changes an order's status, internal note and (optionally) tracking link, version-checked. Shared by Admin and the
 * staff orders page; only Admin may relink a staff preview to a customer. */
export async function updatePackingLine(env: Env, id: string, body: Record<string, any>) {
  const expected = version(body.ifVersion);
  const order = await get<Order>(env, "order", id);
  if (!order || order.deletedAt != null || order.preview !== false) throw new ApiError(404, "not_found", "Order not found.");
  if (order.version !== expected) throw new ApiError(409, "conflict", "This order changed. Review the latest packing list before checking any more bags.");
  if (order.status !== "Preparing") throw new ApiError(409, "packing_closed", "Start preparing this order before checking off its bags.");
  const inRange = (line: unknown): line is number => Number.isSafeInteger(line) && (line as number) >= 0 && (line as number) < order.lines.length;
  let marks: Set<number>;
  if (Array.isArray(body.packedLines)) {
    // The whole set of ticked lines at once: what a phone sends after several quick ticks, or "Mark all coffees as bagged".
    if (body.packedLines.length > order.lines.length || !body.packedLines.every(inRange) || new Set(body.packedLines).size !== body.packedLines.length) throw invalid("Choose lines from this order's packing list.");
    marks = new Set(body.packedLines);
  } else {
    if (!inRange(body.line) || typeof body.packed !== "boolean") throw invalid("Choose a line from this order's packing list.");
    marks = new Set(order.packedLines || []);
    if (body.packed) marks.add(body.line);
    else marks.delete(body.line);
  }
  const next = [...marks].sort((a, b) => a - b), now = [...(order.packedLines || [])].sort((a, b) => a - b);
  if (next.join() === now.join()) return order;
  const { id: savedId, version: oldVersion, updatedAt, ...data } = order;
  return save(env, "order", savedId, { ...data, packedLines: next }, expected);
}

export async function updateOrderStatus(env: Env, id: string, body: Record<string, any>, actor: string, { allowRelink = false, customerOnly = false, allowSchedule = false, notify }: { allowRelink?: boolean; customerOnly?: boolean; allowSchedule?: boolean; notify?: { ctx?: ExecutionContext; ordersUrl: string } } = {}): Promise<Order & Versioned> {
  const order = await get<Order>(env, "order", id);
  if (!order || order.deletedAt != null || (customerOnly && order.preview !== false)) throw new ApiError(404, "not_found", "Order not found.");
  if (!STATUSES.includes(body.status)) throw invalid("Choose a listed order status.");
  const expected = version(body.ifVersion);
  if (order.version !== expected) throw new ApiError(409, "conflict", "This order changed on another device. Reload it before saving.");
  if (body.requirePacked === true && (order.preview !== false || body.status !== "Ready" || order.status !== "Preparing" ||
      !order.lines.length || !order.lines.every((_, index) => order.packedLines?.includes(index)))) {
    throw new ApiError(409, "packing_incomplete", "Check off every coffee line before marking this order ready.");
  }
  let customerId = order.customerId ?? null;
  if (allowRelink) {
    customerId = body.customerId ?? null;
    if (customerId !== null && (typeof customerId !== "string" || !await get<Customer>(env, "customer", customerId))) throw invalid("Choose an existing wholesale customer.");
    if (order.preview === false && customerId !== order.customerId) throw invalid("Customer orders stay linked to the business that placed them.");
  }
  const { id: savedId, version: oldVersion, updatedAt, ...current } = order;
  const note = body.note === undefined ? order.note || "" : text(body.note, "order note", 1000);
  // Dispatch day and standing order: Admin only (the staff orders page never sends `schedule`).
  const schedule = allowSchedule ? scheduleFields(order, body.schedule) : null;
  // The first time a customer order is marked Dispatched, the customer is emailed (shipped or collected); recorded on
  // a unique durable event so going back and forth never sends it twice.
  const firstDispatch = body.status === "Dispatched" && order.status !== "Dispatched" && order.preview === false && !order.dispatchEmailedAt;
  // A collection order marked Ready: the customer is told it's ready to collect from the Roastery (the owner's request,
  // 23 Nov 2026). Never for delivery orders; once per order ("ready:<id>"), however often it goes back and forth.
  const firstReady = body.status === "Ready" && order.status !== "Ready" && order.preview === false && !isWholesaleDelivery(order.delivery);
  const suppliedTracking = body.trackingUrl === undefined ? order.trackingUrl || "" : trackingUrl(body.trackingUrl);
  const handover = body.status === "Dispatched" && order.status !== "Dispatched" && order.preview === false &&
    customerId && isWholesaleDelivery(order.delivery) ? await resolveWholesaleHandover(env, order, suppliedTracking) : null;
  const guard = handover?.guard;
  const data: Order = { ...current, ...(schedule || {}), status: body.status, customerId, note, trackingUrl: handover?.trackingUrl ?? suppliedTracking };
  if (data.status === "New" || data.status === "Cancelled") delete data.packedLines;
  if (data.status === "Dispatched") { if (order.status !== "Dispatched" || !data.dispatchedAt) data.dispatchedAt = Date.now(); }
  else delete data.dispatchedAt;
  for (const key of ["dispatchDate", "standing"] as const) if (data[key] === undefined) delete data[key];
  if (!data.standing) { delete data.standingIssue; delete data.standingRetryAt; }
  const emailKind = firstDispatch ? "dispatch" : firstReady ? "ready" : null;
  const outgoing = emailKind && notify ? await (emailKind === "ready" ? prepareReadyEmail : prepareDispatchEmail)(
    env, { ...data, id, shippingDestination: handover?.destination }, notify.ordersUrl,
  ) : null;
  let updated: Order & Versioned;
  let emailQueued = false;
  if (outgoing || guard) {
    const at = Date.now();
    // The dispatch event and order update use the same order and shipment conditions in one transaction.
    const write = env.DB.prepare(`UPDATE wholesale_preview SET data=?,version=version+1,updated_at=?
      WHERE kind='order' AND id=? AND version=? AND json_extract(data,'$.deletedAt') IS NULL${guard?.sql ?? ""}`)
      .bind(JSON.stringify(data), at, id, expected, ...(guard?.args ?? []));
    const writes = outgoing ? await env.DB.batch([dispatchEvent(env, id, expected, outgoing, emailKind!, guard), write]) : [await write.run()];
    if (!writes[writes.length - 1].meta.changes) {
      if (guard && (await get<Order>(env, "order", id))?.version === expected) {
        throw new ApiError(409, "royal_mail_handover_review", "Royal Mail shipping changed while confirming dispatch. Review the shipment and try again.");
      }
      throw new ApiError(409, "conflict", "This order changed on another device. Reload it before saving.");
    }
    emailQueued = !!outgoing && !!writes[0].meta.changes;
    updated = { ...data, id, version: expected + 1, updatedAt: at };
  } else updated = await save(env, "order", id, data, expected);
  await audit(env, order.preview === false ? "wholesale_order_status" : "wholesale_preview_status", actor,
    `${actor} marked ${order.preview === false ? "wholesale" : "staff preview"} order ${id} as ${body.status}.${emailQueued ? " Customer email queued." : ""}`);
  if ((body.status === "Dispatched" || emailQueued && emailKind === "ready") && notify) {
    const key = (body.status === "Dispatched" ? "dispatch:" : "ready:") + id;
    const delivery = wakeIntegration(env.DISPATCH_EMAIL_QUEUE, { key }, () => deliverDispatchEmails(env, key)).catch(() => {});
    if (notify.ctx) notify.ctx.waitUntil(delivery); else await delivery;
  }
  // Automatic invoicing (src/autoInvoice.ts) invoices a customer order when it goes out; the five-minute job catches any
  // dispatched without a page to wait on.
  if (body.status === "Dispatched" && order.status !== "Dispatched" && order.preview === false && notify) await startAutoInvoice(env, "order:" + id, notify.ctx);
  // A standing run that went out (or was skipped) makes the next one, which also records it on this order.
  await rollStanding(env, updated, actor, notify?.ctx);
  if (updated.standing && ["Dispatched", "Cancelled"].includes(updated.status)) return (await get<Order>(env, "order", id))!;
  return updated as Order & Versioned;
}

export async function handleWholesaleAdmin(req: Request, env: Env, route: string, user: User, links: Links, ctx?:ExecutionContext): Promise<Response> {
  const quickbooks = await handleQuickBooks(req, env, route, user, ctx); if (quickbooks) return quickbooks;
  if (user.role !== "admin") throw denied();
  if (route === "royal-mail" || route === "royal-mail/credentials") {
    return handleRoyalMailSettings(req, env, user.name, route === "royal-mail/credentials");
  }
  const shipping = ROYAL_MAIL_ORDER_ROUTE.exec(route);
  if (shipping) return handleWholesaleRoyalMail(req, env, shipping[1], shipping[2], user);
  if (route.startsWith("invoicing/")) {
    const action = route.slice("invoicing/".length);
    const workspace = await handleBillingAccounts(req, env, action, user)
      || await handleBatches(req, env, action, user) || await handleReconciliation(req, env, action, user)
      || await handleQuickBooksMatches(req, env, action, user);
    if (!workspace) throw new ApiError(404, "not_found", "Invoicing action not found.");
    return workspace;
  }
  const reminders = await handleInvoiceReminders(req, env, route, user);
  if (reminders) return reminders;
  const invoiceResponse = await handleInvoiceAdmin(req, env, route, user.name);
  if (invoiceResponse) return invoiceResponse;
  const autoInvoicing = await handleAutoInvoiceAdmin(req, env, route, user, ctx);
  if (autoInvoicing) return autoInvoicing;
  const announcement = await handleAnnouncementAdmin(req, env, route, user.name);
  if (announcement) return announcement;
  const orderEmails = await handleOrderEmailsAdmin(req, env, route, user.name, links.diary, ctx);
  if (orderEmails) return orderEmails;
  const insightsResponse = await handleInsights(req, env, route, user.name);
  if (insightsResponse) return insightsResponse;
  if (route === "" && req.method === "GET") {
    const standingIssues = await env.DB.prepare("SELECT id,json_extract(data,'$.business') AS business,COUNT(*) OVER() AS count FROM wholesale_preview WHERE kind='order' AND json_extract(data,'$.preview')=0 AND json_extract(data,'$.deletedAt') IS NULL AND json_extract(data,'$.standingIssue') IS NOT NULL AND json_extract(data,'$.status') IN ('Dispatched','Cancelled') ORDER BY updated_at DESC LIMIT 20").all<{ id: string; business: string; count: number }>();
    const [orderPage, customerPage, products, counts, stats] = await Promise.all([
      adminWholesalePage<Order>(env, "order"), adminWholesalePage<Customer>(env, "customer"), catalogue(env, true),
      env.DB.prepare("SELECT kind, COUNT(*) AS n FROM wholesale_preview WHERE kind <> 'order' OR json_extract(data, '$.deletedAt') IS NULL GROUP BY kind").all<{ kind: string; n: number }>(),
      adminWholesaleStats(env),
    ]);
    return json({ standingIssues: standingIssues.results, minimumOrderGrams: standardMinimum(env), orders: orderPage.records.map((order) => visibleOrder(order, true)), customers: customerPage.records.map(locationDefaults), orderCursor: orderPage.nextCursor, customerCursor: customerPage.nextCursor, stats: { ...stats, totalCustomers: customerPage.count, visibleCoffees: products.filter((product) => product.active).length, totalCoffees: products.length }, accounts: await wholesaleAccounts(env), products, paymentTermChoices: PAYMENT_TERMS, statuses: STATUSES, sourceDate: catalogueRetrievedAt, counts: Object.fromEntries(counts.results.map((row) => [row.kind, row.n])), links: { ...links, preview: links.preview || "/wholesale/" }, preview: true, stage: "beta" });
  }
  // Orders to print (packing sheets and bag totals): customer orders by status, or the orders an admin picked.
  if (route === "orders/print" && req.method === "GET") {
    const orders = (await ordersToPrint(env, new URL(req.url).searchParams)).map((order) => visibleOrder(order, true));
    return json({ orders, printedAt: Date.now() });
  }
  if (route === "orders/packing-totals" && req.method === "GET") return json(await packingTotals(env, new URL(req.url).searchParams));
  const packingOrder = /^orders\/(WS-[A-F0-9]{32})\/packing$/.exec(route);
  if (packingOrder && req.method === "PATCH") {
    return json({ order: visibleOrder(await updatePackingLine(env, packingOrder[1], object(await readJson(req, 2048))), true) });
  }
  if ((route === "orders" || route === "customers") && req.method === "GET") {
    const query = new URL(req.url).searchParams;
    if (route === "orders") {
      const page = await adminWholesalePage<Order>(env, "order", query);
      return json({ orders: page.records.map((order) => visibleOrder(order, true)), nextCursor: page.nextCursor, count: page.count });
    }
    const page = await adminWholesalePage<Customer>(env, "customer", query);
    const ids = new Set(page.records.map((customer) => customer.id));
    return json({ customers: page.records.map(locationDefaults), accounts: (await wholesaleAccounts(env)).filter((account) => ids.has(account.customerId)), nextCursor: page.nextCursor, count: page.count });
  }
  const catalogueResponse = await handleCatalogueAdmin(req, env, route, user.name);
  if (catalogueResponse) return catalogueResponse;
  const accountMatch = /^customers\/([a-f0-9-]{36})\/account(\/reset-password)?$/.exec(route);
  if (accountMatch && ((accountMatch[2] && req.method === "POST") || (!accountMatch[2] && ["POST", "PUT"].includes(req.method)))) return manageWholesaleAccount(req, env, accountMatch[1], !!accountMatch[2], user.name);
  // Customer tabs (also on the staff orders page): list, put an order on or off, clear.
  if (route === "tabs" && req.method === "GET") return json(await listTabs(env, { admin: true }));
  const tabOrder = /^orders\/(WS-[A-F0-9]{32})\/tab$/.exec(route), tabClear = /^tabs\/([a-f0-9-]{36})\/clear$/.exec(route);
  if (tabOrder && req.method === "PUT") return json({ order: visibleOrder(await setOnTab(env, tabOrder[1], await readJson(req, 4096), user.name) as Order & Versioned, true) });
  if (tabClear && req.method === "POST") { const cleared = await clearTab(env, tabClear[1], await readJson(req, 64 * 1024), user.name, { admin: true }); await startAutoInvoice(env, "tab:" + cleared.id, ctx); return json({ cleared }); }
  // Every business's name, for choosing who a white-label coffee belongs to.
  if (route === "customers/names" && req.method === "GET") {
    const rows = await env.DB.prepare("SELECT id, json_extract(data, '$.business') AS business FROM wholesale_preview WHERE kind = 'customer' ORDER BY business COLLATE NOCASE").all<{ id: string; business: string }>();
    return json({ customers: rows.results.map((r) => ({ id: r.id, business: r.business || "" })) });
  }
  // QuickBooks customer import and invites to order online (src/wholesaleImport.ts).
  if (route === "customers/invites" && req.method === "GET") return json({ invites: await inviteStates(env) });
  if (route === "customers/import" && req.method === "POST") return json(await importCustomers(env, await readJson(req, 512 * 1024), user.name));
  if (route === "customers/accounts-emails" && req.method === "POST") return json(await matchAccountsEmails(env, await readJson(req, 512 * 1024), user.name));
  const inviteOne = /^customers\/([a-f0-9-]{36})\/invite$/.exec(route);
  if ((inviteOne || route === "customers/invites") && req.method === "POST") {
    const ids: unknown = inviteOne ? [inviteOne[1]] : (await readJson<Record<string, unknown>>(req, 64 * 1024))?.customerIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 25 || ids.some((x) => typeof x !== "string" || !/^[a-f0-9-]{36}$/.test(x))) throw invalid("Choose from 1 to 25 businesses to invite.");
    const replyTo = (await orderEmailSettings(env)).to[0] || DEFAULT_ORDER_EMAIL;
    const signin = customerOrdersUrl(env, links, req).replace(/#orders$/, "signin");
    const results: Record<string, string> = {};
    for (const id of ids as string[]) { results[id] = await inviteCustomer(env, id, user.name, signin, replyTo); if (results[id] === "limit" || results[id] === "off") break; }
    return json({ results, invites: await inviteStates(env) });
  }
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) throw new ApiError(404, "not_found", "Unknown wholesale management route.");
  const customerMatch = /^customers\/([a-f0-9-]{36})$/.exec(route);
  const customerWrite = (route === "customers" && req.method === "POST") || (customerMatch && req.method === "PUT");
  const body = object(await readJson(req, (customerWrite || route.endsWith("/lines") ? 64 : 16) * 1024));
  if (customerWrite) {
    const expected = customerMatch ? version(body.ifVersion) : 0;
    const oldCustomer = customerMatch ? await get<Customer>(env, "customer", customerMatch[1]) : null;
    if (customerMatch && !oldCustomer) throw new ApiError(404, "not_found", "Customer not found.");
    if (oldCustomer && expected !== oldCustomer.version) throw new ApiError(409, "conflict", "This business changed on another device. Reload it before saving.");
    const business = text(body.business, "business name", 120, true);
    const email = text(body.email, "email", 150);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("Check the contact email.");
    if (body.status !== "Active" && body.status !== "On hold") throw invalid("Choose Active or On hold.");
    const paymentTerms = body.paymentTerms === undefined ? oldCustomer?.paymentTerms || "to-agree" : body.paymentTerms;
    if (typeof paymentTerms !== "string" || !PAYMENT_TERMS.some((term) => term.id === paymentTerms)) throw invalid("Choose listed payment terms.");
    const data: Customer = { business, email, contact: text(body.contact, "contact name", 120), phone: body.phone === undefined ? oldCustomer?.phone || "" : text(body.phone, "phone number", 40), address: body.address === undefined ? oldCustomer?.address || "" : text(body.address, "delivery address", 500), postcode: body.postcode === undefined ? oldCustomer?.postcode || "" : text(body.postcode, "postcode", 20), deliveryNotes: body.deliveryNotes === undefined ? oldCustomer?.deliveryNotes || "" : text(body.deliveryNotes, "delivery notes", 1000), status: body.status, note: text(body.note, "account note", 1000), locations: oldCustomer?.locations, defaultLocationId: oldCustomer?.defaultLocationId };
    data.paymentTerms = paymentTerms;
    const accountsEmail = accountsEmailFrom(body.accountsEmail, oldCustomer?.accountsEmail);
    if (accountsEmail) data.accountsEmail = accountsEmail;
    if (body.noMinimumOrder !== undefined && typeof body.noMinimumOrder !== "boolean") throw invalid("Choose whether this business has a minimum order.");
    if (body.noMinimumOrder ?? oldCustomer?.noMinimumOrder) data.noMinimumOrder = true;
    if (body.hidePrices !== undefined && typeof body.hidePrices !== "boolean") throw invalid("Choose whether this business sees prices.");
    if (body.hidePrices ?? oldCustomer?.hidePrices) data.hidePrices = true;
    if (body.autoTab !== undefined && typeof body.autoTab !== "boolean") throw invalid("Choose whether this business's orders go on a tab.");
    if (body.autoTab ?? oldCustomer?.autoTab) data.autoTab = true;
    if (body.noInvoice !== undefined && typeof body.noInvoice !== "boolean") throw invalid("Choose whether this business is ever invoiced.");
    if (body.noInvoice ?? oldCustomer?.noInvoice) data.noInvoice = true;
    if (body.freeDelivery !== undefined && typeof body.freeDelivery !== "boolean") throw invalid("Choose whether this business gets free delivery.");
    if (body.freeDelivery ?? oldCustomer?.freeDelivery) data.freeDelivery = true;
    if (oldCustomer?.quickbooksName) data.quickbooksName = oldCustomer.quickbooksName;
    data.paymentNote = body.paymentNote === undefined ? oldCustomer?.paymentNote || "" : text(body.paymentNote, "payment instructions", 500);
    if (paymentTerms === "custom" && !data.paymentNote.trim()) throw invalid("Add the agreed custom payment terms in payment instructions.");
    const customer = await save(env, "customer", customerMatch?.[1] || crypto.randomUUID(), editedCustomerLocations(data, body, oldCustomer?.business), expected);
    await audit(env, "wholesale_preview_customer", user.name, `${user.name} ${customerMatch ? "updated" : "added"} wholesale customer ${business}.`);
    return json({ customer: locationDefaults(customer) }, customerMatch ? 200 : 201);
  }
  const orderMatch = /^orders\/((?:PREVIEW|WS)-[A-F0-9]{32})$/.exec(route);
  if (orderMatch && req.method === "DELETE") {
    const order = await get<Order>(env, "order", orderMatch[1]);
    if (!order || order.deletedAt != null) throw new ApiError(404, "not_found", "Order not found.");
    const { id, version: oldVersion, updatedAt, ...current } = order;
    const removed = await save(env, "order", id, { ...current, deletedAt: Date.now(), deletedBy: user.name }, version(body.ifVersion));
    await audit(env, "wholesale_order_deleted", user.name, `${user.name} removed wholesale ${order.preview === false ? "customer" : "staff preview"} order ${id}.`);
    return json({ deleted: true, id, version: removed.version });
  }
  const linesMatch = /^orders\/(WS-[A-F0-9]{32})\/lines$/.exec(route);
  if (linesMatch && req.method === "PUT") {
    const saved = await amendLines(env, linesMatch[1], body, user.name);
    await tellCustomerStandingChange(env, ctx, saved, "lines", body, customerOrdersUrl(env, links, req), new URL(links.diary || "/", req.url).href, user.name);
    return json({ order: visibleOrder(saved as Order & Versioned, true) });
  }
  const skipMatch = /^orders\/(WS-[A-F0-9]{32})\/skip$/.exec(route);
  if (skipMatch && req.method === "POST") {
    const saved = await skipRun(env, skipMatch[1], body, user.name, {}, ctx);
    await tellCustomerStandingChange(env, ctx, saved, "skip", body, customerOrdersUrl(env, links, req), new URL(links.diary || "/", req.url).href, user.name);
    return json({ order: visibleOrder(saved as Order & Versioned, true) });
  }
  if (orderMatch && req.method === "PATCH") {
    const updated = await updateOrderStatus(env, orderMatch[1], body, user.name, { allowRelink: true, allowSchedule: true, notify: { ctx, ordersUrl: customerOrdersUrl(env, links, req) } });
    return json({ order: visibleOrder(updated, true) });
  }
  throw new ApiError(404, "not_found", "Unknown wholesale management route.");
}
