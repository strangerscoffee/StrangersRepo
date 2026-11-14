// Catalogue edits and raster photos share the existing D1 records and FILES KV binding.
import { products as originals, type SourceCoffee } from "./wholesale/catalogue.js";
import { newId } from "./auth";
import { audit } from "./audit";
import { ApiError, type Env, invalid, json, readJson } from "./http";
import { list, object, save, text, version } from "./wholesaleStore";
import { canOrder, editedRecipe, editedWhiteLabel, isCustomCoffee } from "./wholesaleWhiteLabel";

import { defaultGrinds, validGrindId, type GrindOption } from "../public/wholesale/grinds.js";

type Prices = SourceCoffee["prices"];
interface Settings { grindOptions?: GrindOption[]; prices: Prices; active: boolean; inStock?: boolean; product?: SourceCoffee; images?: string[] }
export type Coffee = SourceCoffee & { grindOptions: GrindOption[]; active: boolean; inStock: boolean; images: string[]; imageUrls: string[]; version: number };
interface ImageMeta { contentType: string; size: number; productId: string; filename: string; by: string; at: number }
const PHOTO_PREFIX = "wholesale-image:";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 6;
const PRODUCT_ID = "([a-z][a-z0-9-]{0,79})";
const CATEGORIES = ["single-origin", "blend", "decaf"];
const missing = () => new ApiError(404, "not_found", "Coffee or photo not found.");

function decorate(product: SourceCoffee, settings: Settings | null, version: number, admin: boolean): Coffee {
  const saved = settings?.prices || product.prices;
  const prices = { quarter: saved.quarter, kilo: saved.kilo }; // a saved 500 g price (no longer sold) is dropped
  const images = settings?.images ?? (product.image ? ["source:" + product.image] : []);
  return {
    ...product, grindOptions: (settings?.grindOptions ?? defaultGrinds).map(option => ({ ...option })), prices: { ...prices }, price: prices.kilo,
    active: settings?.active ?? true, inStock: settings?.inStock ?? true, images, version,
    imageUrls: images.map((id) => id.startsWith("source:") ? "/wholesale/images/" + id.slice(7) : `/api/${admin ? "admin/" : ""}wholesale/images/` + id.slice(7)),
  };
}
export async function catalogue(env: Env, admin = false): Promise<Coffee[]> {
  const entries = await list<Settings>(env, "catalogue", 1000);
  const sourced = originals.map((source) => {
    const entry = entries.find((row) => row.id === source.id);
    return decorate(entry?.product || source, entry || null, entry?.version || 0, admin);
  });
  const added = entries.filter((row) => row.product && !originals.some((source) => source.id === row.id)).map((entry) => decorate(entry.product!, entry, entry.version, admin));
  return [...sourced, ...added];
}
function settingsFor(coffee: Coffee): Settings {
  const { active, inStock, images, imageUrls, version, grindOptions, ...product } = coffee;
  return { product, prices: product.prices, active, inStock, images, grindOptions };
}
async function write(env: Env, coffee: Coffee, expected: number): Promise<Coffee> {
  const settings = settingsFor(coffee);
  const result = await save(env, "catalogue", coffee.id, settings, expected);
  return decorate(settings.product!, settings, result.version, true);
}
/** The bag sizes a coffee is sold in: both unless it has been limited to one. */
export const packsOf = (product: { packs?: string[] }): ("quarter" | "kilo")[] => product.packs?.length === 1 && ["quarter", "kilo"].includes(product.packs[0]) ? [product.packs[0] as "quarter" | "kilo"] : ["quarter", "kilo"];
function packsFor(value: unknown): ("quarter" | "kilo")[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 2 || value.some((pack) => pack !== "quarter" && pack !== "kilo") || new Set(value).size !== value.length) throw invalid("Sell this coffee in 250 g bags, 1 kg bags or both.");
  return value.length === 1 ? [value[0]] : undefined;
}
function pricesFor(value: unknown, sold: string[] = ["quarter", "kilo"], current?: Prices): Prices {
  const prices = object(value);
  // 250 g and 1 kg. A 500 g price from an older page is ignored: 500 g bags are no longer sold.
  const valid = (pack: string) => Number.isInteger(prices[pack]) && prices[pack] >= 1 && prices[pack] <= 1000000;
  if (Object.keys(prices).some((pack) => !["quarter", "half", "kilo"].includes(pack)) || sold.some((pack) => !valid(pack))) throw invalid(sold.length === 2 ? "Send the 250 g and 1 kg bag prices in pence, from £0.01 to £10,000.00." : `Send the ${sold[0] === "kilo" ? "1 kg" : "250 g"} bag price in pence, from £0.01 to £10,000.00.`);
  // A size that isn't sold keeps a price (the one sent, the saved one, or one worked out from the other size) for when it's sold again.
  const kept = (pack: "quarter" | "kilo") => valid(pack) ? prices[pack] : current?.[pack] ?? (pack === "quarter" ? Math.max(1, Math.round(prices.kilo / 4)) : prices.quarter * 4);
  return { quarter: kept("quarter"), kilo: kept("kilo") };
}
function editedGrinds(value: unknown, previous: GrindOption[] = []): GrindOption[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw invalid("Choose between 1 and 20 grind options.");
  const options = value.map(entry => {
    const option = object(entry);
    if (!validGrindId(option.id) || typeof option.enabled !== "boolean") throw invalid("Choose a valid grind option and availability.");
    const hint = option.hint == null ? "" : text(option.hint, "grind description", 120);
    return { id: option.id as string, label: text(option.label, "grind label", 60, true), ...(hint ? { hint } : {}), enabled: option.enabled };
  });
  if (new Set(options.map(option => option.id)).size !== options.length || new Set(options.map(option => option.label.toLocaleLowerCase("en-GB"))).size !== options.length) throw invalid("Each grind needs a unique ID and name.");
  if (!options.some(option => option.enabled)) throw invalid("Keep at least one grind available for ordering.");
  // A renamed option gets a new id (it's a different grind), except a built-in one moving to its new name.
  const builtIn = (option: GrindOption) => defaultGrinds.some(d => d.id === option.id && d.label === option.label);
  return options.map(option => !builtIn(option) && previous.some(old => old.id === option.id && old.label !== option.label) ? { ...option, id: "grind-" + crypto.randomUUID() } : option);
}
// Packaging colours: one or two #RRGGBB (two show as stripes), or null/[] for the built-in or automatic colour.
function coloursFor(body: Record<string, any>, current: Coffee | null): Pick<Coffee, "colours" | "colourStyle"> {
  const value = body.colours === undefined ? current?.colours : body.colours;
  if (value == null || (Array.isArray(value) && !value.length)) return {};
  if (!Array.isArray(value) || value.length > 2 || value.some((c) => typeof c !== "string" || !/^#[0-9a-f]{6}$/i.test(c))) throw invalid("Choose one or two colours, like #4B8E68.");
  const style = body.colourStyle === undefined ? current?.colourStyle ?? "solid" : body.colourStyle;
  if (style !== "solid" && style !== "striped") throw invalid("Choose solid or striped.");
  return { colours: value.map((c: string) => c.toUpperCase()), colourStyle: value.length > 1 ? "striped" : style };
}
function edited(body: Record<string, any>, current: Coffee | null, ids: Set<string> = new Set()): Coffee {
  const field = (key: "name" | "title" | "origin" | "process" | "notes" | "badge", max: number, required = false) => body[key] === undefined && current ? current[key] : text(body[key], key, max, required);
  const title = field("title", 180, true);
  const name = body.name === undefined && !current ? text(title, "short name", 120, true) : field("name", 120, true);
  const categories = body.categories ?? current?.categories;
  if (!Array.isArray(categories) || !categories.length || categories.length > 3 || categories.some((value) => !CATEGORIES.includes(value)) || new Set(categories).size !== categories.length) throw invalid("Choose single origin, blend or decaf categories.");
  if (typeof body.active !== "boolean") throw invalid("Choose whether this coffee is visible.");
  const inStock = body.inStock === undefined ? current?.inStock ?? true : body.inStock;
  if (typeof inStock !== "boolean") throw invalid("Choose whether this coffee is in stock.");
  const packs = body.packs === undefined ? current?.packs : packsFor(body.packs);
  const prices = pricesFor(body.prices, packsOf({ packs }), current?.prices);
  if (body.customerOnly !== undefined && typeof body.customerOnly !== "boolean") throw invalid("Choose whether this coffee is for selected customers only.");
  const whiteLabel = body.whiteLabel === undefined ? current?.whiteLabel : editedWhiteLabel(body.whiteLabel);
  const customerOnly = body.customerOnly === undefined ? !!whiteLabel?.length || !!current && isCustomCoffee(current) : body.customerOnly;
  if (body.customerOnly === false && whiteLabel?.length) throw invalid("Remove the selected customers before making this coffee available to everyone.");
  return {
    id: current?.id || "coffee-" + crypto.randomUUID(), title, name,
    origin: field("origin", 100), process: field("process", 120), notes: field("notes", 400), badge: field("badge", 60), categories: [...categories],
    prices, price: prices.kilo, active: body.active, inStock, grindOptions: editedGrinds(body.grindOptions === undefined ? current?.grindOptions ?? defaultGrinds : body.grindOptions, current?.grindOptions),
    image: current?.image || "", sourceUrl: current?.sourceUrl || "", sourceImage: current?.sourceImage || "", sourceUpdatedAt: current?.sourceUpdatedAt || Date.now(),
    images: current?.images || [], imageUrls: current?.imageUrls || [], version: current?.version || 0,
    ...coloursFor(body, current),
    ...(packs ? { packs } : {}),
    ...(whiteLabel?.length ? { whiteLabel } : {}),
    ...(customerOnly ? { customerOnly: true as const } : {}),
    ...((v) => (v ? { recipe: v } : {}))(body.recipe === undefined ? current?.recipe : editedRecipe(body.recipe, ids, current?.id || null)),
  };
}
function imageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}
async function upload(req: Request, env: Env, coffee: Coffee, by: string): Promise<Response> {
  const query = new URL(req.url).searchParams.get("ifVersion");
  if (query === null) throw invalid("Send the coffee's ifVersion.");
  const expected = version(Number(query));
  if (expected !== coffee.version) throw new ApiError(409, "conflict", "This coffee changed. Reload before adding photos.");
  if (coffee.images.length >= MAX_IMAGES) throw invalid("Each coffee can have up to six photos.");
  if (Number(req.headers.get("content-length") || 0) > MAX_IMAGE_BYTES) throw new ApiError(413, "too_large", "Photos can be up to 5 MB.");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ApiError(413, "too_large", "Photos can be up to 5 MB.");
  const contentType = imageType(bytes);
  // Some original retail photos have a .webp filename but contain JPEG bytes. Serve the detected raster type.
  if (!contentType) throw new ApiError(415, "unsupported_type", "Choose a JPEG, PNG or WebP photo.");
  const id = newId(16);
  let filename = "Photo";
  try { filename = decodeURIComponent(req.headers.get("x-file-name") || "Photo").replace(/[\u0000-\u001f\\/]/g, "").slice(0, 160); } catch {}
  const metadata: ImageMeta = { contentType, size: bytes.byteLength, productId: coffee.id, filename, by, at: Date.now() };
  await env.FILES.put(PHOTO_PREFIX + id, bytes, { metadata });
  let product;
  try { product = await write(env, { ...coffee, images: [...coffee.images, "upload:" + id] }, expected); }
  catch (error) { await env.FILES.delete(PHOTO_PREFIX + id); throw error; }
  await audit(env, "wholesale_photo", by, `${by} added a photo to ${coffee.title}.`);
  return json({ product }, 201);
}
export async function serveCatalogueImage(env: Env, id: string, customerId: string | null = null): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(id)) throw missing();
  const stored = await env.FILES.getWithMetadata<ImageMeta>(PHOTO_PREFIX + id, { type: "stream" });
  if (!stored.value || !stored.metadata) throw missing();
  const coffee = (await catalogue(env)).find((row) => row.id === stored.metadata!.productId);
  if (!coffee?.images.includes("upload:" + id) || !canOrder(coffee, customerId)) throw missing();
  return new Response(stored.value, { headers: { "content-type": stored.metadata.contentType, "content-length": String(stored.metadata.size), "x-content-type-options": "nosniff", "cache-control": "private, no-store" } });
}

/** Called only after the existing admin-role guard. Binary uploads never enter the JSON parser. */
/** A white-label coffee can only belong to businesses that exist. */
async function checkBusinesses(env: Env, ids: string[] | undefined) {
  if (!ids?.length) return;
  const found = await env.DB.prepare("SELECT COUNT(*) AS n FROM wholesale_preview WHERE kind = 'customer' AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).first<{ n: number }>();
  if ((found?.n || 0) !== ids.length) throw invalid("Choose saved businesses for a white-label coffee.");
}
export async function handleCatalogueAdmin(req: Request, env: Env, route: string, by: string): Promise<Response | null> {
  const image = /^images\/([a-f0-9]{32})$/.exec(route);
  if (image && req.method === "GET") return serveCatalogueImage(env, image[1]);
  if (route === "catalogue" && req.method === "POST") {
    if ((await catalogue(env)).length >= 500) throw invalid("This catalogue supports up to 500 coffees.");
    const body = object(await readJson(req, 16 * 1024));
    const coffee = edited(body, null, new Set((await catalogue(env, true)).map((c) => c.id)));
    await checkBusinesses(env, coffee.whiteLabel);
    const product = await write(env, coffee, 0);
    await audit(env, "wholesale_catalogue", by, `${by} added coffee ${product.title}.`);
    return json({ product }, 201);
  }
  const match = new RegExp("^catalogue/" + PRODUCT_ID + "(/images)?$").exec(route);
  if (!match) return null;
  const coffee = (await catalogue(env, true)).find((row) => row.id === match[1]);
  if (!coffee) throw missing();
  if (match[2] && req.method === "POST") return upload(req, env, coffee, by);
  if (match[2] && req.method === "PATCH") {
    const body = object(await readJson(req, 4096));
    if (body.restore === true && body.remove !== undefined) throw invalid("Choose either restore or remove.");
    const expected = version(body.ifVersion);
    let images = [...coffee.images];
    if (body.restore === true) {
      const source = originals.find((row) => row.id === coffee.id);
      if (!source?.image) throw invalid("This coffee has no original photo.");
      if (!images.includes("source:" + source.image)) images.push("source:" + source.image);
      if (images.length > MAX_IMAGES) throw invalid("Each coffee can have up to six photos.");
    } else {
      if (typeof body.remove !== "string" || !images.includes(body.remove)) throw missing();
      images = images.filter((id) => id !== body.remove);
    }
    const product = await write(env, { ...coffee, images }, expected);
    if (typeof body.remove === "string" && body.remove.startsWith("upload:")) await env.FILES.delete(PHOTO_PREFIX + body.remove.slice(7));
    await audit(env, "wholesale_photo", by, `${by} ${body.restore ? "restored the original photo for" : "removed a photo from"} ${coffee.title}.`);
    return json({ product });
  }
  if (!match[2] && req.method === "PUT") {
    const body = object(await readJson(req, 16 * 1024));
    const next = edited(body, coffee, new Set((await catalogue(env, true)).map((c) => c.id)));
    await checkBusinesses(env, next.whiteLabel);
    const product = await write(env, next, version(body.ifVersion));
    await audit(env, "wholesale_catalogue", by, `${by} updated coffee ${product.title}.`);
    return json({ product });
  }
  return null;
}
