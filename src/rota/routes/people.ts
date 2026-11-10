// Rota routes for people (contracts, availability) and sites (opening hours, cover).
import { invalid, json } from "../../http";
import { activeUser, loadSites } from "../load";
import { DAY_KEYS, RotaRequest, SITE_IDS } from "../types";
import { checkContract, checkPattern, checkSites } from "../validate";
import { isTime, mins, nowMs, parseJson } from "../util";

export async function peopleRoutes(r: RotaRequest): Promise<Response | null> {
  const { env, route, seg, m, needAdmin, needSiteManager, body } = r;

  if (seg[0] === "people" && seg.length === 2 && m === "PUT") {
    needAdmin();
    const uid = await activeUser(env, seg[1]);
    const b = await body();
    if ("sites" in b || "pattern" in b) needAdmin();
    const cur = await env.DB.prepare("SELECT * FROM rota_people WHERE user_id = ?").bind(uid)
      .first<{ sites: string; pattern: string; contract_min: number | null; contract_max: number | null }>();
    // {contractMin, contractMax}; or the older single {contractHours}, which sets both. Leaving them out keeps them.
    let min = cur?.contract_min ?? null, max = cur?.contract_max ?? null;
    if ("contractHours" in b && !("contractMin" in b) && !("contractMax" in b)) min = max = checkContract(b.contractHours);
    if ("contractMin" in b) min = checkContract(b.contractMin);
    if ("contractMax" in b) max = checkContract(b.contractMax);
    if (min != null && max != null && min > max) throw invalid("The minimum contracted hours can't be more than the maximum.");
    const sites = "sites" in b ? checkSites(b.sites) : parseJson(cur?.sites, []);
    const pattern = "pattern" in b ? checkPattern(b.pattern) : parseJson(cur?.pattern, {});
    await env.DB.prepare(
      `INSERT INTO rota_people (user_id, contract_hours, contract_min, contract_max, sites, pattern, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET contract_hours = excluded.contract_hours, contract_min = excluded.contract_min, contract_max = excluded.contract_max,
         sites = excluded.sites, pattern = excluded.pattern, updated_at = excluded.updated_at`,
    ).bind(uid, max, min, max, JSON.stringify(sites), JSON.stringify(pattern), nowMs()).run();
    return json({ userId: uid, contractMin: min, contractMax: max, contractHours: max, sites, pattern });
  }

  if (route === "sites" && m === "GET") {
    const sites = await loadSites(env);
    return json({ sites: [...sites.values()].map((s) => ({ id: s.id, name: s.name, inUse: s.inUse, closedDays: s.closedDays, opensAt: s.opensAt, closesAt: s.closesAt, minPeople: s.minPeople, dayHours: s.dayHours })) });
  }

  if (seg[0] === "sites" && seg.length === 2 && m === "PUT") {
    needSiteManager();
    if (!SITE_IDS.has(seg[1])) throw invalid("Choose one of the four sites.");
    const b = await body();
    const t = (v: unknown, label: string) => { if (v == null || v === "") return null; if (!isTime(v)) throw invalid(`${label} is HH:MM, for example 07:00.`); return v; };
    const opensAt = t(b.opensAt, "Opening time"), closesAt = t(b.closesAt, "Closing time");
    if (opensAt && closesAt && mins(closesAt) <= mins(opensAt)) throw invalid("Closing time has to be after opening time.");
    const minPeople = b.minPeople == null ? 1 : Number(b.minPeople);
    if (!Number.isInteger(minPeople) || minPeople < 0 || minPeople > 20) throw invalid("Minimum people is 0 to 20.");
    // Days with other hours, {sat: {opensAt, closesAt}, …}; a day left out (or null) uses the usual hours. Left out
    // altogether, the saved days are kept.
    let dayHours: Record<string, { opensAt: string; closesAt: string }>;
    if (b.dayHours === undefined) {
      dayHours = (await loadSites(env)).get(seg[1])!.dayHours;
    } else {
      if (b.dayHours !== null && (typeof b.dayHours !== "object" || Array.isArray(b.dayHours))) throw invalid("Day hours aren't valid.");
      dayHours = {};
      for (const [k, d] of Object.entries((b.dayHours || {}) as Record<string, any>)) {
        if (!(DAY_KEYS as readonly string[]).includes(k)) throw invalid("Day hours use mon to sun.");
        if (d == null) continue;
        const o = t(d.opensAt, `Opening time on ${k}`), c = t(d.closesAt, `Closing time on ${k}`);
        if (!o || !c) throw invalid("Give an opening and a closing time for each day with its own hours.");
        if (mins(c) <= mins(o)) throw invalid("Closing time has to be after opening time.");
        dayHours[k] = { opensAt: o, closesAt: c };
      }
    }
    await env.DB.prepare(
      `INSERT INTO rota_sites (site, opens_at, closes_at, min_people, day_hours) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (site) DO UPDATE SET opens_at = excluded.opens_at, closes_at = excluded.closes_at, min_people = excluded.min_people, day_hours = excluded.day_hours`,
    ).bind(seg[1], opensAt, closesAt, minPeople, JSON.stringify(dayHours)).run();
    return json({ id: seg[1], opensAt, closesAt, minPeople, dayHours });
  }

  return null;
}
