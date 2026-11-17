// Provider acknowledgements and verified delivery feedback. No bodies, reset links or signing secrets are stored.
import { audit } from "../audit";
import { ApiError, type Env, json, readBytes } from "../http";
import { orderSender } from "./sender";
import { cleanEmail, senderAddress } from "./address";
import type { Outgoing } from "./send";

const TYPES = new Set(["email.sent", "email.delivered", "email.delivery_delayed", "email.bounced", "email.complained", "email.failed", "email.suppressed", "suppression.added", "suppression.removed"]);
const clip = (value: unknown, max: number) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, max) : "";
const opaqueId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);

export async function recipientSuppressed(env: Env, email: string) {
  const row = await env.DB.prepare("SELECT active FROM email_suppressions WHERE email=?").bind(email.toLowerCase()).first<{active:number}>();
  return row?.active === 1;
}
export async function recordAccepted(env: Env, outgoing: Outgoing, providerId: unknown, eventKey?: string) {
  const id = eventKey || crypto.randomUUID(), pid = opaqueId(providerId) ? providerId as string : null;
  await env.DB.prepare("INSERT OR IGNORE INTO email_delivery_messages(id,provider_id,recipient,recipient_name,subject,stream,about,accepted_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(id, pid, outgoing.to.email.toLowerCase(), clip(outgoing.to.name, 120), clip(outgoing.mail.subject, 240), outgoing.kind === "order" || outgoing.from ? "wholesale" : "rota", clip(outgoing.about, 240), Date.now()).run();
}

function bytes64(value: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Invalid signing data.");
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
function signingReady(secret: string | undefined) {
  try { return !!secret?.startsWith("whsec_") && bytes64(secret.slice(6)).byteLength >= 16; } catch { return false; }
}
async function verify(req: Request, secret: string, body: Uint8Array) {
  const id = req.headers.get("svix-id") || "", timestamp = req.headers.get("svix-timestamp") || "", signatures = req.headers.get("svix-signature") || "";
  if (!opaqueId(id) || !/^\d{10,12}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > 300000 || signatures.length > 2048) throw new ApiError(400, "webhook_invalid", "Invalid webhook signature.");
  try {
    if (!secret.startsWith("whsec_")) throw new Error("Invalid key.");
    const key = await crypto.subtle.importKey("raw", bytes64(secret.slice(6)), {name:"HMAC",hash:"SHA-256"}, false, ["verify"]);
    const prefix = new TextEncoder().encode(id + "." + timestamp + "."), signed = new Uint8Array(prefix.length + body.length); signed.set(prefix); signed.set(body,prefix.length);
    for (const signature of signatures.split(" ")) {
      if (!signature.startsWith("v1,")) continue;
      try { if (await crypto.subtle.verify("HMAC", key, bytes64(signature.slice(3)), signed)) return id; } catch { /* another rotated signature may be valid */ }
    }
  } catch { /* expose no key or payload details */ }
  throw new ApiError(400, "webhook_invalid", "Invalid webhook signature.");
}

export async function handleResendWebhook(req: Request, env: Env, ready: () => Promise<void>): Promise<Response> {
  if (env.ADMIN_HOST && new URL(req.url).hostname.toLowerCase() !== env.ADMIN_HOST.toLowerCase()) throw new ApiError(404,"not_found","Not found.");
  if (req.method !== "POST") return new Response(null,{status:405,headers:{allow:"POST"}});
  if (!signingReady(env.RESEND_WEBHOOK_SECRET)) throw new ApiError(503,"webhook_off","Email feedback is not configured.");
  const raw = await readBytes(req, 65536, "Webhook payload is too large."), id = await verify(req, env.RESEND_WEBHOOK_SECRET!, raw);
  let payload: any;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new ApiError(400,"webhook_invalid","Invalid webhook payload."); }
  if (!payload || typeof payload !== "object" || !TYPES.has(payload.type)) return new Response(null,{status:204});
  const data = payload.data, parsedAt = Date.parse(payload.created_at);
  if (!data || typeof data !== "object" || !Number.isFinite(parsedAt) || parsedAt <= 0 || parsedAt > Date.now()+300000) throw new ApiError(400,"webhook_invalid","Invalid webhook payload.");
  const suppression = payload.type.startsWith("suppression.");
  let recipients: string[], providerId: string | null;
  if (suppression) {
    const email = cleanEmail(data.email);
    if (!email) throw new ApiError(400,"webhook_invalid","Invalid webhook recipient.");
    recipients = [email]; providerId = opaqueId(data.source_id) ? data.source_id : null;
  } else {
    const from = typeof data.from === "string" ? senderAddress(data.from) : null;
    const domains = [senderAddress(orderSender(env)),senderAddress(env.EMAIL_FROM || "rota@staffstrangerscoffee.com")].filter(Boolean).map(address=>address!.split("@")[1]);
    if (!from || !domains.includes(from.split("@")[1])) return new Response(null,{status:204});
    if (!opaqueId(data.email_id) || !Array.isArray(data.to) || !data.to.length || data.to.length > 5) throw new ApiError(400,"webhook_invalid","Invalid webhook message.");
    recipients = data.to.map(cleanEmail);
    if (recipients.some(email=>!email)) throw new ApiError(400,"webhook_invalid","Invalid webhook recipient.");
    providerId = data.email_id;
  }
  await ready(); // No database I/O for unsigned requests.
  if (suppression && !await env.DB.prepare("SELECT 1 FROM email_delivery_messages WHERE recipient=? LIMIT 1").bind(recipients[0]).first()) return new Response(null,{status:204});
  const reason = clip(data.bounce?.message || data.suppressed?.message || data.failed?.reason || data.origin,300);
  const ingest = crypto.randomUUID();
  const record = env.DB.prepare("INSERT OR IGNORE INTO email_delivery_events(id,provider_id,type,event_at,received_at,recipients,reason,ingest_id) VALUES(?,?,?,?,?,?,?,?)")
    .bind(id,providerId,payload.type,parsedAt,Date.now(),JSON.stringify(recipients),reason,ingest);
  const statements: D1PreparedStatement[] = [record];
  const active = payload.type !== "suppression.removed";
  if (suppression || ["email.bounced","email.complained","email.suppressed"].includes(payload.type)) for (const email of recipients) {
    // Event time, not arrival order, decides the current suppression. At an exact tie, blocking wins.
    statements.push(env.DB.prepare("INSERT INTO email_suppressions(email,active,source,event_at,event_id) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM email_delivery_events WHERE id=? AND ingest_id=?) ON CONFLICT(email) DO UPDATE SET active=excluded.active,source=excluded.source,event_at=excluded.event_at,event_id=excluded.event_id WHERE excluded.event_at>email_suppressions.event_at OR (excluded.event_at=email_suppressions.event_at AND excluded.active>email_suppressions.active)")
      .bind(email,active?1:0,payload.type,parsedAt,id,id,ingest));
  }
  const result = await env.DB.batch(statements);
  if (result[0].meta.changes && ["email.bounced","email.complained","email.suppressed"].includes(payload.type)) await audit(env,"email_delivery_problem",null,`Email ${providerId}: ${payload.type.slice(6)}. Review Email health in Admin.`);
  return json({received:true,duplicate:!result[0].meta.changes});
}

const STATUS = `CASE WHEN EXISTS(SELECT 1 FROM email_delivery_events e,json_each(e.recipients) r WHERE e.provider_id=m.provider_id AND r.value=m.recipient AND e.type='email.complained') THEN 'complained' WHEN EXISTS(SELECT 1 FROM email_delivery_events e,json_each(e.recipients) r WHERE e.provider_id=m.provider_id AND r.value=m.recipient AND e.type='email.bounced') THEN 'bounced' WHEN EXISTS(SELECT 1 FROM email_delivery_events e,json_each(e.recipients) r WHERE e.provider_id=m.provider_id AND r.value=m.recipient AND e.type='email.suppressed') THEN 'suppressed' WHEN EXISTS(SELECT 1 FROM email_delivery_events e,json_each(e.recipients) r WHERE e.provider_id=m.provider_id AND r.value=m.recipient AND e.type='email.failed') THEN 'failed' WHEN EXISTS(SELECT 1 FROM email_delivery_events e,json_each(e.recipients) r WHERE e.provider_id=m.provider_id AND r.value=m.recipient AND e.type='email.delivered') THEN 'delivered' WHEN EXISTS(SELECT 1 FROM email_delivery_events e,json_each(e.recipients) r WHERE e.provider_id=m.provider_id AND r.value=m.recipient AND e.type='email.delivery_delayed') THEN 'delayed' ELSE 'accepted' END`;
export async function emailDeliveryStatus(env: Env) {
  const [recent,suppressed,last] = await Promise.all([
    env.DB.prepare(`SELECT m.id,m.recipient,m.recipient_name AS name,m.subject,m.stream,m.accepted_at AS acceptedAt,(SELECT e.reason FROM email_delivery_events e,json_each(e.recipients) r WHERE e.provider_id=m.provider_id AND r.value=m.recipient AND e.reason<>'' ORDER BY e.event_at DESC LIMIT 1) AS detail,${STATUS} AS status FROM email_delivery_messages m ORDER BY m.accepted_at DESC,m.id LIMIT 50`).all(),
    env.DB.prepare("SELECT email,source,event_at AS at FROM email_suppressions WHERE active=1 ORDER BY event_at DESC,email LIMIT 50").all(),
    env.DB.prepare("SELECT MAX(received_at) AS at FROM email_delivery_events").first<{at:number|null}>(),
  ]);
  return {webhookConfigured:signingReady(env.RESEND_WEBHOOK_SECRET),lastWebhookAt:last?.at||null,messages:recent.results,suppressed:suppressed.results};
}
