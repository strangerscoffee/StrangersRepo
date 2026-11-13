// Allergen PDFs in Workers KV (docs/runtime-api.md, `assets`).
import { ApiError, Env, json } from "./http";

const MAX_BYTES = 20 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{32}$/;

interface Meta {
  contentType: string;
  size: number;
  by: string;
  at: number;
}

function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function uploadAsset(req: Request, env: Env, by: string): Promise<Response> {
  const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/pdf") throw new ApiError(415, "unsupported_type", "Only PDF files can be uploaded.");
  if (Number(req.headers.get("content-length") || 0) > MAX_BYTES) throw new ApiError(413, "too_large", "PDFs can be up to 20 MB.");
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BYTES) throw new ApiError(413, "too_large", "PDFs can be up to 20 MB.");
  if (body.byteLength === 0) throw new ApiError(400, "invalid_argument", "The file is empty.");
  const magic = new TextDecoder().decode(new Uint8Array(body, 0, Math.min(1024, body.byteLength)));
  if (!magic.includes("%PDF-")) throw new ApiError(415, "unsupported_type", "That file isn't a PDF.");
  const id = newId();
  const meta: Meta = { contentType: "application/pdf", size: body.byteLength, by, at: Date.now() };
  await env.FILES.put(id, body, { metadata: meta });
  return json({ id, url: "/_blob/" + id, sizeBytes: body.byteLength, contentType: "application/pdf" });
}

export async function deleteAsset(env: Env, id: string): Promise<Response> {
  if (!ID_RE.test(id)) return json({ deleted: false });
  const { metadata } = await env.FILES.getWithMetadata(id, { type: "stream" });
  if (metadata) await env.FILES.delete(id);
  return json({ deleted: !!metadata });
}

export async function serveBlob(env: Env, id: string): Promise<Response> {
  const obj = ID_RE.test(id) ? await env.FILES.getWithMetadata<Meta>(id, { type: "stream" }) : null;
  if (!obj || !obj.value) return new Response("Not found", { status: 404, headers: { "x-content-type-options": "nosniff" } });
  const meta = obj.metadata;
  return new Response(obj.value, {
    headers: {
      "content-type": meta?.contentType || "application/octet-stream",
      "content-disposition": "inline",
      ...(meta?.size ? { "content-length": String(meta.size) } : {}),
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
