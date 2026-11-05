// /email/unsubscribe?t=<signed token>: the link at the foot of every rota email, which works without signing in.
// Opening it (GET) only asks, so a mail scanner that follows links can't unsubscribe anyone; the button (POST), or
// a mail app's one-tap unsubscribe (POST "List-Unsubscribe=One-Click", RFC 8058), turns that email off, or all.
import { audit } from "../audit";
import { Env } from "../http";
import { EMAIL_KINDS, isEmailKind, prefsOf, readUnsubscribe } from "./send";
import { esc } from "./templates";

const LABEL: Record<string, string> = { published: "your shifts when a week is published", changed: "changes to your shifts", requests: "cover, pick-up and time off decisions", open: "open shifts you could take" };

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Strangers Coffee - Emails</title></head><body style="margin:0;background:#eef1f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#14181f;">
<main style="max-width:480px;margin:48px auto;padding:0 16px;"><div style="background:#fff;border:1px solid #e3e6eb;border-radius:16px;padding:24px;">
<div style="font-weight:800;letter-spacing:0.32em;font-size:14px;">STRANGERS <span style="letter-spacing:0.18em;font-size:10px;color:#5d6675;">ROTA</span></div>
<h1 style="font-size:22px;margin:14px 0 8px;">${esc(title)}</h1>${body}</div></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
const button = (label: string, primary: boolean) =>
  `<button type="submit" style="font:inherit;font-weight:700;border:0;border-radius:99px;padding:12px 20px;margin:0 8px 8px 0;cursor:pointer;background:${primary ? "#0062cc" : "#eef4fc"};color:${primary ? "#fff" : "#0062cc"};">${esc(label)}</button>`;

export async function handleUnsubscribe(req: Request, env: Env, url: URL): Promise<Response> {
  const form = req.method === "POST" ? await req.formData().catch(() => null) : null;
  const t = url.searchParams.get("t") || (form?.get("t") as string | null);
  const tok = await readUnsubscribe(env, t);
  const user = tok ? await env.DB.prepare("SELECT id, name, email_prefs FROM users WHERE id = ?").bind(tok.u).first<{ id: string; name: string; email_prefs: string }>() : null;
  if (!tok || !user) return page("This link doesn't work", `<p>It may have been copied wrongly. You can choose which emails you get in the rota, under <b>When I can work</b>.</p>`, 400);
  const kind = isEmailKind(tok.k) ? tok.k : null;
  if (req.method === "GET") {
    return page("Stop these emails?", `<p style="line-height:1.5;">${kind ? `Stop emails about <b>${esc(LABEL[kind])}</b>, or all rota emails?` : "Stop all rota emails?"}</p>
<form method="post" action="/email/unsubscribe"><input type="hidden" name="t" value="${esc(t)}">
${kind ? `<input type="hidden" name="only" value="1">${button("Stop these emails", true)}</form><form method="post" action="/email/unsubscribe"><input type="hidden" name="t" value="${esc(t)}">${button("Stop all rota emails", false)}` : button("Stop all rota emails", true)}</form>`);
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  // One-tap unsubscribe from a mail app turns off just that email; the page's buttons say which.
  const oneTap = form?.get("List-Unsubscribe") === "One-Click";
  const only = kind && (oneTap || form?.get("only") === "1");
  const prefs = prefsOf(user.email_prefs);
  if (only) prefs[kind!] = false;
  else for (const k of Object.keys(EMAIL_KINDS) as (keyof typeof EMAIL_KINDS)[]) prefs[k] = false;
  await env.DB.prepare("UPDATE users SET email_prefs = ? WHERE id = ?").bind(JSON.stringify(prefs), user.id).run();
  await audit(env, "email_unsubscribed", user.name, `${user.name} unsubscribed from ${only ? `emails about ${LABEL[kind!]}` : "all rota emails"}`);
  return page("Done", `<p style="line-height:1.5;">You won't get ${only ? `emails about ${esc(LABEL[kind!])}` : "any rota emails"} any more. To turn them back on, open the rota and go to <b>When I can work</b>.</p>`);
}
