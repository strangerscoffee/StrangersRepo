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

Reject any other path with `invalid_argument`.

## D1 table

`src/schema.ts` creates it (with the `users`, `secrets`, `meta` and `rate_limits` tables for accounts, sessions, change tracking and rate limiting):

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
| `rota_weeks` | `week (Monday), published_at (NULL = draft), published_by, changed_at, changes (shift changes since it was last published)` |
| `rota_sites` | `site, opens_at, closes_at (the usual hours; NULL = not set), min_people (default 1), day_hours (JSON {"sat"\|"sun"\|…: {"opensAt","closesAt"}}: weekdays with their own hours)` |
| `rota_people` | `user_id, contract_min, contract_max (contracted hours a week, a range; NULL = none; hours over the max are overtime), contract_hours (kept equal to contract_max for older pages), sites (JSON site ids they can get to; [] = any), pattern (JSON {"mon":"any"\|"off"\|{"from","to"}, …}; a missing day = any), updated_at` |
| `rota_time_off` | `id, user_id, from_day, to_day (inclusive), reason, status ('requested'\|'approved'\|'declined'\|'cancelled'), decided_by, decided_at, created_at` |
| `rota_requests` | `id, kind ('claim' = take an open shift \| 'cover' = give my shift away), shift_id, from_user, to_user (cover: who's asked; NULL = anyone), taker, message, status ('open'\|'accepted'\|'approved'\|'declined'\|'cancelled'), decided_by, decided_at, created_at` |

The rota also reads three things from the diary's documents: a site is in use only once it has `settings/main`, it's closed on the weekdays in `closedDays` and on any day whose `days/<date>` has `closed` (a closure), and "trained on opening and closing checks" means that site's `staff/<id>` for the person (matched by name) has a date for the topic `diary`.

## The audit log

`audit_log` (`src/schema.ts`, written by `src/audit.ts`): `id, at (ms), kind, actor (a name or NULL), text`. Kinds: `user_added`, `renamed`, `username_changed`, `role_changed`, `active_changed`, `password_reset`, `unlocked`, `signed_out`, `locked`, `signin_failed`, `backup`, `setup_copied`, `pins_reset`, `signed_out_all`. The text is in words for the admin section ("Sam Patel made Priya Shah a manager"); it never holds a password, PIN or a typed username. Rows older than about 400 days are removed.

Backups (`src/backup.ts`) include every rota table under `rota`.

### The rota API (`/api/rota/…`)

Signed out gets 401 `unauthenticated`; writes count towards the per-IP write limit. "Managers" are the `manager` and `admin` roles (`isRotaManager` in `src/access.ts`). Errors are `{code, message}`: `invalid_argument` (400), `permission_denied` (403), `not_found` (404), `conflict` (409, a change the checks refuse).

| Route | Who | What |
|---|---|---|
| `GET week?start=` | all | The week: `{week, days, published, changesSincePublish, sites:[{id,name,inUse,open[7],closedWhy[7],opensAt,closesAt,minPeople}], people, shifts, timeOff, problems}`. Staff get names only for `people`, no `timeOff` or `problems`, and no shifts until the week is published. |
| `POST shifts`, `PATCH shifts/:id`, `DELETE shifts/:id` | manager | Create, change or delete a shift; each returns the week's new `problems`. Shifts on a closed day are refused. Shift objects carry `start`/`end`/`breakMins` as planned, `actualStart`/`actualEnd`/`actualBreakMins`/`adjustNote` once amended (`adjusted`), `hours` (as worked), `plannedHours`, and in the week and My shifts views `overtime` (the part of `hours` over the person's max that week, marked in time order). Staff don't see other people's `overtime` or `adjustNote`. |
| `PUT shifts/:id/actual` | manager | Amend a shift on the day (from its day on): `{start, end, breakMins?, note?}` as worked, or `{clear: true}` to go back to the plan. The plan is kept; hours, overtime and cover use the amended times. Giving the shift to someone else clears it. |
| `POST week/copy` | manager | `{from, to, replace?}`: copies a week's shifts, skipping days a site is now closed; refuses (409) to overwrite unless `replace`. |
| `POST week/publish` | manager | `{week}`: publishes or republishes. |
| `GET mine?from=&to=` | all | My shifts in published weeks, each with who else is on at that site, plus `contractMin`, `contractMax` and `weeks: [{week, hours, overtime}]` (whole weeks). |
| `GET today?site=` | all | Today's (UK) shifts at a site when its week is published; for the diary's Today (with `actualStart`/`actualEnd` when amended). |
| `GET suggest?shift=` | manager | Everyone who could take a shift, best fit first, with flags: clash, time off, overtime, short rest, availability, untrained. |
| `GET hours?start=` (`&format=csv`) | manager | Paid hours per person and site against contract; CSV columns `name,role,contract_hours,rota_hours,difference,roastery,cafe,asg,factory`. |
| `GET me`, `PUT me/availability` | all / admin | My pattern, sites, contract, time off and requests (`user.admin` says whether I'm an admin); only admins set their own pattern and sites (`permission_denied` for anyone else). |
| `PUT people/:userId` | manager (sites and pattern: admin) | `{contractMin?, contractMax?, sites?, pattern?}` for anyone; `sites` and `pattern` are admin-only (min ≤ max; a field left out is kept). The older `{contractHours}` sets both. |
| `POST time-off`, `PATCH time-off/:id` | all / manager / owner | Ask for time off (managers can add it for anyone, approved); approve or decline (manager); cancel (owner). |
| `GET requests`, `POST requests`, `PATCH requests/:id` | all | Pickups (`claim`) and covers (`cover`); `{action: accept\|decline\|cancel\|approve}`. Approving re-checks the taker and refuses a clash or time off with 409. |
| `GET open` | all | Open shifts in published weeks I could take. |
| `GET sites`, `PUT sites/:site` | all / manager | Usual opening and closing time, minimum people and `dayHours` (weekdays with their own hours, for example Sundays) per site. `PUT` without `dayHours` keeps them; `dayHours: null` clears them. The week view gives each site `hours[7]`, that week's hours day by day. |
| `GET links` | all | `{rota, diary}`: where each app lives, as seen from this address. |

The checks (`computeProblems` in `src/rota.ts`): `open_shift`, `clash`, `time_off` and `closed` are errors; `no_opener`, `no_closer`, `short_cover` (against each day's own hours, counting who's actually there), `overtime` (over the max contracted hours) and `rest` (under 11 hours) are warnings; `break` (over 6 hours with under 20 minutes), `availability`, `seven_days` and `under_contract` (under the min contracted hours) are notes. They're prompts for the manager: publishing is allowed with problems.
