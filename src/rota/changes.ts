// What's changed on a published week since it was published (the owner's request, 18 Nov 2026), for the publish
// sheet and the week's "Published · n changes not sent". Import-free so tests can load it.
//
// Publishing saves a snapshot of the week (rota_weeks.published_shifts, migration 35): every shift and every
// approved absence. The week view compares today's shifts and absences with it. Weeks published before the snapshot
// existed compare with what staff were last emailed (rota_weeks.emailed): assigned shifts only.
// Admins only: the list names people.

export interface PubShift { id: string; day: string; site: string; start: string; end: string; breakMins?: number; job: string; userId: string | null; note?: string }
export interface PubOff { id: string; userId: string; from: string; to: string; kind?: string; fromTime?: string | null; toTime?: string | null }
export interface WeekSnapshot { at: number; shifts: PubShift[]; timeOff: PubOff[] | null; basis: "published" | "emailed" }

export interface WeekChange {
  kind: "added" | "removed" | "changed" | "off-added" | "off-removed";
  day: string; site?: string; start?: string; end?: string; name: string | null;
  /** For "changed": how it was, and which parts changed. */
  was?: { day: string; site: string; start: string; end: string; name: string | null };
  what?: ("person" | "day" | "site" | "time" | "break" | "job" | "note")[];
  /** For absences. */
  to?: string; type?: string;
}

const shiftOf = (s: PubShift): PubShift => ({ id: s.id, day: s.day, site: s.site, start: s.start, end: s.end, breakMins: s.breakMins ?? 0, job: s.job || "", userId: s.userId ?? null, note: s.note || "" });
const offOf = (t: PubOff): PubOff => ({ id: t.id, userId: t.userId, from: t.from, to: t.to, kind: t.kind || "", fromTime: t.fromTime ?? null, toTime: t.toTime ?? null });

/** What publishing saves. */
export function snapshotOf(shifts: PubShift[], timeOff: PubOff[], at: number): WeekSnapshot {
  return { at, basis: "published", shifts: shifts.map(shiftOf), timeOff: timeOff.map(offOf) };
}

/** The snapshot to compare with: the saved one, else the last email's (assigned shifts only), else none. */
export function readSnapshot(published: string | null | undefined, emailed: string | null | undefined): WeekSnapshot | null {
  try {
    if (published) { const p = JSON.parse(published); if (Array.isArray(p?.shifts)) return { at: p.at || 0, basis: "published", shifts: p.shifts, timeOff: Array.isArray(p.timeOff) ? p.timeOff : null }; }
  } catch { /* fall through */ }
  try {
    if (emailed) {
      const e = JSON.parse(emailed);
      const shifts: PubShift[] = Object.entries((e?.people || {}) as Record<string, any[]>).flatMap(([userId, xs]) => (xs || []).map((s) => ({ id: s.id, day: s.day, site: s.site, start: s.start, end: s.end, job: s.job || "", userId })));
      return { at: 0, basis: "emailed", shifts, timeOff: null };
    }
  } catch { /* none */ }
  return null;
}

export function diffWeek(snap: WeekSnapshot, shifts: PubShift[], timeOff: PubOff[], nameOf: (id: string | null) => string | null): WeekChange[] {
  const out: WeekChange[] = [];
  const full = snap.basis === "published";
  // The last email only knew assigned shifts: open ones can't be compared with it.
  const now = shifts.map(shiftOf).filter((s) => full || s.userId);
  const before = new Map(snap.shifts.map((s) => [s.id, shiftOf(s)]));
  for (const s of now) {
    const old = before.get(s.id);
    if (!old) { out.push({ kind: "added", day: s.day, site: s.site, start: s.start, end: s.end, name: nameOf(s.userId) }); continue; }
    const what: NonNullable<WeekChange["what"]> = [];
    if (old.userId !== s.userId) what.push("person");
    if (old.day !== s.day) what.push("day");
    if (old.site !== s.site) what.push("site");
    if (old.start !== s.start || old.end !== s.end) what.push("time");
    if (full && old.breakMins !== s.breakMins) what.push("break");
    if (old.job !== s.job) what.push("job");
    if (full && old.note !== s.note) what.push("note");
    if (what.length) out.push({ kind: "changed", day: s.day, site: s.site, start: s.start, end: s.end, name: nameOf(s.userId), what,
      was: { day: old.day, site: old.site, start: old.start, end: old.end, name: nameOf(old.userId) } });
  }
  const ids = new Set(now.map((s) => s.id));
  for (const old of before.values()) if (!ids.has(old.id)) out.push({ kind: "removed", day: old.day, site: old.site, start: old.start, end: old.end, name: nameOf(old.userId) });
  if (snap.timeOff) {
    const was = new Set(snap.timeOff.map((t) => t.id)), is = new Set(timeOff.map((t) => t.id));
    for (const t of timeOff) if (!was.has(t.id)) out.push({ kind: "off-added", day: t.from, to: t.to, type: t.kind, name: nameOf(t.userId) });
    for (const t of snap.timeOff) if (!is.has(t.id)) out.push({ kind: "off-removed", day: t.from, to: t.to, type: t.kind, name: nameOf(t.userId) });
  }
  return out.sort((a, b) => (a.day + (a.start || "")).localeCompare(b.day + (b.start || "")) || (a.name || "").localeCompare(b.name || ""));
}
