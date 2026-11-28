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

### Employee-private records

Employee access is admin-or-self, including for managers. The generic DB API protects `staff`, `contacts` and `onboarding` at every site. `ownerUserId` is a stable `users.id`; `web:<name>`, `personId`, document IDs and equal display names never confer ownership. Contacts/onboarding require an admin-reviewed `visibility: "shared-business"` or `"employee"` classification; employee-private records also require their owner.

The server trusts metadata only when the separate `employee_privacy_version` column equals the row’s `seq`. Legacy/unverified records remain admin-only; admins must review and link/classify them through validated writes. Nonadmin reads exclude unauthorized rows before sorting/limits. Direct reads return a nonrevealing missing document; unauthorized writes cannot return private current data in conflict errors. Protected nonadmin polls always return a complete authorized snapshot, even at the same version or when `delta:true` is supplied, so a changed owner cannot leave a cached row visible. Admins retain full access and may retain unlinked legacy records privately.

The EHO view/PDF reports only authorized training: admins get the full workforce pack, while staff/managers get their own verified records with an explicit scope and no workforce training totals. Shared-business guidance is preserved; private onboarding metadata is owner-filtered too. All email/CSV/PDF/backup paths must enforce the same policy as the interactive API.

### Changes from several devices

The diary, the rota and the admin section are used on several phones, iPads and computers at once. What keeps
them from overwriting each other:

- **Versions.** Every write gives the document a new version (the global change counter, `meta.seq`), returned
  as `{ok, ver}`; reads, queries and polls report each document's `ver`. The shim remembers the latest version
  it has seen of every document (`version()`).
- **Versioned writes.** A write may carry `ifVersion`: the version it was based on. If the document has changed
  since, the Worker refuses it with **409 `conflict`** and `{path, current: {exists, data, ver}}`, instead of
  replacing a change this device hasn't seen. `ifVersion: 0` means "only if it doesn't exist yet". The shim adds
  `ifVersion` by itself (the latest version this device has seen) to ordinary replacements, deletes and updates
  that replace a list. Day and week pages merge. Checklist edits also guard each attempt with a version, so
  a request delayed by a connection failure cannot reapply after a newer tap. On a conflict the shim retries
  the same checklist patch against the newer row. `opts.ifVersion` overrides the default (`null` omits the guard).
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

**Only what changed.** An ordinary business list the device already holds is polled with `delta: true` and the version it has; the answer is then `{ver, delta: [{id, ver, data} | {id, ver, deleted: true}]}`, just the documents changed since, which the shim merges into its copy, sorts the way the server does (`ordered` in `public/claude-shim.js`, matching SQLite's order) and cuts to the limit. So one reading costs each open device a few hundred bytes, not the site's whole list of days. The server sends the whole list instead when more than 100 documents changed, or a document was deleted from a limited list (the gap can only be filled from the server); and the shim asks for the whole list anyway every 10 minutes. A poll without `delta` (an older page) gets whole lists as before.

**History when it's needed.** The diary opens with the latest 90 days, 12 weeks, 60 deliveries and 80 Prove it records of its site: enough for Today, This week, Last 4 weeks, closures, the menu and the review reminder. `needHistory()` (`public/diary/start.js`) switches those four lists to the long ones (400 days, 120 weeks, 400 deliveries, 500 Prove it records) the first time a screen needs older records: a date or week before the last 55 days, a temperature log longer than that, the Deliveries or Prove it list, or the 4-weekly review going back further. The new list starts from the old one's copy, so nothing goes blank meanwhile. EHO inspection mode fetches its own period.

**Every site at a glance.** The site switcher, Today's reminders, the maintenance bell and Setup's publish preview need a little about every site, so the page asks for one summary rather than each site's lists: `db.summary(from, to)` in the shim, a poll query `{kind: "summary", from, to}` answered by `siteSummary` (`src/summary.ts`) with, for each of the four sites, its `settings/main`, its days from `from` to `to` (the diary asks for the last 8 days), `firstDay` (the date of its first day page), its extra checks and cleaning without their `log`, and its maintenance jobs that are open or were done in the last 14 days. Its version is the latest change to any of those collections, so it's sent again only when one of them changes. For the site on screen the page uses its own full lists instead (`siteAttention`, `maintNotifs`), which also show this device's changes at once. Maintenance → All sites subscribes to every site's full maintenance list when it's first opened.

### Session identity and cached data

`public/shared/core.js` and the diary shim bind loaded state and requests to the expected stable account ID **and role**. Data requests carry `x-expected-user-id` and `x-expected-user-role`; a cookie identity/role mismatch returns 409 `session_changed` before routing. A page restored from browser memory or returning to focus must verify its session before exposing cached private content. Auth changes, role changes, cross-tab switches, expired sessions and unverifiable offline resumes cover the UI, clear sensitive in-memory lists/editors and block unsafe reads/writes/queue replay. The first identity binding requires fresh asynchronous server proof; completing/streaming response bodies must also be checked before their data reaches the page. Out-of-order auth responses cannot silently replace the expected identity.

Migration 14 adds privacy verification and increments every staff account’s `session_ver` once, requiring fresh password sign-in and re-establishing trusted quick switching. It also advances `meta.seq`; credentials, document data and existing browser queues are retained. `GET /api/auth/me` is read-only: it does not repair old verification metadata or revive a cutover session.

### Offline
An operational business write that can't reach the server (no connection, or a 502/503/504) isn't rejected: it's queued on the device (localStorage, per person), applied to every subscription's results so the page shows it at once, and replayed in order when the connection returns (an `update` that finds the document missing is replayed as a `set`). While anything is queued, later writes join the queue so order is kept. Operational business writes retain that offline queue. New private `staff`/`contacts`/`onboarding` writes require a verified online save and do not enter a new plaintext local queue. Legacy unsent private queues remain stored for their original stable identity, quarantined from automatic replay; changed/unverified sessions cannot replay them and must not delete that user work. Legacy queue storage is not encrypted and is inspectable through DevTools in the same browser profile; see `docs/employee-privacy-audit.md` for this residual limit. The shim reports `diary:connection` events (`{offline, pending}`) and `diary:dropped` when the server refuses a queued change.

### Time
Every response the browser never keeps (`cache-control: no-store`, so every API answer and page) carries `x-now` (the server's time, ms), and pages read the time only from those: a static file the browser keeps would come back with the time it was first fetched and every request from a page carries `x-device-time` (the device's own clock). `public/shared/core.js` replaces the page's `Date` so `Date.now()` and `new Date()` give the server's time (the offset from the quickest round trip, re-measured at least every 10 minutes, kept in localStorage `sc.clock` for offline starts; a change of over a minute fires a `sc-clock` event, on which the diary re-checks its date). Dates and times are UK time (Europe/London). Times in a written document (`at`, `lastAt`, `createdAt`, `updatedAt`, `doneAt`, `reportedAt`, `importedAt`) more than 5 minutes in the future are set to now, except inside `$op` list operations.

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
me(): Promise<{id, userId, name, avatarUrl, role, quickPin, quickSwitch, notifSeen}>
// notifSeen: the time (ms) up to which this person has seen their notifications, on any device
// {id:"web:Sam Patel", userId:"<stable users.id>", name:"Sam Patel", avatarUrl:"", role:"staff"|"manager"|"admin",
//  quickPin: has set a quick PIN, quickSwitch: this device can switch person with one}
can(perm: "data.write"): Promise<boolean>                       // true for any signed-in person
profiles(ids: string[]): Promise<Record<string, {name: string}>>
seenNotifications(at: number): Promise<number | null>          // POST /api/auth/notifications/seen; never backwards or past now
team(): Promise<Array<{id, userId?, name, role, active?}> | null>                 // admin includes inactive accounts and stable userId; null offline
```
`team` (GET `/api/auth/team`) exposes active names/roles and historical attribution IDs to nonadmins, never private account details. Admins additionally receive stable `userId` and `active` for all accounts, including inactive ones, so they can review/link private records reliably. `me().userId` is the stable ownership key; `me().id` remains `web:<name>` for diary attribution.
`profiles` resolves names for the "by" ids on records:
- `web:<name>` → `<name>`.
- `u_…` (older records made in the Claude version of the diary) → the name in `config/people`, else `""`. The page shows "a team member" for `""`.

## `rota`

```ts
today(site: string): Promise<{site, day, published, shifts: Array<{name, me, open, start, end, job, actualStart, actualEnd}>, rotaUrl} | null>
links(): Promise<{rota: string, diary: string} | null>
```
Today’s published shifts at a site (`GET /api/rota/today`) are employee-scoped: admins receive the full site day; staff/managers receive only their own assignments and scrubbed unassigned opportunities. Other employee names, hours and actual times are never returned. A missing/unverified session hides cached private content; unpublished weeks return no assignments. `links()` gives the rota's address for the diary's **Rota** link. The rota itself is a separate app (`public/rota/`) that calls `/api/rota/*` directly; see `docs/data-model.md` → "The rota API".

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

`POST /api/wholesale/orders` accepts `{requestId,lines:[{productId,pack,grind,quantity,price}],delivery,reference?,business?,customerVersion?,locationId?,customerNote?}`. Orders under the business's minimum (6 kg of coffee unless Admin set `noMinimumOrder`) get 409 `below_minimum`; session and catalogue reads carry `minimumOrderGrams` (6000, or 0 when exempt). `customerNote` is the customer's optional comments (up to 1,000 characters, trimmed); it is kept on the order, shown back to that business and to admins, never changes afterwards, and is only part of the retry check when it isn't blank. Customer orders require the reviewed integer `customerVersion`; missing/stale versions return 409 `account_changed` and require reloading/reviewing. The quoted pence price must match the current server catalogue; hidden coffees and out-of-stock coffees cannot create new orders. Ownership/business, UK date, totals, delivery details and customer payment-term snapshots are server-set. Delivery needs an address/postcode; holds prevent new orders. Customers create `WS-…` records with `preview:false`; staff create marked `PREVIEW-…` records. A successful new request returns 201, an identical retry 200 with its original snapshot even after terms or stock change. Reusing an ID with another payload/owner returns 409.

`GET /api/wholesale/orders?cursor=` returns up to 200 own-business customer orders or own staff preview orders, plus `count` and `nextCursor`. It uses `updated_at DESC,id ASC` keyset pages; invalid cursors return 400, and every page/count retains the same business/creator scope. `GET .../orders/<id>` returns an owned record (admins may read all). Other businesses' IDs and staff preview records requested by customers return 404. Internal notes and idempotency hashes are omitted from customer responses. Order again in the client builds a basket at current prices and requires confirmation.

Admin-only: `GET /api/admin/wholesale` (latest 200 orders/customers, all coffees, `paymentTermChoices`, safe account metadata and record counts), `POST .../customers`, `PUT .../customers/<uuid>` and `PATCH .../orders/<id>`. Customer/catalogue/order edits require `ifVersion`; stale saves return 409. Customer orders remain linked to the business that placed them. Customer writes accept `paymentTerms` (a listed term ID) and `paymentNote` (up to 500 characters); omitted fields preserve existing terms, and Custom requires instructions. Order updates send `status,note,customerId` and optional `trackingUrl`, preserving snapshots. Omitted tracking preserves the saved link; an empty string removes it. Links are normalized absolute HTTP/HTTPS URLs, up to 2,000 characters, without credentials or literal/encoded control characters. Legacy and new untracked order DTOs return `trackingUrl:""`. Customer checkout cannot set tracking or change its request hash. Owned receipts/history expose the saved link; no courier request is sent.

Catalogue administration under `/api/admin/wholesale`:

| Method and route | Input / result |
|---|---|
| `POST /catalogue` | Creates a coffee with `title,name,origin,process,notes,badge,categories,prices:{quarter,kilo},active,inStock,grindOptions?:[{id,label,enabled}]`. Prices are integer GBP pence, £0.01–£10,000 per bag. Categories are `single-origin`, `blend`, `decaf`. Returns 201 `{product}`. Up to 500 coffees. |
| `PUT /catalogue/<id>` | Same editable fields plus `ifVersion`; returns `{product}`. Omitted detail/stock fields preserve existing values for older clients. Image references cannot be set through this route. |
| `POST /catalogue/<id>/images?ifVersion=N` | Raw raster bytes, optional encoded `x-file-name`; up to 5 MB, detected JPEG/PNG/WebP, six images per coffee. Returns 201 `{product}` with its new version. |
| `PATCH /catalogue/<id>/images` | `{ifVersion,remove:<image reference>}` unlinks/deletes a photo, or `{ifVersion,restore:true}` restores a bundled original. Returns `{product}`. The two operations cannot be combined. |
| `GET /images/<32 hex id>` | Admin-session photo read. Customer/staff ordering reads use `GET /api/wholesale/images/<id>`. Both verify a current product reference, return the detected MIME type, `nosniff` and private revalidation headers, or 404 for missing/removed photos. |

Bundled source photos retain `/wholesale/images/<filename>` URLs. Uploads use the existing `FILES` KV binding and new references are committed using the catalogue's version check. Removing a bundled image only unlinks it; removing an upload deletes its KV bytes.

Account administration: `POST .../customers/<uuid>/account` creates an approved temporary-password login; `PUT .../account` sends `username,active,approvalStatus,ifVersion`; `POST .../account/reset-password` sends `ifVersion`. Approval is pending/approved/rejected. Approving a pending registration activates its customer record. Creates/resets return a temporary password once. Username changes, disabling and resets revoke existing sessions. Staff/managers receive 403 on every management route. No endpoint automatically takes payment, emails or ships an order.

Wholesale retains all existing paths and per-order `preview` semantics; catalogue/session/bootstrap add `stage:"beta"`. The shared theme stylesheet is public on the ordering host without exposing account or catalogue data. Admin bootstrap also returns `orderCursor`, `customerCursor` and full-database `stats:{openOrders,gramsToPrepare,pendingAccounts,totalCustomers,visibleCoffees,totalCoffees}`.

Admin-only `GET /api/admin/wholesale/orders?q=&status=&cursor=` returns `{orders,nextCursor,count}` and `GET .../customers?q=&status=&approval=&cursor=` returns `{customers,accounts,nextCursor,count}`. Pages hold 200 records, ordered `updated_at DESC,id ASC`; cursors are validated `<timestamp>:<id>`. Search is bound and treats SQL wildcards literally. Status/approval values are validated. Counts cover all matching records; staff previews do not count towards preparation stats. Client checkout stores a frozen uncertain submission and retries the same UUID/payload until the server returns its existing receipt or a validated rejection.

New checkout clients send `orderingIdentity` with the reviewed signed-in user ID. When present, the server compares it with the authenticated identity before processing and rejects a changed account with 409 `account_changed`; it never grants ownership from that field. Legacy clients keep the existing ownership checks. A resumed browser submission also rechecks its session before retrying, and a receipt is validated before clearing local recovery state.

Repeat-order previews use the existing authenticated catalogue read and only alter the browser basket after confirmation. Customer history appends owned pages without changing checkout or approval. Admin preparation shortcuts use the existing version-checked order PATCH with the displayed customerId and unchanged internal note; they add no fulfilment side effects or new permission boundary.

Profile writes also accept the expected `orderingIdentity`; a mismatched provided identity returns 409 `account_changed`. The customer UI checks identity before saving and reloads cached pages before restoring private dialogs, preventing a form from one business being submitted under another session.

Admin-only `DELETE /api/admin/wholesale/orders/<id>` accepts `{ifVersion}` and removes a customer or staff-preview order from ordering/management views. It uses the existing Origin/rate-limit protection and an atomic version check; stale requests return 409, missing/already removed orders return 404. Removed records retain server `deletedAt`/`deletedBy` metadata for audit/idempotency and are excluded from every list/count/preparation aggregate. A matching original checkout retry returns 410 `order_deleted` and never recreates the order. No payment/refund/fulfilment action is invoked.

Customer profiles expose `locations` and `defaultLocationId`. Customer profile PUT and admin customer PUT accept optional `locations:[{id?,name,contact,phone,address,postcode,deliveryNotes}]` plus `defaultLocationId`; updates remain version checked. The array includes the permanent `primary` location, with at most 20 entries. New extra entries omit `id` and receive a UUID; supplied IDs must already belong to the customer. Omitted arrays preserve extra locations while syncing legacy primary fields. Changed customer-supplied business names return 403; omitted or unchanged names remain compatible. These profile bodies are capped at 64 KiB.

Checkout location IDs must belong to the signed-in business. New clients send the reviewed selected ID and customer version, including collection orders; legacy omitted IDs use primary. A saved order snapshots the chosen location and retains its original result on an exact retry after location changes/removal. An altered location ID with the same request UUID remains a conflict.

`GET /api/admin/wholesale/orders/print?status=<New|Preparing|…>[,…]` returns `{orders, printedAt}`: full admin views of customer orders (no staff previews, no removed orders) with those statuses, oldest first, up to 500; `?ids=<id>,…` (up to 200) returns exactly those orders, previews included, in the order given. Admin-only; used for packing sheets and bag totals.

`GET /api/admin/wholesale/order-emails` returns `{enabled,to,version,updatedAt,sending,from}`; `PUT` takes `{ifVersion,enabled,to:[up to 5 emails]}` (409 `conflict` on a stale version); `POST order-emails/test` sends a sample to each address (409 `email_off` without a Resend key). Admin-only. A new customer order emails those addresses after it's saved.

## Wholesale invoices

All `/api/admin/wholesale/` invoice routes are admin-only with the existing Origin/write-rate guards. `GET/PUT invoice-settings` reads/saves `{ifVersion,...settings}` and returns `{settings,version,updatedAt,ready,reasons}`. `PUT invoice-settings/customers` `{ifVersion,enabled}` switches invoices on or off for customers (`settings.customersSeeInvoices`, absent = on; a full settings save keeps it): while off, every customer invoice route answers 403 `invoices_unavailable`, customer order lists omit `invoice` links and the customer session/catalogue carry `invoices:false`. Settings include `seller`, `priceBasis`, `vatRates:[{id,label,basisPoints}]`, defaults, `invoicePrefix`, `firstInvoiceNumber`, `paymentInstructions` and `confirmed`. Incomplete drafts are allowed; issuing requires ready settings.

`GET orders/<WS-id>/invoice` recovers an issued invoice. `POST orders/<WS-id>/invoice/preview` calculates a draft and `/preview/pdf` renders a marked draft; neither allocates a number. `POST orders/<WS-id>/invoice` explicitly issues one immutable invoice. Bodies carry `{orderVersion,settingsVersion,invoiceDate,supplyDate,billTo?,deliveryCharge?,lineVatRateIds?,paymentInstructions?,dueDate?}`. Saved order quantities/prices are fixed; VAT and totals are calculated server-side in integer pence. Net-term due dates are calculated from the invoice date. Orders payable before dispatch are due on the invoice date. Both fixed rules reject conflicting overrides. Other terms can carry an explicit due date. Exact normalized retries recover the existing invoice before current-source validation, while changed requests conflict. Staff previews, deleted or cancelled source orders cannot create a new invoice.

`GET invoices?cursor=<seq>` returns `{invoices,nextCursor,count,summary}` with up to 200 records and full-scope outstanding/overdue totals. `GET invoices/<seq>` and `/pdf` return an issued document. `PATCH invoices/<seq>/payment` accepts `{ifVersion,paid,paidDate?,reference?}`, updates payment metadata atomically and audits it; it performs no bank transaction.

Customer `GET /api/wholesale/invoices`, `GET .../invoices/<seq>[/pdf]` and `GET .../orders/<WS-id>/invoice[/pdf]` are read-only and always constrained by the signed-in business. Other businesses receive 404; staff preview identities have no customer-invoice access. Issued invoices remain visible after source-order deletion. Order history also includes issued invoice IDs/numbers.

Catalogue `grindOptions` is optional for backward compatibility; omission preserves current options or the legacy defaults on creation. Validate 1–20 unique IDs/names, labels 1–60 characters, boolean `enabled`, and at least one enabled option. IDs are legacy grind IDs or `grind-<uuid>`. Renamed existing options receive a new server-generated ID. Image updates preserve grind settings. Catalogue/session DTOs expose options for the customer picker; customer writes cannot change them. Checkout validates the selected enabled option for its product and saves the server-controlled label. A retired/disabled/foreign grind returns 409 `grind_unavailable`; an exact successful order retry still returns its immutable original receipt before current catalogue validation.


## QuickBooks Online

Management routes below are under `/api/admin/wholesale/quickbooks` and require a current admin staff session with existing identity, Origin and write-limit guards. `?environment=sandbox|production` scopes connections/mappings/exports and defaults to **sandbox** for old clients. Provider authorization failures return 409 for reconnect without ending staff sign-in. No arbitrary provider URL/query/write proxy exists.

| Method and suffix | Behaviour |
|---|---|
| `GET /app-settings` | Admin-only client ID, credential-presence/source flags, app/connection versions, encryption readiness and copyable callback/webhook URLs. Never returns a client secret, verifier token, ciphertext or encryption key. |
| `PUT /app-settings` | `{ifVersion,connectionVersion,reviewed:true,clientId?,clientSecret?,webhookToken?,clearWebhook?,reset?}`. Blank secrets retain values; `clearWebhook:true` disables notifications, `reset:true` removes overrides. Requires hosting encryption key for stored values, atomic CAS, disconnect before auth credential changes, OAuth invalidation and fresh Live review. |
| `GET /status` | Selected environment/configuration/missing names, safe company/version, active environment/mode version, Live checks, queue/reconciliation health and capabilities. |
| `POST /connect` | Begins hashed single-use ten-minute OAuth state tied to environment/admin/session/connection version; returns fixed Intuit consent URL. |
| `GET /callback` | Consumes `state,code,realmId` for its **saved** environment; validates same admin/session/version, UK/GBP, encrypts tokens, pending company confirmation. Redirects native review with `qbEnvironment`; cancelled consent is handled without changing active mode. |
| `POST /confirm` | `{ifVersion,vatNumber,confirmed:true}` confirms the returned UK/GBP company and admin-reviewed supplier VAT number. |
| `POST /disconnect` | `{ifVersion}` clears local credentials/nonces, attempts provider revocation; returns `disconnected,revoked`. |
| `GET /references?kind=customer|item|taxcode|term&cursor=` | At most 100 active minimal references/page with `nextCursor`; no provider addresses/notes/emails. |
| `GET /mappings` | Scoped data, mapping/connection versions, environment/realm. |
| `PUT /mappings` | `{ifVersion,connectionVersion,customer?:{localId,quickbooksId},coffeeItemId,deliveryItemId,taxMappings:[{rateId,basisPoints,taxCodeId}],term?:{localId,quickbooksId},reviewed:true}`. Revalidates active GBP customer, Service/NonInventory items and Income/OtherIncome accounts, VAT treatment and net-period terms; CAS update. Empty term ref clears it. |
| `GET /invoices/<seq>/preview` | Revalidates issued snapshot/references and returns `{preview,exportReady,exportReasons,connectionVersion,mappingVersion,modeVersion}`. Preview always has `canTransmit:false`; separate readiness includes active-mode/Live-profile gates. |
| `POST /invoices/<seq>/export` | `{fingerprint,connectionVersion,mappingVersion,modeVersion,reviewed:true,paidInvoiceConfirmed?:true,paidInvoiceVersion?:number}`. Atomically stores or reuses frozen operation, then acknowledges durably before processing in a separate invocation. 202 pending or 200 existing linked; `{export}`. No payment/email side effect. |
| `GET /exports?invoiceId=&cursor=` | Up to 50 saved operations in selected environment, including original previous companies; stable descending ID cursor and `nextCursor`. |
| `GET /exports/<id>` | Scoped safe operation metadata and balance observation. |
| `GET /exports/<id>/review` | Operation plus the immutable original preview. For Live and automatic exports it also reports whether the website records payment and the version of the paid record. |
| `POST /exports/<id>/process` | `{}` starts a previously reviewed queued operation in a separate bounded invocation. Scheduled recovery handles a missed browser follow-up; no new request/body is created. |
| `POST /exports/<id>/retry` | `{ifVersion,modeVersion,reviewed:true,paidInvoiceConfirmed?:true,paidInvoiceVersion?:number}` reauthorizes the original company, request and body. Live and automatic exports need explicit payment confirmation on retry if the website records them as paid. Use the version returned by the review endpoint to confirm the current record. |
| `POST /exports/<id>/link-existing` | `{ifVersion,modeVersion,remoteId,reviewed:true}` explicitly adopts an exactly matching existing invoice. Does not establish successful Sandbox create evidence. |
| `POST /exports/<id>/refresh` | `{}` reads linked original-company Invoice and persists a revision-guarded payment observation; works for existing Live links while Sandbox is active. |
| `GET /readiness` | Live checklist/fingerprint/connection+mode versions, webhook configuration and approved/ready state. |
| `POST /approve-live` | `{ifVersion,connectionVersion,fingerprint,reviewed:true,attestations:{company:true,vat:true,rounding:true,payments:true,fees:true}}`. Requires successful Sandbox evidence and complete Production setup; approval does not activate Live. |
| `PUT /mode` | `{ifVersion,environment,reviewed:true}` chooses new-export environment. Live requires valid approval; active sends block switching. |
| `POST /refresh-payments` | `{}` coalesces an environment/company reconciliation request; returns 202. |

The service route `POST /api/quickbooks/webhook/sandbox|production` is public on the configured Admin host, outside staff authentication. It requires the corresponding verifier secret and valid `intuit-signature` HMAC-SHA256 of exact raw bytes. Size-bounded current CloudEvents arrays/legacy notifications are filtered to known environment/realm and Invoice/Payment entities, deduplicated and durably queued before acknowledgement. No raw financial/employee notification body is retained. Five-minute scheduled work reads authoritative records and uses CDC/owned-link sweeps to recover missed changes.

Live-linked invoice JSON keeps the issued snapshot and adds `payment.source:'quickbooks'`, `status:'unpaid'|'overdue'|'part-paid'|'paid'|'settled'|'review'|'voided'`, `paidPence`, `outstandingPence`, `checkedAt` and the verified `totalPence` and `dueDate` when available. `outstandingPence` is `null` for an unconfirmed balance. Customer summaries count these invoices in `reviewCount` and exclude their balances from outstanding amounts. Admin `reviewCount` also counts invoice detail and local payment discrepancies. `accounting.status` and `checkedAt` describe the saved observation. `accounting.invoiceChanged` marks a difference from the issued invoice, with `exportId`, `invoiceIssue` and `reason` available to Admin. A confirmed invoice void has zero outstanding and appears as voided on the PDF. `payment.hasVoidedPayment:true` identifies a confirmed reversal of a payment associated with the invoice. Owner scoping applies to lists, single invoices and PDFs. Customer APIs expose only Live observations. Local payment PATCH returns 409 when a Live create is in flight, its outcome is uncertain, or it has been linked. [QuickBooks integration](quickbooks-integration.md).

## Customer ordering hostname

`PREVIEW_HOST` is `strangerscoffee.trade`; `LEGACY_PREVIEW_HOST` retains `preview.staffstrangerscoffee.com` as a working ordering alias. Both serve only wholesale pages/data. On the separate customer domain staff auth, diary, rota and admin APIs return 404, and staff cookies never authorize wholesale access. Wholesale host-only sessions require a fresh sign-in on a new hostname; existing accounts/data stay in the same D1 database. Origin-local baskets and uncertain submissions remain recoverable on the old address. Staff sign-in returns to the legacy preview on the shared staff cookie domain. Admin and QuickBooks callback/webhook addresses remain unchanged.

## Fast, protected page startup

`GET /api/auth/me` accepts `x-sc-session-check: 1` for the shared identity guard. After the usual session authorization it returns only current `user:{id,role}` (or `null`) and the non-secret shared cookie domain; it omits setup counts, PIN/device checks and notification data. It is always `no-store` and never sets session/device cookies. Normal bootstrap replies retain their existing fields and include app `links`, removing Admin’s separate links request.

`SC.startSession({clear})` shares startup and retries interrupted bootstrap/proof requests without abandoning initialization. The first profile reply remains provisional: fresh asynchronous verification must complete before private rendering or queue loading. Every focus/restore/auth event still invalidates the proof generation immediately; same-turn activation bursts defer the network check until the burst ends. Stale replies cannot unlock a different account or role. Late protected body readers can reuse a successful current verification instead of forcing another identical request. Invalidations and unfinished sign-out keep the shield in place and clear private state; existing per-owner queues remain quarantined.


New wholesale order lines include server-derived `grindHint` and `decaf` snapshots alongside existing saved labels. These optional presentation fields do not alter request hashing, quote validation, totals or old records. Clients cannot override them. Catalogue changes never rewrite an existing line or exact checkout retry.

## Staff wholesale orders

Only the diary hostname serves `/orders` and `/api/staff-orders/*`. Existing staff authentication is required; wholesale customer sessions are not accepted. Admins inherit access and staff/managers require an enabled stable-ID grant. Normal `/api/auth/me` adds `capabilities.staffOrders` for the current authenticated employee; the compact session-proof and anonymous response shapes stay unchanged. The capability controls navigation only.

Admin-only `GET /api/admin/users/<id>/orders-access` returns `{userId,enabled,version,inherited}`; `PUT` accepts `{enabled:boolean,ifVersion}` and returns the new version. Missing grants are version 0. Stale writes return 409. Admin-role inherited access is read-only. Grants/revocations are audited; the normal Origin, write limit and expected-identity checks apply.

`GET /api/staff-orders/orders?status=open&q=&cursor=` returns `{orders,count,nextCursor}` with 100 records per page, newest update first and ID tie-breaks. Status is `open` (New/Preparing/Ready, default), `prepare` (New/Preparing), `all` or a saved status. Search is at most 120 characters and literal wildcard characters are escaped. Filtering, exclusion of previews/tombstones and total counts happen before paging. Every response is no-store, bound to the expected staff identity and rechecks the capability before release.

`PATCH /api/staff-orders/orders/<WS-id>` takes `{ifVersion,status,note,trackingUrl}` and returns `{order}` (the staff view): the same version-checked update as Admin (409 `conflict` on a stale version, 404 for previews or removed orders). `GET /api/staff-orders/print?status=New[,Preparing…]` or `?ids=` returns `{orders,printedAt}` (customer orders only, staff view, no prices). `GET /api/staff-orders/customers?q=` returns `{customers,more}`: `{id,business,contact,email,phone,status,locations[{id,name,contact,phone,address,postcode,deliveryNotes}],defaultLocationId}` sorted by business, up to 500; search matches business, contact or postcode. All require the wholesale orders grant, rechecked before the response; other methods answer 405.

Each row includes order ID, approved business name, location name, received time, reference, status, fulfilment preference/address/postcode/instructions, customer comment, safe tracking URL, bag/weight totals, saved preparation lines, and `account:{overdue,review}`. It excludes money, invoice documents, customer contacts, employee attribution and internal customer notes. Granted staff can read and update an internal order note. Account warnings use server UK dates and Live observations, never Sandbox. The page holds no persisted order data or offline queue, hides immediately on blur/restore and clears on denial/identity change.

Admin and staff order lists accept `dispatch=all|today|upcoming` (London dates) and `sort=updated|dispatch|dispatch-desc|bags|bags-asc`. Reload from page one when changing the sort. Unscheduled orders sort last by dispatch date. Admin also supports `status=open` for real New, Preparing and Ready orders.

Both role-specific order APIs accept `PATCH orders/<WS-id>/packing {ifVersion,line,packed}`. The zero-based line index refers to the saved order at that version. Only real orders in Preparing accept changes. Packing checks stay private to Admin and granted staff. Checklist-driven status updates include `requirePacked:true` when moving from Preparing to Ready. Changing the bags clears the checks and sends a Ready order back to Preparing. New standing deliveries start unchecked. `GET orders/packing-totals` under Admin and `GET packing-totals` under Staff return `{remaining,packed}`, grouped by saved product, weight and grind across open orders, with the optional dispatch filter. Neither response contains prices or customer identifiers.

## Customer identity and external access safeguards

Customer ordering uses `SC.startSession({scope:"wholesale",clear})` with `/api/wholesale/session` as its profile and proof endpoint. `x-sc-session-check:1` returns only `user:{id,role}` (plus the shared cookie domain for staff previews), never business details or a new cookie. Ordering requests bind `x-expected-ordering-id`/`x-expected-ordering-role` to the page identity; mismatches return 409 `session_changed` before customer data reads/writes or logout. These headers add a stale-page guard and never establish authentication themselves.

Writes and live connections accept only exact current/configured app origins. Private API/download responses prohibit cross-origin embedding, and authenticated PDFs/uploaded catalogue images are no-store. The shared verification shield is a native modal so private dialogs cannot block Retry. See [security review](security-privacy-review-2026-11-13.md) for scope, encryption and remaining administrative checks.


## Holiday management (`/api/rota/leave/…`)

- `GET dashboard[?userId=]`: employee’s own leave years, balances and absence history; another employee requires admin.
- `GET calendar?from=&to=`: authenticated staff; at most 93 days of approved annual-leave names/dates and generic blocking labels. No private employee records or other absence types.
- `GET requests/:id`: owner/admin-only absence, affected balances and own assigned-shift conflicts; another employee gets a nonrevealing missing record.
- `POST preview`, `POST requests`: own annual/unpaid requests; admin may target an active employee and record sick/unauthorised absence or mark a record approved. Creation needs a request key and exact reviewed annual charges.
- `PATCH requests/:id`: owner cancellation subject to historical/type restrictions; admin approval/decline/cancellation. A record version is required.
- `GET admin`, `PUT settings`, `PUT allowances`: admin-only setup and versioned policy/employee-year updates.
- `POST credits`, `POST credits/reverse`: admin-only, versioned worked-bank-holiday release or audited correction; no duplicate active release for a date.
- `POST blocks`, `DELETE blocks/:id`: admin-only scoped blackout dates with version checks on removal.
- `PATCH requests/:id/classify`: admin-only explicit legacy reconciliation, including an opening-used coverage flag when appropriate.
- `GET events?userId=`: admin-only transactional history.
- `GET bank-holidays?from=&to=`: admin-only optional England/Wales public date lookup; fixed GOV.UK source, no employee data sent. Failure preserves the manual setup form.

Every mutation uses the existing authentication/identity/origin/rate-limit boundary. Atomic revision checks cover legacy and new time-off writers, budgets and capacity. Conflicts require review rather than overwriting another decision. See [leave management](leave-management.md) for policy semantics and onboarding.

Custom catalogue records may set `customerOnly: true` alongside the existing `whiteLabel` customer-ID allowlist. This marker keeps a custom coffee private when its allowlist is empty. Legacy nonempty allowlists remain private automatically. Admin writes validate the boolean, customer IDs and record version; omitted visibility preserves private access, including for legacy nonempty allowlists. New allowlists automatically set the private marker. Explicit `customerOnly: false` with an empty allowlist returns it to the general range. Customer responses omit both visibility metadata and recipes; only authorised coffees carry `yours: true`. Catalogue, new-order validation and uploaded-photo access use the same restriction. Historical order snapshots retain their original details.

### Daily Admin overview

Admin-only `GET /api/admin/overview` retains its existing fields and adds `daily`: server `asOf`, real customer order aggregates, invoice overdue/review summary, pending account/annual/other-absence/shift counts, approved annual-leave people on next Monday, current site deadlines, operational alerts and next-week publication summary. No private data moves to public assets or nonadmin endpoints. `GET /api/admin/wholesale/orders?queue=prepare|ready` uses the existing keyset pagination/search with real-customer and nondeleted-record filters, applied before counting and paging. This read-only filter never updates order status.

### Forecast diagnostics

Existing admin-only Insights responses retain `forecast.total` and `forecast.byCoffee` with integer-gram week points and add `model`, `modelLabel`, `validation` (`samples`, `origins`, `maeGrams`, signed `biasGrams`) and `rangeBasis` (`backtest` or `limited`). Positive bias means recorded demand exceeded the historical prediction. Diagnostics describe bounded rolling-origin checks of the forecasting process, not promised future accuracy. Internal historical trials are not returned. Customer-filtered Insights use only that customer's sales for models, calibration and totals, while the existing admin customer picker remains available.

### Production audit corrections

`GET /wholesale/catalogue.js` and its legacy alias remain module-compatible but use the authenticated customer's current filtered catalogue. Customer recipe/allowlist fields remain excluded; source image reads apply the same scope and no-store.

`PUT /api/rota/shifts/<id>/actual` requires the reviewed `ifUpdatedAt` for amendments and `{clear:true}`; missing/stale revisions return 409, with atomic checks and a strictly advanced `updatedAt`. Role/privacy checks remain first. Sickness amendments/removal also advance the revision. Monthly payroll allocates weekly overtime onto actual shift dates before month filtering. CSV consumers receive safe text cells and unchanged numeric values.

`GET /api/staff-orders/orders/<WS-id>/receipt` requires current wholesale staff access and matching immutable `createdBy`; other creators get 404. It returns only the existing unpriced staff projection, or 410 for an owned deleted record. It never creates an order. Frozen pending submissions are retained per original staff identity and UUID, not replayed automatically.

Order bag changes and standing skips atomically check the reviewed order revision and invoice absence. Standing parent/child rollover is atomic; the five-minute cron provides bounded recovery for missing next runs. Existing next rows, including tombstones, remain authoritative. Roast rows add `backlogGrams`, `committedGrams` and `additionalForecastGrams`; `forecastGrams` remains the model total, and `neededGrams` reconciles committed demand. `roast.laterGrams` reports excluded later dispatches.

`POST /api/staff-orders/attempts/<WS-id>/close {customerId}` requires current staff wholesale access. It atomically inserts a hidden tombstone only if that ID has no order. A concurrent original order either wins and is returned unpriced to its creator, or loses to the closure and cannot be created later. It returns `{closed:true}` or `{closed:false,order}`; another creator gets 404. It never cancels an existing order, sends a notification or consumes an invoice number. The client requires explicit inline confirmation before using it and retains pending work until the result is verified.

## Notification recovery and reviewed fulfilment batches

Admin-only `GET /api/admin/wholesale/order-emails` adds `delivery:{email,slack,legacyDispatch}`. Each channel has `pending`, `failed`, `unknown` counts; legacy dispatch failures include only order ID/business for review, never outgoing credentials. `POST .../order-emails/email-retry` and `.../slack-retry` accept `{acknowledgeUnknown?:boolean}`: false retries known failures; true explicitly retries uncertain deliveries after checking for duplicates. An unknown-only ordinary retry returns 409 `delivery_unknown`. `POST .../order-emails/legacy-retry` requires `{orderId,acknowledgeUnknown:true}` and an eligible audit-log failure, a currently dispatched real order, and no existing outbox event. Responses return the queued count and refreshed delivery summary. Staff/customers cannot call these endpoints.

Wholesale admin list responses include at most twenty `standingIssues` entries (ID, business, total count). Customers receive only a generic issue on their own historical run. Correct eligibility and save a closed standing order to retry, or disable its repeat schedule. Cron repair is bounded and backs blocked runs off, without recreating tombstones.

Staff/admin batch actions retain the original reviewed versions; a live refresh cannot rebase a pending write onto a newer order. Success requires a matching order ID, requested status and advancing version. Uncertain or conflicted results remain selected for verification. Session invalidation cancels the operation and clears sensitive data. A local operation token survives clearing safely. Existing intentional single-order status corrections remain available.

Binary PDF and catalogue photo requests enforce their existing limits while streaming, including omitted or inaccurate Content-Length. Oversized bodies are cancelled before KV storage.

Admin static JS/CSS and shared helper code can load without a session so cached pages can verify identity. These routes return code with correct MIME/cache headers, never sign-in HTML. Admin page/data/image authorization remains unchanged. The dependency bootstrap preserves source fingerprints and downloads Admin scripts in parallel before executing them in dependency order. It retries a failed network resource once and waits at most eight seconds per preload. A core failure leaves a persistent reload action. Optional feature failures are recorded in error reporting and show reload actions in the affected views.

Each deployment retains up to 16 distinct browser releases from recent main history. Wholesale sign-in reloads once if a required script or stylesheet fails before someone starts using the form. A persistent failure still shows its usual error card with the reload option.

## Email delivery feedback

`GET /api/admin/wholesale/order-emails/delivery` returns at most 50 accepted message metadata rows, derived delivery states, at most 50 active suppressions, feedback readiness and public setup instructions. `GET .../delivery/dns` performs read-only DNS checks for configured sender domains using a fixed resolver and bounded responses/timeouts; it is admin-only. No key or email body is returned.

`POST /api/email/resend-webhook` is available on Admin's host (local dev: the local host). It requires RESEND_WEBHOOK_SECRET and validates the exact raw body, svix-id, svix-timestamp and v1 signatures before touching D1. Unknown event types and unrelated senders are ignored. Valid events are recorded idempotently with minimal recipient metadata; their own timestamps govern suppression state. Duplicate event IDs cannot mutate state through altered payloads. Non-POST returns 405; invalid signatures/freshness return 400; unconfigured feedback returns 503; an oversized body returns 413. No browser session substitutes for a webhook signature.

A provider acknowledgement remains distinct from delivery. A delivered callback means acceptance by the recipient mail server, not proof of inbox placement. Newly recorded hard bounces/complaints/suppression block further sends and stop automatic dispatch retries, while existing provider suppression remains in force. No automatic real-world test messages are sent.

## Wholesale Royal Mail labels

The Admin Labels tab at `#wholesale/royal-mail/labels` reads `GET /api/admin/wholesale/royal-mail/labels`. The optional `search`, `status`, `limit` and `cursor` parameters scope an ordered page of recorded bookings. Following `nextCursor` preserves the current search and status. The list response contains order and tracking metadata. Carrier PDFs are fetched only for individual orders.

An admin can preview the original document through `GET /api/admin/wholesale/orders/:id/shipping/label?preview=1`. A successful preview is served inline with `no-store` and leaves the first download time unchanged. Print and Download use the existing label route without the preview flag. Both paths verify the booking identity in the active Click & Drop account and recheck the order before releasing the PDF. None creates a shipment.

The browser loads Mozilla PDF.js 6.5.438 from same-origin release assets when a label is opened. The browser and worker files are the legacy minified builds from `pdfjs-dist`, accompanied by its JBIG2 and OpenJPEG JavaScript fallbacks. Distribution notices are in `docs/licenses/royal-mail-label-pdf.txt`.
