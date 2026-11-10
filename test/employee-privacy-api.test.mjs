// Employee-private diary records are readable only by their stable account owner or an admin.
// These local fixtures deliberately include legacy names and multi-site copies; no production data is used.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, A, B, MANAGER;
const PREFIXES = ["", "sites/cafe/", "sites/asg/", "sites/factory/"];
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value)) || "").split(";")[0];
async function request(method, path, body, cookie = ADMIN) {
  const headers = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) };
  const response = await fetch(srv.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cookie: cookieOf(response) };
}
const db = (op, body, cookie = ADMIN) => request("POST", "/api/db/" + op, body, cookie);
async function account(name, username, role = "staff") {
  const created = await request("POST", "/api/admin/users", { name, username, role, password: "temporary-private-password" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const password = username + "-private-password";
  const login = await request("POST", "/api/auth/change", { username, password: "temporary-private-password", newPassword: password }, null);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.ok(login.cookie);
  return { id: created.body.user.id, name, username, password, cookie: login.cookie };
}
async function put(path, data, cookie = ADMIN, ifVersion) {
  const result = await db("set", { path, data, ...(ifVersion === undefined ? {} : { ifVersion }) }, cookie);
  assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
  return result.body.ver;
}
async function get(path, cookie = ADMIN) {
  const result = await db("get", { path }, cookie);
  assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
  return result.body;
}
function hidden(document, label) {
  assert.equal(document.exists, false, label);
  assert.equal(document.data, undefined, label + ": no private data");
  assert.equal(document.ver, 0, label + ": no private record version");
  if ("docVer" in document) assert.equal(document.docVer, 0, label + ": no private poll version");
}
function denied(result, label) {
  assert.equal(result.status, 403, `${label}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.code, "permission_denied", label);
  assert.equal(result.body.current, undefined, label + ": permission refusal cannot include the current private document");
}
const training = (person, notes, rank = 20) => ({ name: person.name, ownerUserId: person.id, personId: "copy-" + person.id, role: "Barista", start: "2026-01-02", topics: { hygiene: { date: "2026-01-03", by: "web:Privacy Admin" } }, notes, sites: ["roastery", "cafe"], rank, at: 1 });
const businessDocument = (kind, title, extra = {}) => kind === "contacts"
  ? { type: "Key holder / manager", name: title, person: title, phone: "07000 123456", email: "employee@example.test", notes: title + " private contact note", at: 1, ...extra }
  : { category: "Induction checklist", title, audience: title, owner: title, sections: [{ heading: "Induction", body: title + " employee details" }], notes: title + " private sign-off note", history: [], updatedAt: 1, ...extra };

before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  const setup = await request("POST", "/api/auth/setup", { name: "Privacy Admin", username: "privacy.admin", password: "privacy-admin-password", code: SETUP_CODE }, null);
  assert.equal(setup.status, 200); ADMIN = setup.cookie;
  A = await account("Privacy Alice", "privacy.alice");
  B = await account("Privacy Bob", "privacy.bob");
  MANAGER = await account("Privacy Manager", "privacy.manager", "manager");
  for (const [index, prefix] of PREFIXES.entries()) {
    const col = prefix + "staff";
    await put(col + "/other-private", training(B, "OTHER_STAFF_SECRET_" + index, 0));
    await put(col + "/legacy-unbound", training(A, "UNBOUND_STAFF_SECRET_" + index, 1));
    await put(col + "/mine", training(A, "MY_STAFF_DETAILS_" + index, 20));
    await put(col + "/manager-private", training(MANAGER, "MANAGER_STAFF_SECRET_" + index, 30));
    // Existing imported records have no reliable owner, even when name/personId look like the signed-in person.
    srv.sql(`UPDATE docs SET data=json_remove(data,'$.ownerUserId') WHERE path='${col}/legacy-unbound'`);
    for (const kind of ["contacts", "onboarding"]) {
      const collection = prefix + kind;
      await put(collection + "/other-private", businessDocument(kind, "OTHER_" + kind.toUpperCase() + "_SECRET_" + index, { visibility: "employee", ownerUserId: B.id, rank: 0 }));
      await put(collection + "/legacy-unclassified", businessDocument(kind, "UNCLASSIFIED_" + kind.toUpperCase() + "_SECRET_" + index, { visibility: "shared-business", rank: 1 }));
      await put(collection + "/mine", businessDocument(kind, "MY_" + kind.toUpperCase() + "_DETAILS_" + index, { visibility: "employee", ownerUserId: A.id, rank: 20 }));
      await put(collection + "/manager-private", businessDocument(kind, "MANAGER_" + kind.toUpperCase() + "_SECRET_" + index, { visibility: "employee", ownerUserId: MANAGER.id, rank: 30 }));
      await put(collection + "/business", businessDocument(kind, "Shared business " + kind, { visibility: "shared-business", rank: 40 }));
      srv.sql(`UPDATE docs SET data=json_remove(data,'$.visibility','$.ownerUserId') WHERE path='${collection}/legacy-unclassified'`);
    }
  }
});
after(async () => { await srv?.stop(); });

test("employee privacy: signed-out requests cannot read documents, collections or polls", async () => {
  for (const [op, body] of [
    ["get", { path: "staff/mine" }],
    ["query", { path: "contacts" }],
    ["poll", { queries: [{ key: "private", kind: "col", path: "onboarding" }] }],
  ]) {
    const result = await db(op, body, null);
    assert.equal(result.status, 401); assert.equal(result.body.code, "unauthenticated");
    assert.equal(result.body.docs, undefined); assert.equal(result.body.results, undefined);
  }
});

test("employee privacy: every site's get/query/poll reads are owner-scoped, including managers and legacy records", async () => {
  for (const [index, prefix] of PREFIXES.entries()) for (const person of [A, B, MANAGER]) {
    const mine = person === A ? "mine" : person === B ? "other-private" : "manager-private";
    const other = person === B ? "mine" : "other-private";
    for (const kind of ["staff", "contacts", "onboarding"]) {
      const collection = prefix + kind, legacy = kind === "staff" ? "legacy-unbound" : "legacy-unclassified";
      assert.equal((await get(collection + "/" + mine, person.cookie)).exists, true);
      hidden(await get(collection + "/" + other, person.cookie), `${person.name} ${collection} another employee`);
      hidden(await get(collection + "/" + legacy, person.cookie), `${person.name} ${collection} legacy`);
      const listed = await db("query", { path: collection, orderBy: "rank", dir: "asc" }, person.cookie);
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.body.docs.map((document) => document.id).sort(), (kind === "staff" ? [mine] : [mine, "business"]).sort());
      assert.ok(listed.body.docs.every((document) => document.ver > 0));
      const queries = [
        { key: "own", kind: "doc", path: collection + "/" + mine },
        { key: "other", kind: "doc", path: collection + "/" + other },
        { key: "old", kind: "doc", path: collection + "/" + legacy },
        { key: "list", kind: "col", path: collection, orderBy: "rank", dir: "asc" },
      ];
      const polled = await db("poll", { queries }, person.cookie);
      assert.equal(polled.status, 200);
      assert.equal(polled.body.results.own.exists, true);
      hidden(polled.body.results.other, `${collection} hidden poll document`);
      hidden(polled.body.results.old, `${collection} unclassified poll document`);
      assert.deepEqual(polled.body.results.list.docs.map((document) => document.id), listed.body.docs.map((document) => document.id));
      assert.equal(polled.body.results.list.delta, undefined);
      const adminList = await db("query", { path: collection }, ADMIN);
      assert.equal(adminList.status, 200); assert.equal(adminList.body.docs.length, kind === "staff" ? 4 : 5);
      assert.equal((await get(collection + "/" + legacy)).exists, true, "admins can review unresolved legacy records");
      if (person !== B) assert.doesNotMatch(JSON.stringify(polled.body.results), new RegExp("OTHER_" + (kind === "staff" ? "STAFF" : kind.toUpperCase()) + "_SECRET_" + index));
    }
  }
});

test("employee privacy: collection limits apply after privacy filtering, in query and requested delta polls", async () => {
  for (const prefix of PREFIXES) for (const kind of ["staff", "contacts", "onboarding"]) {
    const query = { path: prefix + kind, orderBy: "rank", dir: "asc", limit: 1 };
    const listed = await db("query", query, A.cookie);
    assert.equal(listed.status, 200); assert.deepEqual(listed.body.docs.map((document) => document.id), ["mine"], "hidden earlier rows do not consume the limit");
    const polled = await db("poll", { queries: [{ ...query, key: "limited", kind: "col", ver: 1, delta: true }] }, A.cookie);
    assert.equal(polled.status, 200); assert.equal(polled.body.results.limited.delta, undefined);
    assert.deepEqual(polled.body.results.limited.docs.map((document) => document.id), ["mine"]);
  }
});

test("employee privacy: unchanged, changed and tombstone polls always replace private caches without leaking hidden IDs", async () => {
  const collection = "sites/asg/staff", ownPath = collection + "/poll-owned", hiddenPath = collection + "/poll-hidden-tombstone";
  await put(ownPath, training(A, "Own live poll record", 100));
  await put(hiddenPath, training(B, "TOMBSTONE_HIDDEN_SECRET", 101));
  const query = { key: "private", kind: "col", path: collection };
  const first = (await db("poll", { queries: [query] }, A.cookie)).body;
  const again = await db("poll", { since: first.seq, queries: [{ ...query, ver: first.results.private.ver, delta: true }] }, A.cookie);
  assert.equal(again.status, 200);
  assert.ok(Array.isArray(again.body.results.private.docs), "even unchanged private snapshots purge older over-broad caches");
  assert.equal(again.body.results.private.delta, undefined);
  assert.equal((await db("delete", { path: hiddenPath })).status, 200);
  const removed = await db("poll", { since: first.seq, queries: [{ ...query, ver: first.results.private.ver, delta: true }, { key: "deleted", kind: "doc", path: hiddenPath }] }, A.cookie);
  assert.equal(removed.status, 200); assert.equal(removed.body.results.private.delta, undefined);
  assert.ok(removed.body.results.private.docs.some((document) => document.id === "poll-owned"));
  assert.doesNotMatch(JSON.stringify(removed.body.results), /poll-hidden-tombstone|TOMBSTONE_HIDDEN_SECRET/);
  hidden(removed.body.results.deleted, "a deleted private record's ID/version is not disclosed");
  // An admin can reassign a live record; an existing owner's same-version poll must remove it completely.
  const version = (await get(ownPath)).ver;
  assert.equal((await db("update", { path: ownPath, patch: { ownerUserId: B.id }, ifVersion: version })).status, 200);
  const reassigned = await db("poll", { since: removed.body.seq, queries: [{ ...query, ver: removed.body.results.private.ver, delta: true }] }, A.cookie);
  assert.equal(reassigned.status, 200); assert.equal(reassigned.body.results.private.delta, undefined);
  assert.ok(!reassigned.body.results.private.docs.some((document) => document.id === "poll-owned"));
  // A page holding an admin's unfiltered version must also receive a newly filtered full snapshot.
  const adminCopy = (await db("poll", { queries: [query] })).body;
  const downgraded = await db("poll", { since: adminCopy.seq, queries: [{ ...query, ver: adminCopy.results.private.ver, delta: true }] }, A.cookie);
  assert.equal(downgraded.status, 200);
  assert.ok(downgraded.body.results.private.docs.every((document) => document.data.ownerUserId === A.id));
  assert.equal(downgraded.body.results.private.delta, undefined);
});

test("employee privacy: staff ownership is server-bound and cannot be forged, reassigned or cleared by full saves", async () => {
  for (const person of [A, MANAGER]) {
    const path = "staff/self-created-" + person.id;
    const { ownerUserId, ...form } = training(person, "Self-created private training");
    form.topics = { hygiene: { date: "2026-01-03", by: "web:" + person.name } };
    await put(path, form, person.cookie, 0);
    const created = await get(path, person.cookie);
    assert.equal(created.data.ownerUserId, person.id, "server binds an omitted owner to the authenticated stable account");
    await put(path, { ...form, notes: "A full form save omitted the hidden ownership field" }, person.cookie, created.ver);
    assert.equal((await get(path)).data.ownerUserId, person.id, "full replacement preserves the existing owner");
    denied(await db("update", { path, patch: { ownerUserId: B.id, notes: "stolen" } }, person.cookie), "reassign own record to another employee");
    denied(await db("update", { path, patch: { ownerUserId: null } }, person.cookie), "clear own record owner");
    denied(await db("set", { path: path + "-forged", data: { ...form, ownerUserId: B.id } }, person.cookie), "create record with forged owner");
    denied(await db("set", { path: "staff/employee-" + B.id, data: form }, person.cookie), "another employee's stable record ID cannot be reserved by a different account");
    denied(await db("set", { path: path + "-wrong-name", data: { ...form, name: B.name } }, person.cookie), "a nonadmin cannot create a self-bound record in another employee's name");
    denied(await db("update", { path, patch: { topics: { hygiene: { date: "2026-02-01", by: "web:Privacy Admin" } } } }, person.cookie), "self ownership does not authorize forging a trainer's attribution");
    denied(await db("delete", { path }, person.cookie), "nonadmins cannot delete private training, including their own");
    assert.equal((await get(path)).data.notes, "A full form save omitted the hidden ownership field");
  }
  const invalidOwner = await db("set", { path: "staff/nonexistent-owner", data: { name: "Unassigned employee", ownerUserId: "account-that-does-not-exist" } });
  assert.equal(invalidOwner.status, 400, "even admins must choose an actual account for private ownership");
});

test("employee privacy: wrong-person writes are refused before stale-version conflict data can expose records", async () => {
  for (const prefix of PREFIXES) for (const person of [A, MANAGER]) for (const kind of ["staff", "contacts", "onboarding"]) {
    const path = prefix + kind + "/other-private", privateBefore = await get(path);
    const data = kind === "staff" ? training(person, "attempted replacement") : businessDocument(kind, "attempted replacement", { visibility: "employee", ownerUserId: person.id });
    for (const [op, body] of [
      ["set", { path, data, ifVersion: 0 }],
      ["update", { path, patch: { notes: "attempted overwrite" }, ifVersion: 0 }],
      ["delete", { path, ifVersion: 0 }],
    ]) {
      const result = await db(op, body, person.cookie);
      denied(result, `${person.role || person.name} ${op} another employee's ${kind}`);
      assert.doesNotMatch(JSON.stringify(result.body), /OTHER_(?:STAFF|CONTACTS|ONBOARDING)_SECRET/);
    }
    assert.deepEqual(await get(path), privateBefore, "refused writes preserve the private record and its version");
  }
  const legacy = "sites/cafe/staff/legacy-unbound";
  denied(await db("set", { path: legacy, data: training(A, "claimed by matching name/personId") }, A.cookie), "a matching display name or copy token cannot claim an unbound legacy record");
});

test("employee privacy: only admins classify/link personal documents while managers retain allowed own/shared edits", async () => {
  for (const kind of ["contacts", "onboarding"]) {
    const base = "sites/factory/" + kind, owned = base + "/mine", managerOwned = base + "/manager-private", shared = base + "/business";
    denied(await db("update", { path: owned, patch: { notes: "staff attempted personal edit" } }, A.cookie), "staff personal " + kind + " remains read-only");
    assert.equal((await db("update", { path: managerOwned, patch: { notes: "Manager changed only their own private details" } }, MANAGER.cookie)).status, 200);
    assert.equal((await db("update", { path: shared, patch: { notes: "Manager maintained shared business details" } }, MANAGER.cookie)).status, 200);
    const { visibility, ownerUserId, ...cachedForm } = (await get(managerOwned)).data;
    await put(managerOwned, { ...cachedForm, notes: "Cached form retained private metadata" }, MANAGER.cookie);
    assert.equal((await get(managerOwned)).data.ownerUserId, MANAGER.id);
    assert.equal((await get(managerOwned)).data.visibility, "employee", "full saves cannot drop protected classification");
    denied(await db("update", { path: managerOwned, patch: { visibility: "shared-business", ownerUserId: null } }, MANAGER.cookie), "manager cannot publish their private " + kind);
    denied(await db("update", { path: shared, patch: { visibility: "employee", ownerUserId: MANAGER.id } }, MANAGER.cookie), "manager cannot change shared " + kind + " classification");
    denied(await db("update", { path: managerOwned, patch: { ownerUserId: B.id } }, MANAGER.cookie), "manager cannot reassign private " + kind);
    denied(await db("set", { path: base + "/manager-new-private", data: businessDocument(kind, "Unauthorized new personal document", { visibility: "employee", ownerUserId: MANAGER.id }) }, MANAGER.cookie), "new private classification is admin-controlled");
    const legacy = base + "/legacy-unclassified", before = await get(legacy);
    assert.equal((await db("update", { path: legacy, patch: { visibility: "employee", ownerUserId: A.id }, ifVersion: before.ver })).status, 200, "admin explicitly links an unresolved imported document");
    assert.equal((await get(legacy, A.cookie)).exists, true);
    hidden(await get(legacy, MANAGER.cookie), "a manager cannot see a newly linked other employee's " + kind);
    const owner = await get(legacy);
    assert.equal((await db("update", { path: legacy, patch: { visibility: "shared-business", ownerUserId: null }, ifVersion: owner.ver })).status, 200, "admin may intentionally turn a record into shared business information");
    assert.equal((await get(legacy, B.cookie)).exists, true);
    assert.ok(!(await get(legacy)).data.ownerUserId, "shared-business records have no employee owner");
  }
});

test("employee privacy: account renaming and reuse of an old display name never transfer stable ownership", async () => {
  const original = await account("Former Display Name", "privacy.rename.original"), path = "staff/rename-owned";
  await put(path, training(original, "ORIGINAL_ACCOUNT_SECRET"));
  const legacyPath = "staff/rename-legacy";
  await put(legacyPath, training(original, "UNBOUND_OLD_NAME_SECRET"));
  srv.sql(`UPDATE docs SET data=json_remove(data,'$.ownerUserId') WHERE path='${legacyPath}'`);
  assert.equal((await request("PATCH", "/api/admin/users/" + original.id, { name: "Renamed Employee" })).status, 200);
  const relogin = await request("POST", "/api/auth/login", { username: original.username, password: original.password }, null);
  assert.equal(relogin.status, 200); original.cookie = relogin.cookie;
  const replacement = await account("Former Display Name", "privacy.rename.replacement");
  assert.equal((await get(path, original.cookie)).data.notes, "ORIGINAL_ACCOUNT_SECRET", "the renamed account retains its own record despite stale record display text");
  hidden(await get(path, replacement.cookie), "reused display name is a different account");
  hidden(await get(legacyPath, replacement.cookie), "an unbound record is not guessed from the newly reused display name");
  hidden(await get(legacyPath, original.cookie), "unresolved legacy ownership remains admin-only even for a formerly matching name");
  denied(await db("update", { path, patch: { notes: "replacement tried to take over" }, ifVersion: 0 }, replacement.cookie), "name reuse cannot write someone else's private record");
  const list = await db("query", { path: "staff" }, replacement.cookie);
  assert.equal(list.status, 200); assert.ok(!list.body.docs.some((document) => document.id === "rename-owned" || document.id === "rename-legacy"));
  assert.equal((await get(path)).data.ownerUserId, original.id);
});

test("employee privacy: historical JSON claims remain unverified until an admin explicitly reviews ownership or sharing", async () => {
  for (const prefix of PREFIXES) for (const kind of ["staff", "contacts", "onboarding"]) {
    const collection = prefix + kind, path = collection + "/historical-forged-claims";
    const old = kind === "staff" ? training(A, "HISTORICAL_PRIVATE_CONTENT")
      : businessDocument(kind, "HISTORICAL_PRIVATE_CONTENT", { visibility: "shared-business", ownerUserId: A.id });
    await put(path, old);
    // Models a pre-cutover row, including valid-looking claims permitted by the old JSON validator.
    srv.sql(`UPDATE docs SET employee_privacy_version=NULL WHERE path='${path}'`);
    for (const person of [A, B, MANAGER]) {
      hidden(await get(path, person.cookie), "historical metadata is not proof of ownership/sharing");
      const listed = await db("query", { path: collection }, person.cookie);
      assert.ok(!listed.body.docs.some(row => row.id === "historical-forged-claims"));
      const poll = await db("poll", { queries: [{ key: "doc", kind: "doc", path }, { key: "list", kind: "col", path: collection, delta: true, ver: 1 }] }, person.cookie);
      hidden(poll.body.results.doc, "unverified historical poll document");
      assert.ok(!poll.body.results.list.docs.some(row => row.id === "historical-forged-claims"));
    }
    const adminCopy = await get(path);
    assert.equal(adminCopy.data.ownerUserId, null, "admin review does not preselect an untrusted historical owner");
    if (kind !== "staff") assert.equal(adminCopy.data.visibility, null, "historical sharing is presented as unreviewed");
    const adminList = (await db("query", { path: collection })).body.docs.find(row => row.id === "historical-forged-claims");
    assert.equal(adminList.data.ownerUserId, null);
    const adminPoll = (await db("poll", { queries: [{ key: "doc", kind: "doc", path }, { key: "list", kind: "col", path: collection }] })).body.results;
    assert.equal(adminPoll.doc.data.ownerUserId, null);
    assert.equal(adminPoll.list.docs.find(row => row.id === "historical-forged-claims").data.ownerUserId, null);
    const patch = { ownerUserId: A.id, ...(kind === "staff" ? {} : { visibility: "employee" }) };
    assert.equal((await db("update", { path, patch, ifVersion: adminCopy.ver })).status, 200);
    assert.equal((await get(path, A.cookie)).exists, true);
    hidden(await get(path, B.cookie), "explicit linkage grants only the selected employee");
    const stored = srv.sql(`SELECT data,seq,employee_privacy_version FROM docs WHERE path='${path}'`)[0];
    assert.equal(stored.employee_privacy_version, stored.seq, "review verification is tied to the exact stored version");
    assert.equal(JSON.parse(stored.data).notes, old.notes, "reviewing ownership preserves original private content");
    if (kind !== "staff") {
      assert.equal((await db("update", { path, patch: { visibility: "shared-business", ownerUserId: null } })).status, 200);
      assert.equal((await get(path, B.cookie)).exists, true, "an explicit admin sharing decision is honored");
    }
  }
});

test("employee privacy: unrelated admin edits cannot adopt untrusted metadata and rejected writes cannot change verification", async () => {
  for (const kind of ["staff", "contacts", "onboarding"]) {
    const path = kind + "/unreviewed-admin-edit";
    await put(path, kind === "staff" ? training(A, "Original retained training note")
      : businessDocument(kind, "Retained personal details", { visibility: "shared-business", ownerUserId: A.id }));
    srv.sql(`UPDATE docs SET employee_privacy_version=NULL WHERE path='${path}'`);
    assert.equal((await db("update", { path, patch: { notes: "Admin corrected only the note" } })).status, 200);
    const edited = await get(path);
    assert.equal(edited.data.ownerUserId, null, "unreviewed owner is never implicitly adopted");
    if (kind !== "staff") assert.equal(edited.data.visibility, null);
    for (const person of [A, B, MANAGER]) hidden(await get(path, person.cookie), "an unrelated admin edit does not authorize old JSON claims");
    const patch = { ownerUserId: A.id, ...(kind === "staff" ? {} : { visibility: "employee" }) };
    assert.equal((await db("update", { path, patch, ifVersion: edited.ver })).status, 200);
    const before = srv.sql(`SELECT data,seq,employee_privacy_version FROM docs WHERE path='${path}'`)[0];
    assert.equal((await db("update", { path, patch: { ownerUserId: "no-such-account" } })).status, 400);
    denied(await db("update", { path, patch: { ownerUserId: B.id } }, A.cookie), "forged owner cannot change a reviewed record");
    const stale = await db("update", { path, patch: { notes: "stale attempted overwrite" }, ifVersion: 0 });
    assert.equal(stale.status, 409);
    assert.deepEqual(srv.sql(`SELECT data,seq,employee_privacy_version FROM docs WHERE path='${path}'`)[0], before, "invalid/forged/CAS-rejected writes leave content and trusted version together unchanged");
    assert.equal((await get(path, A.cookie)).exists, true);
  }
});

test("employee privacy: an old writer changing JSON/version without the trusted column invalidates ownership and sharing", async () => {
  for (const kind of ["staff", "contacts", "onboarding"]) {
    const path = kind + "/old-writer-update";
    await put(path, kind === "staff" ? training(A, "Original reviewed content")
      : businessDocument(kind, "Reviewed contact or policy", { visibility: "employee", ownerUserId: A.id }));
    assert.equal((await get(path, A.cookie)).exists, true);
    const jsonChange = kind === "staff" ? `json_set(data,'$.ownerUserId','${B.id}','$.employee_privacy_version',999999)`
      : "json_set(data,'$.visibility','shared-business','$.ownerUserId',NULL,'$.employee_privacy_version',999999)";
    srv.sql(`UPDATE meta SET v=v+1 WHERE k='seq'; UPDATE docs SET data=${jsonChange},seq=(SELECT v FROM meta WHERE k='seq') WHERE path='${path}'`);
    const staleTrust = srv.sql(`SELECT seq,employee_privacy_version FROM docs WHERE path='${path}'`)[0];
    assert.notEqual(staleTrust.employee_privacy_version, staleTrust.seq, "legacy writes cannot move the server's verification column");
    for (const person of [A, B, MANAGER]) hidden(await get(path, person.cookie), "changed unverified data fails closed even with a forged JSON trust field");
    const review = await get(path);
    assert.equal(review.data.ownerUserId, null);
    const patch = kind === "staff" ? { ownerUserId: B.id } : { visibility: "shared-business", ownerUserId: null };
    assert.equal((await db("update", { path, patch, ifVersion: review.ver })).status, 200);
    assert.equal((await get(path, B.cookie)).exists, true, "only a fresh validated review restores access");
    const reviewed = srv.sql(`SELECT seq,employee_privacy_version FROM docs WHERE path='${path}'`)[0];
    assert.equal(reviewed.employee_privacy_version, reviewed.seq);
  }
  const unreviewedPath = "staff/backup-unreviewed";
  await put(unreviewedPath, training(A, "Backup retains unresolved historical private data"));
  srv.sql(`UPDATE docs SET employee_privacy_version=NULL WHERE path='${unreviewedPath}'`);
  const created = await request("POST", "/api/admin/backups", {});
  assert.equal(created.status, 200);
  const downloaded = await request("GET", "/api/admin/backups/" + created.body.backup.id);
  assert.equal(downloaded.status, 200);
  const backup = downloaded.body;
  assert.equal(backup.documentSequence, srv.sql("SELECT v FROM meta WHERE k='seq'")[0].v, "restore retains the document counter rather than reusing verified versions");
  const verified = backup.docs.find(row => row.path === "onboarding/old-writer-update");
  assert.equal(verified.employee_privacy_version, verified.seq, "verified metadata is exported as its own trusted column/version pair");
  assert.notEqual(verified.employee_privacy_version, verified.data.employee_privacy_version, "a forged trust-looking JSON field remains distinct from trusted backup metadata");
  const unreviewed = backup.docs.find(row => row.path === unreviewedPath);
  assert.equal(unreviewed.employee_privacy_version, null, "restore cannot turn an unresolved historical owner claim into verified access");
  assert.equal(unreviewed.data.ownerUserId, A.id, "the raw historical data remains backed up without granting it trust");
  assert.equal(unreviewed.data.notes, "Backup retains unresolved historical private data");
});
