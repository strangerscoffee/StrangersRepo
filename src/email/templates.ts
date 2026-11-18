// The rota's emails, in the "week strip" design the host chose: a white card with the Strangers wordmark, for a
// week a Mon–Sun strip coloured by site (days off grey), then the shifts one per line, and a plain-text version of
// each. Built with tables and inline styles, as email apps (Outlook, Gmail) need; everything shown is escaped.

export interface MailShift {
  id: string; day: string; start: string; end: string; site: string; siteName: string; job: string; hours: number; with: string[];
}
export interface Built { subject: string; html: string; text: string }
export interface Links { rota: string; prefs: string; unsubscribe: string }

const SITE_COLOUR: Record<string, string> = { roastery: "#0062cc", cafe: "#c45f00", asg: "#1f7a45", factory: "#6f42c1" };
const MUTED = "#5d6675", LINE = "#e3e6eb", INK = "#14181f";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const DAY_MS = 864e5;
const dateOf = (d: string) => new Date(d + "T12:00:00Z");
export const addDays = (d: string, n: number) => new Date(dateOf(d).getTime() + n * DAY_MS).toISOString().slice(0, 10);
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...o }).format(dateOf(d));
export const longDay = (d: string) => fmt(d, { weekday: "long", day: "numeric", month: "long" }); // Monday 9 November
export const shortDay = (d: string) => fmt(d, { weekday: "short", day: "numeric", month: "short" }); // Mon 9 Nov
const dayMonth = (d: string) => fmt(d, { day: "numeric", month: "long" }); // 9 November
const hrs = (h: number) => `${Math.round(h * 100) / 100}`.replace(/\.0+$/, "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const listNames = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** "Opens · with Priya" style line for a shift. */
function detail(s: MailShift): string {
  const bits = [s.job === "opens" ? "Opens" : s.job === "closes" ? "Closes" : ""];
  if (s.with.length) bits.push(`${bits[0] ? "with" : "With"} ${listNames(s.with)}`);
  return bits.filter(Boolean).join(" · ");
}

/* ---------- the frame every email shares ---------- */

function layout(o: { preheader: string; heading: string; body: string; links: Links }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(o.heading)}</title></head>
<body style="margin:0;padding:0;background:#eef1f6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;"><tr><td align="center" style="padding:20px 12px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:14px;font-family:${FONT};color:${INK};">
<tr><td style="padding:22px 22px 0;">
<div style="font-weight:800;letter-spacing:0.32em;font-size:14px;">STRANGERS <span style="letter-spacing:0.18em;font-size:10px;color:${MUTED};">ROTA</span></div>
<h1 style="margin:14px 0 0;font-size:22px;line-height:1.25;font-weight:700;">${esc(o.heading)}</h1>
</td></tr>
${o.body}
<tr><td style="border-top:1px solid ${LINE};padding:14px 22px 18px;font-size:12.5px;line-height:1.5;color:${MUTED};">
Sent by the Strangers Coffee staff rota because you work on it.<br>
<a href="${esc(o.links.prefs)}" style="color:${MUTED};">Choose which emails you get</a> · <a href="${esc(o.links.unsubscribe)}" style="color:${MUTED};">Unsubscribe</a>
</td></tr></table></td></tr></table></body></html>`;
}
const row = (html: string, pad = "14px 22px 0") => `<tr><td style="padding:${pad};font-size:15px;line-height:1.5;">${html}</td></tr>`;
const button = (href: string, label: string, primary = true) =>
  `<a href="${esc(href)}" style="display:inline-block;background:${primary ? "#0062cc" : "#eef4fc"};color:${primary ? "#ffffff" : "#0062cc"};font-weight:700;text-decoration:none;border-radius:99px;padding:12px 20px;margin:0 8px 8px 0;font-size:15px;">${esc(label)}</a>`;
const textFooter = (l: Links) => `\n--\nSent by the Strangers Coffee staff rota because you work on it.\nChoose which emails you get: ${l.prefs}\nUnsubscribe: ${l.unsubscribe}\n`;

/* ---------- a week: the strip and the list ---------- */

function strip(week: string, shifts: MailShift[], changedDays: Set<string>): string {
  const cells: string[] = [];
  const sites = new Map<string, string>();
  for (let i = 0; i < 7; i++) {
    const d = addDays(week, i), on = shifts.filter((s) => s.day === d).sort((a, b) => a.start.localeCompare(b.start));
    const first = on[0];
    if (first) sites.set(first.site, first.siteName);
    const bg = first ? SITE_COLOUR[first.site] || "#0062cc" : "#f1f3f7", fg = first ? "#ffffff" : MUTED;
    const ring = changedDays.has(d) ? "box-shadow:0 0 0 2px #ffffff,0 0 0 4px #f5a524;" : "";
    cells.push(`<td width="14%" align="center" style="padding:0 2px;"><div style="border-radius:10px;padding:8px 0;background:${bg};color:${fg};font-family:${FONT};${ring}">
<div style="font-size:10.5px;font-weight:700;">${fmt(d, { weekday: "short" }).toUpperCase()}</div>
<div style="font-size:18px;font-weight:800;line-height:1.3;">${fmt(d, { day: "numeric" })}</div>
<div style="font-size:10px;font-weight:600;">${first ? esc(first.start) : "off"}</div></div></td>`);
  }
  const key = [...sites].map(([id, name]) => `<span style="display:inline-block;margin-right:14px;"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${SITE_COLOUR[id] || "#0062cc"};vertical-align:middle;"></span>&nbsp;${esc(name)}</span>`).join("");
  return `<tr><td style="padding:16px 20px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells.join("")}</tr></table>
${key ? `<div style="margin-top:10px;font-size:12px;color:${MUTED};">${key}</div>` : ""}</td></tr>`;
}

function shiftLine(s: MailShift, extra = "", was = ""): string {
  const sub = [detail(s), was ? `was ${was}` : ""].filter(Boolean).join(" · ");
  return `<tr><td style="padding:10px 0;border-top:1px solid ${LINE};font-size:15px;line-height:1.45;">
<b>${esc(fmt(s.day, { weekday: "long" }))}</b> · ${esc(s.siteName)}${extra}${sub ? `<br><span style="font-size:13px;color:${MUTED};">${esc(sub)}</span>` : ""}</td>
<td align="right" valign="top" style="padding:10px 0;border-top:1px solid ${LINE};font-size:15px;font-weight:700;white-space:nowrap;">${esc(s.start)}–${esc(s.end)}</td></tr>`;
}
const lines = (inner: string) => `<tr><td style="padding:14px 22px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid ${LINE};">${inner}</table></td></tr>`;
const contractText = (min: number | null, max: number | null) =>
  min != null && max != null ? (min === max ? `${hrs(max)}h` : `${hrs(min)}–${hrs(max)}h`) : max != null ? `up to ${hrs(max)}h` : min != null ? `at least ${hrs(min)}h` : "";
function totals(shifts: MailShift[], min: number | null, max: number | null): string {
  const total = shifts.reduce((h, s) => h + s.hours, 0), c = contractText(min, max);
  return `${hrs(total)} hours after breaks${c ? ` · your contract is ${c}` : ""}`;
}
const textShift = (s: MailShift) => `- ${shortDay(s.day)}, ${s.start}–${s.end} at the ${s.siteName}${detail(s) ? ` (${detail(s)})` : ""}`;
const shiftChangeHelp = "To change one of your shifts, ask an admin.";

export interface WeekMail { name: string; week: string; shifts: MailShift[]; contractMin: number | null; contractMax: number | null; links: Links }

/** "Your shifts for the week of 9 November": when a week is first published. */
export function publishedEmail(m: WeekMail): Built {
  const first = m.name.split(" ")[0];
  const days = new Set(m.shifts.map((s) => s.day)).size;
  const subject = `Your shifts for the week of ${dayMonth(m.week)}`;
  const heading = `Hi ${first}, you're on ${plural(days, "day")} next week`;
  const sorted = [...m.shifts].sort((a, b) => (a.day + a.start).localeCompare(b.day + b.start));
  const html = layout({
    preheader: `${plural(m.shifts.length, "shift")}, ${hrs(m.shifts.reduce((h, s) => h + s.hours, 0))} hours. The rota for the week of ${dayMonth(m.week)} is out.`,
    heading, links: m.links,
    body: strip(m.week, sorted, new Set()) + lines(sorted.map((s) => shiftLine(s)).join("")) +
      row(`<span style="font-size:14px;color:${MUTED};">${esc(totals(sorted, m.contractMin, m.contractMax))}</span>`) +
      row(`${button(m.links.rota, "Open the rota")}<br><span style="font-size:13px;color:${MUTED};">A calendar file with these shifts is attached. ${shiftChangeHelp}</span>`, "14px 22px 22px"),
  });
  const text = `Hi ${first},\n\nThe rota for the week of ${dayMonth(m.week)} is out. Your shifts:\n\n${sorted.map(textShift).join("\n")}\n\n${totals(sorted, m.contractMin, m.contractMax)}.\n\nOpen the rota: ${m.links.rota}\n${shiftChangeHelp}\n${textFooter(m.links)}`;
  return { subject, html, text };
}

export interface Change { kind: "added" | "moved" | "removed"; shift: MailShift; was?: string }

/** "Your shifts for the week of 9 November have changed": after a published week is changed and published again. */
export function changedEmail(m: WeekMail & { changes: Change[]; by: string }): Built {
  const first = m.name.split(" ")[0];
  const subject = m.changes.length === 1
    ? `Your shift on ${longDay(m.changes[0].shift.day)} has ${m.changes[0].kind === "added" ? "been added" : m.changes[0].kind === "removed" ? "been removed" : "changed"}`
    : `Your shifts for the week of ${dayMonth(m.week)} have changed`;
  const sorted = [...m.shifts].sort((a, b) => (a.day + a.start).localeCompare(b.day + b.start));
  const changedDays = new Set(m.changes.map((c) => c.shift.day));
  const tag = (c: Change) => c.kind === "added" ? ` <span style="font-size:12px;font-weight:700;color:#1f7a45;">· Added</span>`
    : c.kind === "removed" ? ` <span style="font-size:12px;font-weight:700;color:#b42318;">· Removed</span>` : ` <span style="font-size:12px;font-weight:700;color:#9a5b00;">· Changed</span>`;
  const changeRows = m.changes.map((c) => c.kind === "removed"
    ? `<tr><td style="padding:10px 0;border-top:1px solid ${LINE};font-size:15px;color:${MUTED};"><s>${esc(fmt(c.shift.day, { weekday: "long" }))} · ${esc(c.shift.siteName)}</s>${tag(c)}</td><td align="right" style="padding:10px 0;border-top:1px solid ${LINE};font-size:15px;color:${MUTED};white-space:nowrap;"><s>${esc(c.shift.start)}–${esc(c.shift.end)}</s></td></tr>`
    : shiftLine(c.shift, tag(c), c.was || "")).join("");
  const html = layout({
    preheader: `${m.by} changed ${plural(m.changes.length, "of your shifts").replace(/^1 of your shifts$/, "one of your shifts")} for the week of ${dayMonth(m.week)}.`,
    heading: `Hi ${first}, your week has changed`, links: m.links,
    body: row(`${esc(m.by)} changed your shifts for the week of ${esc(dayMonth(m.week))}. What changed:`) + lines(changeRows) +
      row(`<b style="font-size:14px;">Your week now</b>`, "18px 22px 0") + strip(m.week, sorted, changedDays) +
      (sorted.length ? lines(sorted.map((s) => shiftLine(s)).join("")) : row(`<span style="color:${MUTED};">You have no shifts that week now.</span>`)) +
      row(`<span style="font-size:14px;color:${MUTED};">${esc(totals(sorted, m.contractMin, m.contractMax))}</span>`) +
      row(button(m.links.rota, "See your week"), "14px 22px 22px"),
  });
  const textChanges = m.changes.map((c) => c.kind === "removed" ? `- Removed: ${shortDay(c.shift.day)}, ${c.shift.start}–${c.shift.end} at the ${c.shift.siteName}`
    : `- ${c.kind === "added" ? "Added" : "Changed"}: ${shortDay(c.shift.day)}, ${c.shift.start}–${c.shift.end} at the ${c.shift.siteName}${c.was ? ` (was ${c.was})` : ""}`).join("\n");
  const text = `Hi ${first},\n\n${m.by} changed your shifts for the week of ${dayMonth(m.week)}.\n\n${textChanges}\n\nYour week now:\n${sorted.length ? sorted.map(textShift).join("\n") : "No shifts."}\n\n${totals(sorted, m.contractMin, m.contractMax)}.\n\nSee your week: ${m.links.rota}\n${textFooter(m.links)}`;
  return { subject, html, text };
}

/* ---------- decisions and offers ---------- */

const notice = (ok: boolean, html: string) =>
  row(`<div style="background:${ok ? "#eaf7ee" : "#fdecea"};color:${ok ? "#14532d" : "#7f1d1d"};border-radius:10px;padding:12px 14px;font-size:15px;line-height:1.45;">${html}</div>`);
const shiftText = (s: MailShift) => `${longDay(s.day)}, ${s.start}–${s.end} at the ${s.siteName}`;

/** A cover or pick-up request decided, for the person who asked or the person taking the shift. */
export function requestEmail(o: { name: string; role: "asker" | "taker"; kind: "cover" | "claim"; approved: boolean; shift: MailShift; by: string; links: Links }): Built {
  const first = o.name.split(" ")[0], when = shiftText(o.shift);
  let subject: string, heading: string, say: string;
  if (o.kind === "claim") {
    subject = o.approved ? `The open shift on ${longDay(o.shift.day)} is yours` : `The open shift on ${longDay(o.shift.day)}: not this time`;
    heading = o.approved ? "You've got the shift" : "Your pick-up wasn't approved";
    say = o.approved ? `It's yours: <b>${esc(when)}</b>.` : `${esc(o.by)} didn't approve your pick-up of ${esc(when)}.`;
  } else if (o.role === "asker") {
    subject = o.approved ? `Your cover is approved for ${longDay(o.shift.day)}` : `Your cover request for ${longDay(o.shift.day)} was declined`;
    heading = o.approved ? "Your cover is approved" : "Your cover request was declined";
    say = o.approved ? `Your shift on <b>${esc(when)}</b> is covered. You're off.` : `You're still on ${esc(when)}.`;
  } else {
    subject = o.approved ? `Your cover shift on ${longDay(o.shift.day)} is approved` : "Your cover request was not approved";
    heading = o.approved ? "You're covering a shift" : "Your cover wasn't approved";
    say = o.approved ? `You're now working <b>${esc(when)}</b>.` : "Your offer to cover was not approved. Your own shifts are unchanged.";
  }
  const html = layout({ preheader: subject, heading: `Hi ${first}: ${heading.toLowerCase()}`, links: o.links,
    body: notice(o.approved, say) + row(`<span style="color:${MUTED};font-size:14px;">${o.approved ? "Approved" : "Decided"} by ${esc(o.by)}.</span>`) + row(button(o.links.rota, "Open the rota"), "14px 22px 22px") });
  const text = `Hi ${first},\n\n${say.replace(/<[^>]+>/g, "")}\n${o.approved ? "Approved" : "Decided"} by ${o.by}.\n\nOpen the rota: ${o.links.rota}\n${textFooter(o.links)}`;
  return { subject, html, text };
}

/** Time off approved or declined. */
export function timeOffEmail(o: { name: string; from: string; to: string; approved: boolean; by: string; links: Links }): Built {
  const first = o.name.split(" ")[0];
  const span = o.from === o.to ? longDay(o.from) : `${longDay(o.from)} to ${longDay(o.to)}`;
  const subject = `Time off ${o.from === o.to ? "on" : "from"} ${o.from === o.to ? longDay(o.from) : `${longDay(o.from)} to ${longDay(o.to)}`}: ${o.approved ? "approved" : "declined"}`;
  const say = o.approved ? `You're off ${o.from === o.to ? "on" : "from"} <b>${esc(span)}</b>.` : `Your time off for <b>${esc(span)}</b> was declined. ${shiftChangeHelp}`;
  const html = layout({ preheader: subject, heading: `Hi ${first}, your time off was ${o.approved ? "approved" : "declined"}`, links: o.links,
    body: notice(o.approved, say) + row(`<span style="color:${MUTED};font-size:14px;">Decided by ${esc(o.by)}.</span>`) + row(button(o.links.rota, "Open the rota"), "14px 22px 22px") });
  const text = `Hi ${first},\n\n${say.replace(/<[^>]+>/g, "")}\nDecided by ${o.by}.\n\nOpen the rota: ${o.links.rota}\n${textFooter(o.links)}`;
  return { subject, html, text };
}

/** Open shifts this person could take (only for those who turned these emails on). */
export function openShiftsEmail(o: { name: string; shifts: MailShift[]; links: Links }): Built {
  const first = o.name.split(" ")[0];
  const sorted = [...o.shifts].sort((a, b) => (a.day + a.start).localeCompare(b.day + b.start));
  const subject = sorted.length === 1 ? `Open shift: ${sorted[0].siteName}, ${longDay(sorted[0].day)}` : `${sorted.length} open shifts you could take`;
  const html = layout({ preheader: subject, heading: sorted.length === 1 ? "There's a shift you could take" : "There are shifts you could take", links: o.links,
    body: row(`Hi ${esc(first)}, you're free for ${sorted.length === 1 ? "this one" : "these"}. A manager approves who gets ${sorted.length === 1 ? "it" : "each"}.`) +
      lines(sorted.map((s) => shiftLine(s)).join("")) + row(button(o.links.rota, "See open shifts"), "14px 22px 22px") });
  const text = `Hi ${first},\n\nYou're free for ${sorted.length === 1 ? "this open shift" : "these open shifts"}:\n\n${sorted.map(textShift).join("\n")}\n\nA manager approves who gets ${sorted.length === 1 ? "it" : "each"}. See open shifts: ${o.links.rota}\n${textFooter(o.links)}`;
  return { subject, html, text };
}

/** A test from the admin section, to the admin's own address. */
export function testEmail(o: { name: string; links: Links }): Built {
  const subject = "Test email from the Strangers rota";
  const html = layout({ preheader: "Rota emails are working.", heading: `Hi ${o.name.split(" ")[0]}, rota emails are working`, links: o.links,
    body: row("This is a test from Admin. If it reached your inbox (not spam), the sending address is set up properly.") + row(button(o.links.rota, "Open the rota"), "14px 22px 22px") });
  return { subject, html, text: `Rota emails are working. This is a test from Admin.\n${textFooter(o.links)}` };
}

/* ---------- a calendar file of a week's shifts (Add to calendar) ---------- */

/** The UTC instant of a wall-clock time in Europe/London on a day. */
function londonUtc(day: string, time: string): Date {
  const guess = new Date(`${day}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(guess);
  const [h, mi] = parts.split(":").map(Number), [th, tm] = time.split(":").map(Number);
  return new Date(guess.getTime() - ((h * 60 + mi) - (th * 60 + tm)) * 60000);
}
const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const icsText = (s: string) => s.replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");

export function shiftsCalendar(shifts: MailShift[], rotaUrl: string): string {
  const now = icsTime(new Date());
  const events = shifts.map((s) => {
    const start = londonUtc(s.day, s.start);
    let end = londonUtc(s.day, s.end);
    if (end <= start) end = londonUtc(addDays(s.day, 1), s.end); // past midnight
    return ["BEGIN:VEVENT", `UID:shift-${s.id}@staffstrangerscoffee.com`, `DTSTAMP:${now}`, `DTSTART:${icsTime(start)}`, `DTEND:${icsTime(end)}`,
      `SUMMARY:${icsText(`Strangers: ${s.siteName}${s.job === "opens" ? " (opening)" : s.job === "closes" ? " (closing)" : ""}`)}`,
      `LOCATION:${icsText(`Strangers Coffee ${s.siteName}`)}`, `DESCRIPTION:${icsText(`${detail(s)}\n${rotaUrl}`.trim())}`, "END:VEVENT"].join("\r\n");
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Strangers Coffee//Rota//EN", "METHOD:PUBLISH", "CALSCALE:GREGORIAN", ...events, "END:VCALENDAR", ""].join("\r\n");
}

/* ---------- holiday: extra hours added, holiday left to take ---------- */

const daysText = (n: number) => `${Math.round(n * 100) / 100} day${Math.round(n * 100) / 100 === 1 ? "" : "s"}`;
const fact = (label: string, value: string) => `<tr><td style="padding:6px 0;border-top:1px solid ${LINE};color:${MUTED};font-size:14px;">${esc(label)}</td><td style="padding:6px 0;border-top:1px solid ${LINE};text-align:right;font-weight:700;font-size:14px;">${esc(value)}</td></tr>`;
const facts = (rows: [string, string][]) => `<tr><td style="padding:14px 22px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.map(([a, b]) => fact(a, b)).join("")}</table></td></tr>`;

/** Holiday added for the hours someone worked above their minimum in a quarter, with the workings. */
export function holidayAddedEmail(o: { name: string; quarter: string; days: number; countedHours: number; minimumHours: number; extraHours: number; accruedHours: number; dayHours: number; links: Links }): Built {
  const first = o.name.split(" ")[0];
  const subject = `${daysText(o.days)} holiday added for your extra hours (${o.quarter})`;
  const rows: [string, string][] = [["Hours counted", `${hrs(o.countedHours)} hours`], ["Your minimum contracted hours", `${hrs(o.minimumHours)} hours`], ["Extra hours", `${hrs(o.extraHours)} hours`], ["Holiday rate", "12.07% (GOV.UK)"], ["Holiday earned", `${hrs(o.accruedHours)} hours`], ["Your average working day", `${hrs(o.dayHours)} hours`], ["Added to your allowance", daysText(o.days)]];
  const html = layout({ preheader: subject, heading: `Hi ${first}, you've earned extra holiday`, links: o.links,
    body: row(`You worked more than your minimum contracted hours in <b>${esc(o.quarter)}</b>, so <b>${esc(daysText(o.days))}</b> of holiday has been added to your allowance.`) + facts(rows) +
      row(`<span style="color:${MUTED};font-size:14px;">Hours counted are your paid hours on the rota, plus planned hours missed through sickness and an average day for each day of holiday.</span>`) + row(button(o.links.rota + "#leave", "See my holiday"), "14px 22px 22px") });
  const text = `Hi ${first},\n\nYou worked more than your minimum contracted hours in ${o.quarter}, so ${daysText(o.days)} of holiday has been added to your allowance.\n\n${rows.map(([a, b]) => `${a}: ${b}`).join("\n")}\n\nSee my holiday: ${o.links.rota}#leave\n${textFooter(o.links)}`;
  return { subject, html, text };
}

/** A reminder about holiday left to take before the leave year ends. The `final` one is the formal notice that what
 *  isn't taken will be lost. */
export function holidayReminderEmail(o: { name: string; stage: "half" | "three" | "two" | "final"; left: number; deadline: string; canRequest: boolean; links: Links }): Built {
  const first = o.name.split(" ")[0], end = longDay(o.deadline), left = daysText(o.left);
  const subject = o.stage === "final" ? `Important: ${left} of holiday must be taken by ${end}` : o.stage === "half" ? `You've ${left} of holiday to book this year` : `${left} of holiday left to book before ${end}`;
  const how = o.canRequest ? "Request it in the rota under Holidays." : "Ask an admin to book it for you.";
  const notice = `Remember to give notice of at least twice as long as the holiday, plus a day (3 days' notice for 1 day off).`;
  const say = o.stage === "final"
    ? `This is your formal notice: you have <b>${esc(left)}</b> of holiday not yet booked, and the leave year ends on <b>${esc(end)}</b>. Holiday not taken by then will be lost unless the law says it carries over or an admin agrees it in writing. Please book it now.`
    : o.stage === "half"
      ? `We're halfway through the leave year and you have <b>${esc(left)}</b> of holiday not yet booked. Taking it regularly is good for you, and leaving it late makes it harder to fit in. The year ends on <b>${esc(end)}</b>.`
      : `You have <b>${esc(left)}</b> of holiday not yet booked, and the leave year ends on <b>${esc(end)}</b>. Please plan it now, so you can take it before then. Holiday not taken by then won't carry over unless the law requires it or an admin agrees.`;
  const html = layout({ preheader: subject, heading: o.stage === "final" ? `${first}, please book your holiday` : `Hi ${first}, don't forget your holiday`, links: o.links,
    body: row(say) + row(`${esc(how)} ${esc(notice)}`) + row(button(o.links.rota + "#leave", o.canRequest ? "Book holiday" : "See my holiday"), "14px 22px 22px") });
  const text = `Hi ${first},\n\n${say.replace(/<[^>]+>/g, "")}\n\n${how} ${notice}\n\n${o.canRequest ? "Book holiday" : "See my holiday"}: ${o.links.rota}#leave\n${textFooter(o.links)}`;
  return { subject, html, text };
}

/** For admins: people with holiday left to take who've reached a reminder stage, and a quarter ready to review. */
export function holidayAdminEmail(o: { name: string; people: { name: string; left: number; stage: string; deadline: string; cutoff: string }[]; quarter: string | null; links: Links }): Built {
  const first = o.name.split(" ")[0];
  const subject = o.people.length ? `${o.people.length} ${o.people.length === 1 ? "person has" : "people have"} holiday left to take` : `Holiday for extra hours: ${o.quarter} is ready to review`;
  const peopleRows = o.people.map((p) => `<tr><td style="padding:8px 0;border-top:1px solid ${LINE};font-size:14px;"><b>${esc(p.name)}</b><br><span style="color:${MUTED};">${esc(p.stage)}</span></td><td style="padding:8px 0;border-top:1px solid ${LINE};text-align:right;font-size:14px;"><b>${esc(daysText(p.left))}</b><br><span style="color:${MUTED};">require by ${esc(shortDay(p.cutoff))}</span></td></tr>`).join("");
  const html = layout({ preheader: subject, heading: `Hi ${first}, holiday needs a look`, links: o.links,
    body: (o.people.length ? row(`These people still have holiday to book before the leave year ends. You can require someone to take holiday by giving notice of twice the length of the holiday; the date on the right is the last day to do that comfortably.`) + `<tr><td style="padding:14px 22px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${peopleRows}</table></td></tr>` : "") +
      (o.quarter ? row(`Holiday for extra hours worked in <b>${esc(o.quarter)}</b> is ready to review and approve.`) : "") + row(button(o.links.rota + "#leave-admin", "Open Holiday management"), "14px 22px 22px") });
  const text = `Hi ${first},\n\n${o.people.length ? `These people still have holiday to book before the leave year ends:\n${o.people.map((p) => `- ${p.name}: ${daysText(p.left)} (${p.stage}; require by ${shortDay(p.cutoff)})`).join("\n")}\n\n` : ""}${o.quarter ? `Holiday for extra hours worked in ${o.quarter} is ready to review and approve.\n\n` : ""}Open Holiday management: ${o.links.rota}#leave-admin\n${textFooter(o.links)}`;
  return { subject, html, text };
}

/** For admins: a member of staff changed their own profile details. Names the fields, never the new values. */
export function profileChangedEmail(o: { name: string; who: string; fields: string[]; adminUrl: string; links: Links }): Built {
  const first = o.name.split(" ")[0];
  const list = o.fields.length < 2 ? o.fields.join("") : `${o.fields.slice(0, -1).join(", ")} and ${o.fields[o.fields.length - 1]}`;
  const subject = `${o.who} updated their ${list}`;
  const html = layout({ preheader: subject, heading: `Hi ${first}, a profile was updated`, links: o.links,
    body: row(`<b>${esc(o.who)}</b> changed their <b>${esc(list)}</b> on their staff profile.`) + row(`<span style="color:${MUTED};font-size:14px;">The new details are in Admin → People. They aren't included in this email.</span>`) + row(button(o.adminUrl, "Open People in Admin"), "14px 22px 22px") });
  const text = `Hi ${first},\n\n${o.who} changed their ${list} on their staff profile.\nThe new details are in Admin → People; they aren't included in this email.\n\nOpen People in Admin: ${o.adminUrl}\n${textFooter(o.links)}`;
  return { subject, html, text };
}
