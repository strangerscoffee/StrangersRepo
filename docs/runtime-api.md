# The page's data API (`window.claude`)

The diary page (`public/diary/*.js`) reads and writes its data only through `window.claude.use(name)`, an interface it was first written against when it ran as a Claude artifact. `public/claude-shim.js` provides it on this site, backed by the Worker's `/api` routes. Keeping that one narrow interface means the page never talks to the network directly.

```js
window.claude = { use: async (name) => ({db, user, assets}[name] ?? null) };
```

`use()` returns a Promise. The page awaits `db`, `user` and `assets` together at start-up; if `db` is missing it shows the "Couldn't load the diary" banner.

## `db`

```ts
db.doc(path: string): DocRef          // even number of segments
db.collection(path: string): ColRef   // odd number of segments
```
Throw a `TypeError` for a path with the wrong segment count.

**DocRef**
```ts
id: string; path: string
get(): Promise<DocSnap>
set(data: object, opts?): Promise<void>      // full replace; creates if missing
update(patch: object, opts?): Promise<void>  // DEEP MERGE into the existing doc (see below)
delete(opts?): Promise<void>
version(): number                            // the latest version of this doc this device has seen (0: none)
// opts: {ifVersion?: number | null}: see "Changes from several devices"
onSnapshot(next: (s: DocSnap) => void, error?: (e) => void): () => void   // returns unsubscribe
```

**ColRef / Query**
```ts
add(data: object): Promise<{id: string}>   // new random id, 20 lowercase alphanumerics
doc(id?: string): DocRef
orderBy(field: string, dir?: "asc"|"desc"): Query
limit(n: number): Query
get(): Promise<QuerySnap>
onSnapshot(next: (q: QuerySnap) => void, error?: (e) => void): () => void
```

**Snapshots**
```ts
DocSnap   = { id, exists: boolean, ver: number, data(): object|undefined }
QuerySnap = { docs: Array<{ id, ver: number, data(): object }> }   // deleted docs excluded
```

### `update` semantics (important)
Nested plain objects merge recursively; everything else (arrays, strings, numbers, `null`) replaces. A `null` value is stored as `null`, not deleted. Example: the doc `{opening:{items:{o1:true},by:"a"}}` updated with `{opening:{items:{o2:true},by:"b"}}` becomes `{opening:{items:{o1:true,o2:true},by:"b"}}`. `update` on a missing document rejects with code `not_found`; the page then falls back to `set`. The Worker does the merge itself, retrying on a change counter, so two staff ticking boxes at once don't overwrite each other.

### Changes from several devices

The diary, the rota and the admin section are used on several phones, iPads and computers at once. What keeps
them from overwriting each other:

- **Versions.** Every write gives the document a new version (the global change counter, `meta.seq`), returned
  as `{ok, ver}`; reads, queries and polls report each document's `ver`. The shim remembers the latest version
  it has seen of every document (`version()`).
- **Versioned writes.** A write may carry `ifVersion`: the version it was based on. If the document has changed
  since, the Worker refuses it with **409 `conflict`** and `{path, current: {exists, data, ver}}`, instead of
  replacing a change this device hasn't seen. `ifVersion: 0` means "only if it doesn't exist yet". The shim adds
  `ifVersion` by itself (the latest version this device has seen) to every `set` and `delete`, and to an
  `update` that replaces a list; never to day and week pages, which only ever merge. `opts.ifVersion` overrides
  it (`null`: no check).
- **Editors** (suppliers, contacts, allergens, staff training, maintenance, and anything saved with
  `multiSave`) record the version and a copy of the item when they open (`beginEdit` in `diary/core.js`) and save from
  that version (`saveEdited`). On a conflict, what this person changed is put on top of the newer version by
  itself; only when both people changed the same field does the save stop with a message ("Someone else changed
  this on another device just now…"). Saving again then replaces it, having been told. HACCP plans, inspections
  and onboarding show a banner when someone else saves while they're open, with "Load their version".
- **Lists** (task and maintenance logs) never travel whole. An `update` may hold list operations, applied by the
  Worker inside the same versioned read-merge-write, so two devices adding at once both keep their entry and a
  change replayed from offline is added once:
  ```js
  {log: {$op: "prepend", items: [entry], key: "at", order: "desc", max: 30}}  // add, skipping ones already there
  {log: {$op: "remove", key: "at", values: [at]}}                            // drop by key
  {lastAt: {$op: "max", value: at}}                                          // a number that only goes up
  ```
  An operation only works on a list (or a number, for `max`) or on nothing yet; anything else is `invalid_argument`.
- **Offline.** A queued change keeps the version it was based on. If the document changed on another device
  meanwhile, it's refused when it's sent and the page says so (`diary:dropped` with `conflict: true`) rather than
  overwriting the newer version. Later queued changes to the same document are based on the earlier one.
- **Staff rules** (signatures, closed days) are checked against the document as it is; if it changes before the
  write lands, the write is checked again against the new version.
- **Live pages.** `GET /api/changes` returns `{docs, rota, accounts}`: change counters for the diary, the rota
  and accounts (one small read). Every rota write moves `rota`; every admin change moves `accounts` and `rota`.
  The rota page checks it every 10 seconds and the admin section every 15 while in view, and redraw when it
  moves, unless a sheet is open or something is being typed. A shift is saved with `ifUpdatedAt` (its
  `updatedAt` when the sheet opened): a change made from an older copy gets `conflict` with the shift as it is now.
- **Limits.** Write limits are per person (`WRITE_LIMIT_PER_15_MIN`), with five times that for an address as a
  whole, because a shop's devices share its Wi-Fi.

### Live updates
`onSnapshot` must call `next` once with the current data soon after subscribing, then again whenever the result changes. It polls: every 5 seconds while the tab is visible, 30 seconds when hidden, and results that haven't changed aren't delivered again, so the page doesn't re-render. It also refreshes straight after its own writes so the person sees their change at once. The page opens about 30 subscriptions (one site in full, plus a summary of all four), so the shim batches them into one `POST /api/db/poll` carrying every active query. While every subscription is up to date it first asks `GET /api/changes` (one small number: the diary's change counter, `docs`) and sends the full poll only when that has moved, so an idle page costs one tiny request every few seconds rather than a few KB.

### Offline
A write that can't reach the server (no connection, or a 502/503/504) isn't rejected: it's queued on the device (localStorage, per person), applied to every subscription's results so the page shows it at once, and replayed in order when the connection returns (an `update` that finds the document missing is replayed as a `set`). While anything is queued, later writes join the queue so order is kept. The shim reports `diary:connection` events (`{offline, pending}`) and `diary:dropped` when the server refuses a queued change.

### Errors
Reject with an object `{code, message}`. Codes the page understands:
- `invalid_data`: a known field has the wrong kind of value for its record (`src/validate.ts`: a date that isn't YYYY-MM-DD, a log that isn't a list, a reading that isn't a number). A whole document (`set`) is checked in full; an `update`, and a `set` on a day or week page (which merges), only for the fields it sends. Unknown fields and `null` are always allowed. The page shows the message; it doesn't switch to read-only.
- `invalid_argument`: bad path or data. **Note:** the page treats this on a write as "you don't have write access" and switches to read-only, so use it only for genuinely invalid writes.
- `quota_exceeded`: database full.
- `revoked`: session ended. Not used on the website: when a session ends the API returns 401 `unauthenticated` and the shim sends the person to the sign-in page.
- `permission_denied`: the signed-in role can't change this (staff saving manager data). The page shows its generic "Couldn't save" message.
- `not_found`: `update` on a missing document.
Anything else shows "Couldn't save. Check your connection and try again."

## `user`

```ts
me(): Promise<{id, name, avatarUrl, role, quickPin, quickSwitch, notifSeen}>
// notifSeen: the time (ms) up to which this person has seen their notifications, on any device
// {id:"web:Sam Patel", name:"Sam Patel", avatarUrl:"", role:"staff"|"manager"|"admin",
//  quickPin: has set a quick PIN, quickSwitch: this device can switch person with one}
can(perm: "data.write"): Promise<boolean>                       // true for any signed-in person
profiles(ids: string[]): Promise<Record<string, {name: string}>>
seenNotifications(at: number): Promise<number | null>          // POST /api/auth/notifications/seen; never backwards or past now
team(): Promise<Array<{id, name, role}> | null>                 // everyone with an active account; null offline
```
`team` (GET `/api/auth/team`) lists names and roles only, never usernames. The page uses it to assign maintenance jobs and to add new accounts to Staff training.
`profiles` resolves names for the "by" ids on records:
- `web:<name>` → `<name>`.
- `u_…` (older records made in the Claude version of the diary) → the name in `config/people`, else `""`. The page shows "a team member" for `""`.

## `rota`

```ts
today(site: string): Promise<{site, day, published, shifts: Array<{name, me, open, start, end, job, actualStart, actualEnd}>, rotaUrl} | null>
links(): Promise<{rota: string, diary: string} | null>
```
Today's published shifts at a site (GET `/api/rota/today`), for the "On shift today" card and the opening and closing cards' "who opens / who closes". `null` when offline: the page keeps what it showed. `published: false` (the week isn't published yet) leaves Today as it is. `links()` gives the rota's address for the diary's **Rota** link. The rota itself is a separate app (`public/rota/`) that calls `/api/rota/*` directly; see `docs/data-model.md` → "The rota API".

## `assets`

```ts
upload(file: Blob, opts?: {type?: string}): Promise<{id, url, sizeBytes, contentType}>
delete(id: string): Promise<{deleted: boolean}>
```
Stored in Workers KV under a random 32-character hex id. PDFs only, 20 MB maximum (rejected with `too_large` or `unsupported_type`). Served at `GET /_blob/<id>` with the stored content type, `Content-Disposition: inline` and `X-Content-Type-Options: nosniff`. `url` = `"/_blob/" + id`.
