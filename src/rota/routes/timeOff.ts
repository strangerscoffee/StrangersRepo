// Rota routes for time off: asking for it (or adding it for someone), and deciding or cancelling it.
import { createLeave, decideLeave } from "../leave/routes";
import { commitLeave, event, policy, revision } from "../leave/model";
import { newId } from "../../auth";
import { invalid, json } from "../../http";
import { activeUser } from "../load";
import { RotaRequest } from "../types";
import { conflict, dateOf, denied, isDay, londonToday, notFound, nowMs, text } from "../util";
import { actor, timeOffDecided } from "../../email/rota";

export async function timeOffRoutes(r: RotaRequest): Promise<Response | null> {
  const { env, exec, user, route, seg, m, mgr, admin, needMgr, body, mailLinks } = r;

  if (route === "time-off" && m === "POST") {
    const b = await body();
    const rev = await revision(env);
    if ((await policy(env)).settings.enabled) return createLeave(r, b);
    const forOther = b.userId != null && b.userId !== user.id;
    if (forOther) needMgr();
    if (!isDay(b.from) || !isDay(b.to)) throw invalid("Choose real dates.");
    if (b.to < b.from) throw invalid("The last day has to be on or after the first.");
    if (dateOf(b.to).getTime() - dateOf(b.from).getTime() > 92 * 864e5) throw invalid("Ask for up to three months at a time.");
    const reason = text(b.reason, "The reason", 200);
    const uid = forOther ? await activeUser(env, b.userId) : user.id;
    const clash = await env.DB.prepare("SELECT from_day, to_day FROM rota_time_off WHERE user_id = ? AND status IN ('requested', 'approved') AND from_day <= ? AND to_day >= ? LIMIT 1")
      .bind(uid, b.to, b.from).first<{ from_day: string; to_day: string }>();
    if (clash) throw conflict(`${forOther ? "They" : "You"} already have time off asked for or booked from ${clash.from_day} to ${clash.to_day}.`);
    const approved = admin && b.userId != null; // admins may add already-approved time off
    const id = newId(10);
    await commitLeave(env, rev, [env.DB.prepare(
      "INSERT INTO rota_time_off (id, user_id, from_day, to_day, reason, status, decided_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, uid, b.from, b.to, reason, approved ? "approved" : "requested", approved ? user.id : null, approved ? nowMs() : null, nowMs()), event(env,uid,id,"legacy_created",user.id,{from:b.from,to:b.to})]);
    return json({ id, userId: uid, from: b.from, to: b.to, reason, status: approved ? "approved" : "requested" });
  }

  if (seg[0] === "time-off" && seg.length === 2 && m === "PATCH") {
    const rev = await revision(env);
    const t = await env.DB.prepare("SELECT * FROM rota_time_off WHERE id = ?").bind(seg[1]).first<{ user_id: string; status: string; from_day: string; to_day: string; kind: string }>();
    if (!t) throw notFound("That request has gone. Refresh and try again.");
    if (!admin && t.user_id !== user.id) throw denied("Only an admin can manage another employee's time off.");
    const b = await body();
    if (t.kind !== "legacy" || ((await policy(env)).settings.enabled && b.status === "approved")) return decideLeave(r, seg[1], b);
    if (b.status === "cancelled") {
      if (t.user_id !== user.id && !mgr) throw denied("Only the person who asked can cancel it.");
      if (!["requested", "approved"].includes(t.status)) throw conflict("That request is already settled.");
      // Time off that has started is a record of what happened; only an admin changes it.
      if (!admin && t.status === "approved" && t.from_day < londonToday()) throw denied("That time off has started. Ask an admin to change it.");
    } else if (b.status === "approved" || b.status === "declined") {
      needMgr();
      if (t.status !== "requested") throw conflict("That request is already settled.");
    } else throw invalid("Choose approve, decline or cancel.");
    await commitLeave(env, rev, [env.DB.prepare("UPDATE rota_time_off SET status = ?, version=version+1, decided_by = ?, decided_at = ? WHERE id = ?").bind(b.status, user.id, nowMs(), seg[1]), event(env,t.user_id,seg[1],b.status,user.id,{legacy:true})]);
    if (b.status === "approved" || b.status === "declined") await timeOffDecided(env, exec, mailLinks, t, b.status === "approved", await actor(env, user)).catch(() => {});
    return json({ id: seg[1], status: b.status });
  }

  return null;
}
