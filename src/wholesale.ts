import { handleQuickBooks } from "./quickbooks/index";
// Wholesale beta: real customer orders and isolated staff test orders. Payments and fulfilment are managed by the team.
import { validGrindId } from "../public/wholesale-preview/grinds.js";
import { shippingFor } from "../public/wholesale-preview/shipping.js";
import { MAX_QUANTITY, MINIMUM_ORDER_GRAMS } from "../public/wholesale-preview/limits.js";
import { catalogueRetrievedAt } from "../public/wholesale-preview/catalogue.js";
import type { User } from "./auth";
import { object, text, version, decode, get, save, type Row, type Versioned } from "./wholesaleStore";
import { catalogue, handleCatalogueAdmin, serveCatalogueImage } from "./wholesaleCatalogue";
import { adminWholesalePage, adminWholesaleStats } from "./wholesaleAdminLists";
import { audit } from "./audit";
import { ApiError, type Env, invalid, json, readJson } from "./http";
import { manageWholesaleAccount, publicCustomer, wholesaleAccounts, wholesaleCustomer, paymentTermsFor, PAYMENT_TERMS, type Customer, type OrderingUser } from "./wholesaleAccounts";
import { customerLocations, editedCustomerLocations, locationDefaults, validLocationId, type CustomerLocation } from "./wholesaleCustomers";
import { confirmToCustomer, dispatchToCustomer, handleOrderEmailsAdmin, notifyNewOrder, orderEmailSettings } from "./email/orders";
import { notifySlackNewOrder } from "./slackOrders";
import { handleInsights } from "./insights";
import { autoTabFor, clearTab, listTabs, setOnTab } from "./wholesaleTabs";
import { importCustomers, inviteCustomer, inviteStates } from "./wholesaleImport";
import { canOrder, catalogueFor, customerLines, recipeText } from "./wholesaleWhiteLabel";
import { amendLines, rollStanding, scheduleFields, type Standing } from "./wholesaleStanding";
import { customersSeeInvoices, handleInvoiceAdmin, handleInvoiceCustomer, invoiceLinks } from "./wholesaleInvoices";

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
  /** Delivery charge in pence including VAT, fixed when the order was placed (absent on orders from before it was automatic). */
  deliveryPence?: number; totalPence?: number;
  preview?: boolean; customerSnapshot?: Omit<ReturnType<typeof publicCustomer>, "locations" | "defaultLocationId">; deliveryNotes?: string;
  paymentTerms?: ReturnType<typeof paymentTermsFor>;
  locationId?: string; locationSnapshot?: CustomerLocation;
  deletedAt?: number; deletedBy?: string;
  trackingUrl?: string;
  /** The customer's own optional note at checkout ("Use our own custom labels"); shown back to them, unlike the internal `note`. */
  customerNote?: string;
  /** When the customer was emailed that it was shipped or collected (once). */
  dispatchEmailedAt?: number;
  /** On the customer's open tab (src/wholesaleTabs.ts), and the cleared tab it went into. Staff/admin only. */
  tab?: { at: number; by: string; auto?: boolean }; tabClearedId?: string;
  /** Admin only to set (src/wholesaleStanding.ts): the day it's due to go out, and the standing order it belongs to. */
  dispatchDate?: string; standing?: Standing; nextRunId?: string; previousRunId?: string;
  /** When an admin changed the bags; `originalLines` are the bags as first placed. */
  amendedAt?: number; amendedBy?: string; originalLines?: Line[];
}
type Links = { admin: string; diary: string; preview?: string };
/** My orders on the customer ordering site, for links in customers' emails (…/#orders opens it). */
export function customerOrdersUrl(env: Env, links: { preview?: string }, req: Request) {
  const site = /^https?:\/\//.test(links.preview || "") ? links.preview! : env.PREVIEW_HOST ? `https://${env.PREVIEW_HOST}/` : new URL("/wholesale-preview/", req.url).href;
  return site.replace(/\/?$/, "/") + "#orders";
}
const denied = () => new ApiError(403, "permission_denied", "Only admins can manage wholesale ordering.");
export function visibleOrder(order: Order & Versioned, admin = false) {
  const { requestKey, note, tab, tabClearedId, amendedBy, ...visible } = order;
  return admin ? { ...visible, trackingUrl: order.trackingUrl || "", note, ...(tab ? { tab } : {}), ...(tabClearedId ? { tabClearedId } : {}), ...(amendedBy ? { amendedBy } : {}) } : { ...visible, lines: customerLines(visible.lines)!, ...(visible.originalLines ? { originalLines: customerLines(visible.originalLines) } : {}), trackingUrl: order.trackingUrl || "" };
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
function orderBody(value: unknown) {
  const body = object(value);
  if (typeof body.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId)) throw invalid("Send a unique requestId for this order.");
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 150) throw invalid("Choose from 1 to 150 coffee variants.");
  const lines: { productId: string; pack: Pack; grind: string; quantity: number; price: number }[] = [];
  for (const value of body.lines) {
    const line = object(value);
    if ((typeof line.productId !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(line.productId)) || typeof line.pack !== "string" || !Object.hasOwn(PACKS, line.pack) || typeof line.grind !== "string" || !validGrindId(line.grind)) throw invalid("Choose a listed coffee, bag size and grind.");
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY) throw invalid(`Choose a whole number of bags from 1 to ${MAX_QUANTITY}.`);
    if (!Number.isInteger(line.price) || line.price < 1 || line.price > 1000000) throw invalid("Check the quoted coffee price.");
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
async function createOrder(req: Request, env: Env, user: OrderingUser, links: Links, ctx?: ExecutionContext): Promise<Response> {
  const submitted = object(await readJson(req, 32 * 1024));
  if (submitted.orderingIdentity !== undefined && submitted.orderingIdentity !== user.id) throw new ApiError(409, "account_changed", "The signed-in account changed. Reload ordering before placing an order.");
  const body = orderBody(submitted);
  const customer = user.role === "wholesale" ? await wholesaleCustomer(env, user.customerId) : null;
  if (user.role === "wholesale") {
    if (!customer) throw new ApiError(403, "permission_denied", "Your wholesale account is unavailable. Contact Strangers.");
    body.id = body.id.replace("PREVIEW-", "WS-");
    body.business = customer.business;
  }
  // Retrying a customer request still finds its original snapshot if business details changed meanwhile.
  const request = user.role === "wholesale" ? { ...body, business: user.customerId } : body;
  const requestKey = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(request))))].map((n) => n.toString(16).padStart(2, "0")).join("");
  const existing = await get<Order>(env, "order", body.id);
  if (existing) {
    if (existing.createdBy !== user.id || existing.requestKey !== requestKey) throw new ApiError(409, "conflict", "That requestId has already been used for another order.");
    if (existing.deletedAt != null) throw new ApiError(410, "order_deleted", "This order was removed by Strangers. Close this review and review your basket before placing a new order.");
    return json({ order: visibleOrder(existing), preview: existing.preview !== false });
  }
  if (customer?.status === "On hold") throw new ApiError(403, "account_on_hold", "Your account is on hold. Contact Strangers before placing an order.");
  const location = customer ? customerLocations(customer).find((location) => location.id === (body.locationId || "primary")) : null;
  if (customer && location && body.delivery === "Delivery" && (!location.address.trim() || !location.postcode.trim())) throw invalid("Add the selected location's delivery address and postcode in My account before ordering delivery.");
  if (customer && !Number.isSafeInteger(submitted.customerVersion)) throw new ApiError(409, "account_changed", "Reload the page to update ordering, then review your basket again.");
  if (customer && submitted.customerVersion !== customer.version) throw new ApiError(409, "account_changed", "Your business details or payment terms changed. Close this review and review your basket again.");
  if (customer && !location) throw invalid("Choose a location saved to your business.");
  if (!customer && body.locationId !== undefined) throw invalid("Saved locations are available for wholesale customer accounts.");
  const coffees = await catalogue(env);
  const lines = body.lines.map((line): Line => {
    const product = coffees.find((product) => product.id === line.productId);
    if (!product || !canOrder(product, customer?.id || null)) throw invalid("Choose a listed coffee.");
    if (!product.inStock) throw new ApiError(409, "out_of_stock", `${product.name} is out of stock. Remove it from your basket to continue.`);
    if (!ORDERABLE_PACKS.includes(line.pack)) throw new ApiError(409, "pack_unavailable", `${PACKS[line.pack].label}s are no longer available. Remove the ${PACKS[line.pack].label} of ${product.name} from your basket and choose 250 g or 1 kg.`);
    if (!product.active) throw new ApiError(409, "conflict", `${product.name} is no longer in the catalogue. Reload your basket.`);
    if (line.price !== product.prices[line.pack as "quarter" | "kilo"]) throw new ApiError(409, "conflict", "The prices have changed. Reload and review your order again.");
    const grind = product.grindOptions.find(option => option.id === line.grind && option.enabled);
    if (!grind) throw new ApiError(409, "grind_unavailable", `${product.name} no longer offers this grind. Remove it from your basket and choose an available option.`);
    return { ...line, title: product.title, packLabel: PACKS[line.pack].label, grindLabel: grind.label, grindHint: grind.hint || "", decaf: product.categories.includes("decaf"), price: product.prices[line.pack as "quarter" | "kilo"], grams: PACKS[line.pack].grams, ...(product.recipe?.length ? { recipe: recipeText(product) } : {}) };
  });
  // After the retry check above, so an order already placed is still returned if the minimum changes later.
  const minimum = minimumOrderGrams(env, customer), grams = lines.reduce((sum, line) => sum + line.grams * line.quantity, 0);
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
    pence: lines.reduce((sum, line) => sum + line.price * line.quantity, 0), grams: lines.reduce((sum, line) => sum + line.grams * line.quantity, 0), packs: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
  order.deliveryPence = shippingFor(order.delivery, order.pence);
  order.totalPence = order.pence + order.deliveryPence;
  let saved;
  try { saved = await save(env, "order", body.id, order, 0); }
  catch (error) {
    if (!(error instanceof ApiError) || error.code !== "conflict") throw error;
    const raced = await get<Order>(env, "order", body.id);
    if (!raced || raced.createdBy !== user.id || raced.requestKey !== requestKey) throw error;
    if (raced.deletedAt != null) throw new ApiError(410, "order_deleted", "This order was removed by Strangers. Close this review and review your basket before placing a new order.");
    return json({ order: visibleOrder(raced), preview: raced.preview !== false });
  }
  await audit(env, customer ? "wholesale_order" : "wholesale_preview_order", user.name, `${user.name} placed ${customer ? "wholesale" : "staff preview"} order ${body.id}.`);
  // A new customer order (never a staff preview or a retry, which returned above) is emailed to Strangers.
  if (customer) {
    await notifyNewOrder(env, ctx, saved, links.diary); await notifySlackNewOrder(env, ctx, saved, links.diary);
    // And the customer gets their own confirmation, linking back to My orders on the ordering site.
    await confirmToCustomer(env, ctx, saved, { showPrices: !customer.hidePrices, ordersUrl: customerOrdersUrl(env, links, req) });
  }
  return json({ order: visibleOrder(saved), preview: !customer }, 201);
}

/** All staff can browse the signed-in catalogue and save preview orders. They cannot read others' records. */
export async function handleWholesale(req: Request, env: Env, route: string, user: OrderingUser, links: Links, ctx?: ExecutionContext): Promise<Response> {
  const invoiceResponse = await handleInvoiceCustomer(req, env, route, user);
  if (invoiceResponse) return invoiceResponse;
  const customer = user.role === "wholesale" ? await wholesaleCustomer(env, user.customerId) : null;
  if ((route === "catalogue" || route === "session") && req.method === "GET") return json({ ...(route === "catalogue" ? { products: catalogueFor(await catalogue(env), user.role === "wholesale" ? user.customerId : null), sourceDate: catalogueRetrievedAt } : {}), stage: "beta", invoices: await customersSeeInvoices(env), minimumOrderGrams: minimumOrderGrams(env, customer), showPrices: !customer?.hidePrices, me: user, customer: customer ? publicCustomer(customer) : null, links: { ...(user.role === "wholesale" ? {} : links), preview: links.preview || "/wholesale-preview/" }, preview: user.role !== "wholesale" });
  if (route === "account" && req.method === "PUT" && customer) {
    const body = object(await readJson(req, 64 * 1024));
    if (body.orderingIdentity !== undefined && body.orderingIdentity !== user.id) throw new ApiError(409, "account_changed", "The signed-in account changed. Reload ordering before saving business details.");
    if (body.business !== undefined && text(body.business, "business name", 120, true) !== customer.business) throw new ApiError(403, "permission_denied", "Only Strangers admins can change the registered business name. Contact the team to update it.");
    const expected = version(body.ifVersion);
    if (expected !== customer.version) throw new ApiError(409, "conflict", "This business changed on another device. Reload it before saving.");
    const email = body.email === undefined ? customer.email : text(body.email, "email", 150);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("Check the contact email.");
    const { id, version: oldVersion, updatedAt, ...current } = customer;
    const data = editedCustomerLocations({ ...current, business: customer.business, contact: body.contact === undefined ? customer.contact : text(body.contact, "contact name", 120), email, phone: body.phone === undefined ? customer.phone || "" : text(body.phone, "phone number", 40), address: body.address === undefined ? customer.address || "" : text(body.address, "delivery address", 500), postcode: body.postcode === undefined ? customer.postcode || "" : text(body.postcode, "postcode", 20), deliveryNotes: body.deliveryNotes === undefined ? customer.deliveryNotes || "" : text(body.deliveryNotes, "delivery notes", 1000) }, body);
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
    const visible = page.map((row) => visibleOrder(decode<Order>(row)));
    return json({ orders: await customersSeeInvoices(env) ? await invoiceLinks(env, visible) : visible, count: total?.n || 0, nextCursor: rows.results.length > 200 && last ? `${last.updated_at}:${last.id}` : null });
  }
  if (/^images\/[a-f0-9]{32}$/.test(route) && req.method === "GET") return serveCatalogueImage(env, route.slice("images/".length), user.role === "wholesale" ? user.customerId : null);
  if (route === "orders" && req.method === "POST") return createOrder(req, env, user, links, ctx);
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
    ? await env.DB.prepare(`SELECT id, data, version, updated_at FROM wholesale_preview WHERE kind = 'order' AND id IN (${ids.map(() => "?").join(",")}) AND json_extract(data, '$.deletedAt') IS NULL${customerOnly ? " AND json_extract(data, '$.preview') = 0" : ""}`).bind(...ids).all<Row>()
    : await env.DB.prepare(`SELECT id, data, version, updated_at FROM wholesale_preview WHERE kind = 'order' AND json_extract(data, '$.preview') = 0 AND json_extract(data, '$.deletedAt') IS NULL AND json_extract(data, '$.status') IN (${statuses.map(() => "?").join(",")}) ORDER BY json_extract(data, '$.createdAt') LIMIT 501`).bind(...statuses).all<Row>();
  if (rows.results.length > 500) throw invalid("There are more than 500 orders to print. Choose fewer.");
  const orders = rows.results.map((row) => decode<Order>(row) as Order & Versioned);
  if (ids.length) orders.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  return orders;
}

/** Changes an order's status, internal note and (optionally) tracking link, version-checked. Shared by Admin and the
 * staff orders page; only Admin may relink a staff preview to a customer. */
export async function updateOrderStatus(env: Env, id: string, body: Record<string, any>, actor: string, { allowRelink = false, customerOnly = false, allowSchedule = false, notify }: { allowRelink?: boolean; customerOnly?: boolean; allowSchedule?: boolean; notify?: { ctx?: ExecutionContext; ordersUrl: string } } = {}): Promise<Order & Versioned> {
  const order = await get<Order>(env, "order", id);
  if (!order || order.deletedAt != null || (customerOnly && order.preview !== false)) throw new ApiError(404, "not_found", "Order not found.");
  if (!STATUSES.includes(body.status)) throw invalid("Choose a listed order status.");
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
  // the order so going back and forth never sends it twice.
  const firstDispatch = body.status === "Dispatched" && order.status !== "Dispatched" && order.preview === false && !order.dispatchEmailedAt;
  const data: Order = { ...current, ...(schedule || {}), status: body.status, customerId, note, trackingUrl: body.trackingUrl === undefined ? order.trackingUrl || "" : trackingUrl(body.trackingUrl), ...(firstDispatch && notify ? { dispatchEmailedAt: Date.now() } : {}) };
  for (const key of ["dispatchDate", "standing"] as const) if (data[key] === undefined) delete data[key];
  const updated = await save(env, "order", id, data, version(body.ifVersion));
  if (firstDispatch && notify) await dispatchToCustomer(env, notify.ctx, updated, notify.ordersUrl);
  await audit(env, "wholesale_preview_status", actor, `${actor} marked wholesale order ${id} as ${body.status}. No fulfilment action was sent.`);
  // A standing run that went out (or was skipped) makes the next one, which also records it on this order.
  if (await rollStanding(env, updated, actor)) return (await get<Order>(env, "order", id))!;
  return updated as Order & Versioned;
}

export async function handleWholesaleAdmin(req: Request, env: Env, route: string, user: User, links: Links, ctx?:ExecutionContext): Promise<Response> {
  const quickbooks = await handleQuickBooks(req, env, route, user, ctx); if (quickbooks) return quickbooks;
  if (user.role !== "admin") throw denied();
  const invoiceResponse = await handleInvoiceAdmin(req, env, route, user.name);
  if (invoiceResponse) return invoiceResponse;
  const orderEmails = await handleOrderEmailsAdmin(req, env, route, user.name, links.diary);
  if (orderEmails) return orderEmails;
  const insightsResponse = await handleInsights(req, env, route, user.name);
  if (insightsResponse) return insightsResponse;
  if (route === "" && req.method === "GET") {
    const [orderPage, customerPage, products, counts, stats] = await Promise.all([
      adminWholesalePage<Order>(env, "order"), adminWholesalePage<Customer>(env, "customer"), catalogue(env, true),
      env.DB.prepare("SELECT kind, COUNT(*) AS n FROM wholesale_preview WHERE kind <> 'order' OR json_extract(data, '$.deletedAt') IS NULL GROUP BY kind").all<{ kind: string; n: number }>(),
      adminWholesaleStats(env),
    ]);
    return json({ minimumOrderGrams: standardMinimum(env), orders: orderPage.records.map((order) => visibleOrder(order, true)), customers: customerPage.records.map(locationDefaults), orderCursor: orderPage.nextCursor, customerCursor: customerPage.nextCursor, stats: { ...stats, totalCustomers: customerPage.count, visibleCoffees: products.filter((product) => product.active).length, totalCoffees: products.length }, accounts: await wholesaleAccounts(env), products, paymentTermChoices: PAYMENT_TERMS, statuses: STATUSES, sourceDate: catalogueRetrievedAt, counts: Object.fromEntries(counts.results.map((row) => [row.kind, row.n])), links: { ...links, preview: links.preview || "/wholesale-preview/" }, preview: true, stage: "beta" });
  }
  // Orders to print (packing sheets and bag totals): customer orders by status, or the orders an admin picked.
  if (route === "orders/print" && req.method === "GET") {
    const orders = (await ordersToPrint(env, new URL(req.url).searchParams)).map((order) => visibleOrder(order, true));
    return json({ orders, printedAt: Date.now() });
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
  if (tabClear && req.method === "POST") return json({ cleared: await clearTab(env, tabClear[1], await readJson(req, 64 * 1024), user.name, { admin: true }) });
  // Every business's name, for choosing who a white-label coffee belongs to.
  if (route === "customers/names" && req.method === "GET") {
    const rows = await env.DB.prepare("SELECT id, json_extract(data, '$.business') AS business FROM wholesale_preview WHERE kind = 'customer' ORDER BY business COLLATE NOCASE").all<{ id: string; business: string }>();
    return json({ customers: rows.results.map((r) => ({ id: r.id, business: r.business || "" })) });
  }
  // QuickBooks customer import and invites to order online (src/wholesaleImport.ts).
  if (route === "customers/invites" && req.method === "GET") return json({ invites: await inviteStates(env) });
  if (route === "customers/import" && req.method === "POST") return json(await importCustomers(env, await readJson(req, 512 * 1024), user.name));
  const inviteOne = /^customers\/([a-f0-9-]{36})\/invite$/.exec(route);
  if ((inviteOne || route === "customers/invites") && req.method === "POST") {
    const ids: unknown = inviteOne ? [inviteOne[1]] : (await readJson<Record<string, unknown>>(req, 64 * 1024))?.customerIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 25 || ids.some((x) => typeof x !== "string" || !/^[a-f0-9-]{36}$/.test(x))) throw invalid("Choose from 1 to 25 businesses to invite.");
    const replyTo = (await orderEmailSettings(env)).to[0] || "sales@strangerscoffee.com";
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
    if (body.noMinimumOrder !== undefined && typeof body.noMinimumOrder !== "boolean") throw invalid("Choose whether this business has a minimum order.");
    if (body.noMinimumOrder ?? oldCustomer?.noMinimumOrder) data.noMinimumOrder = true;
    if (body.hidePrices !== undefined && typeof body.hidePrices !== "boolean") throw invalid("Choose whether this business sees prices.");
    if (body.hidePrices ?? oldCustomer?.hidePrices) data.hidePrices = true;
    if (body.autoTab !== undefined && typeof body.autoTab !== "boolean") throw invalid("Choose whether this business's orders go on a tab.");
    if (body.autoTab ?? oldCustomer?.autoTab) data.autoTab = true;
    if (oldCustomer?.quickbooksName) data.quickbooksName = oldCustomer.quickbooksName;
    data.paymentNote = body.paymentNote === undefined ? oldCustomer?.paymentNote || "" : text(body.paymentNote, "payment instructions", 500);
    if (paymentTerms === "custom" && !data.paymentNote.trim()) throw invalid("Add the agreed custom payment terms in payment instructions.");
    const customer = await save(env, "customer", customerMatch?.[1] || crypto.randomUUID(), editedCustomerLocations(data, body), expected);
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
  if (linesMatch && req.method === "PUT") return json({ order: visibleOrder(await amendLines(env, linesMatch[1], body, user.name) as Order & Versioned, true) });
  if (orderMatch && req.method === "PATCH") {
    const updated = await updateOrderStatus(env, orderMatch[1], body, user.name, { allowRelink: true, allowSchedule: true, notify: { ctx, ordersUrl: customerOrdersUrl(env, links, req) } });
    return json({ order: visibleOrder(updated, true) });
  }
  throw new ApiError(404, "not_found", "Unknown wholesale management route.");
}
