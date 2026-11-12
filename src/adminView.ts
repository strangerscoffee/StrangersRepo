// The admin section's data (admin.staffstrangerscoffee.com, public/admin/): an overview of the diary and the rota,
// people with their account, rota and training details, sites, activity, security and exports. Admins only
// (checked in index.ts before anything here runs). Reads the diary's documents and the rota's tables directly.
import { audit } from "./audit";
import { deviceOf, errorCode, recentErrors, whereOf } from "./errors";
import { emailReady, prefsOf, weeklySitesOf } from "./email/send";
import { User, nameKey } from "./auth";
import { listBackups } from "./backup";
import { setDoc } from "./docs";
import { ApiError, Env, invalid, json, readJson } from "./http";
import { addDays, isDay, londonToday, mondayOf, rotaWeekSummary } from "./rota";

const SITES = [
  { id: "roastery", name: "Roastery", prefix: "", address: "10 Dove Street, Norwich, NR2 1DE" },
  { id: "cafe", name: "Cafe", prefix: "sites/cafe/", address: "21 Pottergate, Norwich, NR2 1DS" },
  { id: "asg", name: "ASG", prefix: "sites/asg/", address: "14 All Saints Green, Norwich, NR1 3NA" },
  { id: "factory", name: "Factory", prefix: "sites/factory/", address: "122 Ber Street, Norwich, NR1 3ES" },
] as const;
const siteOf = (id: string) => SITES.find((s) => s.id === id);
const TOPICS = ["hygiene", "cross", "cleaning", "chilling", "cooking", "allergens", "diary", "l2"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Doc = Record<string, any>;
const parse = (s: string | null | undefined, fallback: any = null) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
async function docData(env: Env, path: string): Promise<Doc | null> {
  const r = await env.DB.prepare("SELECT data FROM docs WHERE path = ? AND deleted = 0").bind(path).first<{ data: string }>();
  return parse(r?.data);
}
/** Several documents by path, in one query. */
async function docsByPath(env: Env, paths: string[]): Promise<Map<string, Doc>> {
  const r = await env.DB.prepare("SELECT path, data FROM docs WHERE deleted = 0 AND path IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(paths)).all<{ path: string; data: string }>();
  return new Map(r.results.map((x) => [x.path, parse(x.data, {})]));
}
const weekdayOf = (day: string) => new Date(day + "T00:00:00Z").getUTCDay();
const shortDate = (day: string) => new Date(day + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

interface UserRow {
  id: string; name: string; username: string; role: string; active: number; must_change: number; locked_until: number;
  created_at: number; created_by: string | null; last_login_at: number | null; quick_hash: string | null; email: string | null; email_prefs: string;
}
const allUsers = (env: Env) => env.DB.prepare(
  "SELECT id, name, username, role, active, must_change, locked_until, created_at, created_by, last_login_at, quick_hash, email, email_prefs FROM users ORDER BY active DESC, name_key",
).all<UserRow>().then((r) => r.results);

/* ---------- the diary today ---------- */

/** How far a site's diary page has got today: temperatures, opening checks, closing checks, sign-off. */
function dayProgress(settings: Doc | null, day: Doc | null, date: string) {
  if (!settings) return { setUp: false, closed: false, pct: 0, status: "Not set up" };
  if (day?.closed || (Array.isArray(settings.closedDays) && settings.closedDays.includes(weekdayOf(date)))) {
    return { setUp: true, closed: true, pct: 100, status: day?.closed?.reason ? `Closed: ${day.closed.reason}` : "Closed today" };
  }
  const due = (list: unknown) => (Array.isArray(list) ? list : []).filter((c: any) => c && !c.off && (!c.from || c.from <= date));
  const listDone = (list: unknown, part: Doc | undefined) => {
    const items = due(list);
    return !items.length || !!part?.allDone || items.every((c: any) => part?.items?.[c.id] === true);
  };
  const units = Array.isArray(settings.units) ? settings.units : [];
  const temps = units.every((u: any) => day?.temps?.[u.id]?.am?.v != null);
  const opening = listDone(settings.opening, day?.opening), closing = listDone(settings.closing, day?.closing), signed = !!day?.signed;
  const pct = [temps, opening, closing, signed].filter(Boolean).length * 25;
  const status = signed ? "Signed off" : !temps ? "Temperatures to do" : !opening ? "Opening checks to do" : !closing ? "Closing checks to do" : "Ready to sign off";
  return { setUp: true, closed: false, pct, status };
}

/* ---------- overview ---------- */

export async function overview(env: Env, links: { rota: string; diary: string }) {
  const now = Date.now(), today = londonToday(), week = mondayOf(today), next = addDays(week, 7);
  const paths = SITES.flatMap((s) => [`${s.prefix}settings/main`, `${s.prefix}days/${today}`]);
  const [users, thisW, nextW, docs, timeOff, requests, backups] = await Promise.all([
    allUsers(env), rotaWeekSummary(env, week), rotaWeekSummary(env, next), docsByPath(env, paths),
    env.DB.prepare("SELECT t.from_day, t.to_day, u.name FROM rota_time_off t JOIN users u ON u.id = t.user_id WHERE t.status = 'requested' ORDER BY t.from_day").all<{ from_day: string; to_day: string; name: string }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM rota_requests WHERE (kind = 'claim' AND status = 'open') OR (kind = 'cover' AND status = 'accepted')").first<{ n: number }>(),
    listBackups(env),
  ]);
  const active = users.filter((u) => u.active);
  const diaryToday = SITES.map((s) => ({ id: s.id, name: s.name, ...dayProgress(docs.get(`${s.prefix}settings/main`) ?? null, docs.get(`${s.prefix}days/${today}`) ?? null, today) }));

  // Notices an admin has dismissed (DISMISSIBLE): gone for every admin until something new happens.
  const dismissed = new Map(((await env.DB.prepare("SELECT key, at FROM admin_dismissed").all<{ key: string; at: number }>().catch(() => null))?.results || []).map((r) => [r.key, r.at]));
  const since = (key: string) => Math.max(now - 864e5, dismissed.get(key) ?? 0);
  const attention: any[] = [];
  for (const u of active.filter((u) => u.locked_until > now)) {
    const until = new Date(u.locked_until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
    attention.push({ tone: "bad", icon: "lock", title: `${u.name} is locked out`, detail: `Too many wrong tries. Unlocks by itself at ${until}.`, action: { label: "Unlock", act: "unlock", id: u.id } });
  }
  const openShifts = (w: typeof thisW) => w.shifts.filter((s) => !s.userId).length;
  const errors = (w: typeof thisW) => w.problems.filter((p) => p.severity === "error").length;
  for (const [w, label] of [[thisW, "This week's"], [nextW, "Next week's"]] as const) {
    if (w.published) continue;
    const bits = [`Week of ${shortDate(w.week)}`, w.shifts.length ? `${w.shifts.length} shift${w.shifts.length === 1 ? "" : "s"} planned` : "nothing planned yet"];
    if (openShifts(w)) bits.push(`${openShifts(w)} open`);
    if (errors(w)) bits.push(`${errors(w)} problem${errors(w) === 1 ? "" : "s"}`);
    attention.push({ tone: "warn", icon: "cal", title: `${label} rota isn't published`, detail: bits.join(" · "), action: { label: "Open rota", href: `${links.rota}#week/${w.week}` } });
  }
  const waiting = timeOff.results.length + (requests?.n ?? 0);
  if (waiting) {
    const names = timeOff.results.slice(0, 3).map((t) => `${t.name}, ${shortDate(t.from_day)}${t.to_day !== t.from_day ? `–${shortDate(t.to_day)}` : ""}`);
    attention.push({
      tone: "warn", icon: "clock", title: `${waiting} rota request${waiting === 1 ? "" : "s"} waiting`,
      detail: [timeOff.results.length ? `Time off: ${names.join("; ")}${timeOff.results.length > 3 ? " and more" : ""}` : "", requests?.n ? `${requests.n} shift swap${requests.n === 1 ? "" : "s"}` : ""].filter(Boolean).join(". "),
      action: { label: "Review", href: `${links.rota}#requests` },
    });
  }
  // A site a member of staff marked closed today (managers plan closures ahead in Setup), so an admin sees it the same day.
  const roleOf = new Map(users.map((u) => ["web:" + u.name, u.role]));
  for (const s of SITES) {
    const c = docs.get(`${s.prefix}days/${today}`)?.closed;
    if (!c || roleOf.get(c.by) !== "staff" || dismissed.has(`closed:${s.id}:${today}`)) continue;
    const who = typeof c.by === "string" ? c.by.slice(4) : "Someone";
    attention.push({ tone: "warn", icon: "house", title: `The ${s.name} was marked closed today`, detail: `By ${who}${c.at ? ` at ${new Date(c.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })}` : ""}: ${String(c.reason || "no reason given").slice(0, 120)}`, action: { label: "Open diary", href: links.diary }, dismiss: `closed:${s.id}:${today}` });
  }
  for (const s of diaryToday.filter((s) => !s.setUp)) {
    attention.push({ tone: "warn", icon: "house", title: `The ${s.name} isn't set up`, detail: "It needs a diary Setup before it's counted in the diary or can have shifts.", action: { label: "Set up", go: "sites" } });
  }
  const errs = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(count), 0) AS times FROM errors WHERE last_at > ?").bind(since("errors")).first<{ n: number; times: number }>().catch(() => null);
  if (errs && errs.n) {
    attention.push({ tone: "warn", icon: "warn", title: `${errs.n} error${errs.n === 1 ? "" : "s"} on the site in the last day`,
      detail: `Seen ${errs.times} time${errs.times === 1 ? "" : "s"} on staff devices or the server. See what and where.`, action: { label: "See errors", act: "errors" }, dismiss: "errors" });
  }
  // Devices whose own clock is well out (src/index.ts flagClock): the site corrects for it; the device should be fixed.
  const clocks = await env.DB.prepare("SELECT id, text FROM audit_log WHERE kind = 'clock_off' AND at > ? ORDER BY at DESC LIMIT 5").bind(now - 864e5).all<{ id: number; text: string }>().catch(() => null);
  for (const c of (clocks?.results || []).filter((c) => !dismissed.has(`clock:${c.id}`))) attention.push({ dismiss: `clock:${c.id}`, tone: "warn", icon: "clock", title: c.text.split(". ")[0], detail: "The site uses the right UK time anyway. On the device: Settings → General → Date & Time → Set Automatically.", action: { label: "See activity", go: "activity" } });
  const mailFails = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(text) AS t FROM audit_log WHERE kind = 'email_failed' AND at > ?").bind(since("email_failed")).first<{ n: number; t: string }>().catch(() => null);
  if (mailFails && mailFails.n) {
    attention.push({ tone: "warn", icon: "warn", title: `${mailFails.n} rota email${mailFails.n === 1 ? "" : "s"} didn't send in the last day`,
      detail: String(mailFails.t || "").slice(0, 160), action: { label: "See activity", go: "activity" }, dismiss: "email_failed" });
  }
  const slackFails = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(text) AS t FROM audit_log WHERE kind = 'slack_failed' AND at > ?").bind(since("slack_failed")).first<{ n: number; t: string }>().catch(() => null);
  if (slackFails && slackFails.n) {
    attention.push({ tone: "warn", icon: "warn", title: `${slackFails.n} new-order Slack post${slackFails.n === 1 ? "" : "s"} didn't send`,
      detail: String(slackFails.t || "").slice(0, 160), action: { label: "See activity", go: "activity" }, dismiss: "slack_failed" });
  }
  for (const u of active.filter((u) => u.must_change && !u.last_login_at && now - u.created_at > 2 * 864e5)) {
    const days = Math.floor((now - u.created_at) / 864e5);
    attention.push({ tone: "warn", icon: "user", title: `${u.name} hasn't signed in yet`, detail: `Added ${days} days ago with a temporary password.`, action: { label: "New password", act: "password", id: u.id } });
  }

  const worked = thisW.shifts.filter((s) => s.userId);
  const round = (n: number) => Math.round(n * 10) / 10;
  const sentToday = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'email_sent' AND at > ?").bind(now - 864e5).first<{ n: number }>().catch(() => null);
  const open = diaryToday.filter((s) => s.setUp && !s.closed);
  return {
    today, week,
    attention,
    stats: {
      diary: { done: open.filter((s) => s.pct === 100).length, open: open.length },
      rota: { hours: round(worked.reduce((h, s) => h + s.hours, 0)), overtime: round(worked.reduce((h, s) => h + (s.overtime || 0), 0)), published: thisW.published },
      people: { active: active.length, locked: active.filter((u) => u.locked_until > now).length, notSignedIn: active.filter((u) => !u.last_login_at).length },
      backup: backups[0] ? { at: backups[0].at, count: backups.length } : null,
    },
    diaryToday,
    rotaWeek: SITES.map((s) => {
      const here = thisW.shifts.filter((x) => x.site === s.id);
      return { id: s.id, name: s.name, hours: round(here.filter((x) => x.userId).reduce((h, x) => h + x.hours, 0)), people: new Set(here.map((x) => x.userId).filter(Boolean)).size, open: here.filter((x) => !x.userId).length, inUse: thisW.sites.find((x) => x.id === s.id)?.inUse ?? false };
    }),
    rotaPublished: thisW.published,
    // Rota emails (src/email/): set up (the RESEND_API_KEY secret), sent in the last day, and who has an address.
    emails: { ready: emailReady(env), sentToday: sentToday?.n ?? 0, withAddress: active.filter((u) => u.email).length, active: active.length },
  };
}

/* ---------- people ---------- */

export async function people(env: Env) {
  const now = Date.now(), today = londonToday(), week = mondayOf(today);
  const staffCols = SITES.map((s) => `${s.prefix}staff`);
  const [users, rota, staffDocs, summary, offs] = await Promise.all([
    allUsers(env),
    env.DB.prepare("SELECT user_id, contract_min, contract_max, sites, pattern FROM rota_people").all<{ user_id: string; contract_min: number | null; contract_max: number | null; sites: string; pattern: string }>(),
    env.DB.prepare("SELECT collection, data FROM docs WHERE deleted = 0 AND collection IN (SELECT value FROM json_each(?))").bind(JSON.stringify(staffCols)).all<{ collection: string; data: string }>(),
    rotaWeekSummary(env, week),
    env.DB.prepare("SELECT user_id, from_day, to_day, status FROM rota_time_off WHERE status IN ('requested', 'approved') AND to_day >= ? ORDER BY from_day").bind(today).all<{ user_id: string; from_day: string; to_day: string; status: string }>(),
  ]);
  const rotaBy = new Map(rota.results.map((r) => [r.user_id, r]));
  // Training records are kept per site, matched to a person by name; merge every site's copy.
  const training = new Map<string, { topics: Set<string>; signedAt: number | null; sites: Set<string> }>();
  for (const r of staffDocs.results) {
    const d = parse(r.data, {});
    if (typeof d.name !== "string") continue;
    const key = nameKey(d.name);
    const t = training.get(key) || { topics: new Set<string>(), signedAt: null, sites: new Set<string>() };
    for (const k of TOPICS) if (d.topics?.[k]?.date) t.topics.add(k);
    if (d.signed?.at && (!t.signedAt || d.signed.at > t.signedAt)) t.signedAt = d.signed.at;
    const site = SITES.find((s) => `${s.prefix}staff` === r.collection);
    if (site) t.sites.add(site.name);
    training.set(key, t);
  }
  return {
    topics: TOPICS,
    people: users.map((u) => {
      const r = rotaBy.get(u.id), t = training.get(nameKey(u.name));
      const mine = summary.shifts.filter((s) => s.userId === u.id);
      return {
        id: u.id, name: u.name, username: u.username, role: u.role, active: !!u.active, mustChange: !!u.must_change,
        locked: u.locked_until > now, lockedUntil: u.locked_until > now ? u.locked_until : null,
        lastLoginAt: u.last_login_at, createdAt: u.created_at, createdBy: u.created_by, quickPin: !!u.quick_hash,
        email: u.email || null, emailPrefs: prefsOf(u.email_prefs), weeklySites: weeklySitesOf(u.email_prefs),
        rota: {
          contractMin: r?.contract_min ?? null, contractMax: r?.contract_max ?? null, sites: parse(r?.sites, []), pattern: parse(r?.pattern, {}),
          weekHours: Math.round(mine.reduce((h, s) => h + s.hours, 0) * 10) / 10, weekOvertime: Math.round(mine.reduce((h, s) => h + (s.overtime || 0), 0) * 10) / 10,
          timeOff: offs.results.filter((o) => o.user_id === u.id).slice(0, 3).map((o) => ({ from: o.from_day, to: o.to_day, status: o.status })),
        },
        training: { topics: t ? TOPICS.filter((k) => t.topics.has(k)) : [], signedAt: t?.signedAt ?? null, sites: t ? [...t.sites] : [] },
      };
    }),
  };
}

/* ---------- sites ---------- */

export async function sites(env: Env) {
  const [docs, rotaSites, rotaPeople, users] = await Promise.all([
    docsByPath(env, SITES.map((s) => `${s.prefix}settings/main`)),
    env.DB.prepare("SELECT site, opens_at, closes_at, min_people, day_hours FROM rota_sites").all<{ site: string; opens_at: string | null; closes_at: string | null; min_people: number; day_hours: string }>(),
    env.DB.prepare("SELECT user_id, sites FROM rota_people").all<{ user_id: string; sites: string }>(),
    env.DB.prepare("SELECT id FROM users WHERE active = 1").all<{ id: string }>(),
  ]);
  const sitesOf = new Map(rotaPeople.results.map((r) => [r.user_id, parse(r.sites, []) as string[]]));
  const count = (list: unknown) => (Array.isArray(list) ? list.filter((c: any) => c && !c.off).length : 0);
  return {
    sites: SITES.map((s) => {
      const set = docs.get(`${s.prefix}settings/main`) ?? null;
      const r = rotaSites.results.find((x) => x.site === s.id);
      const here = users.results.filter((u) => (sitesOf.get(u.id) || []).includes(s.id)).length;
      const anywhere = users.results.filter((u) => !(sitesOf.get(u.id) || []).length).length;
      return {
        id: s.id, name: s.name, address: s.address, setUp: !!set,
        diary: set ? {
          units: Array.isArray(set.units) ? set.units.length : 0, opening: count(set.opening), closing: count(set.closing), weekly: count(set.weekly),
          closedDays: (Array.isArray(set.closedDays) ? set.closedDays : []).filter((d: unknown) => typeof d === "number" && d >= 0 && d <= 6).map((d: number) => WEEKDAYS[d]),
          manager: typeof set.info?.manager === "string" ? set.info.manager : "",
        } : null,
        rota: { opensAt: r?.opens_at ?? null, closesAt: r?.closes_at ?? null, minPeople: r?.min_people ?? 1, dayHours: parse(r?.day_hours, {}) },
        people: here, anywhere,
      };
    }),
  };
}

/** Copies one site's diary Setup to a site that has none yet (for example the Roastery's to the Factory). */
async function copySetup(env: Env, user: User, to: string, body: any) {
  const target = siteOf(to), source = siteOf(String(body?.from || ""));
  if (!target || !source || source.id === target.id) throw invalid("Choose a site to copy from.");
  if (await docData(env, `${target.prefix}settings/main`)) throw new ApiError(409, "conflict", `The ${target.name} is already set up. Change it in the diary's Setup.`);
  const src = await docData(env, `${source.prefix}settings/main`);
  if (!src) throw new ApiError(409, "conflict", `The ${source.name} isn't set up, so there's nothing to copy.`);
  const today = londonToday();
  const data: Doc = { ...src, info: { ...(src.info || {}), address: target.address, note: "" }, startDate: today, updatedBy: "web:" + user.name, updatedAt: Date.now() };
  for (const k of ["startSet", "publishedAt", "publishedFrom"]) delete data[k];
  // Checks count from today at the new site, so no earlier day is incomplete.
  for (const k of ["opening", "closing", "weekly"]) if (Array.isArray(data[k])) data[k] = data[k].map((c: Doc) => ({ ...c, from: today }));
  await setDoc(env, `${target.prefix}settings/main`, data, "web:" + user.name);
  await audit(env, "setup_copied", user.name, `${user.name} copied the ${source.name}'s diary Setup to the ${target.name}`);
  return { ok: true };
}

/* ---------- activity ---------- */

const COLLECTION_LABEL: Record<string, string> = {
  days: "the diary", weeks: "the end-of-week checks", extras: "an extra check", cleaning: "a cleaning job", proveit: "a Prove it check",
  allergens: "an allergen item", allergenDocs: "an allergen PDF", suppliers: "a supplier", contacts: "a contact", staff: "a training record",
  reviews: "the 4-weekly review", plans: "a HACCP or risk document", onboarding: "an onboarding document", inspections: "an EHO inspection",
  deliveries: "a delivery", maintenance: "a maintenance job", fire: "a fire safety check", accidents: "an accident book entry", settings: "the Setup",
};
const who = (by: string | null, names: Map<string, string>) => !by ? "Someone" : by.startsWith("web:") ? by.slice(4) : names.get(by) || "Someone";

export async function activity(env: Env, kind: string) {
  const want = (k: string) => kind !== "errors" && (!kind || kind === "all" || kind === k);
  const [docs, people, weeks, offs, reqs, adjusted, log] = await Promise.all([
    want("diary") ? env.DB.prepare("SELECT path, collection, doc_id, data, deleted, updated_at, updated_by FROM docs WHERE source = 'web' AND updated_by IS NOT NULL ORDER BY updated_at DESC LIMIT 60").all<{ path: string; collection: string; doc_id: string; data: string | null; deleted: number; updated_at: number; updated_by: string }>() : null,
    docData(env, "config/people"),
    want("rota") ? env.DB.prepare("SELECT w.week, w.published_at, u.name FROM rota_weeks w LEFT JOIN users u ON u.id = w.published_by WHERE w.published_at IS NOT NULL ORDER BY w.published_at DESC LIMIT 20").all<{ week: string; published_at: number; name: string | null }>() : null,
    want("rota") ? env.DB.prepare("SELECT t.from_day, t.to_day, t.status, t.decided_at, u.name AS who, d.name AS by FROM rota_time_off t JOIN users u ON u.id = t.user_id LEFT JOIN users d ON d.id = t.decided_by WHERE t.decided_at IS NOT NULL AND t.status IN ('approved', 'declined') ORDER BY t.decided_at DESC LIMIT 30").all<{ from_day: string; to_day: string; status: string; decided_at: number; who: string; by: string | null }>() : null,
    want("rota") ? env.DB.prepare("SELECT r.kind, r.status, r.decided_at, s.day, s.site, t.name AS taker, d.name AS by FROM rota_requests r JOIN rota_shifts s ON s.id = r.shift_id LEFT JOIN users t ON t.id = r.taker LEFT JOIN users d ON d.id = r.decided_by WHERE r.status IN ('approved', 'declined') AND r.decided_at IS NOT NULL ORDER BY r.decided_at DESC LIMIT 30").all<any>() : null,
    want("rota") ? env.DB.prepare("SELECT s.day, s.site, s.adjust_note, s.adjusted_at, s.actual_start, s.actual_end, u.name AS who, d.name AS by FROM rota_shifts s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN users d ON d.id = s.adjusted_by WHERE s.adjusted_at IS NOT NULL ORDER BY s.adjusted_at DESC LIMIT 30").all<any>() : null,
    want("account") ? env.DB.prepare("SELECT at, kind, text FROM audit_log WHERE kind <> 'signin_failed' ORDER BY at DESC LIMIT 80").all<{ at: number; kind: string; text: string }>() : null,
  ]);
  const names = new Map(Object.entries(people || {}).filter(([, v]) => typeof v === "string") as [string, string][]);
  const items: { kind: string; at: number; text: string; where: string }[] = [];
  for (const d of docs?.results || []) {
    const site = SITES.find((s) => s.prefix && d.path.startsWith(s.prefix)) || SITES[0];
    const col = d.collection.split("/").pop()!;
    const data = parse(d.data, {});
    const title = typeof data.title === "string" ? data.title : typeof data.name === "string" ? data.name : typeof data.supplier === "string" ? data.supplier : "";
    let what = d.path === "config/shared" ? "the shared setup" : COLLECTION_LABEL[col] || col;
    if (col === "days" && isDay(d.doc_id)) what = `the diary for ${shortDate(d.doc_id)}`;
    else if (col === "weeks" && isDay(d.doc_id)) what = `the end-of-week checks for the week of ${shortDate(d.doc_id)}`;
    else if (title && col !== "staff" && col !== "accidents" && col !== "settings") what += ` (${title.slice(0, 60)})`;
    items.push({ kind: "diary", at: d.updated_at, text: `${who(d.updated_by, names)} ${d.deleted ? "removed" : "updated"} ${what}`, where: d.path.startsWith("config/") ? "Kitchen Diary · all sites" : `Kitchen Diary · ${site.name}` });
  }
  for (const w of weeks?.results || []) items.push({ kind: "rota", at: w.published_at, text: `${w.name || "Someone"} published the rota for the week of ${shortDate(w.week)}`, where: "Rota" });
  for (const t of offs?.results || []) items.push({ kind: "rota", at: t.decided_at, text: `${t.by || "Someone"} ${t.status} ${t.who}'s time off, ${shortDate(t.from_day)}${t.to_day !== t.from_day ? `–${shortDate(t.to_day)}` : ""}`, where: "Rota" });
  for (const r of reqs?.results || []) items.push({ kind: "rota", at: r.decided_at, text: `${r.by || "Someone"} ${r.status} ${r.taker ? `${r.taker} taking` : "a request for"} a shift on ${shortDate(r.day)}`, where: `Rota · ${siteOf(r.site)?.name || r.site}` });
  for (const s of adjusted?.results || []) items.push({ kind: "rota", at: s.adjusted_at, text: `${s.by || "Someone"} amended ${s.who ? `${s.who}'s` : "a"} shift on ${shortDate(s.day)}: ${s.actual_start}–${s.actual_end}${s.adjust_note ? `, ${s.adjust_note}` : ""}`, where: `Rota · ${siteOf(s.site)?.name || s.site}` });
  for (const l of log?.results || []) items.push({ kind: "account", at: l.at, text: l.text, where: l.kind === "backup" ? "Backups" : l.kind === "setup_copied" ? "Kitchen Diary" : l.kind.startsWith("email_") && l.kind !== "email_changed" ? "Rota emails" : l.kind === "clock_off" ? "Devices" : "Accounts" });
  // Errors: only on their own tab (they're for whoever looks after the site, not the day's activity).
  if (kind === "errors") {
    const APP: Record<string, string> = { diary: "Kitchen Diary", rota: "Rota", admin: "Admin", signin: "Staff Login", worker: "Server" };
    const uk = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
    for (const e of await recentErrors(env)) {
      const code = errorCode(e.key), at = whereOf(e.detail), device = e.ua ? deviceOf(e.ua) : "";
      // Everything needed to find and fix it, laid out to be read from a screenshot or pasted as text.
      const report = [
        `Strangers Coffee error ${code}`,
        `What:   ${e.message}`,
        at ? `Where:  ${at}` : "",
        `App:    ${APP[e.app] || e.app}, ${e.source === "server" ? "request" : "page"} ${e.page}`,
        `When:   last ${uk(e.last_at)} (UK time)${e.count > 1 ? `; first ${uk(e.first_at)}; ${e.count} times` : ""}`,
        `Who:    ${[e.who || (e.source === "page" ? "signed out" : "the server"), device].filter(Boolean).join(" · ")}`,
        e.ua ? `Device: ${e.ua}` : "",
        e.detail ? `Stack:\n${e.detail.split("\n").map((l) => "  " + l.trim()).join("\n")}` : "",
      ].filter(Boolean).join("\n");
      items.push({ kind: "error", at: e.last_at, text: e.message, code, at_line: at,
        where: [code, APP[e.app] || e.app, e.page, e.count > 1 ? `${e.count} times since ${shortDate(new Date(e.first_at).toISOString().slice(0, 10))}` : "", e.who || (e.source === "page" ? "signed out" : ""), device].filter(Boolean).join(" · "),
        detail: e.detail, report } as any);
    }
  }
  items.sort((a, b) => b.at - a.at);
  return { items: items.slice(0, 120) };
}

/* ---------- security ---------- */

export async function security(env: Env) {
  const now = Date.now();
  const [users, failed, locks] = await Promise.all([
    allUsers(env),
    env.DB.prepare("SELECT at, text FROM audit_log WHERE kind = 'signin_failed' AND at > ? ORDER BY at DESC").bind(now - 864e5).all<{ at: number; text: string }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'locked' AND at > ?").bind(now - 7 * 864e5).first<{ n: number }>(),
  ]);
  const active = users.filter((u) => u.active);
  return {
    locked: active.filter((u) => u.locked_until > now).map((u) => ({ id: u.id, name: u.name, until: u.locked_until, pinOff: u.role !== "admin" && !u.quick_hash })),
    failed24h: failed.results.length,
    recentFailed: failed.results.slice(0, 8),
    locks7d: locks?.n ?? 0,
    quickPins: active.filter((u) => u.quick_hash).length,
    admins: active.filter((u) => u.role === "admin").length,
    switchedOff: users.filter((u) => !u.active).length,
  };
}

/* ---------- exports ---------- */

/** One CSV cell: quoted, and with a leading quote on anything a spreadsheet would run as a formula. */
const cell = (v: unknown) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};
const csv = (name: string, rows: unknown[][]) => new Response(rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n", {
  headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" },
});

async function exportPeople(env: Env) {
  const { people: list } = await people(env);
  return csv("people.csv", [
    ["name", "username", "role", "active", "rota_sites", "contract_min", "contract_max", "training_topics", "last_sign_in"],
    ...list.map((p) => [p.name, p.username, p.role, p.active ? "yes" : "no", p.rota.sites.map((s: string) => siteOf(s)?.name || s).join("; ") || "any",
      p.rota.contractMin ?? "", p.rota.contractMax ?? "", p.training.topics.length, p.lastLoginAt ? new Date(p.lastLoginAt).toISOString() : ""]),
  ]);
}

async function exportShifts(env: Env, url: URL) {
  const today = londonToday();
  const from = url.searchParams.get("from") || addDays(today, -30), to = url.searchParams.get("to") || today;
  if (!isDay(from) || !isDay(to) || to < from) throw invalid("Choose real dates.");
  if (new Date(to).getTime() - new Date(from).getTime() > 366 * 864e5) throw invalid("Export up to a year at a time.");
  const rows = await env.DB.prepare(
    `SELECT s.day, s.site, s.start, s.end, s.break_mins, s.job, s.actual_start, s.actual_end, s.actual_break, s.adjust_note, u.name
     FROM rota_shifts s LEFT JOIN users u ON u.id = s.user_id WHERE s.day BETWEEN ? AND ? ORDER BY s.day, s.site, s.start`,
  ).bind(from, to).all<any>();
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const paid = (a: string, b: string, brk: number) => Math.max(0, mins(b) - mins(a) - (brk || 0)) / 60;
  return csv(`shifts-${from}-to-${to}.csv`, [
    ["date", "site", "person", "job", "planned_start", "planned_end", "planned_break_mins", "worked_start", "worked_end", "worked_break_mins", "paid_hours", "note"],
    ...rows.results.map((s) => {
      const amended = s.actual_start && s.actual_end;
      const hours = amended ? paid(s.actual_start, s.actual_end, s.actual_break ?? s.break_mins) : paid(s.start, s.end, s.break_mins);
      return [s.day, siteOf(s.site)?.name || s.site, s.name || "Open shift", s.job, s.start, s.end, s.break_mins,
        amended ? s.actual_start : "", amended ? s.actual_end : "", amended ? s.actual_break ?? s.break_mins : "", Math.round(hours * 100) / 100, s.adjust_note || ""];
    }),
  ]);
}

/** The notices on the Overview that can be dismissed: things that happened, not things still to do. Errors and
 *  failed emails come back when there's a new one; a device's clock or a site closed today don't come back. */
const DISMISSIBLE = /^(errors|email_failed|slack_failed|clock:\d{1,12}|closed:[a-z]{1,20}:\d{4}-\d{2}-\d{2})$/;
async function dismiss(env: Env, user: User, body: any) {
  const key = body?.key;
  if (typeof key !== "string" || !DISMISSIBLE.test(key)) throw invalid("That notice can't be dismissed.");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO admin_dismissed (key, at, by) VALUES (?, ?, ?)").bind(key, now, user.name),
    env.DB.prepare("DELETE FROM admin_dismissed WHERE at < ?").bind(now - 30 * 864e5),
  ]);
  return { ok: true };
}

/* ---------- routes: /api/admin/<these> ---------- */

/** The admin section's routes. Returns null for routes it doesn't handle (accounts and backups are elsewhere). */
export async function handleAdminView(req: Request, env: Env, route: string, user: User, links: { rota: string; diary: string }): Promise<Response | null> {
  const m = req.method;
  if (route === "overview" && m === "GET") return json(await overview(env, links));
  if (route === "overview/dismiss" && m === "POST") return json(await dismiss(env, user, await readJson<any>(req, 1024)));
  if (route === "people" && m === "GET") return json(await people(env));
  if (route === "sites" && m === "GET") return json(await sites(env));
  const copy = route.match(/^sites\/([a-z]+)\/copy-setup$/);
  if (copy && m === "POST") return json(await copySetup(env, user, copy[1], await readJson<any>(req, 1024)));
  if (route === "activity" && m === "GET") return json(await activity(env, new URL(req.url).searchParams.get("kind") || "all"));
  if (route === "security" && m === "GET") return json(await security(env));
  if (route === "security/reset-pins" && m === "POST") {
    const r = await env.DB.prepare("UPDATE users SET quick_hash = NULL, quick_salt = NULL WHERE quick_hash IS NOT NULL").run();
    await audit(env, "pins_reset", user.name, `${user.name} reset everyone's quick PIN (${r.meta.changes})`);
    return json({ ok: true, reset: r.meta.changes });
  }
  if (route === "security/sign-out-all" && m === "POST") {
    await env.DB.prepare("UPDATE users SET session_ver = session_ver + 1").run();
    await audit(env, "signed_out_all", user.name, `${user.name} signed everyone out`);
    return json({ ok: true });
  }
  if (route === "export/people.csv" && m === "GET") return exportPeople(env);
  if (route === "export/shifts.csv" && m === "GET") return exportShifts(env, new URL(req.url));
  return null;
}
