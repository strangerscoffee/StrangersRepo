# Data model

The diary stores JSON documents at slash-separated paths, Firestore-style: an even number of segments is a document (`days/2026-10-27`), an odd number is a collection (`days`, `sites/cafe/days`).

## Where each site's data lives

| Site | Path prefix | Example |
|---|---|---|
| Roastery | *(none: top level)* | `days/2026-10-27` |
| Cafe | `sites/cafe/` | `sites/cafe/days/2026-10-27` |
| ASG | `sites/asg/` | `sites/asg/days/2026-10-27` |
| Factory | `sites/factory/` | `sites/factory/days/2026-10-27` |

The Roastery's records were recorded before sites existed, so they sit at the top level. **Keep it that way:** the page relies on it, and moving them would mean migrating every document.

## Allowed collections

Under each site prefix:

`settings` · `days` · `weeks` · `extras` · `cleaning` · `proveit` · `allergens` · `allergenDocs` · `suppliers` · `contacts` · `staff` · `reviews` · `plans` · `onboarding` · `inspections` · `deliveries` · `maintenance`

Plus two single documents: `config/shared` (the shared setup, below) and `config/people` (read-only: names for people who recorded in the earlier Claude version of the diary, see below).

Reject any other path with `invalid_argument`. The types of the fields below are checked on every write (`src/validate.ts`, 400 `invalid_data`); keep it in step when a field is added or changes type.

## D1 table

`src/schema.ts` creates it (with the `users`, `secrets`, `meta` and `rate_limits` tables for accounts, sessions, change tracking and rate limiting). `meta` holds the change counters: `seq` (every diary write; also each document's version), `rota` and `accounts` (for `GET /api/changes`, docs/runtime-api.md). `rate_limits` keys are an IP address, `login:<ip>` or `user:<id>`:

```sql
CREATE TABLE docs (
  path        TEXT PRIMARY KEY,           -- e.g. 'sites/cafe/days/2026-10-27'
  collection  TEXT NOT NULL,              -- e.g. 'sites/cafe/days'
  doc_id      TEXT NOT NULL,              -- e.g. '2026-10-27'
  data        TEXT,                       -- JSON; NULL when deleted
  updated_at  INTEGER NOT NULL,           -- ms since epoch
  source      TEXT NOT NULL,              -- 'web'; 'claude' on rows copied from the earlier Claude diary
  deleted     INTEGER NOT NULL DEFAULT 0, -- deletes are kept as rows so live polling sees them
  claude_data TEXT,                       -- unused (left from the Claude sync)
  seq         INTEGER NOT NULL DEFAULT 0, -- change counter for live polling
  employee_privacy_version INTEGER,       -- trusted only when equal to this row’s seq
  updated_by  TEXT                        -- 'web:<name>'
);
```

Queries the page makes: one document by path; a whole collection; a collection ordered by one field and limited (`days` by `date` desc, `weeks` by `week` desc, `reviews` by `date` desc, `proveit` by `at` desc). Ordering on a JSON field with `json_extract(data,'$.date')` is fine at this size (hundreds of documents per collection).

## Documents

Timestamps (`at`, `lastAt`, `createdAt`, `updatedAt`) are ms since epoch. Dates are `YYYY-MM-DD` strings. `by` fields are user ids: `web:<name>` (the signed-in person's display name), or `u_…` on older records made in the Claude version of the diary, whose names are in `config/people`. These historical attribution IDs are never employee ownership or authorization keys; private records use stable `users.id` values.

**`settings/main`**, one per site: the site's setup.
```
units:[{id,name,kind:"fridge"|"freezer"}]
opening|closing|weekly:[{id,t,off?:true,from?}]     // checks; off = turned off at this site; from = YYYY-MM-DD it counts from
closedDays:[0..6]   // 0 = Sunday
hide:{<tab>:true}   // sections not used at this site
proveOff:[<method>]  trainingOff:[<topic>]  allergenSections?  info:{address,manager,note}  startDate  startSet?
updatedBy, updatedAt, publishedAt?, publishedFrom?
```
A check's `from` is the day it was added (saved in Setup, or published to the site) or switched back on. Days before it don't include that check, so adding checks never makes past days incomplete. Checks without `from` have always applied. End-of-week checks count from the week that contains their `from` date.

`startDate` (YYYY-MM-DD) is the first day the diary counts at the site. It is filled in with the date Setup is first saved; then empty earlier days are never counted as missed. `startSet: true` means someone chose it in Setup → Diary starts on (optionally for all four sites): every day before it is left out of Last 4 weeks and EHO inspection mode, though the records stay in the database and can still be opened by date. Cleaning and extra checks have their own `lastAt` dates and are not affected.


**`days/<YYYY-MM-DD>`**: one diary page. A temperature reading `temps.<unit>.am` is `{v, by, at}`; when it is added later or changed from Records → Temperature log it also has `note`, `late: true` (added after the day) or `amended: true`, and `was: {v, by, at}` (the first value); a removed reading keeps `was` with `v: null`.
```
date
temps:{<unitId>:{am:{v,by,at}}}
opening|closing:{items:{<checkId>:bool}, by, at, allDone?:{by,at}}
problems:{text,by,at}
closed:{reason,by,at}        // closed outside the usual opening days (holiday, maintenance, unexpected): never counted as incomplete; null when reopened. Staff may set it only on today's page, with their own by and a reason; only managers and admins reopen a day or close an earlier one
signed:{by,at,name}          // name = the signed-in person's name (older entries may lack it); only managers and admins set it back to null (undo)
```
A `set` on a day page that already exists merges into it like an `update` (so a page another device created first keeps its checks). Staff can't delete day or week pages or reviews, and a `signed` block a staff member writes must be in their own name, both `by` and `name` (unless it's the one already there). Staff can't clear a whole section of a day or week (a top-level key set to `null`, other than `signed` and `closed`, which have their own rules), can't change a review someone else signed (`by`), and record training dates (`topics.<id>.by`) on their own staff record in their own name only.

The page writes these with nested `update`s such as `{temps:{u1:{am:{v:3.2,by,at}}}}`, which must merge deeply (see `runtime-api.md`).

**`weeks/<Monday YYYY-MM-DD>`**: `week, items:{<checkId>:bool}, by, at, notes:{text,by,at}, signed:{by,at,name}`

**`extras/<id>`**, **`cleaning/<id>`**: `name, how, freq ("after use"|"daily"|"weekly"|"fortnightly"|"monthly"|"quarterly"|"six-monthly"|"yearly"), who, createdAt, lastAt?, lastBy?, lastSet?, log:[{at,by,note,set?}] (newest first, max 30), importedAt?, importedFrom?`

`lastSet: true` (and `set: true` on its log entry) means the last-done date was entered by hand ("Last done on" → Save date) rather than ticked off at the time: `lastAt` is then midday on that date (or the moment it was saved, if it was today) and the page shows it as a date only. `lastBy` is whoever entered it. Ticking the task done sets `lastSet: false`.

**`deliveries/<id>`**: `date (YYYY-MM-DD), at, supplier, supplierId (suppliers/<id> at that site, or null if typed), items, chilled (°C or null), frozen (°C or null), noTemp, packaging ("ok"|"no"), order ("ok"|"no"), outcome ("accepted"|"rejected"), note, by`. Chilled passes at 8°C or below (5°C ideal), frozen at −15°C or below (−18°C ideal). A rejection, or accepting despite a failed check, needs a `note`. Staff can write.

**`maintenance/<id>`**: `title, area, details, priority ("urgent"|"soon"|"later"), status ("open"|"done"), assignee? ("web:<name>" or null), assigneeName?, reportedBy, reportedAt, at, doneBy?, doneAt?, fixNote?, log:[{at,by,what:"Done"|"Reopened"|"Assigned to <name>"|"Unassigned",note}]` (newest first, max 30). The people to assign come from `user.team()` (everyone with an account). Staff can write. Maintenance → All sites reads every site's collection.

**`proveit/<id>`**: `date, method, food, reading, unit, pass, action, by, at`

**`allergens/<id>`**: `name, source, contains:[allergen names], notes, kind? ("drink"|"food"), by, at, importedFrom?`. When a site separates allergens into Drinks and Food (settings `allergenSections`; on by default at the Cafe), `kind` puts the item in a section; items without one are drinks.

**`allergenDocs/<id>`**: `title, note, fileName, assetId, size, by, at`. `assetId` is the PDF's key in the KV namespace (`FILES`), served at `/_blob/<assetId>`. No longer uploaded: the allergen matrix PDF is generated on the device from `allergens`. PDFs uploaded before are still listed (Open, Remove) until removed.

**`suppliers/<id>`**: `name, supplies, contact, phone, email, address, rating, notes, by, at`

**`contacts/<id>`**: `type, name, person, phone, outOfHours, email, account, notes, by, at, visibility ("shared-business"|"employee"), ownerUserId?`. An admin must explicitly classify a shared business contact or select the stable employee account for a private contact. Classification is not inferred from its text/type/name.

**Saved to several sites.** Documents in `extras`, `cleaning`, `plans`, `suppliers`, `contacts`, `onboarding`, `allergens` and `allergenDocs` may also carry `linkId` (the same on every copy) and `sites:[siteIds]` (where it was last sent). Saving with sites ticked writes a copy at each one: the copy with the same `linkId` is replaced (for `extras` and `cleaning` only the item's own fields are updated, so each site keeps its own `lastAt`, `lastBy` and `log`); otherwise a new one is added. Suppliers, contacts, allergen items and tasks saved before linking are matched by name; HACCP & risk, onboarding documents and allergen PDFs only by `linkId`. Protected contact/onboarding copies must preserve their validated classification and stable owner; name matching is not ownership proof and must not link private records to a different employee. Removing deletes the copy at the current site only. Allergen PDF copies share one `assetId`; the stored file is deleted once no site's `allergenDocs` refers to it.

**`staff/<id>`**: `name, role, start, topics:{<topic>:{date,by}}, notes, personId, ownerUserId, sites:[siteIds], signed?:{by,name,at,topics}, at`. `ownerUserId` is a stable `users.id`; `personId`, display name and signatures do not grant access.

Records → Staff training. Admins manage all records and link ownership. Staff and managers can read or maintain only their own verified record; they cannot transfer ownership. Nonadmins cannot delete their training record. `sites` copies the record to the ticked sites, preserving stable ownership. `signed` confirms the employee’s own dates; its `topics` is the dated topics as sorted `key=YYYY-MM-DD` pairs, so it becomes invalid when those dates change. Admin inspection packs include all training; other employees’ screens/PDFs contain only their own linked records and no workforce training counts.

Training topics (`<topic>`): `hygiene`, `cross`, `cleaning`, `chilling`, `cooking`, `allergens`, `diary`, `l2`. A site's `trainingOff` (set from Staff training → Topics for this site) lists the topics it doesn't use: they're hidden there and not counted as training to do, and any dates already in `topics` are kept.

**`reviews/<YYYY-MM-DD>`**: `date, answers:{<q>:{a:"Yes"|"No", d}}, notes, by, at`. Anyone can sign it (Records → 4-weekly review); when it's overdue, Today shows a reminder that opens it. The questions and their keys are `REVIEW_QS` in `public/diary/core.js`, following the SFBB 4-weekly review page; each says which answer needs noting (most a "Yes", the "have you done it" ones a "No"), which is what the review history and the inspection PDF list. Keys are stored with old answers, so never rename or reuse one; new questions only need answering on new reviews.

**`plans/<id>`** (HACCP plans and risk assessments): `type:"haccp"|"risk", title, …metadata, steps[] or rows[], notes, source, createdBy, createdAt, updatedBy, updatedAt, history[]`

**`onboarding/<id>`**: `category, title, audience, owner, date, reviewDate, summary, sections:[{heading,body}], notes, source, created…/updated…, history[], visibility ("shared-business"|"employee"), ownerUserId?`. `owner` is descriptive text, not authorization; private onboarding requires a stable `ownerUserId`. Admins explicitly classify shared business guidance or employee-private records.

**`inspections/<id>`** (EHO): `inspectionDate, inspector, authority, visitType, rating, scores:{hygiene,structure,management}, revisitDate, summary, goodPoints[], issues:[{id,issue,area,priority,action,deadline,ref,done,doneBy,doneAt,fixNote}], notes, source, created…/updated…, history[]`

**`config/shared`**: the last published shared setup: `opening, closing, weekly, from, to[], by, at`.

**`config/people`**: `{ "u_…": "<name>" }`, names for the `u_…` ids on older records. Read-only.

## Employee ownership and verification

Only admins or the individual employee may access employee-private data. The manager role grants business management, never access to another employee’s hours, contracts, availability, leave, reasons, private contact/training/onboarding or request details. Full rota planning, assignments, actual-hour amendments and employee exports are admin-only.

Protected collections are `staff`, `contacts` and `onboarding` under every site prefix. A nonadmin read requires server-verified metadata: `employee_privacy_version === seq`. Verified training additionally requires `data.ownerUserId === user.id`. Contacts/onboarding allow either `visibility: "shared-business"` or `visibility: "employee"` with matching `ownerUserId`. Unclassified or unverified legacy rows remain admin-only, even if their old JSON contains plausible ownership/classification fields. Admin responses clear unverified claims so the editor requests an explicit review/link; names never establish ownership.

Only validated writes stamp `employee_privacy_version` to the new row version. Filtering occurs before query ordering/limits and applies to get, query, poll, delta requests and conflict responses. Nonadmin protected polls return complete authorized snapshots, including when the change counter is unchanged, so reassignment removes stale rows. A denied direct read is a nonrevealing missing document; unauthorized writes cannot disclose a current record in a conflict.

Migration 14 adds the verification column, increments `meta.seq` and every `users.session_ver` once, in the same atomic migration claim. This invalidates all old staff sessions/trusted quick-switch devices and requires password sign-in. It does not delete password/PIN hashes, diary/rota data or client queues. `GET /api/auth/me` is read-only.

## The rota's tables

The staff rota (`src/rota/`, at `ROTA_HOST`) uses separate D1 tables. Only admins administer employee planning/private records; staff and managers see their own assigned published shifts and their own employee information. Managers may manage business site opening hours/minimum cover. People are stable `users.id` values; names are labels. Days are `YYYY-MM-DD`, times `HH:MM` UK local time and weeks begin on Monday.

| Table | Columns |
|---|---|
| `rota_shifts` | `id, site (roastery\|cafe\|asg\|factory), day, start, end (after start, same day), break_mins (unpaid, 0–180), job ('opens'\|'closes'\|''), user_id (NULL = open shift), note, updated_at, updated_by, actual_start, actual_end, actual_break (as worked when amended on the day; NULL = as planned), adjust_note (why), adjusted_by, adjusted_at` |
| `rota_weeks` | `week (Monday), published_at (NULL = draft), published_by, changed_at, changes (shift changes since it was last published), emailed (JSON: what each person was last emailed about the week, {people:{<userId>:[{id,day,start,end,site,job,hours}]}, open:[shiftIds]}; NULL until first emailed)` |
| `rota_sites` | `site, opens_at, closes_at (the usual hours; NULL = not set), min_people (default 1), day_hours (JSON {"sat"\|"sun"\|…: {"opensAt","closesAt"}}: weekdays with their own hours)` |
| `rota_people` | `user_id, contract_min, contract_max (contracted hours a week, a range; NULL = none; hours over the max are overtime), contract_hours (kept equal to contract_max for older pages), sites (JSON site ids they can get to; [] = any), pattern (JSON {"mon":"any"\|"off"\|{"from","to"}, …}; a missing day = any), updated_at` |
| `rota_time_off` | `id, user_id, from_day, to_day (inclusive), reason, status ('requested'\|'approved'\|'declined'\|'cancelled'), decided_by, decided_at, created_at` |
| `rota_requests` | `id, kind ('claim' = take an open shift \| 'cover' = give my shift away), shift_id, from_user, to_user (cover: who's asked; NULL = anyone), taker, message, status ('open'\|'accepted'\|'approved'\|'declined'\|'cancelled'), decided_by, decided_at, created_at` |

The rota also reads two things from the diary's documents: a site is in use only once it has `settings/main`, and it's closed on the weekdays in `closedDays` and on any day whose `days/<date>` has `closed` (a closure). It doesn't check who is trained on the opening and closing checks: everyone is, and whoever is on shift does them.

## The audit log

`audit_log` (`src/schema.ts`, written by `src/audit.ts`): `id, at (ms), kind, actor (a name or NULL), text`. Kinds: `user_added`, `renamed`, `username_changed`, `role_changed`, `active_changed`, `password_reset`, `unlocked`, `signed_out`, `locked`, `signin_failed`, `backup`, `setup_copied`, `pins_reset`, `signed_out_all`, and for rota emails `email_sent`, `email_failed`, `email_unsubscribed`, `email_changed` (an admin set or removed someone's address), `email_weekly`, and `clock_off` (a device whose own clock was over 5 minutes out: who, which device and by how much; at most once a day per person; flagged on the Overview). The text is in words for the admin section ("Sam Patel made Priya Shah a manager"); it never holds a password, PIN or a typed username. Rows older than about 400 days are removed.

`admin_dismissed` (`src/schema.ts`, migration 10; `POST /api/admin/overview/dismiss {key}` in `src/adminView.ts`): `key, at (ms), by (a name)`, the Overview notices an admin has dismissed, for every admin. Keys: `errors` and `email_failed` (hidden until there's one newer than `at`), `clock:<audit_log id>` and `closed:<site>:<date>` (gone for good). Things still to do (an unpublished rota, a locked account, requests waiting) can't be dismissed. Rows older than 30 days are removed.

Admin-only backups (`src/backup.ts`) include every rota table under `rota`, stable account IDs, top-level `documentSequence` (`meta.seq`) and each document’s `seq` plus `employee_privacy_version`. Restore those fields together with the exact document data and account identities. Do not manufacture verification for old/missing metadata or restore a global counter below row sequences; legacy records remain admin-only until reviewed.

### The rota API (`/api/rota/…`)

Signed out gets 401 `unauthenticated`; writes count towards rate limits. Private employee administration requires `role: "admin"` (the rota’s historical `manager` capability flag now denotes this admin permission). Managers retain the separate `siteManager` business capability. Errors are `{code, message}`: `invalid_argument` (400), `permission_denied` (403), `not_found` (404) and `conflict` (409).

| Route | Who | What |
|---|---|---|
| `GET week?start=` | signed in | Admins receive the full planner. Staff/managers receive only their own person/assigned shifts in published weeks and scrubbed unassigned opportunities; never other employees’ contracts, leave, actual hours, notes or staffing aggregates. |
| `POST shifts`, `PATCH shifts/:id`, `DELETE shifts/:id` | admin | Assign/create/change/delete shifts, with optional `ifUpdatedAt` and `?with=problems`. Giving a shift to another employee clears predecessor notes and actual-hour metadata. |
| `PUT shifts/:id/actual` | admin | Amend actual times/break/reason or `{clear:true}`, retaining the plan. |
| `POST week/copy`, `POST week/publish` | admin | Copy `{from,to,replace?}` or publish `{week,email?}`. Publishing emails only permitted personal content and safe unassigned opportunities. |
| `GET week/emails?week=` | admin | Preview recipient counts/missing addresses for publication. |
| `GET mine?from=&to=` | signed in | Own published assignments, contract and weekly hours/overtime. `others` is empty for nonadmins. |
| `GET today?site=` | signed in | Admins receive the full published site day; staff/managers receive own shifts plus scrubbed unassigned opportunities. |
| `GET suggest?shift=`, `GET hours?start=` (`&format=csv`) | admin | Full candidate eligibility, private paid hours/contracts and employee/site aggregates. |
| `GET me` | signed in | Own contract, availability, leave, requests and email settings. `user.manager`/`admin` indicate private admin capability; `siteManager` indicates business settings permission. |
| `PUT me/emails` | signed in | Own subscriptions; managers/admins may also change their own business-summary `weekly` preference and `weeklySites`. |
| `PUT me/availability`, `PUT people/:userId` | admin | Set employee contracts, sites and availability. The older `contractHours` sets both min/max. |
| `POST time-off`, `PATCH time-off/:id` | owner/admin | Anyone asks for their own leave or cancels their own pending request; only admins create/manage another employee’s leave or approve/decline. |
| `GET requests` | signed in | Admins receive pending requests; others receive only their own involvement, without counterpart identities/messages or assigned-other shift snapshots. |
| `POST requests`, `PATCH requests/:id` | owner/admin | Nonadmins can create/cancel own general cover or claim an unassigned opportunity. Targeted/cross-person acceptance, decline and approval are admin-only; checked before conflict details are returned. |
| `GET open` | signed in | Suitable published unassigned opportunities, with former employee notes, actual data and identities removed. |
| `GET sites`, `PUT sites/:site` | signed in / manager or admin | Business opening hours, minimum cover and weekday `dayHours`. No employee fields. |
| `GET links` | signed in | App links `{rota,diary}`. |

The checks (`computeProblems` in `src/rota/problems.ts`): `open_shift`, `clash`, `time_off` and `closed` are errors; `short_cover` (against each day's own hours, counting who's actually there), `overtime` (over the max contracted hours) and `rest` (under 11 hours) are warnings; `break` (over 6 hours with under 20 minutes), `availability`, `seven_days` and `under_contract` (under the min contracted hours) are notes. They are private planning prompts for admins; publishing is allowed with problems. There's no check for who opens or closes a site: a shift's job (`opens`/`closes`) is optional, and only labels the shift and the diary's "who opens / who closes".


## Rota emails

Sent through Resend (`src/email/`) when the `RESEND_API_KEY` secret is set; without it nothing is sent. `users.email` is the address (admins set it: `PATCH /api/admin/users/<id> {email}`, `""` removes it) and `users.email_prefs` a JSON object of which emails the person gets: `published` (their week when it's published, on by default), `changed` (their shifts changed after publishing, on), `requests` (cover, pick-up and time-off decisions, on) and `open` (open shifts they're free for, off), and for managers and admins `weekly` (the Monday summary, on) with `weeklySites` (the sites it covers; all four when not set). Each email has a calendar file of the shifts (for a week), a link to the rota, and a signed one-tap unsubscribe link (`/email/unsubscribe?t=…`, no sign-in; opening it only asks). At most `EMAIL_DAILY_LIMIT` (100) a day. Each one sent or refused is logged in `audit_log` (Admin → Activity, "Rota emails"); failures in the last day are flagged on the Overview.

**The Monday summary** (`src/email/weekly.ts`): at 07:30 UK time on Mondays, each active manager/admin with an address and `weekly` enabled receives the selected sites’ business diary summary. Manager output excludes employee training counts, assigned rota hours/aggregates, leave and request names/dates/messages; admin output retains full planning/HR items. Personal emails and attached calendars contain only the recipient’s permitted assignments and contract; no co-worker names or personal account Reply-To are shared. Declined cover-taker notices omit another employee’s shift details. Own preferences/sites are changed through `PUT /api/rota/me/emails`; admins can change anyone’s preferences or send themselves a summary preview. Sending remains once weekly through `meta.weekly_sent`.

## Wholesale (legacy storage names retained)

Migration 11 adds a separate `wholesale_preview` table. It does not add any allowed diary document paths. Columns: `kind` (`order`, `customer`, `catalogue`), `id`, `data` (JSON), `version` (integer, starting at 1) and `updated_at` (server ms). Primary key `(kind,id)`; an index on `(kind,updated_at DESC,id)` supports the bounded admin lists.

- `catalogue/<product-id>`: `prices:{quarter,kilo}` in GBP pence, `active` (visibility), `inStock`, optional `grindOptions:[{id,label,enabled}]`, full `product` details and `images` (ordered references). Without a record the ten-coffee source snapshot is used, visible and in stock; older price/visibility-only overrides remain supported. New products use `coffee-<uuid>` IDs. Product details include `name,title,origin,process,notes,badge,categories`, source metadata and prices. Image references are `source:<bundled filename>` or `upload:<32 hex characters>`; an empty list means no image. Catalogue and terms changes need no migration beyond the shipped tables.
- `customer/<uuid>`: `business,contact,email,phone,address,postcode,deliveryNotes,status` (`Active` or `On hold`), `note`, `paymentTerms`, `paymentNote`. Approved customers may edit their own contact/delivery details; the approved business name, hold status, internal notes and payment terms remain admin-only. Stored terms are an ID (`to-agree`, `before-dispatch`, `net-7`, `net-14`, `net-30`, `net-60`, `custom`) plus customer-facing instructions of up to 500 characters. Missing terms default to `to-agree`; Custom requires instructions. Public profile responses expose terms as `{id,label,note}`.
- `order/PREVIEW-<32 hex characters>` (staff test) or `order/WS-<32 hex characters>` (customer): `createdBy,createdName,business,reference,delivery,customerId,status,note,date,createdAt,requestKey,lines[],pence,grams,packs,deliveryPence,totalPence`. The server sets creator, date and totals. `deliveryPence` (including VAT) is fixed when the order is placed by `shippingFor` in `public/wholesale-preview/shipping.js`: £7.44 for Delivery under £250 of coffee, free from £250, nothing for Roastery collection; `totalPence` is `pence + deliveryPence`. Orders from before have neither; the invoice form pre-fills its delivery charge from `deliveryPence` (converted to before VAT when saved prices exclude VAT). 500 g bags (`half`) are no longer sold or priced: the catalogue holds only `quarter` and `kilo` prices (a `half` price sent by an older page is ignored), new orders for them are refused (`pack_unavailable`), saved baskets drop them, and past orders keep their own saved lines. Each line contains `productId,title,pack,packLabel,grind,grindLabel,quantity,price,grams`. Prices and descriptive line fields are snapshots. `requestKey` is a server-side idempotency digest and is omitted from order API responses. The unique request ID and ownership checks prevent duplicate retries or another person reading the order through its ID. Optional `customerNote` (up to 1,000 characters) is the customer's own comments from checkout ("Use our own custom labels"): set when the order is placed, shown to the business and admins, and separate from the admin-only `note`.

Ordering requires an approved wholesale session or a staff preview session; management is admin-only. Edits require `ifVersion` and update atomically. Read/write access is through `src/wholesale.ts`, not the diary document API. Records are shared across devices and included under `wholesalePreview` in backup JSON. They do not automatically trigger payment, email or shipping actions.

Uploaded photos use the existing `FILES` KV binding with key `wholesale-image:<32 hex characters>`. Metadata: `contentType,size,productId,filename,by,at`. Only detected JPEG, PNG and WebP raster types are accepted, up to six images per coffee and 5 MB per file. The upload is linked by a version-checked catalogue save; a failed save removes the new upload. Removal unlinks the reference and deletes uploaded bytes. Authenticated image routes verify the product still references the image. JSON/D1 backups contain image references, not KV bytes; retain the original files. `src/wholesaleCatalogue.ts` manages catalogue/photos and `src/wholesaleStore.ts` shares versioned D1 access.

### Wholesale customer accounts (migration 12)

`wholesale_accounts`: UUID `id`, unique `customer_id` and case-insensitive `username`, PBKDF2 `password_hash/password_salt`, `must_change`, `active`, `approval_status` (pending/approved/rejected), `session_ver`, failed/lock counters, version, creation/update/last-login times. Registration creates pending, inactive accounts with a chosen password. Admin-created accounts are approved with a temporary password. Approval and active state are checked on every session read. Account resets, username changes and disabling increment the session version.

`wholesale_sessions`: SHA-256 token `hash` (primary key), account id, session version and expiry; indexes on account and expiry. The raw 256-bit cookie is never stored. This table is not used by staff authorization or included in backups.

Customer records also have `phone,address,postcode,deliveryNotes`. Their own profile API exposes only public contact/delivery fields, status and read-only terms; it cannot alter internal notes, terms or approval. Customer order records use `WS-…` IDs, `preview:false`, the fixed customer id and a `customerSnapshot`/delivery notes copied at checkout. New orders also snapshot `paymentTerms:{id,label,note}` at the top level and in the customer snapshot. Checkout verifies the reviewed customer version before saving; later terms edits do not rewrite orders. Staff preview records retain their old IDs and are excluded from customer histories. Internal order notes and idempotency hashes are omitted from customer responses. The new expression index supports customer order lookup. Account metadata is backed up under `wholesaleAccounts`; credentials and session tokens are excluded.

Wholesale retains the shipped `wholesale_preview` table and all customer/order/catalogue IDs. Admin lists use `(kind,updated_at DESC,id)` keyset pages and full-record aggregate queries; no schema change is needed. Checkout recovery is browser-local, keyed by the existing per-identity basket storage key plus `.pending-order`, and holds the exact submitted UUID/payload and display summary until resolved. It is not an extra server order or a payment record.

Customer histories now page through all owned orders using the existing customer expression index, with `updated_at DESC,id ASC` cursors and an ownership-scoped count. No schema change is needed. Repeat-order confirmation is an in-memory basket plan, not an order record; quick admin statuses preserve the existing order/snapshot fields and advance only via version-checked PATCH.

Order removal retains the same record/UUID with server `deletedAt` (milliseconds) and `deletedBy` (admin name), incrementing its version. These tombstones stay in backups for audit and idempotency, but normal order reads, histories, pages, counts and preparation totals exclude them. Reusing the original valid submission returns `order_deleted` rather than inserting another order. No migration is needed for these optional JSON fields.

Saved delivery locations use optional JSON fields on the existing customer record: `locations` (1–20 entries) and `defaultLocationId`. Each location has `id,name,contact,phone,address,postcode,deliveryNotes`. The permanent `primary` location mirrors the legacy flat delivery/contact fields; extra locations receive server UUIDs and are scoped to that business. Customers and admins edit locations using the customer version; no migration is needed. New orders record `locationId` and an immutable `locationSnapshot`, and their customer snapshot uses only the selected delivery/contact details. Omitted location IDs keep legacy primary-address request hashes and retry behaviour. Removing or editing a location cannot change a saved order.

### Wholesale VAT invoices (migration 13)

`wholesale_invoice_settings` holds singleton `id=1`, JSON settings, version and update time. Settings capture legal supplier/VAT/contact details, explicit inclusive/exclusive price basis, named rates in integer basis points, default coffee/delivery rates, invoice prefix/first number and payment instructions. Incomplete setup can be saved; readiness requires required fields and confirmation. First-number changes are blocked atomically after issuance.

`wholesale_invoices` has monotonic `seq INTEGER PRIMARY KEY AUTOINCREMENT`, unique `invoice_number`, unique `order_id`, `customer_id`, canonical `request_key`, immutable JSON snapshot, issued time/actor, and separate mutable `paid,paid_date,paid_at,payment_reference,payment_version` columns. The snapshot holds supply/invoice dates, supplier, bill-to, chosen delivery location, saved lines/prices, VAT basis/rates, per-line integer net/VAT/gross, rate breakdowns, totals, payment terms/instructions and due date. One real order can have one issued invoice; previews allocate no sequence. Issuing atomically checks order/settings versions and invoice uniqueness. Exact request retries return the same document; altered retries conflict. Payment updates use their own version and cannot rewrite financial content.

Invoice snapshots and sequence survive source-order deletion and appear in backups under `wholesaleInvoices:{settings,sequence,invoices}`. Customer access is scoped to `customer_id`, including invoices whose source order is hidden. PDF creation metadata uses the issued timestamp, so later downloads and payment-status changes leave the financial document unchanged.


Wholesale order JSON may include mutable `trackingUrl`, defaulting to an empty string in API responses for older orders. Admin version-checked updates add, replace or clear a normalized absolute HTTP/HTTPS link; creation, financial/location snapshots, invoice snapshots and original request hashes remain unchanged. Owned order reads expose tracking, while ordinary customer writes cannot set it. No migration is required.

Wholesale grind options default to Beans (`beans`, the default on each coffee), Fine (`espresso`), Medium (`filter`) and Coarse (`cafetiere`), each with an optional `hint` (what it's for, up to 120 characters, shown smaller to customers): the built-in ids are kept so saved baskets and past orders still match. `moka` is retired but still recognised in old baskets and orders. Admins may keep 1–20 uniquely named options (labels up to 60 characters), with at least one enabled. Standard IDs remain accepted; custom IDs are `grind-<uuid>`. Renaming retires an existing ID and creates a new custom ID so a stale reviewed choice cannot silently change meaning. Disabling/removing a choice blocks new orders while matching successful retries and immutable order/invoice snapshots retain their saved grind labels. Removed/disabled choices remain visible in saved baskets for review/removal. No migration is required; existing catalogue versioning and JSON backups include the settings.


### QuickBooks accounting (migrations 15–17)

Shipped migration 15 remains immutable. Additive migration 16 copies its singleton connection/mappings into the Sandbox namespace, preserving legacy token authenticated context, then clears retired credentials/nonces. `quickbooks_installation.namespace` remains the stable installation identity; keep it across restores.

`quickbooks_connections` is keyed by environment (`sandbox`, `production`). It stores public connection version/status, realm/company/UK/GBP/VAT, generation-bound encrypted tokens, separate token version and short refresh lease. AES-GCM v2 includes environment/realm/generation; legacy v1 decrypts only for Sandbox. `quickbooks_auth_states` contains hashed single-use nonces bound to environment, initiating admin/session, connection version and ten-minute expiry. Public DTOs and JSON backups exclude tokens/nonces/leases.

`quickbooks_environment_mappings` is keyed by environment and realm, with CAS-versioned local business/customer links, coffee/delivery sales items, VAT-rate-ID/percentage/code pairs and optional payment term links. `quickbooks_settings` stores active environment (default Sandbox), version and approval fingerprint/active admin/attestations. Approval binds the Live company generation, supplier and relevant financial mappings. Exporting a new Live VAT/price-basis/line-kind profile requires corresponding successful Sandbox evidence.

`quickbooks_exports` stores each frozen operation before provider writes: original company/environment, local invoice, stable request ID, immutable preview/payload/content/source hashes, admin, mapping revision, state/lease/retry metadata and remote link. Unique constraints prevent duplicate local invoices per environment/realm, duplicate request IDs, duplicate remote links and multiple Live operations for one local invoice across companies. Original request bytes and identifiers survive retries; uncertain results are reconciled before another create. History uses stable ID pagination across previous companies.

`quickbooks_observations` stores separate read-only balance/status, source revision, read start/observed times and CAS version. Old revision/response races cannot overwrite newer reads. Invoice financial snapshots and PDFs are not rewritten. Only Live-linked observations augment owner-scoped invoice JSON with unpaid/part-paid/paid/review status, outstanding/paid pence, source and checked time. Admin-only accounting fields include the export ID and diagnostic reason. Conflicts use review status; Sandbox balances never appear to customers.

`quickbooks_events` durably deduplicates minimal signed Invoice/Payment notification IDs by environment/realm; no raw webhook body is retained. `quickbooks_reconciliation` stores CDC checkpoints, sweep cursor/times and processing leases/backoff. Five-minute cron work is bounded; daily/gap sweeps check owned links. `quickbooks_verifications` stores actual successful Sandbox-create/VAT-profile/partial/full-payment evidence, keyed to supplier VAT and adapter version. Manual adoption is not create evidence.

Backups preserve namespace, company/mappings, ledger, observations/evidence and checkpoints; omit credentials/nonces/leases/Live approval; default to Sandbox and put unlinked operations in review. Raw D1 restores require the explicit disconnect/pause SQL in [QuickBooks recovery](quickbooks-integration.md). Preserve both invoice and export sequences and all original operation hashes/request IDs/remote links.

Migration 17 adds `quickbooks_app_settings`: environment primary key (`sandbox`/`production`), authenticated encrypted `data`, independent `generation`, CAS `version` and `updated_at`. Its client ID/secret and optional verifier token override existing hosting settings. Ciphertext binds environment and the app-settings purpose; the master key stays only in Cloudflare. The whole table is excluded from JSON backups. Restored raw D1 copies must clear app settings as described in the recovery guide. Credential replacement increments the disconnected connection version, clears its OAuth states and invalidates Live approval atomically; webhook-only changes retain the company connection.
