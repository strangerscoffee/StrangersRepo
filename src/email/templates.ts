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
      row(`${button(m.links.rota, "Open the rota")}<br><span style="font-size:13px;color:${MUTED};">A calendar file with these shifts is attached. Need a swap? Ask for cover from the shift in the rota.</span>`, "14px 22px 22px"),
  });
  const text = `Hi ${first},\n\nThe rota for the week of ${dayMonth(m.week)} is out. Your shifts:\n\n${sorted.map(textShift).join("\n")}\n\n${totals(sorted, m.contractMin, m.contractMax)}.\n\nOpen the rota: ${m.links.rota}\nNeed a swap? Ask for cover from the shift in the rota.\n${textFooter(m.links)}`;
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
export function requestEmail(o: { name: string; role: "asker" | "taker"; kind: "cover" | "claim"; approved: boolean; shift: MailShift; other: string; by: string; links: Links }): Built {
  const first = o.name.split(" ")[0], when = shiftText(o.shift);
  let subject: string, heading: string, say: string;
  if (o.kind === "claim") {
    subject = o.approved ? `The open shift on ${longDay(o.shift.day)} is yours` : `The open shift on ${longDay(o.shift.day)}: not this time`;
    heading = o.approved ? "You've got the shift" : "Your pick-up wasn't approved";
    say = o.approved ? `It's yours: <b>${esc(when)}</b>.` : `${esc(o.by)} didn't approve your pick-up of ${esc(when)}.`;
  } else if (o.role === "asker") {
    subject = o.approved ? `${o.other} is covering your shift on ${longDay(o.shift.day)}` : `Your cover request for ${longDay(o.shift.day)} was declined`;
    heading = o.approved ? "Your cover is approved" : "Your cover request was declined";
    say = o.approved ? `<b>${esc(o.other)}</b> is now working your shift on <b>${esc(when)}</b>. You're off.` : `You're still on ${esc(when)}.`;
  } else {
    subject = o.approved ? `You're covering ${o.other}'s shift on ${longDay(o.shift.day)}` : `Cover for ${o.other} on ${longDay(o.shift.day)}: not needed`;
    heading = o.approved ? "You're covering a shift" : "Your cover wasn't approved";
    say = o.approved ? `You're now working <b>${esc(when)}</b>, covering ${esc(o.other)}.` : `${esc(o.other)} stays on ${esc(when)}.`;
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
  const say = o.approved ? `You're off ${o.from === o.to ? "on" : "from"} <b>${esc(span)}</b>.` : `Your time off for <b>${esc(span)}</b> was declined. You can still ask someone to cover your shifts from the rota.`;
  const html = layout({ preheader: subject, heading: `Hi ${first}, your time off was ${o.approved ? "approved" : "declined"}`, links: o.links,
    body: notice(o.approved, say) + row(`<span style="color:${MUTED};font-size:14px;">Decided by ${esc(o.by)}.</span>`) + row(button(o.links.rota, o.approved ? "Open the rota" : "Ask for cover"), "14px 22px 22px") });
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
