// The private staff profile (the owner's request, 18 Nov 2026): each person's start date, contact number, contact
// email and home address. Only the person and admins see it. Staff edit their own contact number, email and address
// on the rota's My profile page (GET/PUT /api/rota/me/profile); only admins set the start date (and can edit the rest)
// through PATCH /api/admin/users/<id>. The contact email is the same address rota emails go to (users.email). When
// staff change their own details, every admin is told who changed which fields (never the new values): an audit_log
// `profile_changed` row (Admin → Activity and a dismissible Overview notice) and an email.
import { Env, invalid } from "./http";
import { audit } from "./audit";
import { cleanEmail } from "./email/send";
import { ApiError } from "./http";
import { isDay } from "./rota/util";

export const PROFILE_LABELS = { phone: "contact number", email: "contact email", address: "home address" } as const;
export type ProfileField = keyof typeof PROFILE_LABELS;

/** A UK or international number: digits, spaces, +, brackets and dashes, 6–20 digits. "" clears it. */
export function cleanPhone(v: unknown): string {
  if (v == null) return "";
  if (typeof v !== "string") throw invalid("Enter a contact number.");
  const s = v.trim().replace(/\s+/g, " ");
  if (!s) return "";
  const digits = s.replace(/\D/g, "").length;
  if (s.length > 30 || !/^[+0-9 ()-]+$/.test(s) || digits < 6 || digits > 20) throw invalid("Enter a contact number using numbers, spaces and +, like 07700 900123.");
  return s;
}
/** Up to 300 characters, new lines kept (at most 6 lines), each line trimmed. */
export function cleanAddress(v: unknown): string {
  if (v == null) return "";
  if (typeof v !== "string") throw invalid("Enter a home address.");
  const lines = v.replace(/\r/g, "").split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean);
  const s = lines.join("\n");
  if (s.length > 300 || lines.length > 6) throw invalid("Keep the home address to 6 lines and 300 characters.");
  return s;
}
export function cleanStartDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (!isDay(v)) throw invalid("Enter the start date as a date.");
  return v;
}

type Row = { id: string; name: string; email: string | null; phone: string | null; home_address: string | null; start_date: string | null; profile_version: number | null };
export async function profileRow(env: Env, userId: string) {
  return env.DB.prepare("SELECT id, name, email, phone, home_address, start_date, profile_version FROM users WHERE id = ?").bind(userId).first<Row>();
}
export const profileView = (r: Row) => ({ name: r.name, startDate: r.start_date || null, phone: r.phone || "", email: r.email || "", address: r.home_address || "", version: r.profile_version || 0 });

/** A person saves their own contact number, email and address. Version-checked; returns the fields that changed. */
export async function saveOwnProfile(env: Env, user: { id: string; name: string }, body: Record<string, unknown>) {
  const row = await profileRow(env, user.id);
  if (!row) throw new ApiError(404, "not_found", "Your account wasn't found.");
  if (body.startDate !== undefined) throw new ApiError(403, "permission_denied", "Only an admin can change your start date.");
  if (Number(body.ifVersion ?? -1) !== (row.profile_version || 0)) throw new ApiError(409, "conflict", "Your details were changed somewhere else. Reload to see them.");
  const next = { phone: row.phone || "", email: row.email || "", address: row.home_address || "" };
  if (body.phone !== undefined) next.phone = cleanPhone(body.phone);
  if (body.address !== undefined) next.address = cleanAddress(body.address);
  if (body.email !== undefined) {
    const e = cleanEmail(body.email);
    if (e === null) throw invalid("Enter an email address like name@example.com, or leave it blank.");
    next.email = e || "";
  }
  const changed = (Object.keys(PROFILE_LABELS) as ProfileField[]).filter((k) => next[k] !== ({ phone: row.phone || "", email: row.email || "", address: row.home_address || "" })[k]);
  if (!changed.length) return { changed, profile: profileView(row) };
  const res = await env.DB.prepare("UPDATE users SET phone = ?, email = ?, home_address = ?, profile_version = COALESCE(profile_version, 0) + 1 WHERE id = ? AND COALESCE(profile_version, 0) = ?")
    .bind(next.phone || null, next.email || null, next.address || null, user.id, row.profile_version || 0).run();
  if (!res.meta.changes) throw new ApiError(409, "conflict", "Your details were changed somewhere else. Reload to see them.");
  await audit(env, "profile_changed", user.name, `${user.name} updated their ${listOf(changed.map((k) => PROFILE_LABELS[k]))}.`);
  return { changed, profile: profileView((await profileRow(env, user.id))!) };
}
export const listOf = (xs: string[]) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** Emails every active admin with an address (their "requests" emails) that someone changed their details. */
export async function tellAdmins(env: Env, exec: ExecutionContext | undefined, base: { rota: string; diary: string }, who: { id: string; name: string }, changed: ProfileField[]) {
  const { emailReady, linksFor, prefsOf, recipients, sendAll } = await import("./email/send");
  const { profileChangedEmail } = await import("./email/templates");
  if (!emailReady(env) || !changed.length) return;
  const ids = (await env.DB.prepare("SELECT id FROM users WHERE active = 1 AND role = 'admin' AND id <> ?").bind(who.id).all<{ id: string }>()).results.map((r) => r.id);
  const people = await recipients(env, ids);
  const adminUrl = env.ADMIN_HOST ? `https://${env.ADMIN_HOST}/#people` : base.diary.replace(/\/?$/, "/") + "admin#people";
  const out = [];
  for (const id of ids) {
    const r = people.get(id);
    if (!r || !r.active || !r.email || !prefsOf(r.email_prefs).requests) continue;
    const links = await linksFor(env, base, id, "requests");
    out.push({ to: r as typeof r & { email: string }, kind: "requests" as const, links, about: `profile updated by ${who.name}`, mail: profileChangedEmail({ name: r.name, who: who.name, fields: changed.map((k) => PROFILE_LABELS[k]), adminUrl, links }) });
  }
  sendAll(env, exec, out);
}
