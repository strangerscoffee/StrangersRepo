// The diary's daily Slack reminders: a morning and an end-of-day message for the Cafe, ASG and the Roastery, each in
// its own channel, saying what's still to do at that site (src/slackDiaryText.ts has the times and the wording).
// Each channel is a Slack "incoming webhook" the host adds as a secret in Cloudflare (SLACK_CAFE_WEBHOOK_URL,
// SLACK_ASG_WEBHOOK_URL, SLACK_ROASTERY_WEBHOOK_URL: README-deploy.md); a site without one gets nothing.
//
// The 5-minute cron (deliverDiaryReminders) sends each message once: slack_diary_posts (migration 27) has a row per
// site, day and slot, claimed before sending, so two runs can't both send it. If Slack refuses, it's tried again on
// the next runs (up to 3 times, within 45 minutes of its time), then logged as slack_failed for Admin → Overview.
import { audit } from "./audit";
import { ApiError, Env } from "./http";
import { SLACK_DIARY_SITES, SiteData, Slot, addDays, buildReminder, dueSlots, london, mondayOf } from "./slackDiaryText";

const PREFIX: Record<string, string> = { roastery: "", cafe: "sites/cafe/", asg: "sites/asg/" };
const MAX_ATTEMPTS = 3;

function hookOf(env: Env, site: string): string | null {
  const s = SLACK_DIARY_SITES.find((x) => x.id === site);
  const url = s ? (env as unknown as Record<string, string | undefined>)[s.secret] || "" : "";
  if (/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(url)) return url;
  if (env.SLACK_TEST_HOOKS === "1" && /^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return url;
  return null;
}
export const diaryReminderReady = (env: Env, site: string) => !!hookOf(env, site);

/** Tests only (with SLACK_TEST_HOOKS): SLACK_DIARY_NOW pins the time these reminders work from. */
const nowOf = (env: Env) => (env.SLACK_TEST_HOOKS === "1" && env.SLACK_DIARY_NOW ? Date.parse(env.SLACK_DIARY_NOW) : Date.now());

/** One site's diary, as much as the reminder needs. */
async function siteData(env: Env, site: string, today: string): Promise<SiteData> {
  const p = PREFIX[site], thisMon = mondayOf(today), lastMon = addDays(thisMon, -7);
  type Row = { collection: string; doc_id: string; data: string };
  const parse = (s: string) => { try { return JSON.parse(s); } catch { return {}; } };
  const [settings, days, first, weeks, tasks, review] = await env.DB.batch([
    env.DB.prepare("SELECT data FROM docs WHERE deleted = 0 AND path = ?").bind(`${p}settings/main`),
    // Back to a week before last Monday: the last open day, and every day of last week.
    env.DB.prepare("SELECT doc_id, data FROM docs WHERE deleted = 0 AND collection = ? AND doc_id BETWEEN ? AND ?").bind(`${p}days`, addDays(lastMon, -1), today),
    env.DB.prepare("SELECT MIN(doc_id) AS doc_id FROM docs WHERE deleted = 0 AND collection = ?").bind(`${p}days`),
    env.DB.prepare("SELECT doc_id, data FROM docs WHERE deleted = 0 AND collection = ? AND doc_id IN (?, ?)").bind(`${p}weeks`, lastMon, thisMon),
    env.DB.prepare("SELECT collection, doc_id, json_remove(data, '$.log') AS data FROM docs WHERE deleted = 0 AND collection IN (?, ?, ?)").bind(`${p}cleaning`, `${p}extras`, `${p}fire`),
    env.DB.prepare("SELECT MAX(json_extract(data, '$.date')) AS doc_id FROM docs WHERE deleted = 0 AND collection = ?").bind(`${p}reviews`),
  ]);
  const s = (settings.results as { data: string }[])[0];
  return {
    settings: s ? parse(s.data) : null,
    days: Object.fromEntries((days.results as Row[]).map((r) => [r.doc_id, parse(r.data)])),
    firstDay: (first.results as { doc_id: string | null }[])[0]?.doc_id || null,
    weeks: Object.fromEntries((weeks.results as Row[]).map((r) => [r.doc_id, parse(r.data)])),
    tasks: (tasks.results as Row[]).map((r) => ({ kind: r.collection.endsWith("cleaning") ? "cleaning" as const : r.collection.endsWith("fire") ? "fire" as const : "extras" as const, ...parse(r.data) })),
    lastReview: (review.results as { doc_id: string | null }[])[0]?.doc_id || null,
  };
}

const diaryUrl = (env: Env) => `https://${env.COOKIE_DOMAIN || "staffstrangerscoffee.com"}/`;

async function post(url: string, text: string) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }) });
  if (!res.ok) throw new Error(`Slack answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
}

/** The message a site would get now (or at `slot`), without sending it. */
export async function diaryReminder(env: Env, site: string, slot: Slot, now = nowOf(env)) {
  const s = SLACK_DIARY_SITES.find((x) => x.id === site);
  if (!s) throw new ApiError(404, "not_found", "That site has no Slack reminders.");
  const today = london(now).date;
  return buildReminder(s, await siteData(env, site, today), slot, today, diaryUrl(env));
}

/** The 5-minute cron: each site's morning and end-of-day message, once, at its time. */
export async function deliverDiaryReminders(env: Env) {
  const now = nowOf(env);
  for (const s of SLACK_DIARY_SITES) {
    const url = hookOf(env, s.id);
    if (!url) continue;
    for (const { date, slot } of dueSlots(s.id, now)) {
      await env.DB.prepare("INSERT OR IGNORE INTO slack_diary_posts (site, day, slot, created_at, attempts) VALUES (?, ?, ?, ?, 0)").bind(s.id, date, slot, Date.now()).run();
      const row = await env.DB.prepare("SELECT attempts, sent_at FROM slack_diary_posts WHERE site = ? AND day = ? AND slot = ?").bind(s.id, date, slot).first<{ attempts: number; sent_at: number | null }>();
      if (!row || row.sent_at != null || row.attempts >= MAX_ATTEMPTS) continue;
      const claimed = await env.DB.prepare("UPDATE slack_diary_posts SET sent_at = ?, attempts = attempts + 1 WHERE site = ? AND day = ? AND slot = ? AND sent_at IS NULL AND attempts = ?")
        .bind(Date.now(), s.id, date, slot, row.attempts).run();
      if (!claimed.meta.changes) continue;
      try {
        const r = await diaryReminder(env, s.id, slot, now);
        if (r.closed) { await env.DB.prepare("UPDATE slack_diary_posts SET last_error = 'closed' WHERE site = ? AND day = ? AND slot = ?").bind(s.id, date, slot).run(); continue; }
        await post(url, r.text);
      } catch (error) {
        const message = String((error as Error)?.message || error).slice(0, 200);
        await env.DB.prepare("UPDATE slack_diary_posts SET sent_at = NULL, last_error = ? WHERE site = ? AND day = ? AND slot = ?").bind(message, s.id, date, slot).run();
        if (row.attempts + 1 >= MAX_ATTEMPTS) await audit(env, "slack_failed", null, `Couldn't post the ${s.name}'s ${slot === "morning" ? "morning" : "end-of-day"} diary reminder to Slack: ${message}`).catch(() => {});
      }
    }
  }
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM slack_diary_posts WHERE created_at < ?").bind(Date.now() - 60 * 864e5).run().catch(() => {});
}

/** Admin → Sites: sends the site's message as it stands now to its channel, marked as a test. */
export async function sendDiaryReminderTest(env: Env, site: string, slot: Slot) {
  const url = hookOf(env, site);
  if (!url) throw new ApiError(409, "slack_not_configured", "This site's Slack channel isn't connected yet.");
  const r = await diaryReminder(env, site, slot);
  const text = r.closed ? `:test_tube: Test: the ${SLACK_DIARY_SITES.find((x) => x.id === site)!.name} is closed today (or not set up), so no reminder would be sent.` : `:test_tube: _Test of the ${slot === "morning" ? "morning" : "end-of-day"} reminder_\n${r.text}`;
  await post(url, text);
  return { sent: true, closed: r.closed, allClear: r.allClear };
}
