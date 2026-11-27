import type { emptyDocument } from "../public/consumer-preview/assets/editor-model.js";
import { ApiError, type Env, errorResponse } from "./http";

type EditorDocument = ReturnType<typeof emptyDocument>;
export const editorMediaPath = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const notFound = () => new ApiError(404, "not_found", "Storefront content not found.");
const BASE = "https://consumer-editor.internal";
const unavailable = () => new ApiError(503, "editor_unavailable", "The storefront editor is temporarily unavailable.");

function binding(env: Env) {
  if (!env.CONSUMER_EDITOR) throw unavailable();
  return env.CONSUMER_EDITOR.get(env.CONSUMER_EDITOR.idFromName("consumer-storefront"));
}

export function handleConsumerEditorAdmin(req: Request, env: Env, path: string): Promise<Response> {
  if (path !== "/" && path !== "/publish" && path !== "/published" && path !== "/restore" && path !== "/media" && !editorMediaPath.test(path)) throw notFound();
  const body = ["PUT", "POST"].includes(req.method);
  if (body && !/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") || "")) {
    throw new ApiError(415, "unsupported_media_type", "Send this change as JSON.");
  }
  const headers = new Headers();
  if (body) {
    headers.set("content-type", "application/json");
    const length = req.headers.get("content-length");
    if (length) headers.set("content-length", length);
  }
  return binding(env).fetch(BASE + "/admin" + path, {method: req.method, headers, body: body ? req.body : undefined});
}

export async function readPublishedConsumerEditor(env: Env): Promise<{ revision: number; document: EditorDocument } | null> {
  if (!env.CONSUMER_EDITOR) return null;
  const response = await binding(env).fetch(BASE + "/public", {signal: AbortSignal.timeout(1800)});
  if (response.status === 204) return null;
  if (!response.ok) throw unavailable();
  return response.json();
}

export function readPublishedConsumerMedia(env: Env, id: string, method = "GET"): Promise<Response> {
  if (!env.CONSUMER_EDITOR || !editorMediaPath.test("/media/" + id) || !["GET", "HEAD"].includes(method)) {
    return Promise.resolve(errorResponse(notFound()));
  }
  return binding(env).fetch(BASE + "/public/media/" + id, {method});
}
