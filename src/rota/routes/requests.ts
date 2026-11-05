// Rota routes for shift requests (pickups of open shifts and covers) and the open shifts someone could take.
import { newId } from "../../auth";
import { invalid, json } from "../../http";
import { activeUser, getShift, loadCtx, loadShifts, loadTimeOff, publishedWeeks, touchWeek, weekRow } from "../load";
import { blocking, effectsFor, onTimeOff, overlaps } from "../problems";
import { describeRequests, visibleRequests } from "../requests";
import { ReqRow, RotaRequest, Shift } from "../types";
import { addDays, conflict, denied, londonToday, mondayOf, notFound, nowMs, siteName, text } from "../util";
import { actor, requestDecided } from "../../email/rota";

export async function requestRoutes(r: RotaRequest): Promise<Response | null> {
  const { env, exec, user, route, seg, m, mgr, needMgr, body, mailLinks } = r;

  if (route === "requests" && m === "GET") {
    // Managers: everything waiting for a decision; everyone: what involves them.
    const pending = mgr
      ? await env.DB.prepare("SELECT r.* FROM rota_requests r JOIN rota_shifts s ON s.id = r.shift_id WHERE r.status IN ('open', 'accepted') AND s.day >= ? ORDER BY r.created_at LIMIT 300").bind(londonToday()).all<ReqRow>()
      : await env.DB.prepare(`SELECT r.* FROM rota_requests r JOIN rota_shifts s ON s.id = r.shift_id
          WHERE r.status IN ('open', 'accepted') AND s.day >= ? AND (r.from_user = ? OR r.to_user = ? OR r.taker = ? OR (r.to_user IS NULL AND r.kind = 'cover')) ORDER BY r.created_at LIMIT 300`)
        .bind(londonToday(), user.id, user.id, user.id).all<ReqRow>();
    const offs = mgr
      ? await env.DB.prepare("SELECT t.*, u.name FROM rota_time_off t JOIN users u ON u.id = t.user_id WHERE t.status = 'requested' ORDER BY t.from_day").all<any>()
      : { results: [] as any[] };
    return json({
      requests: await visibleRequests(env, pending.results, mgr),
      timeOff: offs.results.map((t) => ({ id: t.id, userId: t.user_id, name: t.name, from: t.from_day, to: t.to_day, reason: t.reason, status: t.status, createdAt: t.created_at })),
    });
  }

  if (route === "open" && m === "GET") {
    // Open shifts in published weeks, from today, that this person could take.
    const from = londonToday(), to = addDays(from, 41);
    const [weeks, all, offs, mine] = await Promise.all([
      publishedWeeks(env, from, to), loadShifts(env, from, to), loadTimeOff(env, from, to),
      env.DB.prepare("SELECT shift_id, status FROM rota_requests WHERE from_user = ? AND kind = 'claim' AND status IN ('open', 'accepted')").bind(user.id).all<{ shift_id: string; status: string }>(),
    ]);
    const pendingAny = await env.DB.prepare("SELECT DISTINCT shift_id FROM rota_requests WHERE kind = 'claim' AND status IN ('open', 'accepted')").all<{ shift_id: string }>();
    const myShifts = all.filter((s) => s.userId === user.id);
    const list = all.filter((s) => !s.userId && weeks.has(mondayOf(s.day)))
      .filter((s) => !myShifts.some((x) => overlaps(x, s)) && !onTimeOff(offs, user.id, s.day))
      .map((s) => ({
        ...s, siteName: siteName(s.site),
        asked: mine.results.some((r) => r.shift_id === s.id),
        takenBySomeone: !mine.results.some((r) => r.shift_id === s.id) && pendingAny.results.some((r) => r.shift_id === s.id),
      }));
    return json({ shifts: list });
  }

  if (route === "requests" && m === "POST") {
    const b = await body();
    const shift = await getShift(env, typeof b.shiftId === "string" ? b.shiftId : "");
    const today = londonToday();
    if (shift.day < today) throw invalid("That shift has already happened.");
    const row = await weekRow(env, mondayOf(shift.day));
    if (!row?.published_at) throw invalid("That week hasn't been published yet.");
    const message = text(b.message, "The message", 300);
    const pending = await env.DB.prepare("SELECT kind, from_user FROM rota_requests WHERE shift_id = ? AND status IN ('open', 'accepted')").bind(shift.id).all<{ kind: string; from_user: string }>();
    const id = newId(10);
    if (b.kind === "claim") {
      if (shift.userId) throw conflict("Someone already has that shift.");
      if (pending.results.length) throw conflict(pending.results.some((p) => p.from_user === user.id) ? "You've already asked for this shift." : "Someone has already asked for this shift.");
      const ctxW = await loadCtx(env, mondayOf(shift.day));
      const stop = blocking(effectsFor(ctxW, shift, user.id).problems);
      if (stop) throw conflict(stop.message);
      // Only if no one else asked in the meantime.
      const ins = await env.DB.prepare(`INSERT INTO rota_requests (id, kind, shift_id, from_user, to_user, taker, message, status, created_at)
          SELECT ?, 'claim', ?, ?, NULL, ?, ?, 'open', ? WHERE NOT EXISTS (SELECT 1 FROM rota_requests WHERE shift_id = ? AND status IN ('open', 'accepted'))`)
        .bind(id, shift.id, user.id, user.id, message, nowMs(), shift.id).run();
      if (!ins.meta.changes) throw conflict("Someone has already asked for this shift.");
    } else if (b.kind === "cover") {
      if (shift.userId !== user.id) throw denied("You can only ask for cover for your own shifts.");
      if (pending.results.some((p) => p.kind === "cover")) throw conflict("You've already asked for cover for this shift.");
      const to = b.toUserId == null || b.toUserId === "" ? null : await activeUser(env, b.toUserId);
      if (to === user.id) throw invalid("Choose someone else to cover it.");
      const ins = await env.DB.prepare(`INSERT INTO rota_requests (id, kind, shift_id, from_user, to_user, taker, message, status, created_at)
          SELECT ?, 'cover', ?, ?, ?, NULL, ?, 'open', ? WHERE NOT EXISTS (SELECT 1 FROM rota_requests WHERE shift_id = ? AND kind = 'cover' AND status IN ('open', 'accepted'))`)
        .bind(id, shift.id, user.id, to, message, nowMs(), shift.id).run();
      if (!ins.meta.changes) throw conflict("You've already asked for cover for this shift.");
    } else throw invalid("Choose claim or cover.");
    const out = await env.DB.prepare("SELECT * FROM rota_requests WHERE id = ?").bind(id).all<ReqRow>();
    return json({ request: (await describeRequests(env, out.results))[0] });
  }

  if (seg[0] === "requests" && seg.length === 2 && m === "PATCH") {
    const r = await env.DB.prepare("SELECT * FROM rota_requests WHERE id = ?").bind(seg[1]).first<ReqRow>();
    if (!r) throw notFound("That request has gone. Refresh and try again.");
    const b = await body();
    const settled = () => { if (!["open", "accepted"].includes(r.status)) throw conflict("That request is already settled."); };
    // A shift only changes hands while it's still ahead, in a published week.
    const stillTakeable = async (shift: Shift) => {
      if (shift.day < londonToday()) throw conflict("That shift has already happened.");
      if (!(await weekRow(env, mondayOf(shift.day)))?.published_at) throw conflict("That week isn't published any more. Check the rota.");
    };
    const set = (status: string, extra: { taker?: string | null; decided?: boolean } = {}) =>
      env.DB.prepare("UPDATE rota_requests SET status = ?, taker = ?, decided_by = ?, decided_at = ? WHERE id = ?")
        .bind(status, extra.taker !== undefined ? extra.taker : r.taker, extra.decided ? user.id : r.decided_by, extra.decided ? nowMs() : r.decided_at, r.id);
    switch (b.action) {
      case "accept": {
        settled();
        if (r.kind !== "cover" || r.status !== "open") throw conflict("Only an open cover request can be accepted.");
        if (r.from_user === user.id) throw invalid("You can't cover your own shift.");
        if (r.to_user && r.to_user !== user.id) throw denied("That request was for someone else.");
        const shift = await getShift(env, r.shift_id);
        await stillTakeable(shift);
        const stop = blocking(effectsFor(await loadCtx(env, mondayOf(shift.day)), shift, user.id).problems);
        if (stop) throw conflict(stop.message);
        await set("accepted", { taker: user.id }).run();
        break;
      }
      case "decline":
        settled();
        if (!(mgr || (r.kind === "cover" && r.to_user === user.id))) throw denied("Only the person asked, or a manager, can decline it.");
        await set("declined", { decided: true }).run();
        // A manager's decision is emailed; someone turning down a cover they were asked for isn't.
        if (mgr && r.to_user !== user.id) await requestDecided(env, exec, mailLinks, r, false, await getShift(env, r.shift_id).catch(() => null) as Shift, await actor(env, user)).catch(() => {});
        break;
      case "cancel":
        settled();
        if (r.from_user !== user.id && !mgr) throw denied("Only the person who asked can cancel it.");
        await set("cancelled", { decided: true }).run();
        break;
      case "approve": {
        needMgr();
        settled();
        if (r.kind === "cover" && r.status !== "accepted") throw conflict("No one has agreed to cover it yet.");
        if (!r.taker) throw conflict("No one has agreed to take it yet.");
        const shift = await getShift(env, r.shift_id);
        if (r.kind === "claim" && shift.userId) throw conflict("Someone already has that shift.");
        if (r.kind === "cover" && shift.userId !== r.from_user) throw conflict("That shift has changed since the request. Check the rota.");
        await stillTakeable(shift);
        const taker = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND active = 1").bind(r.taker).first();
        if (!taker) throw conflict(`${(await describeRequests(env, [r]))[0]?.takerName || "That person"}'s account is switched off, so they can't take it.`);
        const stop = blocking(effectsFor(await loadCtx(env, mondayOf(shift.day)), shift, r.taker).problems);
        if (stop) throw conflict(stop.message);
        await env.DB.batch([
          env.DB.prepare("UPDATE rota_shifts SET user_id = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(r.taker, nowMs(), user.id, shift.id),
          set("approved", { decided: true }),
          env.DB.prepare("UPDATE rota_requests SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE shift_id = ? AND id <> ? AND status IN ('open', 'accepted')").bind(user.id, nowMs(), shift.id, r.id),
          touchWeek(env, mondayOf(shift.day)),
        ]);
        await requestDecided(env, exec, mailLinks, r, true, shift, await actor(env, user)).catch(() => {});
        break;
      }
      default:
        throw invalid("Choose accept, decline, cancel or approve.");
    }
    const out = await env.DB.prepare("SELECT * FROM rota_requests WHERE id = ?").bind(r.id).all<ReqRow>();
    return json({ request: (await describeRequests(env, out.results))[0] });
  }

  return null;
}
