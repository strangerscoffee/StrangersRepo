import { handleQuickBooks } from "./quickbooks/index";
// Wholesale beta: real customer orders and isolated staff test orders. Payments and fulfilment are managed by the team.
import { validGrindId } from "../public/wholesale-preview/grinds.js";
import { shippingFor } from "../public/wholesale-preview/shipping.js";
import { MAX_QUANTITY } from "../public/wholesale-preview/limits.js";
import { catalogueRetrievedAt } from "../public/wholesale-preview/catalogue.js";
import type { User } from "./auth";
import { object, text, version, decode, get, save, type Row, type Versioned } from "./wholesaleStore";
import { catalogue, handleCatalogueAdmin, serveCatalogueImage } from "./wholesaleCatalogue";
import { adminWholesalePage, adminWholesaleStats } from "./wholesaleAdminLists";
import { audit } from "./audit";
import { ApiError, type Env, invalid, json, readJson } from "./http";
import { manageWholesaleAccount, publicCustomer, wholesaleAccounts, wholesaleCustomer, paymentTermsFor, PAYMENT_TERMS, type Customer, type OrderingUser } from "./wholesaleAccounts";
import { customerLocations, editedCustomerLocations, locationDefaults, validLocationId, type CustomerLocation } from "./wholesaleCustomers";
import { handleInvoiceAdmin, handleInvoiceCustomer, invoiceLinks } from "./wholesaleInvoices";

type Pack = "quarter" | "half" | "kilo";
const PACKS: Record<Pack, { label: string; grams: number }> = { quarter: { label: "250 g bag", grams: 250 }, half: { label: "500 g bag", grams: 500 }, kilo: { label: "1 kg bag", grams: 1000 } };
// 500 g bags are no longer sold or priced: kept above only so past orders and their exact retries still read; refused for new orders.
const ORDERABLE_PACKS: Pack[] = ["quarter", "kilo"]; // checked before any price is read (the catalogue has none for 500 g)
const STATUSES = ["New", "Preparing", "Ready", "Dispatched", "Cancelled"];
interface Line { productId: string; title: string; pack: Pack; packLabel: string; grind: string; grindLabel: string; quantity: number; price: number; grams: number }
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
}
type Links = { admin: string; diary: string; preview?: string };
const denied = () => new ApiError(403, "permission_denied", "Only admins can manage wholesale ordering.");
function visibleOrder(order: Order & Versioned, admin = false) {
  const { requestKey, note, ...visible } = order;
  return admin ? { ...visible, trackingUrl: order.trackingUrl || "", note } : { ...visible, trackingUrl: order.trackingUrl || "" };
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
  return {
    id: `PREVIEW-${body.requestId.replaceAll("-", "").toUpperCase()}`,
    lines: lines.sort((a, b) => `${a.productId}:${a.pack}:${a.grind}`.localeCompare(`${b.productId}:${b.pack}:${b.grind}`)),
    delivery: body.delivery as string, reference: text(body.reference, "purchase reference", 80), business: text(body.business, "business name", 120),
    ...(locationId === undefined ? {} : { locationId }),
  };
}
async function createOrder(req: Request, env: Env, user: OrderingUser): Promise<Response> {
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
    if (!product) throw invalid("Choose a listed coffee.");
    if (!product.inStock) throw new ApiError(409, "out_of_stock", `${product.name} is out of stock. Remove it from your basket to continue.`);
    if (!ORDERABLE_PACKS.includes(line.pack)) throw new ApiError(409, "pack_unavailable", `${PACKS[line.pack].label}s are no longer available. Remove the ${PACKS[line.pack].label} of ${product.name} from your basket and choose 250 g or 1 kg.`);
    if (!product.active) throw new ApiError(409, "conflict", `${product.name} is no longer in the catalogue. Reload your basket.`);
    if (line.price !== product.prices[line.pack as "quarter" | "kilo"]) throw new ApiError(409, "conflict", "The prices have changed. Reload and review your order again.");
    const grind = product.grindOptions.find(option => option.id === line.grind && option.enabled);
    if (!grind) throw new ApiError(409, "grind_unavailable", `${product.name} no longer offers this grind. Remove it from your basket and choose an available option.`);
    return { ...line, title: product.title, packLabel: PACKS[line.pack].label, grindLabel: grind.label, price: product.prices[line.pack as "quarter" | "kilo"], grams: PACKS[line.pack].grams };
  });
  const at = Date.now();
  const customerSnapshot = customer && location ? (() => {
    const { locations, defaultLocationId, ...profile } = publicCustomer(customer);
    return { ...profile, contact: location.contact, phone: location.phone, address: location.address, postcode: location.postcode, deliveryNotes: location.deliveryNotes };
  })() : undefined;
  const order: Order = {
    createdBy: user.id, createdName: user.name, business: body.business, reference: body.reference, delivery: body.delivery,
    customerId: customer?.id || null, status: "New", note: "", trackingUrl: "", preview: !customer, ...(customer && location ? { customerSnapshot, deliveryNotes: location.deliveryNotes, paymentTerms: paymentTermsFor(customer), locationId: location.id, locationSnapshot: { ...location } } : {}), date: new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(new Date(at)),
    createdAt: at, requestKey, lines,
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
  return json({ order: visibleOrder(saved), preview: !customer }, 201);
}

/** All staff can browse the signed-in catalogue and save preview orders. They cannot read others' records. */
export async function handleWholesale(req: Request, env: Env, route: string, user: OrderingUser, links: Links): Promise<Response> {
  const invoiceResponse = await handleInvoiceCustomer(req, env, route, user);
  if (invoiceResponse) return invoiceResponse;
  const customer = user.role === "wholesale" ? await wholesaleCustomer(env, user.customerId) : null;
  if ((route === "catalogue" || route === "session") && req.method === "GET") return json({ ...(route === "catalogue" ? { products: await catalogue(env), sourceDate: catalogueRetrievedAt } : {}), stage: "beta", me: user, customer: customer ? publicCustomer(customer) : null, links: { ...(user.role === "wholesale" ? {} : links), preview: links.preview || "/wholesale-preview/" }, preview: user.role !== "wholesale" });
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
    return json({ orders: await invoiceLinks(env, page.map((row) => visibleOrder(decode<Order>(row)))), count: total?.n || 0, nextCursor: rows.results.length > 200 && last ? `${last.updated_at}:${last.id}` : null });
  }
  if (/^images\/[a-f0-9]{32}$/.test(route) && req.method === "GET") return serveCatalogueImage(env, route.slice("images/".length));
  if (route === "orders" && req.method === "POST") return createOrder(req, env, user);
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
export async function handleWholesaleAdmin(req: Request, env: Env, route: string, user: User, links: Links, ctx?:ExecutionContext): Promise<Response> {
  const quickbooks = await handleQuickBooks(req, env, route, user, ctx); if (quickbooks) return quickbooks;
  if (user.role !== "admin") throw denied();
  const invoiceResponse = await handleInvoiceAdmin(req, env, route, user.name);
  if (invoiceResponse) return invoiceResponse;
  if (route === "" && req.method === "GET") {
    const [orderPage, customerPage, products, counts, stats] = await Promise.all([
      adminWholesalePage<Order>(env, "order"), adminWholesalePage<Customer>(env, "customer"), catalogue(env, true),
      env.DB.prepare("SELECT kind, COUNT(*) AS n FROM wholesale_preview WHERE kind <> 'order' OR json_extract(data, '$.deletedAt') IS NULL GROUP BY kind").all<{ kind: string; n: number }>(),
      adminWholesaleStats(env),
    ]);
    return json({ orders: orderPage.records.map((order) => visibleOrder(order, true)), customers: customerPage.records.map(locationDefaults), orderCursor: orderPage.nextCursor, customerCursor: customerPage.nextCursor, stats: { ...stats, totalCustomers: customerPage.count, visibleCoffees: products.filter((product) => product.active).length, totalCoffees: products.length }, accounts: await wholesaleAccounts(env), products, paymentTermChoices: PAYMENT_TERMS, statuses: STATUSES, sourceDate: catalogueRetrievedAt, counts: Object.fromEntries(counts.results.map((row) => [row.kind, row.n])), links: { ...links, preview: links.preview || "/wholesale-preview/" }, preview: true, stage: "beta" });
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
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) throw new ApiError(404, "not_found", "Unknown wholesale management route.");
  const customerMatch = /^customers\/([a-f0-9-]{36})$/.exec(route);
  const customerWrite = (route === "customers" && req.method === "POST") || (customerMatch && req.method === "PUT");
  const body = object(await readJson(req, (customerWrite ? 64 : 16) * 1024));
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
  if (orderMatch && req.method === "PATCH") {
    const order = await get<Order>(env, "order", orderMatch[1]);
    if (!order || order.deletedAt != null) throw new ApiError(404, "not_found", "Order not found.");
    if (!STATUSES.includes(body.status)) throw invalid("Choose a listed order status.");
    const customerId = body.customerId ?? null;
    if (customerId !== null && (typeof customerId !== "string" || !await get<Customer>(env, "customer", customerId))) throw invalid("Choose an existing wholesale customer.");
    if (order.preview === false && customerId !== order.customerId) throw invalid("Customer orders stay linked to the business that placed them.");
    const { id, version: oldVersion, updatedAt, ...current } = order;
    const updated = await save(env, "order", id, { ...current, status: body.status, customerId, note: text(body.note, "order note", 1000), trackingUrl: body.trackingUrl === undefined ? order.trackingUrl || "" : trackingUrl(body.trackingUrl) }, version(body.ifVersion));
    await audit(env, "wholesale_preview_status", user.name, `${user.name} marked wholesale order ${id} as ${body.status}. No fulfilment action was sent.`);
    return json({ order: visibleOrder(updated, true) });
  }
  throw new ApiError(404, "not_found", "Unknown wholesale management route.");
}
