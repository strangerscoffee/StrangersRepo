import { ApiError, type Env, json, readBytes } from "./http";
import { readEditorPhoto } from "./consumerEditorPhoto";
import { retailServiceRequest } from "./retailService";

const PUBLIC_FIELDS = ["id", "name", "category", "notes", "shortCopy", "story", "country", "region", "process",
  "profile", "prices", "grinds", "image", "available", "shippingWeightGrams", "contents", "url", "shelfOrder"] as const;
const MAX_CATALOGUE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 220 * 1024;

type RetailProduct = Record<string, unknown> & { id: string; name: string };

export async function readConsumerCatalogue(env: Env): Promise<RetailProduct[] | null> {
  try {
    const response = await retailServiceRequest(env, "/consumer-bridge/catalogue", {method: "GET"});
    if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel();
      return null;
    }
    const bytes = await readBytes(response, MAX_CATALOGUE_BYTES, "The catalogue response was too large.");
    const {products} = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(products)) return null;
    const retail: RetailProduct[] = [];
    for (const product of products) {
      if (!product || typeof product.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(product.id) ||
          typeof product.name !== "string" || typeof product.available !== "boolean") return null;
      if (product.archived) continue;
      const item: RetailProduct = {id: product.id, name: product.name};
      for (const field of PUBLIC_FIELDS) if (field in product) item[field] = product[field];
      if (typeof item.image === "string" && /^\/assets\/[a-z0-9-]+\.webp$/.test(item.image)) {
        item.image = "/consumer-preview" + item.image;
      }
      retail.push(item);
    }
    return retail;
  } catch {
    return null;
  }
}

export async function retailCatalogueResponse(env: Env) {
  const products = await readConsumerCatalogue(env);
  return products ? json({products}) : json({error: "catalogue_unavailable", message: "The shop catalogue is temporarily unavailable. Try again shortly."}, 503);
}

export function productPhotoUpload(input: Record<string, unknown>) {
  if (input.type !== "image/jpeg" && input.type !== "image/webp") throw new ApiError(400, "invalid_image", "Choose a JPEG or WebP photo.");
  const photo = readEditorPhoto({name: "product", type: input.type, data: input.data});
  if (photo.data.byteLength > MAX_IMAGE_BYTES) throw new ApiError(413, "too_large", "Resize the product photo to 220 KB or smaller.");
  let binary = "";
  for (let offset = 0; offset < photo.data.length; offset += 8192) {
    binary += String.fromCharCode(...photo.data.subarray(offset, offset + 8192));
  }
  return JSON.stringify({type: photo.type, data: btoa(binary)});
}

export async function retailProductPhoto(env: Env, digest: string, admin: boolean, method: string) {
  const path = (admin ? "/api/control/consumer/product-photos/" : "/consumer-bridge/product-photos/") + digest;
  try {
    const response = await retailServiceRequest(env, path, {method: "GET"});
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (response.status === 404) {
      await response.body?.cancel();
      return new Response(null, {status: 404, headers: {"cache-control": "no-store"}});
    }
    if (response.status === 200 && (type === "image/jpeg" || type === "image/webp")) {
      const image = await readBytes(response, MAX_IMAGE_BYTES, "The product photo was too large.");
      return new Response(method === "HEAD" ? null : image, {headers: {
        "content-type": type, "content-length": String(image.byteLength), "x-content-type-options": "nosniff",
        "cache-control": admin ? "private, no-store" : "public, no-cache, must-revalidate",
      }});
    }
    await response.body?.cancel();
  } catch {
    // Do not forward upstream errors, redirects or headers to either site.
  }
  return new Response(null, {status: 503, headers: {"cache-control": "no-store"}});
}
