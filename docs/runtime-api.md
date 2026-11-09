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
`onSnapshot` must call `next` once with the current data soon after subscribing, then again whenever the result changes. It polls: every 5 seconds while the tab is visible, 30 seconds when hidden, and results that haven't changed aren't delivered again, so the page doesn't re-render. It also refreshes straight after its own writes so the person sees their change at once. The page opens about 20 subscriptions (one site in full, plus one summary of all four), so the shim batches them into one `POST /api/db/poll` carrying every active query. While every subscription is up to date it first asks `GET /api/changes` (one small number: the diary's change counter, `docs`) and sends the full poll only when that has moved, so an idle page costs one tiny request every few seconds rather than a few KB.

**Pushed, not polled.** Each page also keeps a WebSocket open to `GET /api/live` (`SC.live` in `public/shared/core.js`; the server side is one Durable Object, `LiveHub` in `src/live.ts`). After every write that moves a change counter (diary saves, the rota, accounts and sites, stored files) the Worker sends the counters (`{docs, rota, accounts}`, never any data) to every open page, which then polls as above at once. While the line is open the shim and the rota and admin pages only check once a minute, in case a message was missed, so an idle page makes no requests at all; when it drops (no signal, a locked phone, a deploy) they go back to polling every few seconds and reconnect with back-off (1 s doubling to 30 s, and straight away when the page is shown or back online). Pages send a keep-alive every 25 s that the runtime answers without waking the object. It's built for the Workers Free plan: hibernating WebSockets cost nothing while idle, and each connection and each change is one Durable Object request. Only signed-in pages from the site's own addresses can connect (Origin is checked).

**Only what changed.** A list the device already holds is polled with `delta: true` and the version it has; the answer is then `{ver, delta: [{id, ver, data} | {id, ver, deleted: true}]}`, just the documents changed since, which the shim merges into its copy, sorts the way the server does (`ordered` in `public/claude-shim.js`, matching SQLite's order) and cuts to the limit. So one reading costs each open device a few hundred bytes, not the site's whole list of days. The server sends the whole list instead when more than 100 documents changed, or a document was deleted from a limited list (the gap can only be filled from the server); and the shim asks for the whole list anyway every 10 minutes. A poll without `delta` (an older page) gets whole lists as before.

**History when it's needed.** The diary opens with the latest 90 days, 12 weeks, 60 deliveries and 80 Prove it records of its site: enough for Today, This week, Last 4 weeks, closures, the menu and the review reminder. `needHistory()` (`public/diary/start.js`) switches those four lists to the long ones (400 days, 120 weeks, 400 deliveries, 500 Prove it records) the first time a screen needs older records: a date or week before the last 55 days, a temperature log longer than that, the Deliveries or Prove it list, or the 4-weekly review going back further. The new list starts from the old one's copy, so nothing goes blank meanwhile. EHO inspection mode fetches its own period.

**Every site at a glance.** The site switcher, Today's reminders, the maintenance bell and Setup's publish preview need a little about every site, so the page asks for one summary rather than each site's lists: `db.summary(from, to)` in the shim, a poll query `{kind: "summary", from, to}` answered by `siteSummary` (`src/summary.ts`) with, for each of the four sites, its `settings/main`, its days from `from` to `to` (the diary asks for the last 8 days), `firstDay` (the date of its first day page), its extra checks and cleaning without their `log`, and its maintenance jobs that are open or were done in the last 14 days. Its version is the latest change to any of those collections, so it's sent again only when one of them changes. For the site on screen the page uses its own full lists instead (`siteAttention`, `maintNotifs`), which also show this device's changes at once. Maintenance → All sites subscribes to every site's full maintenance list when it's first opened.

### Offline
A write that can't reach the server (no connection, or a 502/503/504) isn't rejected: it's queued on the device (localStorage, per person), applied to every subscription's results so the page shows it at once, and replayed in order when the connection returns (an `update` that finds the document missing is replayed as a `set`). While anything is queued, later writes join the queue so order is kept. The shim reports `diary:connection` events (`{offline, pending}`) and `diary:dropped` when the server refuses a queued change.

### Time
Every response carries `x-now` (the server's time, ms) and every request from a page carries `x-device-time` (the device's own clock). `public/shared/core.js` replaces the page's `Date` so `Date.now()` and `new Date()` give the server's time (the offset from the quickest round trip, re-measured at least every 10 minutes, kept in localStorage `sc.clock` for offline starts; a change of over a minute fires a `sc-clock` event, on which the diary re-checks its date). Dates and times are UK time (Europe/London). Times in a written document (`at`, `lastAt`, `createdAt`, `updatedAt`, `doneAt`, `reportedAt`, `importedAt`) more than 5 minutes in the future are set to now, except inside `$op` list operations.

### Errors
Reject with an object `{code, message}`. Codes the page understands:
- `invalid_data`: a known field has the wrong kind of value for its record (`src/validate.ts`: a date that isn't YYYY-MM-DD, a log that isn't a list, a reading that isn't a number). A whole document (`set`) is checked in full; an `update`, and a `set` on a day or week page (which merges), only for the fields it sends. Unknown fields and `null` are always allowed. The page shows the message; it doesn't switch to read-only.
- `invalid_argument`: bad path or data. **Note:** the page treats this on a write as "you don't have write access" and switches to read-only, so use it only for genuinely invalid writes.
- `quota_exceeded`: database full.
- `revoked`: session ended. Not used on the website: when a session ends the API returns 401 `unauthenticated` and the shim sends the person to the sign-in page.
- `permission_denied`: the signed-in role can't change this (staff saving manager data). The page shows its generic "Couldn't save" message.
- `not_found`: `update` on a missing document.
- `internal` (500): something unexpected failed on the server. It carries `ref`, the error's code (`E-` and six characters), and the message names it, so a screenshot of the message is enough to find the error in Admin → Activity → Errors.
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

## Wholesale accounts and ordering

These routes are separate from the diary shim. Approved wholesale sessions and existing staff sessions are accepted for ordering only; wholesale sessions never authorize staff APIs. All writes have the existing Origin and rate-limit protection. Administration stays on the admin app; the preview hostname refuses diary, rota and admin-management APIs.

Public customer-auth routes: `POST /api/wholesale/auth/register` (`business,contact,email,phone?,username,password`), `POST .../login` (`username,password`), `POST .../change-password` (`username,password,newPassword`), `POST .../logout`, `GET .../me`. Registration returns 201 with pending approval and no cookie. Pending/declined logins return 403 after credential verification. A temporary password returns `password_change_required`; changing it completes sign-in. Login and registration have dedicated attempt limits.

`GET /api/wholesale/catalogue` returns sourced and added coffees with current details, prices, `active`, `inStock`, `images`, relative `imageUrls` and versions, source date, ordering identity, safe business profile and links. The client excludes hidden products from its list. `GET /api/wholesale/session` returns identity/profile without the catalogue. Public customer profiles include read-only `paymentTerms:{id,label,note}`. Wholesale customers receive no staff-management links. `PUT /api/wholesale/account` updates their own contact/delivery fields, using `ifVersion`; it cannot rename the approved business or set hold status, internal notes or payment terms.

`POST /api/wholesale/orders` accepts `{requestId,lines:[{productId,pack,grind,quantity,price}],delivery,reference?,business?,customerVersion?,locationId?}`. Customer orders require the reviewed integer `customerVersion`; missing/stale versions return 409 `account_changed` and require reloading/reviewing. The quoted pence price must match the current server catalogue; hidden coffees and out-of-stock coffees cannot create new orders. Ownership/business, UK date, totals, delivery details and customer payment-term snapshots are server-set. Delivery needs an address/postcode; holds prevent new orders. Customers create `WS-…` records with `preview:false`; staff create marked `PREVIEW-…` records. A successful new request returns 201, an identical retry 200 with its original snapshot even after terms or stock change. Reusing an ID with another payload/owner returns 409.

`GET /api/wholesale/orders?cursor=` returns up to 200 own-business customer orders or own staff preview orders, plus `count` and `nextCursor`. It uses `updated_at DESC,id ASC` keyset pages; invalid cursors return 400, and every page/count retains the same business/creator scope. `GET .../orders/<id>` returns an owned record (admins may read all). Other businesses' IDs and staff preview records requested by customers return 404. Internal notes and idempotency hashes are omitted from customer responses. Order again in the client builds a basket at current prices and requires confirmation.

Admin-only: `GET /api/admin/wholesale` (latest 200 orders/customers, all coffees, `paymentTermChoices`, safe account metadata and record counts), `POST .../customers`, `PUT .../customers/<uuid>` and `PATCH .../orders/<id>`. Customer/catalogue/order edits require `ifVersion`; stale saves return 409. Customer orders remain linked to the business that placed them. Customer writes accept `paymentTerms` (a listed term ID) and `paymentNote` (up to 500 characters); omitted fields preserve existing terms, and Custom requires instructions. Order updates send `status,note,customerId` and optional `trackingUrl`, preserving snapshots. Omitted tracking preserves the saved link; an empty string removes it. Links are normalized absolute HTTP/HTTPS URLs, up to 2,000 characters, without credentials or literal/encoded control characters. Legacy and new untracked order DTOs return `trackingUrl:""`. Customer checkout cannot set tracking or change its request hash. Owned receipts/history expose the saved link; no courier request is sent.

Catalogue administration under `/api/admin/wholesale`:

| Method and route | Input / result |
|---|---|
| `POST /catalogue` | Creates a coffee with `title,name,origin,process,notes,badge,categories,prices:{quarter,half,kilo},active,inStock`. Prices are integer GBP pence, £0.01–£10,000 per bag. Categories are `single-origin`, `blend`, `decaf`. Returns 201 `{product}`. Up to 500 coffees. |
| `PUT /catalogue/<id>` | Same editable fields plus `ifVersion`; returns `{product}`. Omitted detail/stock fields preserve existing values for older clients. Image references cannot be set through this route. |
| `POST /catalogue/<id>/images?ifVersion=N` | Raw raster bytes, optional encoded `x-file-name`; up to 5 MB, detected JPEG/PNG/WebP, six images per coffee. Returns 201 `{product}` with its new version. |
| `PATCH /catalogue/<id>/images` | `{ifVersion,remove:<image reference>}` unlinks/deletes a photo, or `{ifVersion,restore:true}` restores a bundled original. Returns `{product}`. The two operations cannot be combined. |
| `GET /images/<32 hex id>` | Admin-session photo read. Customer/staff ordering reads use `GET /api/wholesale/images/<id>`. Both verify a current product reference, return the detected MIME type, `nosniff` and private revalidation headers, or 404 for missing/removed photos. |

Bundled source photos retain `/wholesale-preview/images/<filename>` URLs. Uploads use the existing `FILES` KV binding and new references are committed using the catalogue's version check. Removing a bundled image only unlinks it; removing an upload deletes its KV bytes.

Account administration: `POST .../customers/<uuid>/account` creates an approved temporary-password login; `PUT .../account` sends `username,active,approvalStatus,ifVersion`; `POST .../account/reset-password` sends `ifVersion`. Approval is pending/approved/rejected. Approving a pending registration activates its customer record. Creates/resets return a temporary password once. Username changes, disabling and resets revoke existing sessions. Staff/managers receive 403 on every management route. No endpoint automatically takes payment, emails or ships an order.

Wholesale retains all existing paths and per-order `preview` semantics; catalogue/session/bootstrap add `stage:"beta"`. The shared theme stylesheet is public on the ordering host without exposing account or catalogue data. Admin bootstrap also returns `orderCursor`, `customerCursor` and full-database `stats:{openOrders,gramsToPrepare,pendingAccounts,totalCustomers,visibleCoffees,totalCoffees}`.

Admin-only `GET /api/admin/wholesale/orders?q=&status=&cursor=` returns `{orders,nextCursor,count}` and `GET .../customers?q=&status=&approval=&cursor=` returns `{customers,accounts,nextCursor,count}`. Pages hold 200 records, ordered `updated_at DESC,id ASC`; cursors are validated `<timestamp>:<id>`. Search is bound and treats SQL wildcards literally. Status/approval values are validated. Counts cover all matching records; staff previews do not count towards preparation stats. Client checkout stores a frozen uncertain submission and retries the same UUID/payload until the server returns its existing receipt or a validated rejection.

New checkout clients send `orderingIdentity` with the reviewed signed-in user ID. When present, the server compares it with the authenticated identity before processing and rejects a changed account with 409 `account_changed`; it never grants ownership from that field. Legacy clients keep the existing ownership checks. A resumed browser submission also rechecks its session before retrying, and a receipt is validated before clearing local recovery state.

Repeat-order previews use the existing authenticated catalogue read and only alter the browser basket after confirmation. Customer history appends owned pages without changing checkout or approval. Admin preparation shortcuts use the existing version-checked order PATCH with the displayed customerId and unchanged internal note; they add no fulfilment side effects or new permission boundary.

Profile writes also accept the expected `orderingIdentity`; a mismatched provided identity returns 409 `account_changed`. The customer UI checks identity before saving and reloads cached pages before restoring private dialogs, preventing a form from one business being submitted under another session.

Admin-only `DELETE /api/admin/wholesale/orders/<id>` accepts `{ifVersion}` and removes a customer or staff-preview order from ordering/management views. It uses the existing Origin/rate-limit protection and an atomic version check; stale requests return 409, missing/already removed orders return 404. Removed records retain server `deletedAt`/`deletedBy` metadata for audit/idempotency and are excluded from every list/count/preparation aggregate. A matching original checkout retry returns 410 `order_deleted` and never recreates the order. No payment/refund/fulfilment action is invoked.

Customer profiles expose `locations` and `defaultLocationId`. Customer profile PUT and admin customer PUT accept optional `locations:[{id?,name,contact,phone,address,postcode,deliveryNotes}]` plus `defaultLocationId`; updates remain version checked. The array includes the permanent `primary` location, with at most 20 entries. New extra entries omit `id` and receive a UUID; supplied IDs must already belong to the customer. Omitted arrays preserve extra locations while syncing legacy primary fields. Changed customer-supplied business names return 403; omitted or unchanged names remain compatible. These profile bodies are capped at 64 KiB.

Checkout location IDs must belong to the signed-in business. New clients send the reviewed selected ID and customer version, including collection orders; legacy omitted IDs use primary. A saved order snapshots the chosen location and retains its original result on an exact retry after location changes/removal. An altered location ID with the same request UUID remains a conflict.

## Wholesale invoices

All `/api/admin/wholesale/` invoice routes are admin-only with the existing Origin/write-rate guards. `GET/PUT invoice-settings` reads/saves `{ifVersion,...settings}` and returns `{settings,version,updatedAt,ready,reasons}`. Settings include `seller`, `priceBasis`, `vatRates:[{id,label,basisPoints}]`, defaults, `invoicePrefix`, `firstInvoiceNumber`, `paymentInstructions` and `confirmed`. Incomplete drafts are allowed; issuing requires ready settings.

`GET orders/<WS-id>/invoice` recovers an issued invoice. `POST orders/<WS-id>/invoice/preview` calculates a draft and `/preview/pdf` renders a marked draft; neither allocates a number. `POST orders/<WS-id>/invoice` explicitly issues one immutable invoice. Bodies carry `{orderVersion,settingsVersion,invoiceDate,supplyDate,billTo?,deliveryCharge?,lineVatRateIds?,paymentInstructions?,dueDate?}`. Saved order quantities/prices are fixed; VAT and totals are calculated server-side in integer pence. Net-term due dates are computed from the invoice date; other terms can carry an explicit due date. Exact normalized retries recover the existing invoice before current-source validation, while changed requests conflict. Staff previews, deleted or cancelled source orders cannot create a new invoice.

`GET invoices?cursor=<seq>` returns `{invoices,nextCursor,count,summary}` with up to 200 records and full-scope outstanding/overdue totals. `GET invoices/<seq>` and `/pdf` return an issued document. `PATCH invoices/<seq>/payment` accepts `{ifVersion,paid,paidDate?,reference?}`, updates payment metadata atomically and audits it; it performs no bank transaction.

Customer `GET /api/wholesale/invoices`, `GET .../invoices/<seq>[/pdf]` and `GET .../orders/<WS-id>/invoice[/pdf]` are read-only and always constrained by the signed-in business. Other businesses receive 404; staff preview identities have no customer-invoice access. Issued invoices remain visible after source-order deletion. Order history also includes issued invoice IDs/numbers.
