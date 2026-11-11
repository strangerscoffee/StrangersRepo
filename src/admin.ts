// Admin API (/api/admin/*): manage accounts. Admins only (enforced in index.ts).
import { ROLES, Role, User, UserRow, checkPassword, checkUsername, cleanName, hashPassword, nameKey, newId, tempPassword, usernameFrom } from "./auth";
import { audit } from "./audit";
import { cleanEmail, emailReady, linksFor, savePrefs, send } from "./email/send";
import { testEmail } from "./email/templates";
import { sendSummary } from "./email/weekly";
import { appLinks } from "./hosts";
import { handleStaffOrderAccess } from "./staffOrdersAccess";
import { ApiError, Env, SQL_NOW_MS, invalid, json, readJson } from "./http";

function listItem(r: UserRow) {
  return {
    id: r.id,
    name: r.name,
    username: r.username,
    role: r.role,
    mustChange: !!r.must_change,
    active: !!r.active,
    locked: r.locked_until > Date.now(),
    createdAt: r.created_at,
    createdBy: r.created_by,
    lastLoginAt: r.last_login_at,
    quickPin: !!r.quick_hash,
    email: (r as any).email || null,
  };
}

function checkRole(role: unknown): Role {
  if (!ROLES.includes(role as Role)) throw invalid("Role must be admin, manager or staff.");
  return role as Role;
}

async function getRow(env: Env, id: string): Promise<UserRow> {
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  if (!row) throw new ApiError(404, "not_found", "No such person.");
  return row;
}

async function activeAdmins(env: Env): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").first<{ n: number }>())?.n ?? 0;
}

async function nameTaken(env: Env, name: string, exceptId = ""): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM users WHERE name_key = ? AND id != ?").bind(nameKey(name), exceptId).first());
}

async function usernameTaken(env: Env, username: string, exceptId = ""): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM users WHERE username = ? AND id != ?").bind(username, exceptId).first());
}

export async function handleAdmin(req: Request, env: Env, route: string, admin: User): Promise<Response> {
  const orderAccess=route.match(/^users\/([0-9a-f]{24})\/orders-access$/);
  if(orderAccess)return handleStaffOrderAccess(req,env,orderAccess[1],admin);
  // GET /api/admin/users
  if (route === "users" && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY active DESC, name_key").all<UserRow>();
    return json({ users: results.map(listItem) });
  }

  // POST /api/admin/users {name, username?, email?, role, password?}. The password is temporary: the person
  // chooses their own at first sign-in. A generated one is returned once.
  if (route === "users" && req.method === "POST") {
    const body = await readJson<any>(req, 4096);
    const name = cleanName(body.name);
    if (!name) throw invalid("Enter a name (up to 60 characters).");
    if (await nameTaken(env, name)) throw new ApiError(409, "name_taken", `There's already someone called ${name}. Add a surname or initial.`);
    const username = checkUsername(body.username || usernameFrom(name));
    if (await usernameTaken(env, username)) throw new ApiError(409, "username_taken", `The username ${username} is taken. Choose another.`);
    const role = checkRole(body.role ?? "staff");
    const password = body.password ? checkPassword(body.password) : tempPassword();
    const email = body.email === undefined ? "" : cleanEmail(body.email);
    if (email === null) throw invalid("Enter an email address like name@example.com, or leave it blank.");
    const { hash, salt } = await hashPassword(password);
    const id = newId();
    await env.DB.prepare(
      `INSERT INTO users (id, name, name_key, username, role, pin_hash, pin_salt, must_change, created_at, created_by, updated_at, email)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ${SQL_NOW_MS}, ?, ${SQL_NOW_MS}, ?)`,
    ).bind(id, name, nameKey(name), username, role, hash, salt, admin.name, email || null).run();
    await audit(env, "user_added", admin.name, `${admin.name} added ${name} as ${role === "staff" ? "staff" : `a${role === "admin" ? "n" : ""} ${role}`}`);
    return json({ user: listItem(await getRow(env, id)), ...(body.password ? {} : { password }) });
  }

  // PATCH /api/admin/users/<id> {name?, username?, email?, role?, active?, password?: "..." | "generate", unlock?, signOut?}
  const m = route.match(/^users\/([0-9a-f]{24})$/);
  if (m && req.method === "PATCH") {
    const body = await readJson<any>(req, 4096);
    const row = await getRow(env, m[1]);
    const sets: string[] = [];
    const args: unknown[] = [];
    let bump = false; // sign this person out everywhere
    let passwordOut: string | undefined;

    if (body.name !== undefined) {
      const name = cleanName(body.name);
      if (!name) throw invalid("Enter a name (up to 60 characters).");
      if (await nameTaken(env, name, row.id)) throw new ApiError(409, "name_taken", `There's already someone called ${name}.`);
      sets.push("name = ?", "name_key = ?");
      args.push(name, nameKey(name));
      bump = true; // their records are written under their name, so sessions must pick up the new one
    }
    // The address rota emails go to (src/email/): admins set it; "" removes it.
    let emailChanged = false;
    if (body.email !== undefined) {
      const email = cleanEmail(body.email);
      if (email === null) throw invalid("Enter an email address like name@example.com, or leave it blank.");
      sets.push("email = ?");
      args.push(email || null);
      emailChanged = (email || null) !== ((row as any).email || null);
    }
    if (body.username !== undefined) {
      const username = checkUsername(body.username);
      if (await usernameTaken(env, username, row.id)) throw new ApiError(409, "username_taken", `The username ${username} is taken.`);
      sets.push("username = ?");
      args.push(username);
    }
    // `active` may arrive as 0, "" or null as well as false: read it as a yes or no once.
    const active = body.active === undefined ? undefined : !!body.active;
    const losingAdmin =
      row.role === "admin" && row.active &&
      ((body.role !== undefined && body.role !== "admin") || active === false);
    if (losingAdmin && (await activeAdmins(env)) <= 1) {
      throw new ApiError(409, "last_admin", "This is the only admin. Make someone else an admin first.");
    }
    if (body.role !== undefined) {
      sets.push("role = ?");
      args.push(checkRole(body.role));
    }
    if (active !== undefined) {
      sets.push("active = ?");
      args.push(active ? 1 : 0);
      if (!active) bump = true;
    }
    if (body.password !== undefined) {
      // A temporary password: they choose their own at next sign-in.
      passwordOut = body.password === "generate" ? tempPassword() : checkPassword(body.password);
      const { hash, salt } = await hashPassword(passwordOut);
      // Resetting someone's password also clears their quick PIN: they set a new one once signed in.
      sets.push("pin_hash = ?", "pin_salt = ?", "must_change = 1", "failed = 0", "locked_until = 0", "quick_hash = NULL", "quick_salt = NULL");
      args.push(hash, salt);
      bump = true;
    }
    if (body.unlock) sets.push("failed = 0", "locked_until = 0");
    if (body.signOut) bump = true;
    if (bump) sets.push("session_ver = session_ver + 1");
    // The Monday summary: on or off, and its sites (managers and admins only).
    let summaryChanged = false;
    if (body.emailPrefs !== undefined || body.weeklySites !== undefined) {
      const role = body.role ?? row.role;
      if (role === "staff") throw invalid("The Monday summary is for managers and admins.");
      await savePrefs(env, row.id, { prefs: body.emailPrefs ?? {}, weeklySites: body.weeklySites });
      summaryChanged = true;
    }
    if (!sets.length && !summaryChanged) throw invalid("Nothing to change.");
    sets.push(`updated_at = ${SQL_NOW_MS}`);
    await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...args, row.id).run();
    // Someone switched off can't pick up or cover shifts: their waiting rota requests end with the account.
    if (active === false && row.active) {
      await env.DB.prepare("UPDATE rota_requests SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE status IN ('open', 'accepted') AND (from_user = ? OR taker = ? OR to_user = ?)")
        .bind(admin.id, Date.now(), row.id, row.id, row.id).run();
    }
    // What changed, in words, for the admin section's Activity page. Never the password itself.
    const newName = body.name !== undefined ? cleanName(body.name)! : row.name;
    const events: [string, string][] = [];
    if (body.name !== undefined && newName !== row.name) events.push(["renamed", `${admin.name} renamed ${row.name} to ${newName}`]);
    if (body.username !== undefined && checkUsername(body.username) !== row.username) events.push(["username_changed", `${admin.name} changed ${newName}'s username`]);
    if (body.role !== undefined && body.role !== row.role) events.push(["role_changed", `${admin.name} made ${newName} ${body.role === "staff" ? "staff" : `a${body.role === "admin" ? "n" : ""} ${body.role}`}`]);
    if (active !== undefined && active !== !!row.active) events.push(["active_changed", `${admin.name} switched ${newName}'s account ${active ? "back on" : "off"}`]);
    if (body.password !== undefined) events.push(["password_reset", `${admin.name} gave ${newName} a temporary password`]);
    if (body.unlock) events.push(["unlocked", `${admin.name} unlocked ${newName}`]);
    if (body.signOut) events.push(["signed_out", `${admin.name} signed ${newName} out everywhere`]);
    if (summaryChanged) events.push(["email_changed", `${admin.name} changed ${newName}'s Monday summary`]);
    if (emailChanged) events.push(["email_changed", `${admin.name} ${cleanEmail(body.email) ? "set" : "removed"} ${newName}'s email address`]);
    for (const [k, t] of events) await audit(env, k, admin.name, t);
    return json({ user: listItem(await getRow(env, row.id)), ...(body.password === "generate" ? { password: passwordOut } : {}) });
  }

  // POST /api/admin/email/test: a test email to the admin's own address, to check Resend is set up.
  if (route === "email/test" && req.method === "POST") {
    if (!emailReady(env)) throw new ApiError(409, "email_off", "Rota emails aren't set up yet: add the RESEND_API_KEY secret in Cloudflare first.");
    const me = await env.DB.prepare("SELECT id, name, email, email_prefs, active FROM users WHERE id = ?").bind(admin.id).first<{ id: string; name: string; email: string | null; email_prefs: string; active: number }>();
    if (!me?.email) throw new ApiError(409, "no_email", "Add your own email address first (People → you → Edit).");
    const url = new URL(req.url), links = appLinks(url, env.ROTA_HOST, env.ADMIN_HOST);
    const base = { rota: new URL(links.rota, url.origin).href, diary: new URL(links.diary, url.origin).href };
    const l = await linksFor(env, base, me.id, "test");
    const r = await send(env, { to: { ...me, email: me.email }, kind: "test", mail: testEmail({ name: me.name, links: l }), links: l, about: "a test email" });
    if (r !== "sent") throw new ApiError(502, "email_failed", r === "limit" ? "Today's email limit has been reached." : "Resend didn't accept it. See Activity → Accounts for why.");
    return json({ ok: true, to: me.email });
  }

  // POST /api/admin/email/weekly-test: this week's Monday summary, now, to the admin's own address (their sites).
  if (route === "email/weekly-test" && req.method === "POST") {
    if (!emailReady(env)) throw new ApiError(409, "email_off", "Rota emails aren't set up yet: add the RESEND_API_KEY secret in Cloudflare first.");
    const me = await env.DB.prepare("SELECT id, name, email, email_prefs, active, role FROM users WHERE id = ?").bind(admin.id).first<{ id: string; name: string; email: string | null; email_prefs: string; active: number; role: string }>();
    if (!me?.email) throw new ApiError(409, "no_email", "Add your own email address first (People → you → Edit).");
    const url = new URL(req.url), links = appLinks(url, env.ROTA_HOST, env.ADMIN_HOST);
    const r = await sendSummary(env, { rota: new URL(links.rota, url.origin).href, diary: new URL(links.diary, url.origin).href }, me);
    if (r !== "sent") throw new ApiError(502, "email_failed", r === "limit" ? "Today's email limit has been reached." : "Resend didn't accept it. See Activity for why.");
    return json({ ok: true, to: me.email });
  }

  // GET /api/admin/status: how much is in the diary.
  if (route === "status" && req.method === "GET") {
    const docs = await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE deleted = 0").first<{ n: number }>();
    return json({ docs: docs?.n ?? 0 });
  }

  throw new ApiError(404, "not_found", "Unknown admin route.");
}
