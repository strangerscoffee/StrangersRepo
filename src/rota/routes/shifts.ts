// Rota routes for shifts: adding, amending on the day, changing, removing, and who could take one.
import { newId } from "../../auth";
import { ApiError, invalid, json } from "../../http";
import { getShift, loadCtx, touchWeek } from "../load";
import { effectsFor } from "../problems";
import { ROTA_SITES, RotaRequest } from "../types";
import { checkShift } from "../validate";
import { afterWrite, weekProblems } from "../views";
import { isTime, londonToday, mins, mondayOf, nowMs, round2, text } from "../util";

export async function shiftRoutes(r: RotaRequest): Promise<Response | null> {
  const { env, user, route, seg, m, q, needMgr, body, withProblems } = r;

  if (route === "shifts" && m === "POST") {
    needMgr();
    const b = await body();
    const v = await checkShift(env, {
      site: b.site, day: b.day, start: b.start, end: b.end, breakMins: b.breakMins ?? 0, job: b.job ?? "",
      userId: b.userId ?? null, note: b.note ?? "",
    });
    const id = newId(10);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO rota_shifts (id, site, day, start, end, break_mins, job, user_id, note, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, v.site, v.day, v.start, v.end, v.breakMins, v.job, v.userId, v.note, nowMs(), user.id),
      touchWeek(env, mondayOf(v.day)),
    ]);
    return json({ shift: await getShift(env, id), ...(await afterWrite(env, v.day, withProblems)) });
  }

  // Amending a shift on the day: when someone actually started and finished (going home sick, staying late).
  // {start, end, breakMins?, note?}, or {clear: true} to put it back as planned. The plan itself is kept.
  if (seg[0] === "shifts" && seg[2] === "actual" && seg.length === 3 && m === "PUT") {
    needMgr();
    const cur = await getShift(env, seg[1]);
    if (!cur.userId) throw invalid("Give the shift to someone before amending their hours.");
    if (cur.day > londonToday()) throw invalid("Shifts can be amended from the day they're on.");
    const b = await body();
    if (b.clear === true) {
      await env.DB.prepare("UPDATE rota_shifts SET actual_start = NULL, actual_end = NULL, actual_break = NULL, adjust_note = '', adjusted_by = ?, adjusted_at = ? WHERE id = ?")
        .bind(user.id, nowMs(), cur.id).run();
    } else {
      if (!isTime(b.start) || !isTime(b.end)) throw invalid("Times are HH:MM, for example 07:30.");
      if (mins(b.end) < mins(b.start)) throw invalid("They can't finish before they start.");
      const brk = b.breakMins == null ? Math.min(cur.breakMins, mins(b.end) - mins(b.start)) : Number(b.breakMins);
      if (!Number.isInteger(brk) || brk < 0 || brk > 180) throw invalid("The unpaid break is 0 to 180 minutes.");
      if (brk > mins(b.end) - mins(b.start)) throw invalid("The break can't be longer than the time they were there.");
      const note = text(b.note, "The reason", 200);
      await env.DB.prepare("UPDATE rota_shifts SET actual_start = ?, actual_end = ?, actual_break = ?, adjust_note = ?, adjusted_by = ?, adjusted_at = ? WHERE id = ?")
        .bind(b.start, b.end, brk, note, user.id, nowMs(), cur.id).run();
    }
    return json({ shift: await getShift(env, cur.id), ...(await afterWrite(env, cur.day, withProblems)) });
  }

  if (seg[0] === "shifts" && seg.length === 2 && (m === "PATCH" || m === "DELETE")) {
    needMgr();
    const cur = await getShift(env, seg[1]);
    if (m === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM rota_shifts WHERE id = ?").bind(cur.id),
        env.DB.prepare("UPDATE rota_requests SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE shift_id = ? AND status IN ('open', 'accepted')").bind(user.id, nowMs(), cur.id),
        touchWeek(env, mondayOf(cur.day)),
      ]);
      return json({ ok: true, ...(await afterWrite(env, cur.day, withProblems)) });
    }
    const b = await body();
    // Several managers can plan at once: a change made from an older copy of the shift is refused, not applied.
    if (b.ifUpdatedAt != null && b.ifUpdatedAt !== cur.updatedAt) {
      throw new ApiError(409, "conflict", "Someone else changed this shift just now. Check how it is now and try again.", { shift: cur });
    }
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    const v = await checkShift(env, {
      site: has("site") ? b.site : cur.site, day: has("day") ? b.day : cur.day, start: has("start") ? b.start : cur.start,
      end: has("end") ? b.end : cur.end, breakMins: has("breakMins") ? b.breakMins : cur.breakMins, job: has("job") ? b.job : cur.job,
      userId: has("userId") ? b.userId : cur.userId, note: has("note") ? b.note : cur.note,
    });
    const stmts = [
      env.DB.prepare("UPDATE rota_shifts SET site = ?, day = ?, start = ?, end = ?, break_mins = ?, job = ?, user_id = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?")
        .bind(v.site, v.day, v.start, v.end, v.breakMins, v.job, v.userId, v.note, nowMs(), user.id, cur.id),
      touchWeek(env, mondayOf(cur.day)),
    ];
    if (mondayOf(v.day) !== mondayOf(cur.day)) stmts.push(touchWeek(env, mondayOf(v.day)));
    // A manager giving the shift to someone settles any pickups or covers still waiting on it.
    // Amended hours belong to the person who worked them.
    if (v.userId !== cur.userId && cur.adjusted) stmts.push(env.DB.prepare("UPDATE rota_shifts SET actual_start = NULL, actual_end = NULL, actual_break = NULL, adjust_note = '' WHERE id = ?").bind(cur.id));
    // So does changing when or where it is: a pickup or cover was agreed for the shift as it was.
    if (v.userId !== cur.userId || v.site !== cur.site || v.day !== cur.day || v.start !== cur.start || v.end !== cur.end) {
      stmts.push(env.DB.prepare("UPDATE rota_requests SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE shift_id = ? AND status IN ('open', 'accepted')").bind(user.id, nowMs(), cur.id));
    }
    await env.DB.batch(stmts);
    const out = await afterWrite(env, v.day, withProblems);
    if (withProblems && out.week !== mondayOf(cur.day)) (out as any).fromWeek = await weekProblems(env, cur.day);
    return json({ shift: await getShift(env, cur.id), ...out });
  }

  if (route === "suggest" && m === "GET") {
    needMgr();
    const shift = await getShift(env, q("shift") || "");
    const week = mondayOf(shift.day);
    const ctxW = await loadCtx(env, week);
    const site = ctxW.sites.get(shift.site)!;
    const list = [...ctxW.people.values()].filter((p) => p.id !== shift.userId).map((p) => {
      const { problems, hours } = effectsFor(ctxW, shift, p.id);
      const flags = problems.map((x) => ({ kind: x.kind, severity: x.severity, message: x.message }));
      const error = flags.find((f) => f.severity === "error");
      const tier = error ? 2 : flags.length ? 1 : 0;
      // Fairest first: whoever is furthest below their minimum (or maximum) gets offered it first.
      const ratio = p.contractMin ? hours / p.contractMin : p.contractMax ? hours / p.contractMax : hours / 40;
      const overtime = p.contractMax != null ? round2(Math.max(0, hours - p.contractMax)) : 0;
      return { userId: p.id, name: p.name, role: p.role, hoursIfGiven: hours, contractMin: p.contractMin, contractMax: p.contractMax,
        contractHours: p.contractMax, overtimeIfGiven: overtime, flags, selectable: !error, tier, ratio };
    });
    list.sort((a, b) => a.tier - b.tier || a.ratio - b.ratio || a.name.localeCompare(b.name));
    const best = list.find((c) => c.selectable)?.userId;
    return json({
      shift: { ...shift, siteName: site.name },
      candidates: list.map(({ tier, ratio, ...c }) => ({ ...c, best: c.userId === best })),
    });
  }

  return null;
}
