import { Env, invalid } from "../http";
import { Pattern } from "./types";
import { conflict, londonToday, nowMs, parseJson } from "./util";

type PeoplePatch = {
  contractMin?: number | null;
  contractMax?: number | null;
  primarySite?: string | null;
  sites?: string[];
  pattern?: Pattern;
};

type PeopleRow = { contract_min: number | null; contract_max: number | null; primary_site: string | null; sites: string; pattern: string };

export async function saveRotaPerson(env: Env, uid: string, patch: PeoplePatch) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await env.DB.prepare("SELECT contract_min, contract_max, primary_site, sites, pattern FROM rota_people WHERE user_id = ?")
      .bind(uid).first<PeopleRow>();
    const oldMin = cur?.contract_min ?? null, oldMax = cur?.contract_max ?? null;
    const min = patch.contractMin === undefined ? oldMin : patch.contractMin;
    const max = patch.contractMax === undefined ? oldMax : patch.contractMax;
    if (min != null && max != null && min > max) throw invalid("The minimum contracted hours can't be more than the maximum.");
    const primarySite = patch.primarySite === undefined ? cur?.primary_site ?? null : patch.primarySite;
    const sites = (patch.sites ?? parseJson<string[]>(cur?.sites, [])).filter((s) => s !== primarySite);
    const pattern = patch.pattern ?? parseJson<Pattern>(cur?.pattern, {});
    const at = nowMs();

    // Apply the patch only to the row we used to merge and validate it. If another request changed
    // the row, read it again so omitted fields and the min/max invariant follow the latest values.
    const write = env.DB.prepare(`INSERT INTO rota_people (user_id, contract_hours, contract_min, contract_max, sites, pattern, primary_site, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE COALESCE((SELECT ? AND contract_min IS ? AND contract_max IS ? AND
        primary_site IS ? AND sites IS ? AND pattern IS ? FROM rota_people WHERE user_id = ?), ?)
      ON CONFLICT (user_id) DO UPDATE SET contract_hours = excluded.contract_hours, contract_min = excluded.contract_min, contract_max = excluded.contract_max,
        sites = excluded.sites, pattern = excluded.pattern, primary_site = excluded.primary_site, updated_at = excluded.updated_at`)
      .bind(uid, max, min, max, JSON.stringify(sites), JSON.stringify(pattern), primarySite, at,
        cur ? 1 : 0, oldMin, oldMax, cur?.primary_site ?? null, cur?.sites ?? null, cur?.pattern ?? null, uid, cur ? 0 : 1);
    // D1 rolls back the current row if history fails. A missed comparison writes neither row.
    const statements = [write];
    if (oldMin !== min || oldMax !== max) {
      statements.push(env.DB.prepare(`INSERT INTO rota_contract_history (user_id, from_day, contract_min, contract_max, at)
        SELECT ?, ?, ?, ?, ? WHERE changes() = 1
        ON CONFLICT (user_id, from_day) DO UPDATE SET contract_min = excluded.contract_min, contract_max = excluded.contract_max, at = excluded.at`)
        .bind(uid, londonToday(new Date(at)), min, max, at));
    }
    const [result] = await env.DB.batch(statements);
    if (result.meta.changes) return { userId: uid, contractMin: min, contractMax: max, contractHours: max, sites, primarySite, pattern };
  }
  throw conflict("Someone else changed this person's rota details. Try saving again.");
}
