// Shared, signed-in wholesale PREVIEW. No payments, emails or fulfilment actions are performed.
import { catalogueRetrievedAt } from "../public/wholesale-preview/catalogue.js";
import type { User } from "./auth";
import { object, text, version, decode, get, list, save, type Row, type Versioned } from "./wholesaleStore";
import { catalogue, handleCatalogueAdmin, serveCatalogueImage } from "./wholesaleCatalogue";
import { audit } from "./audit";
import { ApiError, type Env, invalid, json, readJson } from "./http";
import { manageWholesaleAccount, publicCustomer, wholesaleAccounts, wholesaleCustomer, paymentTermsFor, PAYMENT_TERMS, type Customer, type OrderingUser } from "./wholesaleAccounts";

type Pack = "quarter" | "half" | "kilo";
const PACKS: Record<Pack, { label: string; grams: number }> = { quarter: { label: "250 g bag", grams: 250 }, half: { label: "500 g bag", grams: 500 }, kilo: { label: "1 kg bag", grams: 1000 } };
const GRINDS: Record<string, string> = { beans: "Beans", espresso: "Espresso / Fine", moka: "Moka Pot / Fine", filter: "Filter / Medium", cafetiere: "Cafetiere / Coarse" };
const STATUSES = ["New", "Preparing", "Ready", "Dispatched", "Cancelled"];
interface Line { productId: string; title: string; pack: Pack; packLabel: string; grind: string; grindLabel: string; quantity: number; price: number; grams: number }
interface Order {
  createdBy: string; createdName: string; business: string; reference: string; delivery: string;
  customerId: string | null; status: string; note: string; date: string; createdAt: number;
  requestKey: string; lines: Line[]; pence: number; grams: number; packs: number;
  preview?: boolean; customerSnapshot?: ReturnType<typeof publicCustomer>; deliveryNotes?: string;
  paymentTerms?: ReturnType<typeof paymentTermsFor>;
}
type Links = { admin: string; diary: string; preview?: string };
const denied = () => new ApiError(403, "permission_denied", "Only admins can manage the wholesale preview.");
function visibleOrder(order: Order & Versioned, admin = false) {
  const { requestKey, note, ...visible } = order;
  return admin ? { ...visible, note } : visible;
}
function orderBody(value: unknown) {
  const body = object(value);
  if (typeof body.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId)) throw invalid("Send a unique requestId for this preview order.");
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 150) throw invalid("Choose from 1 to 150 coffee variants.");
  const lines: { productId: string; pack: Pack; grind: string; quantity: number; price: number }[] = [];
  for (const value of body.lines) {
    const line = object(value);
    if ((typeof line.productId !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(line.productId)) || typeof line.pack !== "string" || !Object.hasOwn(PACKS, line.pack) || typeof line.grind !== "string" || !Object.hasOwn(GRINDS, line.grind)) throw invalid("Choose a listed coffee, bag size and grind.");
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) throw invalid("Choose a whole number of bags from 1 to 99.");
    if (!Number.isInteger(line.price) || line.price < 1 || line.price > 1000000) throw invalid("Check the quoted coffee price.");
    const previous = lines.find((item) => item.productId === line.productId && item.pack === line.pack && item.grind === line.grind);
    if (previous) {
      if (previous.price !== line.price || previous.quantity + line.quantity > 99) throw invalid("Each coffee, weight and grind can have at most 99 bags at one price.");
      previous.quantity += line.quantity;
    } else lines.push({ productId: line.productId, pack: line.pack as Pack, grind: line.grind, quantity: line.quantity, price: line.price });
  }
  if (body.delivery !== "Delivery" && body.delivery !== "Roastery collection") throw invalid("Choose delivery or roastery collection.");
  return {
    id: `PREVIEW-${body.requestId.replaceAll("-", "").toUpperCase()}`,
    lines: lines.sort((a, b) => `${a.productId}:${a.pack}:${a.grind}`.localeCompare(`${b.productId}:${b.pack}:${b.grind}`)),
    delivery: body.delivery as string, reference: text(body.reference, "purchase reference", 80), business: text(body.business, "business name", 120),
  };
}
async function createOrder(req: Request, env: Env, user: OrderingUser): Promise<Response> {
  const submitted = object(await readJson(req, 32 * 1024));
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
    if (existing.createdBy !== user.id || existing.requestKey !== requestKey) throw new ApiError(409, "conflict", "That requestId has already been used for another preview order.");
    return json({ order: visibleOrder(existing), preview: existing.preview !== false });
  }
  if (customer?.status === "On hold") throw new ApiError(403, "account_on_hold", "Your account is on hold. Contact Strangers before placing an order.");
  if (customer && body.delivery === "Delivery" && (!customer.address?.trim() || !customer.postcode?.trim())) throw invalid("Add your delivery address and postcode in My account before ordering delivery.");
  if (customer && !Number.isSafeInteger(submitted.customerVersion)) throw new ApiError(409, "account_changed", "Reload the page to update ordering, then review your basket again.");
  if (customer && submitted.customerVersion !== customer.version) throw new ApiError(409, "account_changed", "Your business details or payment terms changed. Close this review and review your basket again.");
  const coffees = await catalogue(env);
  const lines = body.lines.map((line): Line => {
    const product = coffees.find((product) => product.id === line.productId);
    if (!product) throw invalid("Choose a listed coffee.");
    if (!product.inStock) throw new ApiError(409, "out_of_stock", `${product.name} is out of stock. Remove it from your basket to continue.`);
    if (!product.active) throw new ApiError(409, "conflict", `${product.name} is no longer in the preview catalogue. Reload your basket.`);
    if (line.price !== product.prices[line.pack]) throw new ApiError(409, "conflict", "The preview prices have changed. Reload and review your order again.");
    return { ...line, title: product.title, packLabel: PACKS[line.pack].label, grindLabel: GRINDS[line.grind], price: product.prices[line.pack], grams: PACKS[line.pack].grams };
  });
  const at = Date.now();
  const order: Order = {
    createdBy: user.id, createdName: user.name, business: body.business, reference: body.reference, delivery: body.delivery,
    customerId: customer?.id || null, status: "New", note: "", preview: !customer, ...(customer ? { customerSnapshot: publicCustomer(customer), deliveryNotes: customer.deliveryNotes || "", paymentTerms: paymentTermsFor(customer) } : {}), date: new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(new Date(at)),
    createdAt: at, requestKey, lines,
    pence: lines.reduce((sum, line) => sum + line.price * line.quantity, 0), grams: lines.reduce((sum, line) => sum + line.grams * line.quantity, 0), packs: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
  let saved;
  try { saved = await save(env, "order", body.id, order, 0); }
  catch (error) {
    if (!(error instanceof ApiError) || error.code !== "conflict") throw error;
    const raced = await get<Order>(env, "order", body.id);
    if (!raced || raced.createdBy !== user.id || raced.requestKey !== requestKey) throw error;
    return json({ order: visibleOrder(raced), preview: raced.preview !== false });
  }
  await audit(env, customer ? "wholesale_order" : "wholesale_preview_order", user.name, `${user.name} placed ${customer ? "wholesale" : "staff preview"} order ${body.id}.`);
  return json({ order: visibleOrder(saved), preview: !customer }, 201);
}

/** All staff can browse the signed-in catalogue and save preview orders. They cannot read others' records. */
export async function handleWholesale(req: Request, env: Env, route: string, user: OrderingUser, links: Links): Promise<Response> {
  const customer = user.role === "wholesale" ? await wholesaleCustomer(env, user.customerId) : null;
  if ((route === "catalogue" || route === "session") && req.method === "GET") return json({ ...(route === "catalogue" ? { products: await catalogue(env), sourceDate: catalogueRetrievedAt } : {}), me: user, customer: customer ? publicCustomer(customer) : null, links: { ...(user.role === "wholesale" ? {} : links), preview: links.preview || "/wholesale-preview/" }, preview: user.role !== "wholesale" });
  if (route === "account" && req.method === "PUT" && customer) {
    const body = object(await readJson(req, 8192));
    const email = text(body.email, "email", 150);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("Check the contact email.");
    const { id, version: oldVersion, updatedAt, ...current } = customer;
    const saved = await save(env, "customer", id, { ...current, business: text(body.business, "business name", 120, true), contact: text(body.contact, "contact name", 120), email, phone: text(body.phone, "phone number", 40), address: text(body.address, "delivery address", 500), postcode: text(body.postcode, "postcode", 20), deliveryNotes: text(body.deliveryNotes, "delivery notes", 1000) }, version(body.ifVersion));
    await audit(env, "wholesale_profile", user.name, `${user.name} updated their wholesale business details.`);
    return json({ customer: publicCustomer(saved) });
  }
  if (route === "orders" && req.method === "GET") {
    const sql = user.role === "wholesale"
      ? "SELECT id, data, version, updated_at FROM wholesale_preview WHERE kind = 'order' AND json_extract(data, '$.customerId') = ? AND json_extract(data, '$.preview') = 0 ORDER BY updated_at DESC LIMIT 200"
      : "SELECT id, data, version, updated_at FROM wholesale_preview WHERE kind = 'order' AND json_extract(data, '$.createdBy') = ? ORDER BY updated_at DESC LIMIT 200";
    const rows = await env.DB.prepare(sql).bind(user.role === "wholesale" ? user.customerId : user.id).all<Row>();
    return json({ orders: rows.results.map((row) => visibleOrder(decode<Order>(row))) });
  }
  if (/^images\/[a-f0-9]{32}$/.test(route) && req.method === "GET") return serveCatalogueImage(env, route.slice("images/".length));
  if (route === "orders" && req.method === "POST") return createOrder(req, env, user);
  const match = /^orders\/((?:PREVIEW|WS)-[A-F0-9]{32})$/.exec(route);
  if (match && req.method === "GET") {
    const order = await get<Order>(env, "order", match[1]);
    const permitted = order && (user.role === "wholesale" ? order.customerId === user.customerId && order.preview === false : order.createdBy === user.id || user.role === "admin");
    if (!order || !permitted) throw new ApiError(404, "not_found", "Order not found.");
    return json({ order: visibleOrder(order, user.role === "admin"), preview: order.preview !== false });
  }
  throw new ApiError(404, "not_found", "Unknown wholesale preview route.");
}

/** Management is part of the existing admin app and uses its admin-only API boundary. */
export async function handleWholesaleAdmin(req: Request, env: Env, route: string, user: User, links: Links): Promise<Response> {
  if (user.role !== "admin") throw denied();
  if (route === "" && req.method === "GET") {
    const [orders, customers, products, counts] = await Promise.all([
      list<Order>(env, "order"), list<Customer>(env, "customer"), catalogue(env, true),
      env.DB.prepare("SELECT kind, COUNT(*) AS n FROM wholesale_preview GROUP BY kind").all<{ kind: string; n: number }>(),
    ]);
    return json({ orders: orders.map((order) => visibleOrder(order, true)), customers, accounts: await wholesaleAccounts(env), products, paymentTermChoices: PAYMENT_TERMS, statuses: STATUSES, sourceDate: catalogueRetrievedAt, counts: Object.fromEntries(counts.results.map((row) => [row.kind, row.n])), links: { ...links, preview: links.preview || "/wholesale-preview/" }, preview: true });
  }
  const catalogueResponse = await handleCatalogueAdmin(req, env, route, user.name);
  if (catalogueResponse) return catalogueResponse;
  const accountMatch = /^customers\/([a-f0-9-]{36})\/account(\/reset-password)?$/.exec(route);
  if (accountMatch && ((accountMatch[2] && req.method === "POST") || (!accountMatch[2] && ["POST", "PUT"].includes(req.method)))) return manageWholesaleAccount(req, env, accountMatch[1], !!accountMatch[2], user.name);
  if (!["POST", "PUT", "PATCH"].includes(req.method)) throw new ApiError(404, "not_found", "Unknown wholesale management route.");
  const body = object(await readJson(req, 16 * 1024));
  const customerMatch = /^customers\/([a-f0-9-]{36})$/.exec(route);
  if ((route === "customers" && req.method === "POST") || (customerMatch && req.method === "PUT")) {
    const expected = customerMatch ? version(body.ifVersion) : 0;
    const oldCustomer = customerMatch ? await get<Customer>(env, "customer", customerMatch[1]) : null;
    if (customerMatch && !oldCustomer) throw new ApiError(404, "not_found", "Customer not found.");
    const business = text(body.business, "business name", 120, true);
    const email = text(body.email, "email", 150);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("Check the contact email.");
    if (body.status !== "Active" && body.status !== "On hold") throw invalid("Choose Active or On hold.");
    const paymentTerms = body.paymentTerms === undefined ? oldCustomer?.paymentTerms || "to-agree" : body.paymentTerms;
    if (typeof paymentTerms !== "string" || !PAYMENT_TERMS.some((term) => term.id === paymentTerms)) throw invalid("Choose listed payment terms.");
    const data: Customer = { business, email, contact: text(body.contact, "contact name", 120), phone: body.phone === undefined ? oldCustomer?.phone || "" : text(body.phone, "phone number", 40), address: body.address === undefined ? oldCustomer?.address || "" : text(body.address, "delivery address", 500), postcode: body.postcode === undefined ? oldCustomer?.postcode || "" : text(body.postcode, "postcode", 20), deliveryNotes: body.deliveryNotes === undefined ? oldCustomer?.deliveryNotes || "" : text(body.deliveryNotes, "delivery notes", 1000), status: body.status, note: text(body.note, "account note", 1000) };
    data.paymentTerms = paymentTerms;
    data.paymentNote = body.paymentNote === undefined ? oldCustomer?.paymentNote || "" : text(body.paymentNote, "payment instructions", 500);
    if (paymentTerms === "custom" && !data.paymentNote.trim()) throw invalid("Add the agreed custom payment terms in payment instructions.");
    const customer = await save(env, "customer", customerMatch?.[1] || crypto.randomUUID(), data, expected);
    await audit(env, "wholesale_preview_customer", user.name, `${user.name} ${customerMatch ? "updated" : "added"} wholesale preview customer ${business}.`);
    return json({ customer }, customerMatch ? 200 : 201);
  }
  const orderMatch = /^orders\/((?:PREVIEW|WS)-[A-F0-9]{32})$/.exec(route);
  if (orderMatch && req.method === "PATCH") {
    const order = await get<Order>(env, "order", orderMatch[1]);
    if (!order) throw new ApiError(404, "not_found", "Preview order not found.");
    if (!STATUSES.includes(body.status)) throw invalid("Choose a listed preview order status.");
    const customerId = body.customerId ?? null;
    if (customerId !== null && (typeof customerId !== "string" || !await get<Customer>(env, "customer", customerId))) throw invalid("Choose an existing preview customer.");
    if (order.preview === false && customerId !== order.customerId) throw invalid("Customer orders stay linked to the business that placed them.");
    const { id, version: oldVersion, updatedAt, ...current } = order;
    const updated = await save(env, "order", id, { ...current, status: body.status, customerId, note: text(body.note, "order note", 1000) }, version(body.ifVersion));
    await audit(env, "wholesale_preview_status", user.name, `${user.name} marked wholesale preview order ${id} as ${body.status}. No fulfilment action was sent.`);
    return json({ order: visibleOrder(updated, true) });
  }
  throw new ApiError(404, "not_found", "Unknown wholesale management route.");
}
