import { type Env, json } from "./http";
import { ensureSchema } from "./schema";

export const RETAIL_SITES_ORIGIN = "https://strangers-coffee-retail-demo.magicloom512.chatgpt.site";
const PREVIEW_ORIGIN = "https://preview.staffstrangerscoffee.com";
const KEY_NAME = "retail_service_v1";
const SERVICE_VERSION = "STRANGERS-RETAIL-SERVICE-V1";
const MAX_BODY_BYTES = 32 * 1024;
const ACCOUNT_API = /^\/api\/account(?:\/orders)?$/;
const ADMIN_API = /^\/api\/control\/consumer(?:\/settings|\/orders(?:\/SC-[A-F0-9]{8})?|\/products(?:\/[a-z0-9][a-z0-9-]{0,99})?|\/product-photos(?:\/[a-f0-9]{64})?|\/support(?:\/HELP-[A-F0-9]{8})?)?$/;
const AUTH_API = /^\/consumer-auth-service\/(?:register|setup|login|forgot|reset|logout)$/;
const ORDER_API = /^\/consumer-orders-service\/orders(?:\/SC-[A-F0-9]{8})?$/;
const SUPPORT_API = /^\/consumer-support-service\/message$/;
const BRIDGE_API = /^\/consumer-bridge\/(?:exchange|revoke|session|availability|catalogue|product-photos\/[a-f0-9]{64})$/;
export const PRODUCT_UPLOAD_LIMIT = 310 * 1024;
const ENCODED_SECRET = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const encoder = new TextEncoder();

interface KeyMaterial {
  publicKey: JsonWebKey;
  signingKey: CryptoKey;
  clientKey: CryptoKey;
}

interface RequestOptions {
  method: string;
  body?: string;
  client?: string | null;
  session?: string | null;
}

// Save only completed key imports. Cloudflare I/O belongs to the current request.
const keyCache = new WeakMap<Env["DB"], KeyMaterial>();

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeSecret(value: string): Uint8Array<ArrayBuffer> {
  if (!ENCODED_SECRET.test(value)) throw new Error("Invalid retail service key material.");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

async function loadKey(env: Env): Promise<KeyMaterial> {
  const cached = keyCache.get(env.DB);
  if (cached) return cached;

  await ensureSchema(env);
  const find = () => env.DB.prepare("SELECT v FROM secrets WHERE k = ?").bind(KEY_NAME).first<{ v: string }>();
  let row = await find();
  if (!row) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    if (!("privateKey" in pair) || !pair.privateKey) throw new Error("Could not create the retail service key.");
    const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const clientSalt = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT OR IGNORE INTO secrets (k, v) VALUES (?, ?)")
      .bind(KEY_NAME, JSON.stringify({ privateKey, clientSalt })).run();
    row = await find();
  }
  if (!row) throw new Error("The retail service key is unavailable.");

  let stored: { privateKey: JsonWebKey; clientSalt: string };
  try {
    stored = JSON.parse(row.v);
  } catch {
    throw new Error("Invalid retail service key material.");
  }
  const { privateKey, clientSalt } = stored;
  const { kty, crv, x, y, d } = privateKey;
  if (kty !== "EC" || crv !== "P-256" || !x || !y || !d || ![x, y, d].every(value => ENCODED_SECRET.test(value))) {
    throw new Error("Invalid retail service key material.");
  }
  const [signingKey, clientKey] = await Promise.all([
    crypto.subtle.importKey("jwk", privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    crypto.subtle.importKey("raw", decodeSecret(clientSalt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  ]);
  const material = { publicKey: { kty, crv, x, y }, signingKey, clientKey };
  keyCache.set(env.DB, material);
  return material;
}

export async function retailServicePublicKey(env: Env): Promise<Response> {
  return json({ key: (await loadKey(env)).publicKey });
}

function retailServiceUrl(path: string): URL {
  const url = new URL(path, RETAIL_SITES_ORIGIN);
  if (url.origin !== RETAIL_SITES_ORIGIN || path !== url.pathname + url.search
      || ![ACCOUNT_API, ADMIN_API, AUTH_API, ORDER_API, SUPPORT_API, BRIDGE_API].some(pattern => pattern.test(url.pathname))) {
    throw new Error("Invalid retail service destination.");
  }
  return url;
}

export async function retailServiceRequest(env: Env, path: string, { method, body, client, session }: RequestOptions): Promise<Response> {
  const url = retailServiceUrl(path);
  const content = encoder.encode(body ?? "");
  const limit = method === "POST" && path === "/api/control/consumer/product-photos" ? PRODUCT_UPLOAD_LIMIT : MAX_BODY_BYTES;
  if (content.byteLength > limit || session && !ENCODED_SECRET.test(session)) {
    throw new Error("Invalid retail service request.");
  }
  const ip = client && /^[0-9a-f:.]{3,45}$/i.test(client) ? client.toLowerCase() : "unavailable";
  const { signingKey, clientKey } = await loadKey(env);
  const [digest, clientDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", content),
    crypto.subtle.sign("HMAC", clientKey, encoder.encode(ip)),
  ]);
  const time = String(Math.floor(Date.now() / 1000));
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const clientId = base64Url(new Uint8Array(clientDigest));
  const bodyDigest = base64Url(new Uint8Array(digest));
  const origin = method === "GET" || method === "HEAD" ? "" : PREVIEW_ORIGIN;
  const input = [SERVICE_VERSION, method, url.origin, path, time, nonce, clientId, session ?? "", origin, bodyDigest].join("\n");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(input));
  const headers = new Headers({
    accept: "application/json",
    "x-strangers-service-time": time,
    "x-strangers-service-nonce": nonce,
    "x-strangers-service-client": clientId,
    "x-strangers-service-digest": bodyDigest,
    "x-strangers-service-signature": base64Url(new Uint8Array(signature)),
  });
  if (session) headers.set("authorization", "Bearer " + session);
  if (origin) headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  return fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(8000) });
}
