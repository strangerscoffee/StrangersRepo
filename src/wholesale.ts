// Shared, signed-in wholesale PREVIEW. No payments, emails or fulfilment actions are performed.
import { products as sourceProducts, catalogueRetrievedAt, type SourceCoffee } from "../public/wholesale-preview/catalogue.js";
import type { User } from "./auth";
import { audit } from "./audit";
import { ApiError, type Env, invalid, json, readJson } from "./http";

type Kind = "order" | "customer" | "catalogue";
type Pack = "quarter" | "half" | "kilo";
const PACKS: Record<Pack, { label: string; grams: number }> = { quarter: { label: "250 g bag", grams: 250 }, half: { label: "500 g bag", grams: 500 }, kilo: { label: "1 kg bag", grams: 1000 } };
const GRINDS: Record<string, string> = { beans: "Beans", espresso: "Espresso / Fine", moka: "Moka Pot / Fine", filter: "Filter / Medium", cafetiere: "Cafetiere / Coarse" };
const STATUSES = ["New", "Preparing", "Ready", "Dispatched", "Cancelled"];
interface Row { id: string; data: string; version: number; updated_at: number }
interface Versioned { id: string; version: number; updatedAt: number }
interface CatalogueSettings { prices: Record<Pack, number>; active: boolean }
type Coffee = SourceCoffee & { active: boolean; version: number };
interface Customer { business: string; contact: string; email: string; status: "Active" | "On hold"; note: string }
interface Line { productId: string; title: string; pack: Pack; packLabel: string; grind: string; grindLabel: string; quantity: number; price: number; grams: number }
interface Order {
  createdBy: string; createdName: string; business: string; reference: string; delivery: string;
  customerId: string | null; status: string; note: string; date: string; createdAt: number;
  requestKey: string; lines: Line[]; pence: number; grams: number; packs: number;
}
type Links = { admin: string; diary: string; preview?: string };
const denied = () => new ApiError(403, "permission_denied", "Only admins can manage the wholesale preview.");
const conflict = () => new ApiError(409, "conflict", "This record changed on another device. Reload it before saving.");
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Send a JSON object.");
  return value as Record<string, any>;
};
function text(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) throw invalid(`Check ${label} (maximum ${max} characters).`);
  return value.trim();
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid("Send the record's ifVersion.");
  return value as number;
}
const decode = <T>(row: Row): T & Versioned => ({ ...JSON.parse(row.data), id: row.id, version: row.version, updatedAt: row.updated_at });
async function get<T>(env: Env, kind: Kind, id: string): Promise<(T & Versioned) | null> {
  const row = await env.DB.prepare("SELECT id, data, version, updated_at FROM wholesale_preview WHERE kind = ? AND id = ?").bind(kind, id).first<Row>();
  return row ? decode<T>(row) : null;
}
async function list<T>(env: Env, kind: Kind, limit = 200): Promise<(T & Versioned)[]> {
  const rows = await env.DB.prepare("SELECT id, data, version, updated_at FROM wholesale_preview WHERE kind = ? ORDER BY updated_at DESC, id LIMIT ?").bind(kind, limit).all<Row>();
  return rows.results.map((row) => decode<T>(row));
}
async function save<T extends object>(env: Env, kind: Kind, id: string, data: T, expected: number): Promise<T & Versioned> {
  const at = Date.now();
  const result = expected === 0
    ? await env.DB.prepare("INSERT INTO wholesale_preview (kind, id, data, version, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(kind, id) DO NOTHING").bind(kind, id, JSON.stringify(data), at).run()
    : await env.DB.prepare("UPDATE wholesale_preview SET data = ?, version = version + 1, updated_at = ? WHERE kind = ? AND id = ? AND version = ?").bind(JSON.stringify(data), at, kind, id, expected).run();
  if (!result.meta.changes) throw conflict();
  return { ...data, id, version: expected + 1, updatedAt: at };
}
async function catalogue(env: Env): Promise<Coffee[]> {
  const settings = await list<CatalogueSettings>(env, "catalogue", 100);
  return sourceProducts.map((product) => {
    const entry = settings.find((row) => row.id === product.id);
    const prices = entry?.prices || product.prices;
    return { ...product, prices: { ...prices }, price: prices.kilo, active: entry?.active ?? true, version: entry?.version ?? 0 };
  });
}
function visibleOrder(order: Order & Versioned) {
  const { requestKey, ...visible } = order;
  return visible;
}
function orderBody(value: unknown) {
  const body = object(value);
  if (typeof body.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId)) throw invalid("Send a unique requestId for this preview order.");
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 150) throw invalid("Choose from 1 to 150 coffee variants.");
  const lines: { productId: string; pack: Pack; grind: string; quantity: number; price: number }[] = [];
  for (const value of body.lines) {
    const line = object(value);
    if (!sourceProducts.some((product) => product.id === line.productId) || typeof line.pack !== "string" || !Object.hasOwn(PACKS, line.pack) || typeof line.grind !== "string" || !Object.hasOwn(GRINDS, line.grind)) throw invalid("Choose a listed coffee, bag size and grind.");
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
async function createOrder(req: Request, env: Env, user: User): Promise<Response> {
  const body = orderBody(await readJson(req, 32 * 1024));
  const requestKey = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body))))].map((n) => n.toString(16).padStart(2, "0")).join("");
  const existing = await get<Order>(env, "order", body.id);
  if (existing) {
    if (existing.createdBy !== user.id || existing.requestKey !== requestKey) throw new ApiError(409, "conflict", "That requestId has already been used for another preview order.");
    return json({ order: visibleOrder(existing), preview: true });
  }
  const coffees = await catalogue(env);
  const lines = body.lines.map((line): Line => {
    const product = coffees.find((product) => product.id === line.productId)!;
    if (!product.active) throw new ApiError(409, "conflict", `${product.name} is no longer in the preview catalogue. Reload your basket.`);
    if (line.price !== product.prices[line.pack]) throw new ApiError(409, "conflict", "The preview prices have changed. Reload and review your order again.");
    return { ...line, title: product.title, packLabel: PACKS[line.pack].label, grindLabel: GRINDS[line.grind], price: product.prices[line.pack], grams: PACKS[line.pack].grams };
  });
  const at = Date.now();
  const order: Order = {
    createdBy: user.id, createdName: user.name, business: body.business, reference: body.reference, delivery: body.delivery,
    customerId: null, status: "New", note: "", date: new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(new Date(at)),
    createdAt: at, requestKey, lines,
    pence: lines.reduce((sum, line) => sum + line.price * line.quantity, 0), grams: lines.reduce((sum, line) => sum + line.grams * line.quantity, 0), packs: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
  let saved;
  try { saved = await save(env, "order", body.id, order, 0); }
  catch (error) {
    if (!(error instanceof ApiError) || error.code !== "conflict") throw error;
    const raced = await get<Order>(env, "order", body.id);
    if (!raced || raced.createdBy !== user.id || raced.requestKey !== requestKey) throw error;
    return json({ order: visibleOrder(raced), preview: true });
  }
  await audit(env, "wholesale_preview_order", user.name, `${user.name} saved wholesale preview order ${body.id}. No fulfilment action was sent.`);
  return json({ order: visibleOrder(saved), preview: true }, 201);
}

/** All staff can browse the signed-in catalogue and save preview orders. They cannot read others' records. */
export async function handleWholesale(req: Request, env: Env, route: string, user: User, links: Links): Promise<Response> {
  if (route === "catalogue" && req.method === "GET") return json({ products: await catalogue(env), sourceDate: catalogueRetrievedAt, me: user, links: { ...links, preview: links.preview || "/wholesale-preview/" }, preview: true });
  if (route === "orders" && req.method === "POST") return createOrder(req, env, user);
  const match = /^orders\/(PREVIEW-[A-F0-9]{32})$/.exec(route);
  if (match && req.method === "GET") {
    const order = await get<Order>(env, "order", match[1]);
    if (!order || (order.createdBy !== user.id && user.role !== "admin")) throw new ApiError(404, "not_found", "Preview order not found.");
    return json({ order: visibleOrder(order), preview: true });
  }
  throw new ApiError(404, "not_found", "Unknown wholesale preview route.");
}

/** Management is part of the existing admin app and uses its admin-only API boundary. */
export async function handleWholesaleAdmin(req: Request, env: Env, route: string, user: User, links: Links): Promise<Response> {
  if (user.role !== "admin") throw denied();
  if (route === "" && req.method === "GET") {
    const [orders, customers, products, counts] = await Promise.all([
      list<Order>(env, "order"), list<Customer>(env, "customer"), catalogue(env),
      env.DB.prepare("SELECT kind, COUNT(*) AS n FROM wholesale_preview GROUP BY kind").all<{ kind: string; n: number }>(),
    ]);
    return json({ orders: orders.map(visibleOrder), customers, products, statuses: STATUSES, sourceDate: catalogueRetrievedAt, counts: Object.fromEntries(counts.results.map((row) => [row.kind, row.n])), links: { ...links, preview: links.preview || "/wholesale-preview/" }, preview: true });
  }
  if (!["POST", "PUT", "PATCH"].includes(req.method)) throw new ApiError(404, "not_found", "Unknown wholesale management route.");
  const body = object(await readJson(req, 16 * 1024));
  const customerMatch = /^customers\/([a-f0-9-]{36})$/.exec(route);
  if ((route === "customers" && req.method === "POST") || (customerMatch && req.method === "PUT")) {
    const expected = customerMatch ? version(body.ifVersion) : 0;
    if (customerMatch && !await get<Customer>(env, "customer", customerMatch[1])) throw new ApiError(404, "not_found", "Preview customer not found.");
    const business = text(body.business, "business name", 120, true);
    const email = text(body.email, "email", 150);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("Check the contact email.");
    if (body.status !== "Active" && body.status !== "On hold") throw invalid("Choose Active or On hold.");
    const data: Customer = { business, email, contact: text(body.contact, "contact name", 120), status: body.status, note: text(body.note, "account note", 1000) };
    const customer = await save(env, "customer", customerMatch?.[1] || crypto.randomUUID(), data, expected);
    await audit(env, "wholesale_preview_customer", user.name, `${user.name} ${customerMatch ? "updated" : "added"} wholesale preview customer ${business}.`);
    return json({ customer }, customerMatch ? 200 : 201);
  }
  const productMatch = /^catalogue\/([a-z-]+)$/.exec(route);
  if (productMatch && req.method === "PUT") {
    if (!sourceProducts.some((product) => product.id === productMatch[1])) throw invalid("Unknown coffee.");
    const prices = object(body.prices);
    if (Object.keys(prices).length !== 3 || Object.keys(PACKS).some((pack) => !Number.isInteger(prices[pack]) || prices[pack] < 1 || prices[pack] > 1000000)) throw invalid("Send all three bag prices in pence, from £0.01 to £10,000.00.");
    if (typeof body.active !== "boolean") throw invalid("Choose whether this coffee is visible in the preview.");
    const product = await save<CatalogueSettings>(env, "catalogue", productMatch[1], { prices: { quarter: prices.quarter, half: prices.half, kilo: prices.kilo }, active: body.active }, version(body.ifVersion));
    await audit(env, "wholesale_preview_catalogue", user.name, `${user.name} updated wholesale preview coffee ${productMatch[1]}.`);
    return json({ product });
  }
  const orderMatch = /^orders\/(PREVIEW-[A-F0-9]{32})$/.exec(route);
  if (orderMatch && req.method === "PATCH") {
    const order = await get<Order>(env, "order", orderMatch[1]);
    if (!order) throw new ApiError(404, "not_found", "Preview order not found.");
    if (!STATUSES.includes(body.status)) throw invalid("Choose a listed preview order status.");
    const customerId = body.customerId ?? null;
    if (customerId !== null && (typeof customerId !== "string" || !await get<Customer>(env, "customer", customerId))) throw invalid("Choose an existing preview customer.");
    const { id, version: oldVersion, updatedAt, ...current } = order;
    const updated = await save(env, "order", id, { ...current, status: body.status, customerId, note: text(body.note, "order note", 1000) }, version(body.ifVersion));
    await audit(env, "wholesale_preview_status", user.name, `${user.name} marked wholesale preview order ${id} as ${body.status}. No fulfilment action was sent.`);
    return json({ order: visibleOrder(updated) });
  }
  throw new ApiError(404, "not_found", "Unknown wholesale management route.");
}
