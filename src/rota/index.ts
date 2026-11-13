// The staff rota: who works where and when, across the four sites. Served under /api/rota/ on both hostnames
// (the rota app at ROTA_HOST, and the diary's Today card). Its data lives in its own rota_* tables
// (src/schema.ts, docs/data-model.md); site opening days and planned closures come from the diary's own
// settings and day documents, and "trained to open and close" from the diary's staff training records.
// The code is split by what it does: types.ts (types and constants), util.ts (dates, times, text), shift.ts (a
// shift's hours and overtime), load.ts (reading from D1), problems.ts (the checks), validate.ts (checking what's
// sent), views.ts (the week view and summaries), requests.ts (request lists), and routes/ (the router's handlers,
// by area). This file is the router.
import { limitWrites } from "../access";
import { User } from "../auth";
import { ApiError, Env, invalid, json, readJson } from "../http";
import { computeProblems } from "./problems";
import { meRoutes } from "./routes/me";
import { peopleRoutes } from "./routes/people";
import { requestRoutes } from "./routes/requests";
import { shiftRoutes } from "./routes/shifts";
import { leaveRoutes } from "./leave/routes";
import { timeOffRoutes } from "./routes/timeOff";
import { weekRoutes } from "./routes/week";
import { paidHours } from "./shift";
import { RotaRequest, SiteId } from "./types";
import { denied, londonToday, mondayOf } from "./util";

export { ROTA_SITES } from "./types";
export type { Person, Problem, Shift } from "./types";
export { addDays, fmtH, isDay, isTime, londonToday, mondayOf } from "./util";
export { computeProblems } from "./problems";
export { rotaWeekSummary } from "./views";

/* ---------- the router ---------- */

export async function handleRota(req: Request, env: Env, ctx: ExecutionContext, route: string, user: User, links: { rota: string; diary: string; admin?: string }): Promise<Response> {
  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k);
  const m = req.method;
  const admin = user.role === "admin";
  // Employee administration is admin-only, including for accounts with the manager role. The old `mgr`
  // name remains the rota page's capability flag; business site settings have a separate permission.
  const mgr = admin;
  const needAdmin = () => { if (!admin) throw denied("Only an admin can manage other employees' rota information."); };
  const needMgr = needAdmin;
  const needSiteManager = () => { if (user.role !== "manager" && !admin) throw denied(); };
  if (m !== "GET" && m !== "HEAD") await limitWrites(req, env, ctx, user.id);
  const body = async () => {
    if (m === "GET") return {} as any;
    const b = await readJson<any>(req, 32 * 1024);
    if (b == null) return {} as any;
    if (typeof b !== "object" || Array.isArray(b)) throw invalid("Send a JSON object.");
    return b;
  };
  const seg = route.split("/");
  const withProblems = q("with") === "problems";

  // Where the rota and the diary live, for links between them.
  if (route === "links" && m === "GET") return json(links);

  const mailLinks = { rota: new URL(links.rota, url.origin).href, diary: new URL(links.diary, url.origin).href };
  const r: RotaRequest = { mailLinks, env, exec: ctx, user, route, seg, m, q, mgr, admin, needMgr, needAdmin, needSiteManager, body, withProblems, links };
  for (const handle of [leaveRoutes, weekRoutes, shiftRoutes, meRoutes, peopleRoutes, timeOffRoutes, requestRoutes]) {
    const res = await handle(r);
    if (res) return res;
  }

  throw new ApiError(404, "not_found", "Unknown rota route.");
}

// Exported for tests of the pure parts.
export const _test = { computeProblems, paidHours, mondayOf, londonToday };
export type { SiteId };
