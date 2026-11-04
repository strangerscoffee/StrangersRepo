# The page's data API (`window.claude`)

The diary page (`public/app.js`) reads and writes its data only through `window.claude.use(name)`, an interface it was first written against when it ran as a Claude artifact. `public/claude-shim.js` provides it on this site, backed by the Worker's `/api` routes. Keeping that one narrow interface means the page never talks to the network directly.

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
set(data: object): Promise<void>      // full replace; creates if missing
update(patch: object): Promise<void>  // DEEP MERGE into the existing doc (see below)
delete(): Promise<void>
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
DocSnap   = { id, exists: boolean, data(): object|undefined }
QuerySnap = { docs: Array<{ id, data(): object }> }   // deleted docs excluded
```

### `update` semantics (important)
Nested plain objects merge recursively; everything else (arrays, strings, numbers, `null`) replaces. A `null` value is stored as `null`, not deleted. Example: the doc `{opening:{items:{o1:true},by:"a"}}` updated with `{opening:{items:{o2:true},by:"b"}}` becomes `{opening:{items:{o1:true,o2:true},by:"b"}}`. `update` on a missing document rejects with code `not_found`; the page then falls back to `set`. The Worker does the merge itself, retrying on a change counter, so two staff ticking boxes at once don't overwrite each other.

### Live updates
`onSnapshot` must call `next` once with the current data soon after subscribing, then again whenever the result changes. It polls: every 5 seconds while the tab is visible, 30 seconds when hidden, and results that haven't changed aren't delivered again, so the page doesn't re-render. It also refreshes straight after its own writes so the person sees their change at once. The page opens about 30 subscriptions (one site in full, plus a summary of all four), so the shim batches them into one `POST /api/db/poll` carrying every active query.

### Offline
A write that can't reach the server (no connection, or a 502/503/504) isn't rejected: it's queued on the device (localStorage, per person), applied to every subscription's results so the page shows it at once, and replayed in order when the connection returns (an `update` that finds the document missing is replayed as a `set`). While anything is queued, later writes join the queue so order is kept. The shim reports `diary:connection` events (`{offline, pending}`) and `diary:dropped` when the server refuses a queued change.

### Errors
Reject with an object `{code, message}`. Codes the page understands:
- `invalid_argument`: bad path or data. **Note:** the page treats this on a write as "you don't have write access" and switches to read-only, so use it only for genuinely invalid writes.
- `quota_exceeded`: database full.
- `revoked`: session ended. Not used on the website: when a session ends the API returns 401 `unauthenticated` and the shim sends the person to the sign-in page.
- `permission_denied`: the signed-in role can't change this (staff saving manager data). The page shows its generic "Couldn't save" message.
- `not_found`: `update` on a missing document.
Anything else shows "Couldn't save. Check your connection and try again."

## `user`

```ts
me(): Promise<{id, name, avatarUrl, role, quickPin, quickSwitch}>
// {id:"web:Sam Patel", name:"Sam Patel", avatarUrl:"", role:"staff"|"manager"|"admin",
//  quickPin: has set a quick PIN, quickSwitch: this device can switch person with one}
can(perm: "data.write"): Promise<boolean>                       // true for any signed-in person
profiles(ids: string[]): Promise<Record<string, {name: string}>>
team(): Promise<Array<{id, name, role}> | null>                 // everyone with an active account; null offline
```
`team` (GET `/api/auth/team`) lists names and roles only, never usernames. The page uses it to assign maintenance jobs and to add new accounts to Staff training.
`profiles` resolves names for the "by" ids on records:
- `web:<name>` → `<name>`.
- `u_…` (older records made in the Claude version of the diary) → the name in `config/people`, else `""`. The page shows "a team member" for `""`.

## `rota`

```ts
today(site: string): Promise<{site, day, published, shifts: Array<{name, me, open, start, end, job}>, rotaUrl} | null>
links(): Promise<{rota: string, diary: string} | null>
```
Today's published shifts at a site (GET `/api/rota/today`), for the "On shift today" card and the opening and closing cards' "who opens / who closes". `null` when offline: the page keeps what it showed. `published: false` (the week isn't published yet) leaves Today as it is. `links()` gives the rota's address for the diary's **Rota** link. The rota itself is a separate app (`public/rota/`) that calls `/api/rota/*` directly; see `docs/data-model.md` → "The rota API".

## `assets`

```ts
upload(file: Blob, opts?: {type?: string}): Promise<{id, url, sizeBytes, contentType}>
delete(id: string): Promise<{deleted: boolean}>
```
Stored in Workers KV under a random 32-character hex id. PDFs only, 20 MB maximum (rejected with `too_large` or `unsupported_type`). Served at `GET /_blob/<id>` with the stored content type, `Content-Disposition: inline` and `X-Content-Type-Options: nosniff`. `url` = `"/_blob/" + id`.
