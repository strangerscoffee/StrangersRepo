// Live updates: one Durable Object that every open page (diary, rota, admin) keeps a WebSocket to, so the server
// can say the moment something changes instead of each page asking every few seconds. It only ever sends the change
// counters (the same {docs, rota, accounts} as GET /api/changes), never any data: a page that sees a counter move
// fetches what changed the usual way, through its own signed-in requests.
//
// Built for the Workers Free plan: it uses the WebSocket Hibernation API, so open connections cost nothing while
// nothing changes (no duration billed), pings are answered by the runtime without waking it, and messages sent out are
// free. Each connection and each change is one Durable Object request (docs/runtime-api.md, "Live updates").
import { DurableObject } from "cloudflare:workers";
import { Env } from "./http";

export class LiveHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alives from pages ("ping") get "pong" from the runtime itself, without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/notify" && req.method === "POST") {
      const msg = await req.text();
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(msg); } catch { /* closing already */ }
      }
      return new Response(null, { status: 204 });
    }
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket.", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(): Promise<void> { /* pages only send pings, answered automatically */ }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code, reason); } catch { /* already closed */ }
  }
}

const hub = (env: Env) => env.LIVE!.get(env.LIVE!.idFromName("all"));

/** Opens a page's live connection (GET /api/live, signed in, from the site's own pages). */
export const openLive = (req: Request, env: Env) => hub(env).fetch(req);

/** Tells every open page the current change counters (after a write). Never throws. */
export async function notifyLive(env: Env): Promise<void> {
  if (!env.LIVE) return;
  try {
    const { results } = await env.DB.prepare("SELECT k, v FROM meta WHERE k IN ('seq', 'rota', 'accounts')").all<{ k: string; v: number }>();
    const v = Object.fromEntries(results.map((r) => [r.k, r.v]));
    await hub(env).fetch("https://live/notify", { method: "POST", body: JSON.stringify({ docs: v.seq ?? 0, rota: v.rota ?? 0, accounts: v.accounts ?? 0 }) });
  } catch (e) { console.error("live", e); }
}
