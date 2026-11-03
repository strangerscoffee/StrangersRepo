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
closed:{reason,by,at}        // closed outside the usual opening days (holiday, maintenance, unexpected): never counted as incomplete; null when reopened
signed:{by,at,name}          // name = the signed-in person's name (older entries may lack it)
```
The page writes these with nested `update`s such as `{temps:{u1:{am:{v:3.2,by,at}}}}`, which must merge deeply (see `runtime-api.md`).

**`weeks/<Monday YYYY-MM-DD>`**: `week, items:{<checkId>:bool}, by, at, notes:{text,by,at}, signed:{by,at,name}`

**`extras/<id>`**, **`cleaning/<id>`**: `name, how, freq ("after use"|"daily"|"weekly"|"fortnightly"|"monthly"|"quarterly"|"yearly"), who, createdAt, lastAt?, lastBy?, lastSet?, log:[{at,by,note,set?}] (newest first, max 30), importedAt?, importedFrom?`

`lastSet: true` (and `set: true` on its log entry) means the last-done date was entered by hand ("Last done on" → Save date) rather than ticked off at the time: `lastAt` is then midday on that date (or the moment it was saved, if it was today) and the page shows it as a date only. `lastBy` is whoever entered it. Ticking the task done sets `lastSet: false`.

**`deliveries/<id>`**: `date (YYYY-MM-DD), at, supplier, supplierId (suppliers/<id> at that site, or null if typed), items, chilled (°C or null), frozen (°C or null), noTemp, packaging ("ok"|"no"), order ("ok"|"no"), outcome ("accepted"|"rejected"), note, by`. Chilled passes at 8°C or below (5°C ideal), frozen at −15°C or below (−18°C ideal). A rejection, or accepting despite a failed check, needs a `note`. Staff can write.

**`maintenance/<id>`**: `title, area, details, priority ("urgent"|"soon"|"later"), status ("open"|"done"), assignee? ("web:<name>" or null), assigneeName?, reportedBy, reportedAt, at, doneBy?, doneAt?, fixNote?, log:[{at,by,what:"Done"|"Reopened"|"Assigned to <name>"|"Unassigned",note}]` (newest first, max 30). The people to assign come from `user.team()` (everyone with an account). Staff can write. Maintenance → All sites reads every site's collection.

**`proveit/<id>`**: `date, method, food, reading, unit, pass, action, by, at`

**`allergens/<id>`**: `name, source, contains:[allergen names], notes, kind? ("drink"|"food"), by, at, importedFrom?`. When a site separates allergens into Drinks and Food (settings `allergenSections`; on by default at the Cafe), `kind` puts the item in a section; items without one are drinks.

**`allergenDocs/<id>`**: `title, note, fileName, assetId, size, by, at`. `assetId` is the PDF's key in the KV namespace (`FILES`), served at `/_blob/<assetId>`. No longer uploaded: the allergen matrix PDF is generated on the device from `allergens`. PDFs uploaded before are still listed (Open, Remove) until removed.

**`suppliers/<id>`**: `name, supplies, contact, phone, email, address, rating, notes, by, at`

**`contacts/<id>`**: `type, name, person, phone, outOfHours, email, account, notes, by, at`

**Saved to several sites.** Documents in `extras`, `cleaning`, `plans`, `suppliers`, `contacts`, `onboarding`, `allergens` and `allergenDocs` may also carry `linkId` (the same on every copy) and `sites:[siteIds]` (where it was last sent). Saving with sites ticked writes a copy at each one: the copy with the same `linkId` is replaced (for `extras` and `cleaning` only the item's own fields are updated, so each site keeps its own `lastAt`, `lastBy` and `log`); otherwise a new one is added. Suppliers, contacts, allergen items and tasks saved before linking are matched by name; HACCP & risk, onboarding documents and allergen PDFs only by `linkId`. Removing deletes the copy at the current site only. Allergen PDF copies share one `assetId`; the stored file is deleted once no site's `allergenDocs` refers to it.

**`staff/<id>`**: `name, role, start, topics:{<topic>:{date,by}}, notes, personId, sites:[siteIds], at`

Training topics (`<topic>`): `hygiene`, `cross`, `cleaning`, `chilling`, `cooking`, `allergens`, `diary`, `l2`. A site's `trainingOff` (set from Staff training → Topics for this site) lists the topics it doesn't use: they're hidden there and not counted as training to do, and any dates already in `topics` are kept.

**`reviews/<YYYY-MM-DD>`**: `date, answers:{<q>:{a:"Yes"|"No", d}}, notes, by, at`

**`plans/<id>`** (HACCP plans and risk assessments): `type:"haccp"|"risk", title, …metadata, steps[] or rows[], notes, source, createdBy, createdAt, updatedBy, updatedAt, history[]`

**`onboarding/<id>`**: `category, title, audience, owner, date, reviewDate, summary, sections:[{heading,body}], notes, source, created…/updated…, history[]`

**`inspections/<id>`** (EHO): `inspectionDate, inspector, authority, visitType, rating, scores:{hygiene,structure,management}, revisitDate, summary, goodPoints[], issues:[{id,issue,area,priority,action,deadline,ref,done,doneBy,doneAt,fixNote}], notes, source, created…/updated…, history[]`

**`config/shared`**: the last published shared setup: `opening, closing, weekly, from, to[], by, at`.

**`config/people`**: `{ "u_…": "<name>" }`, names for the `u_…` ids on older records. Read-only.
