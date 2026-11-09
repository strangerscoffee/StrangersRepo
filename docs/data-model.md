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
  updated_by  TEXT                        -- 'web:<name>'
);
```

Queries the page makes: one document by path; a whole collection; a collection ordered by one field and limited (`days` by `date` desc, `weeks` by `week` desc, `reviews` by `date` desc, `proveit` by `at` desc). Ordering on a JSON field with `json_extract(data,'$.date')` is fine at this size (hundreds of documents per collection).

## Documents

Timestamps (`at`, `lastAt`, `createdAt`, `updatedAt`) are ms since epoch. Dates are `YYYY-MM-DD` strings. `by` fields are user ids: `web:<name>` (the signed-in person's display name), or `u_…` on older records made in the Claude version of the diary, whose names are in `config/people`.

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

**`contacts/<id>`**: `type, name, person, phone, outOfHours, email, account, notes, by, at`

**Saved to several sites.** Documents in `extras`, `cleaning`, `plans`, `suppliers`, `contacts`, `onboarding`, `allergens` and `allergenDocs` may also carry `linkId` (the same on every copy) and `sites:[siteIds]` (where it was last sent). Saving with sites ticked writes a copy at each one: the copy with the same `linkId` is replaced (for `extras` and `cleaning` only the item's own fields are updated, so each site keeps its own `lastAt`, `lastBy` and `log`); otherwise a new one is added. Suppliers, contacts, allergen items and tasks saved before linking are matched by name; HACCP & risk, onboarding documents and allergen PDFs only by `linkId`. Removing deletes the copy at the current site only. Allergen PDF copies share one `assetId`; the stored file is deleted once no site's `allergenDocs` refers to it.

**`staff/<id>`**: `name, role, start, topics:{<topic>:{date,by}}, notes, personId, sites:[siteIds], signed?:{by,name,at,topics}, at`

Records → Staff training. Managers and admins write anyone's record; staff only the one in their own name (matched case-insensitively against their account name, before and after the change) and never delete one. `sites` is where the person works: saving writes a copy at each ticked site. `signed` is the person confirming their own dates; its `topics` is the dated topics as `key=YYYY-MM-DD` joined by commas, sorted, so a signature counts only while those dates are unchanged (the page shows "Not signed" otherwise, and "Trained today" clears it).

Training topics (`<topic>`): `hygiene`, `cross`, `cleaning`, `chilling`, `cooking`, `allergens`, `diary`, `l2`. A site's `trainingOff` (set from Staff training → Topics for this site) lists the topics it doesn't use: they're hidden there and not counted as training to do, and any dates already in `topics` are kept.

**`reviews/<YYYY-MM-DD>`**: `date, answers:{<q>:{a:"Yes"|"No", d}}, notes, by, at`. Anyone can sign it (Records → 4-weekly review); when it's overdue, Today shows a reminder that opens it.

**`plans/<id>`** (HACCP plans and risk assessments): `type:"haccp"|"risk", title, …metadata, steps[] or rows[], notes, source, createdBy, createdAt, updatedBy, updatedAt, history[]`

**`onboarding/<id>`**: `category, title, audience, owner, date, reviewDate, summary, sections:[{heading,body}], notes, source, created…/updated…, history[]`

**`inspections/<id>`** (EHO): `inspectionDate, inspector, authority, visitType, rating, scores:{hygiene,structure,management}, revisitDate, summary, goodPoints[], issues:[{id,issue,area,priority,action,deadline,ref,done,doneBy,doneAt,fixNote}], notes, source, created…/updated…, history[]`

**`config/shared`**: the last published shared setup: `opening, closing, weekly, from, to[], by, at`.

**`config/people`**: `{ "u_…": "<name>" }`, names for the `u_…` ids on older records. Read-only.

## The rota's tables

The staff rota (`src/rota.ts`, at `ROTA_HOST`) keeps its data in its own D1 tables rather than as documents, because it needs per-row rules (only admins set which days and sites people work; staff ask for their own time off). `src/schema.ts` creates them. People are `users.id` (not `web:<name>`); names come from `users.name`. Days are `YYYY-MM-DD`, times `HH:MM` UK local time, weeks are identified by their Monday.

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

Backups (`src/backup.ts`) include every rota table under `rota`.

### The rota API (`/api/rota/…`)

Signed out gets 401 `unauthenticated`; writes count towards the per-IP write limit. "Managers" are the `manager` and `admin` roles (`isRotaManager` in `src/access.ts`). Errors are `{code, message}`: `invalid_argument` (400), `permission_denied` (403), `not_found` (404), `conflict` (409, a change the checks refuse).

| Route | Who | What |
|---|---|---|
| `GET week?start=` | all | The week: `{week, days, published, changesSincePublish, sites:[{id,name,inUse,open[7],closedWhy[7],opensAt,closesAt,minPeople}], people, shifts, timeOff, problems}`. Staff get names (and each person's `hue`, their colour on the rota) only for `people`, no `timeOff` or `problems`, and no shifts until the week is published. |
| `POST shifts`, `PATCH shifts/:id`, `DELETE shifts/:id` | manager | Create, change or delete a shift; each returns the shift and its `week`, and the week's new `problems` only when asked (`?with=problems`: the rota page redraws the week instead). A change sent with `ifUpdatedAt` (the shift's `updatedAt` when it was opened) is refused with 409 `conflict` if someone changed it since. Shifts on a closed day are refused. Shift objects carry `start`/`end`/`breakMins` as planned, `actualStart`/`actualEnd`/`actualBreakMins`/`adjustNote` once amended (`adjusted`), `hours` (as worked), `plannedHours`, and in the week and My shifts views `overtime` (the part of `hours` over the person's max that week, marked in time order). Staff don't see other people's `overtime` or `adjustNote`. |
| `PUT shifts/:id/actual` | manager | Amend a shift on the day (from its day on): `{start, end, breakMins?, note?}` as worked, or `{clear: true}` to go back to the plan (`?with=problems` as above). The plan is kept; hours, overtime and cover use the amended times. Giving the shift to someone else clears it. |
| `POST week/copy` | manager | `{from, to, replace?}`: copies a week's shifts, skipping days a site is now closed; refuses (409) to overwrite unless `replace`. |
| `POST week/publish` | manager | `{week, email?}`: publishes or republishes. With `email: true`, emails the people on it (`src/email/rota.ts`): the first time, everyone with shifts; after that, only those whose shifts changed since their last email, with what changed; plus open shifts to people who turned those emails on and are free. Answers with `emailed` (how many are being sent). |
| `GET week/emails?week=` | manager | What publishing would email: `{ready, first, people, noAddress:[names], open}`, for the publish sheet. |
| `GET mine?from=&to=` | all | My shifts in published weeks, each with who else is on at that site, plus `contractMin`, `contractMax` and `weeks: [{week, hours, overtime}]` (whole weeks). |
| `GET today?site=` | all | Today's (UK) shifts at a site when its week is published; for the diary's Today (with `actualStart`/`actualEnd` when amended). |
| `GET suggest?shift=` | manager | Everyone who could take a shift, best fit first, with flags: clash, time off, overtime, short rest, availability. |
| `GET hours?start=` (`&format=csv`) | manager | Paid hours per person and site against contract; CSV columns `name,role,contract_hours,rota_hours,difference,roastery,cafe,asg,factory`. |
| `PUT me/emails` | all | `{prefs:{published?, changed?, requests?, open?}}`: which rota emails I get. My address is set by an admin; `GET me` returns `email: {address, prefs, ready}`. |
| `GET me`, `PUT me/availability` | all / admin | My pattern, sites, contract, time off and requests (`user.admin` says whether I'm an admin); only admins set their own pattern and sites (`permission_denied` for anyone else). |
| `PUT people/:userId` | manager (sites and pattern: admin) | `{contractMin?, contractMax?, sites?, pattern?}` for anyone; `sites` and `pattern` are admin-only (min ≤ max; a field left out is kept). The older `{contractHours}` sets both. |
| `POST time-off`, `PATCH time-off/:id` | all / manager / owner | Ask for time off (managers can add it for anyone, approved); approve or decline (manager); cancel (owner). |
| `GET requests`, `POST requests`, `PATCH requests/:id` | all | Pickups (`claim`) and covers (`cover`); `{action: accept\|decline\|cancel\|approve}`. Approving re-checks the taker and refuses a clash or time off with 409. |
| `GET open` | all | Open shifts in published weeks I could take. |
| `GET sites`, `PUT sites/:site` | all / manager | Usual opening and closing time, minimum people and `dayHours` (weekdays with their own hours, for example Sundays) per site. `PUT` without `dayHours` keeps them; `dayHours: null` clears them. The week view gives each site `hours[7]`, that week's hours day by day. |
| `GET links` | all | `{rota, diary}`: where each app lives, as seen from this address. |

The checks (`computeProblems` in `src/rota/problems.ts`): `open_shift`, `clash`, `time_off` and `closed` are errors; `short_cover` (against each day's own hours, counting who's actually there), `overtime` (over the max contracted hours) and `rest` (under 11 hours) are warnings; `break` (over 6 hours with under 20 minutes), `availability`, `seven_days` and `under_contract` (under the min contracted hours) are notes. They're prompts for the manager: publishing is allowed with problems. There's no check for who opens or closes a site: a shift's job (`opens`/`closes`) is optional, and only labels the shift and the diary's "who opens / who closes".


## Rota emails

Sent through Resend (`src/email/`) when the `RESEND_API_KEY` secret is set; without it nothing is sent. `users.email` is the address (admins set it: `PATCH /api/admin/users/<id> {email}`, `""` removes it) and `users.email_prefs` a JSON object of which emails the person gets: `published` (their week when it's published, on by default), `changed` (their shifts changed after publishing, on), `requests` (cover, pick-up and time-off decisions, on) and `open` (open shifts they're free for, off), and for managers and admins `weekly` (the Monday summary, on) with `weeklySites` (the sites it covers; all four when not set). Each email has a calendar file of the shifts (for a week), a link to the rota, and a signed one-tap unsubscribe link (`/email/unsubscribe?t=…`, no sign-in; opening it only asks). At most `EMAIL_DAILY_LIMIT` (100) a day. Each one sent or refused is logged in `audit_log` (Admin → Activity, "Rota emails"); failures in the last day are flagged on the Overview.

**The managers' Monday summary** (`src/email/weekly.ts`): at 07:30 UK time every Monday (cron `30 6,7 * * 1`, sending only at 07:xx in London, once a week: `meta.weekly_sent`), each active manager and admin with an address and `weekly` on gets last week at their `weeklySites`: what needs them (urgent: an out-of-range reading with nothing in Problems & changes, urgent maintenance; this week: days not signed off, overdue cleaning and extra checks, overdue 4-weekly reviews, rota requests waiting, this week's rota unpublished; to plan: next week's rota unpublished), a Mon–Sun grid per site (✓ signed off, ✕ missed, ! a reading out of range, – closed) with totals against the week before, and what's coming up. They change it in Rota → When I can work → Emails (`PUT /api/rota/me/emails {prefs: {weekly}, weeklySites}`); admins change anyone's in Admin → People (`PATCH /api/admin/users/<id> {emailPrefs: {weekly}, weeklySites}`), and send themselves this week's from the Overview (`POST /api/admin/email/weekly-test`).

## Wholesale beta (legacy storage names retained)

Migration 11 adds a separate `wholesale_preview` table. It does not add any allowed diary document paths. Columns: `kind` (`order`, `customer`, `catalogue`), `id`, `data` (JSON), `version` (integer, starting at 1) and `updated_at` (server ms). Primary key `(kind,id)`; an index on `(kind,updated_at DESC,id)` supports the bounded admin lists.

- `catalogue/<product-id>`: `prices:{quarter,half,kilo}` in GBP pence, `active` (visibility), `inStock`, full `product` details and `images` (ordered references). Without a record the ten-coffee source snapshot is used, visible and in stock; older price/visibility-only overrides remain supported. New products use `coffee-<uuid>` IDs. Product details include `name,title,origin,process,notes,badge,categories`, source metadata and prices. Image references are `source:<bundled filename>` or `upload:<32 hex characters>`; an empty list means no image. Catalogue and terms changes need no migration beyond the shipped tables.
- `customer/<uuid>`: `business,contact,email,phone,address,postcode,deliveryNotes,status` (`Active` or `On hold`), `note`, `paymentTerms`, `paymentNote`. Approved customers may edit their own contact/delivery details; hold status, internal notes and payment terms remain admin-only. Stored terms are an ID (`to-agree`, `before-dispatch`, `net-7`, `net-14`, `net-30`, `net-60`, `custom`) plus customer-facing instructions of up to 500 characters. Missing terms default to `to-agree`; Custom requires instructions. Public profile responses expose terms as `{id,label,note}`.
- `order/PREVIEW-<32 hex characters>` (staff test) or `order/WS-<32 hex characters>` (customer): `createdBy,createdName,business,reference,delivery,customerId,status,note,date,createdAt,requestKey,lines[],pence,grams,packs`. The server sets creator, date and totals. Each line contains `productId,title,pack,packLabel,grind,grindLabel,quantity,price,grams`. Prices and descriptive line fields are snapshots. `requestKey` is a server-side idempotency digest and is omitted from order API responses. The unique request ID and ownership checks prevent duplicate retries or another person reading the order through its ID.

Ordering requires an approved wholesale session or a staff preview session; management is admin-only. Edits require `ifVersion` and update atomically. Read/write access is through `src/wholesale.ts`, not the diary document API. Records are shared across devices and included under `wholesalePreview` in backup JSON. They do not automatically trigger payment, email or shipping actions.

Uploaded photos use the existing `FILES` KV binding with key `wholesale-image:<32 hex characters>`. Metadata: `contentType,size,productId,filename,by,at`. Only detected JPEG, PNG and WebP raster types are accepted, up to six images per coffee and 5 MB per file. The upload is linked by a version-checked catalogue save; a failed save removes the new upload. Removal unlinks the reference and deletes uploaded bytes. Authenticated image routes verify the product still references the image. JSON/D1 backups contain image references, not KV bytes; retain the original files. `src/wholesaleCatalogue.ts` manages catalogue/photos and `src/wholesaleStore.ts` shares versioned D1 access.

### Wholesale customer accounts (migration 12)

`wholesale_accounts`: UUID `id`, unique `customer_id` and case-insensitive `username`, PBKDF2 `password_hash/password_salt`, `must_change`, `active`, `approval_status` (pending/approved/rejected), `session_ver`, failed/lock counters, version, creation/update/last-login times. Registration creates pending, inactive accounts with a chosen password. Admin-created accounts are approved with a temporary password. Approval and active state are checked on every session read. Account resets, username changes and disabling increment the session version.

`wholesale_sessions`: SHA-256 token `hash` (primary key), account id, session version and expiry; indexes on account and expiry. The raw 256-bit cookie is never stored. This table is not used by staff authorization or included in backups.

Customer records also have `phone,address,postcode,deliveryNotes`. Their own profile API exposes only public contact/delivery fields, status and read-only terms; it cannot alter internal notes, terms or approval. Customer order records use `WS-…` IDs, `preview:false`, the fixed customer id and a `customerSnapshot`/delivery notes copied at checkout. New orders also snapshot `paymentTerms:{id,label,note}` at the top level and in the customer snapshot. Checkout verifies the reviewed customer version before saving; later terms edits do not rewrite orders. Staff preview records retain their old IDs and are excluded from customer histories. Internal order notes and idempotency hashes are omitted from customer responses. The new expression index supports customer order lookup. Account metadata is backed up under `wholesaleAccounts`; credentials and session tokens are excluded.

The beta retains the shipped `wholesale_preview` table and all customer/order/catalogue IDs. Admin lists use `(kind,updated_at DESC,id)` keyset pages and full-record aggregate queries; no schema change is needed. Checkout recovery is browser-local, keyed by the existing per-identity basket storage key plus `.pending-order`, and holds the exact submitted UUID/payload and display summary until resolved. It is not an extra server order or a payment record.

Customer histories now page through all owned orders using the existing customer expression index, with `updated_at DESC,id ASC` cursors and an ownership-scoped count. No schema change is needed. Repeat-order confirmation is an in-memory basket plan, not an order record; quick admin statuses preserve the existing order/snapshot fields and advance only via version-checked PATCH.
