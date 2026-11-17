// The Bradford Factor (Admin → Sickness), import-free so test/bradford.test.mjs runs it directly.
const DAY = 864e5;
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * DAY).toISOString().slice(0, 10);

/* ---------- the Bradford Factor: S² × D over the last 52 weeks ---------- */
// Counted from every approved sickness absence (rota_time_off kind 'sick': sickness forms, absences recorded in the rota
// and those imported from WhosOff), not only forms. S is the number of separate spells: absences on touching or
// overlapping days are one spell, and an admin can mark an absence as continuing the spell before it (when the days
// between weren't working days). D is the whole days off. Part days (half days, going home early) don't count at all,
// neither as a spell nor as days (the owner's decision, 17 Nov 2026). An admin can leave an absence out with a reason,
// as Acas advises for pregnancy- or disability-related absence (rota_bradford_review, migration 33). It covers the last
// 52 weeks, so each day off stops counting 52 weeks after it. The trigger points are the ones most UK employers use;
// reaching one starts a review, not automatic action.
export const BRADFORD_BANDS = [
  { min: 0, max: 49, key: "none", label: "No concern", action: "No action. Hold a return-to-work chat after each absence." },
  { min: 50, max: 124, key: "monitor", label: "Monitor", action: "Informal review: talk through the pattern and note any support needed." },
  { min: 125, max: 399, key: "stage1", label: "Stage 1", action: "First formal absence meeting; a first written warning may be given." },
  { min: 400, max: 649, key: "stage2", label: "Stage 2", action: "Second formal meeting; a final written warning may be given." },
  { min: 650, max: Infinity, key: "stage3", label: "Stage 3", action: "Final review meeting; dismissal may be considered, after checking for health or disability reasons." },
] as const;
export const EXCLUDE_REASONS = ["Pregnancy-related", "Disability-related", "Accident or injury at work", "Recorded in error", "Other"] as const;
export const bandOf = (score: number) => BRADFORD_BANDS.find((b) => score <= b.max) || BRADFORD_BANDS[BRADFORD_BANDS.length - 1];
export interface SickAbsence { id?: string; from_day: string; to_day: string; partial?: boolean; excluded?: string | null; continues?: boolean }
const WINDOW = 364; // the last 52 weeks, today included
function score(records: SickAbsence[], today: string) {
  const start = addDays(today, -WINDOW);
  const inWindow = records.filter((r) => !r.partial && !r.excluded && r.to_day >= start && r.from_day <= today)
    .map((r) => ({ ...r, from: r.from_day < start ? start : r.from_day, to: r.to_day > today ? today : r.to_day })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  let spells = 0, lastTo = "", days = 0;
  const covered = new Set<string>();
  for (const r of inWindow) {
    if (!lastTo || (r.from > addDays(lastTo, 1) && !(r.continues && r.from <= addDays(lastTo, 7)))) spells++;
    if (!lastTo || r.to > lastTo) lastTo = r.to;
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) covered.add(d); // a day recorded twice counts once
  }
  days = covered.size;
  return { spells, days, score: spells * spells * days };
}
export function bradford(records: SickAbsence[], today: string) {
  const now = score(records, today), band = bandOf(now.score);
  // When it next goes down, and when it clears: each counted day stops counting 52 weeks on.
  const counted = records.filter((r) => !r.partial && !r.excluded);
  const drops = [...new Set(counted.flatMap((r) => { const out: string[] = []; for (let d = r.from_day; d <= r.to_day; d = addDays(d, 1)) { const off = addDays(d, WINDOW + 1); if (off > today) out.push(off); } return out; }))].sort();
  let nextDrop: { on: string; score: number } | null = null;
  for (const on of drops) { const s = score(counted.filter((r) => r.from_day <= today), on).score; if (s < now.score) { nextDrop = { on, score: s }; break; } }
  const clearsOn = now.score && drops.length ? drops[drops.length - 1] : null;
  const start = addDays(today, -WINDOW), recent = records.filter((r) => r.to_day >= start && r.from_day <= today);
  return { ...now, band: { key: band.key, label: band.label, action: band.action }, nextDrop, clearsOn, partDays: recent.filter((r) => r.partial).length, leftOut: recent.filter((r) => !r.partial && r.excluded).length };
}

