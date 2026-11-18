// The sums behind "Start next year for everyone" (nextYear.ts), import-free so tests can load them directly.
const addDays = (day: string, n: number) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const dayCount = (from: string, to: string) => Math.round((Date.parse(to + "T12:00:00Z") - Date.parse(from + "T12:00:00Z")) / 864e5) + 1;
const plusYear = (day: string) => { const d = new Date(day + "T12:00:00Z"); d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); };

/** The leave year after the one today is in. */
export function nextLeaveYear(today: string, yearStart = "04-01") {
  const thisFrom = (today.slice(5) < yearStart ? Number(today.slice(0, 4)) - 1 : Number(today.slice(0, 4))) + "-" + yearStart;
  const from = plusYear(thisFrom);
  return { thisFrom, thisTo: addDays(from, -1), from, to: addDays(plusYear(from), -1) };
}

/** The most a full year is proposed at: 28 days (5.6 weeks for a full-time worker), the top allowance in use. */
export const FULL_YEAR_CAP = 28;

/** Someone who started part way through a leave year: this year's entitlement scaled back up to a whole year, to the
 *  nearest half day and at most FULL_YEAR_CAP. (Weekday charges can't tell full from part time here: most people are
 *  charged on all seven days, so the figure is a suggestion the admin checks.) Null for a whole year. */
export function fullYearOf(entitlementDays: number, yearFrom: string, yearTo: string, startDate: string | null) {
  if (!startDate || startDate <= yearFrom || startDate > yearTo) return null;
  const share = dayCount(startDate, yearTo) / dayCount(yearFrom, yearTo);
  const scaled = Math.round((entitlementDays / share) * 2) / 2;
  return { share: Math.round(share * 1000) / 1000, scaled, fullYear: Math.min(scaled, FULL_YEAR_CAP), capped: scaled > FULL_YEAR_CAP };
}
