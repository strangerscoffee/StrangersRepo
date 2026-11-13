# Deploying and running the Kitchen Diary

**Wholesale:** customers register at **https://strangerscoffee.trade** and wait for admin approval. Manage registrations, customer accounts and orders in **Admin → Wholesale** at `https://admin.staffstrangerscoffee.com/#wholesale`. Wholesale credentials are separate from staff credentials. No new secret or external identity provider is required. See [docs/wholesale-preview.md](docs/wholesale-preview.md).

The customer domain and `www.strangerscoffee.trade` are Worker custom domains declared in `wrangler.jsonc`; `www` redirects to the bare address. Deploying requires the purchased zone to be active in the same Cloudflare account as the Worker, with no conflicting DNS record on these names. Cloudflare provisions the custom-domain DNS records and TLS certificates. The staff, rota and Admin domains stay separate; QuickBooks OAuth/webhook URLs stay on Admin.

The old `preview.staffstrangerscoffee.com` remains a working alias (`LEGACY_PREVIEW_HOST`). Customers use their existing credentials on the new domain and sign in there once; accounts, orders, catalogue and invoices remain in the same database. Host-only cookies and browser storage cannot move between domains. Keep the alias available so customers can retrieve saved baskets and recover uncertain checkout attempts on their original address. Do not clear or copy pending checkout payloads as a migration shortcut. Staff sign-in from the customer domain returns to the legacy staff preview, where the staff cookie is valid. No new secret or database migration is needed.

The site is one Cloudflare Worker serving the diary's pages and the API they talk to. It runs at **https://staffstrangerscoffee.com**, and the staff rota, from the same Worker, at **https://rota.staffstrangerscoffee.com**. **Every push to `main` redeploys it automatically** (Cloudflare Workers Builds).

| Path | What it is |
|---|---|
| `public/index.html`, `public/diary/` | The diary: markup, and its page logic as classic scripts loaded in order by `index.html` (`core.js` first, `start.js` last; see CLAUDE.md). |
| `public/shared/core.js` | Helpers all three apps share (`window.SC`): building elements, icons, toasts, Europe/London dates, going to sign-in, the session check when Safari brings a page back, watching for changes from other devices. |
| `public/app.css`, `public/theme.css`, `public/ui.css` | Styles: base layout, the Liquid Glass theme (colours, materials, dark mode, accessibility settings), then the app layout (bars, sidebar, cards, lists). See `docs/design.md`. |
| `public/claude-shim.js` | The page's data connection: `window.claude.use("db" \| "user" \| "assets")` backed by the API, with live updates by polling. The name dates from when the page ran inside Claude; see `docs/runtime-api.md`. |
| `public/signin.html`, `public/signin.js` | Sign-in, choosing a new password, changing a password, first-admin setup and admin password recovery. |
| `public/admin/` | The admin section: `index.html`, `admin.js` (talks to `/api/admin/*` and `/api/rota/*` with fetch) and `admin.css`, on top of `theme.css`. Served at `/` on the admin address and at `/admin` on the diary's when there's no admin address (local dev). |
| `public/icon-*.png`, `public/manifest.webmanifest` | Home Screen icon and app settings. |
| `public/pdf.js` | Makes PDFs on the device (allergen matrix, EHO inspection records): Helvetica text, tables and the logo, no libraries. |
| `public/pinpad.js` | The 4-digit PIN pad for quick switching, used by the diary, the rota and the sign-in page. |
| `public/rota/` | The staff rota app: `index.html`, `rota.js` (talks to `/api/rota/*` with fetch, like `admin/admin.js`) and `rota.css`, on top of the diary's styles. Served at `/` on the rota's address and at `/rota/` everywhere (for local development). |
| `src/` | The Worker: `index.ts` (routing, security headers and the nightly job), `access.ts` (who can reach what: access control, roles and write rate limiting, in one place), `auth.ts` (sign-in, sessions and quick switching), `admin.ts` (admin API), `backup.ts` (nightly backups), `docs.ts` (the db API), `assets.ts` (PDFs), `paths.ts` (allowed document paths), `schema.ts` (database tables, created automatically), `rota/` (the rota API: shifts, publishing, checks, suggestions, requests, hours; `rota/index.ts` is its router, `rota/routes/` its handlers by area), `hosts.ts` (which app each hostname serves). |
| `.github/workflows/test.yml`, `.github/annotate.mjs` | Runs every test on GitHub for each pull request and each merge to `main`; posts a failing test's message as an annotation. |
| `.github/workflows/automerge.yml` | Squash-merges each pull request into `main` by itself once Tests passes. |
| `test/` | `api.test.mjs`, `migration.test.mjs` and `rota.test.mjs` (the API and the rota's hostname, against `wrangler dev`), `e2e.test.mjs` (the diary in a browser, phone-sized), `rota.e2e.test.mjs` (the rota in a browser, phone and iPad) and `pdf.e2e.test.mjs` (the EHO records and allergen matrix PDFs with very long content: no text off the page or over other text) `readonly.e2e.test.mjs` (what staff see read-only: no stray "null", no Undo sign-off) and `today.e2e.test.mjs` (Today on a phone: reminders fold, closing checks wait in the morning). |
| `docs/rota-designs/` | The rota's screen designs (PNG and HTML), for reference. |

Data lives in a D1 database (`kitchen-diary`); allergen PDFs and uploaded catalogue photos use the existing `FILES` KV namespace. Cloudflare creates both on the first deploy and the Worker creates its own tables, so there are no ids to copy and no migrations to run. The only required secret is the **setup code**.

## First deployment (in the Cloudflare dashboard, no terminal)

`staffstrangerscoffee.com` must be a domain (zone) in the Cloudflare account you use, with its nameservers pointing at Cloudflare. The site is served at `staffstrangerscoffee.com`; `www.staffstrangerscoffee.com` redirects there.

1. **Free up the addresses.** If another Worker already uses `staffstrangerscoffee.com` or `www.staffstrangerscoffee.com`, open it under **Workers & Pages → that Worker → Settings → Domains & Routes** and remove the domain. If the zone already has A, AAAA or CNAME records for either name (for example a parked page from the registrar), delete them under **DNS → Records**, or the deploy can't add its own.
2. **Connect the repo.** **Workers & Pages → Create → Import a repository**, connect GitHub and pick `StrangersRepo`.
   - Project name: `strangers-kitchen-diary` (it must match `name` in `wrangler.jsonc`).
   - Build command: leave empty, or `npm run build` (it does nothing). Deploy command: `npx wrangler deploy`.
   - Click **Deploy**. Cloudflare creates the database, the PDF store and the address.
3. **Add the setup code.** In the Worker: **Settings → Variables and Secrets → Add**, type **Secret**, name `SETUP_CODE`, value a long random string (32+ characters). It must be a runtime secret, not a build variable. Keep it somewhere safe.
4. **Create the first admin.** Open the site. With no accounts yet it shows "Set up the first admin": enter your name, a username, a password and the setup code.

## Changing the site

**Custom coffees:** Admin → Wholesale → Custom coffees manages products for selected customers. Existing white-label assignments appear here automatically. New custom coffees start hidden and remain private when no customers are selected; access is enforced for catalogue responses, new orders and uploaded photos. General coffees remain in Coffee catalogue. These settings use the existing versioned catalogue records; no new migration, secret or setup is required.

The customer wholesale catalogue uses a compact three-row mobile toolbar (coffee count, bag size and sort; search; category pills). It reuses the same controls across the 700 px breakpoint, keeping search, sort and product choices when resizing. Desktop retains the full catalogue heading and layout. No backend migration or configuration is required. Order and invoice history use matching circular refresh actions with a larger rounded arrow, busy-state rotation and reduced-motion support.

Edit the files in `public/` (or `src/` for the API), run the tests, and open a pull request. Once Tests passes, squash-merge it into `main`; Cloudflare deploys that commit. The deploy takes about a minute. If a deploy fails, the build log is in the Cloudflare dashboard under the Worker → **Deployments**, and GitHub shows a red cross next to the commit. If a deploy sits as "queued" for more than a few minutes, press **Retry build** on it in the Worker's **Deployments** (or **Builds**) tab; any later merge to `main` also starts a fresh build that includes every earlier change.

**Browser install on GitHub.** The Tests check installs Chromium with its system packages; if GitHub's runner can't reach Ubuntu's package servers, it gives up after 3 minutes and uses the libraries the runner already has (a warning on the check says so). The browser tests still have to pass.

**Tests on GitHub.** Every pull request, and every merge to `main`, runs the typecheck, the API tests and the browser test (the "Tests" check). If one fails, its error message is shown as an annotation on the check. Cloudflare deploys whatever reaches `main`, so the safe way to change the site is a branch and a pull request, merged once Tests is green. That's a rule on `main` (GitHub → the repo → **Settings → Rules → Rulesets**: "Tests must pass", requiring the **test** status check).

**Auto-merge.** Every pull request into `main` is squash-merged by itself as soon as Tests passes (`.github/workflows/automerge.yml`), then Cloudflare deploys it, so there's nothing to press. If Tests fails, the pull request stays open with a red cross until it's fixed. To hold a change back, open it as a **draft** pull request (or "Convert to draft" on an open one): drafts aren't merged until they're marked "Ready for review". Auto-merge needs **Settings → General → Allow auto-merge** switched on (it is), and squash merging allowed.

## The rota's address

The rota is served by the same Worker on its own hostname, set in `wrangler.jsonc`: the var `ROTA_HOST` (`rota.staffstrangerscoffee.com`) and a third custom-domain route for it, after the diary's two. On deploy, Cloudflare creates the `rota` DNS record and its certificate in the `staffstrangerscoffee.com` zone (it has to be in the same Cloudflare account, as it is for the diary; if a `rota` record already exists, delete it first, as for the diary's own addresses). Nothing about the diary's address changes.

On `ROTA_HOST`, `/` is the rota app; the sign-in page, `/api/auth/*`, `/api/rota/*` and the shared styles work as on the diary; diary pages redirect to `/` and the diary's data API (`/api/db/*`, `/api/assets*`, `/_blob/*`) returns 404. Sign-in is shared: the session cookie is set on the whole domain (`COOKIE_DOMAIN` in `wrangler.jsonc`, `staffstrangerscoffee.com`), so signing in, switching person or signing out on either address does the same on both. There is one sign-in page (**Staff Login**) on the diary's address: `/signin` on the rota redirects there with `next=` as a full link back (`unifiedSignin` in `src/hosts.ts`), and the sign-in page only follows `next=` to its own paths or https subdomains. Migration 14 invalidates all pre-cutover staff sessions and trusted quick-switch devices. A fresh password sign-in establishes the current shared session; `GET /api/auth/me` is read-only and does not move or revive an old session. Locally there's no second hostname: the rota is at `http://localhost:8787/rota/` (`wrangler dev` sends every request as the first route's hostname, `staffstrangerscoffee.com`, which is why the tests start a second server with `--var ROTA_HOST:staffstrangerscoffee.com` to test the rota's own address).

## The admin section's address

The admin section is served by the same Worker on its own hostname: the var `ADMIN_HOST` (`admin.staffstrangerscoffee.com`) and a fourth custom-domain route in `wrangler.jsonc`. On deploy, Cloudflare creates the `admin` DNS record and its certificate in the `staffstrangerscoffee.com` zone, as for the rota (delete an existing `admin` record first). It's admins only: anyone else who opens it goes back to the diary, and its API returns 403. `/admin` on the diary forwards there. Sign-in is shared, so admins are already signed in.

Locally there's no second hostname: `npm run dev` passes `--var ADMIN_HOST:` (empty), so the section is at `http://localhost:8787/admin`, and the tests do the same (`test/harness.mjs`). `test/admin.test.mjs` starts a server with `ADMIN_HOST` set to test the address itself.

## Live updates

Open pages are told the moment something changes through one Cloudflare Durable Object (`LiveHub`, `src/live.ts`, declared in `wrangler.jsonc`). Cloudflare creates it on the first deploy; nothing to set up. It's within the Workers Free plan (Durable Objects: 100,000 requests a day; each open page and each change is one), and it saves far more Worker requests than it uses, since idle pages no longer ask every few seconds. If it's ever unavailable, pages quietly go back to asking every few seconds.

## Rota emails (Resend)

The rota emails people their shifts when a week is published, when their shifts change, and when a cover, pick-up or time off is decided (`src/email/`). Nothing is sent until this is set up:

1. Create a free account at resend.com, add the domain `staffstrangerscoffee.com` and use **Auto configure** to add its DNS records in Cloudflare (SPF and DKIM, so emails don't land in spam). This is a DNS change, the host's to make.
2. Create an API key with sending access to that domain.
3. In the Worker: **Settings → Variables and Secrets → Add**, type **Secret**, name `RESEND_API_KEY`, the key as its value.
4. In the admin section, add your own email address (People → you → Edit), then Overview → Rota emails → **Send me a test email**. Add everyone else's addresses the same way.

Managers and admins with an address can receive a summary every Monday at 07:30 for their chosen sites. Managers receive business food-safety information only; employee planning, requests, leave and training aggregates are admin-only. Personal shift/decision emails and calendar files contain only the recipient’s permitted information, without co-worker assignments. Emails come from `Strangers Rota <rota@staffstrangerscoffee.com>` (`EMAIL_FROM` changes the business sender); no employee account address is used as a shared Reply-To. At most 100 are sent a day (`EMAIL_DAILY_LIMIT`). Delete the sending secret to stop emails.

**New wholesale order emails.** With the same Resend key, every new customer order is emailed to sales@strangerscoffee.com from orders@staffstrangerscoffee.com (no mailbox needed: Resend sends for any address on the verified domain). Change who gets them, switch them off or send a test in Admin → Wholesale → Orders → **Order alerts**. Replies go to the customer. The email's **Open the order** button opens it on the staff Wholesale orders page, so anyone with wholesale orders access can use it.

## New wholesale orders in Slack

Every new customer order can be posted to a Slack channel (Strangers uses #C0CH4KT2BS6): the business name, the bags by coffee, size and grind, collection or delivery, any customer comments, and a link to the staff Wholesale orders page. No prices or contact details. Orders placed between 07:45 and 16:45 UK time (Sunday 10:00 to 15:30) are posted straight away; anything earlier or later is held and posted when those hours next start: 07:50, or 10:00 on a Sunday (the 5-minute cron sends it). Nothing is posted until this is set up, once:

1. Go to api.slack.com/apps → **Create New App** → **From scratch**, name it "Wholesale orders", workspace Strangers Coffee. (Free; a Slack admin may need to approve it.)
2. In the app: **Incoming Webhooks** → switch on → **Add New Webhook to Workspace** → pick the orders channel → **Allow**. Copy the webhook URL (it starts `https://hooks.slack.com/services/`). Treat it like a password: anyone with it can post in that channel.
3. In the Worker: **Settings → Variables and Secrets → Add**, type **Secret**, name `SLACK_ORDERS_WEBHOOK_URL`, the URL as its value. Deploy.
4. Admin → Wholesale → Orders → **Order alerts** → **Send a test to Slack**.

Delete the secret to stop the posts. If Slack refuses a post, it's tried again every 5 minutes, up to six times, and then Admin's Overview says so.

## Wholesale Insights and QuickBooks sales history

Admin → Wholesale → **Insights** shows sales, coffee volumes, customers, an 8-week forecast and next week's roast plan from the site's customer orders. To add past years (and a seasonal forecast), import your QuickBooks sales once; no QuickBooks connection is needed:

1. In QuickBooks: **Reports** → **Sales by Product/Service Detail** (or Sales by Customer Detail), choose the dates, run it, then **Export** → **Export to Excel** (or CSV).
2. Insights → **Import QuickBooks history** → choose the file → **Import**. Large files go up in parts; importing the same report again adds nothing twice.
3. Check **QuickBooks products**: which coffee and bag size each product is (anything else, such as delivery, as Not coffee).

History is used up to the first site order unless changed under the roast plan's batch button, so orders later sent to QuickBooks from the site aren't counted twice. Remove an imported file from QuickBooks products → Imported files.

## Change the setup code

In the Worker: **Settings → Variables and Secrets**, edit `SETUP_CODE`. It takes effect immediately and only affects creating the first admin and the "Admin? Forgotten password" recovery. Existing accounts and sessions are unaffected. (`SYNC_TOKEN`, the secret's name before the Claude sync was removed, is still accepted if `SETUP_CODE` isn't set.)

## Back up

The website backs up nightly at 03:17 UTC into KV, keeping the last 30 copies. Only admins can create, list or download backups in **Backups & exports**. Each JSON contains documents, account metadata without credentials, all rota tables and wholesale records. Documents retain their `seq` and `employee_privacy_version`, and top-level `documentSequence` records `meta.seq`. Backups contain private employee information and must remain admin-controlled.

When restoring JSON, restore each document’s path/data, `seq` and `employee_privacy_version` together, and restore `meta.seq` from `documentSequence` without setting it below the restored row sequences. Preserve stable account IDs so `ownerUserId` still identifies the same employee. A protected row is verified only when `employee_privacy_version === seq`; missing/unknown old metadata must remain unverified and admin-only until reviewed. Do not copy a marker onto changed JSON or infer ownership from names. Restore through the validated API for reviewed records, or use a controlled database restore that preserves this complete metadata. For a full database copy from a terminal:

```sh
npx wrangler d1 export kitchen-diary --remote --output backup-$(date +%F).sql
```

Keep backups private: they contain the whole diary, including staff names. D1 also keeps point-in-time history (7 days on the free plan, 30 on paid): `npx wrangler d1 time-travel restore kitchen-diary --timestamp=<ISO time>`. Allergen PDFs and uploaded catalogue photos live in KV and aren't in the JSON or SQL export; keep the originals. Wholesale catalogue records include image references, not image bytes. After restoring to an empty KV namespace, reupload missing photos in Admin → Wholesale → Coffee catalogue. Bundled source photos remain in the repository.

## Run it locally (for code changes)

Needs Node.js 20 or later.

```sh
npm install
cp .dev.vars.example .dev.vars     # a local-only setup code
npm run dev                        # http://localhost:8787
npm test                           # typecheck + API and rota tests (loads src/hosts.ts directly, so Node 22.6 or later)
npm run test:e2e                   # browser test; needs Playwright: npm i -D playwright && npx playwright install chromium
```

To deploy from a terminal instead of from GitHub: `npx wrangler login`, then `npm run deploy`.

## Limits and costs

Everything fits Cloudflare's free tier, with no card needed. One thing to watch: each open diary tab checks for changes every 5 seconds while visible (every 30 seconds in the background), and each check is a Worker request. The free tier allows 100,000 requests a day, roughly eight tablets showing the diary for 12 hours. Beyond that, either move to Workers Paid ($5/month) or slow the polling in `public/claude-shim.js` (`VISIBLE_MS`). KV's free tier allows 1,000 PDF uploads a day and 1 GB of PDFs.

Writes are limited to 600 per IP address per 15 minutes (`WRITE_LIMIT_PER_15_MIN` in `wrangler.jsonc`), set high enough for several staff behind one shop Wi-Fi.

## Accounts

- **Adding people.** Account menu → **Admin** → **Add person**: their name (as it should appear on records), a username (suggested from the name), their role, and a temporary password, or leave it blank to have one created. Give them the username and temporary password in person; they choose their own password when they first sign in. If they've recorded entries under a name before, use exactly that name to keep their history together.
- **Changing a password.** Anyone can: account menu → **Change password**.
- **Forgotten password.** In Admin → People, open the person and set or create a temporary password. That signs them out everywhere and clears their quick PIN.
- **Quick PINs.** Staff and managers set their own (account menu → Set a quick PIN; 4 digits, not repeated or running digits). Switching with a PIN only works on a device someone has signed in on with a password in the last 180 days; elsewhere the list of names is empty. Wrong PINs count towards the same 5-tries lock as passwords. The Admin page shows who has one.
- **Locked out.** Five wrong passwords lock an account for 10 minutes (and each IP is limited to 30 failed attempts per 15 minutes). An admin can **Unlock** it straight away.
- **Someone leaves.** In Admin → People, open them → **Switch off**. They can't sign in, and their records stay.
- **The only admin forgot their password.** On the sign-in page, choose "Admin? Forgotten password" and use the setup code.

Authentication is centralized in `authorize()` (`src/access.ts`), with account/session handling in `src/auth.ts`. Employee authorization also lives in `src/employeePrivacy.ts` and `src/rota/privacy.ts`: only admins or the employee may read private information; manager business permissions do not grant employee administration. Protected get/query/poll/conflict responses and all exports must enforce this on the server. Admin account/team endpoints provide stable IDs for reviewing ownership, including inactive accounts.

## Employee privacy rollout and recovery

Migration 14 runs automatically and adds nullable `docs.employee_privacy_version`. It increments the document change counter and every staff account’s `users.session_ver` once, atomically with the migration claim. Existing sessions and trusted quick-switch devices then require a fresh password sign-in. Existing passwords, password/PIN hashes, business/employee records and browser offline queues are not deleted. Wholesale credentials/sessions remain separate. `GET /api/auth/me` is read-only and must not reset this cutover or silently reauthorize an old session.

Existing JSON ownership/classification claims predate validation and are not trusted. Admins review training and link `ownerUserId` to the correct stable `users.id`; contacts/onboarding must also be classified `shared-business` or `employee`. The server stamps verification only on validated writes. Unreviewed legacy records remain admin-only. Review copies at every relevant site; changing a display name never transfers ownership.

Shared-device clients verify the expected stable account ID and role, including after focus, tab resume and auth changes. An expired, changed or unverifiable session covers private UI, clears private in-memory state and stops unsafe queue replay. Business diary work retains its ordinary offline queue. New private `staff`/`contacts`/`onboarding` writes are online-only and must not create new plaintext local queue entries. Existing unsent queues are preserved, bound to their original owner and quarantined from automatic replay; do not delete user work as a privacy reset. Legacy queue values are not encrypted: someone with DevTools access to the same browser profile can inspect its local storage. Use separate browser/OS profiles where that threat must be excluded. See [the employee privacy audit](docs/employee-privacy-audit.md) for the residual limits. No new secret, hostname or DNS change is required for this rollout.

## Wholesale accounts and ordering

The existing `PREVIEW_HOST` custom domain serves wholesale ordering, its customer sign-in and registration page. Staff use the Staff sign-in link to reach the existing staff login; wholesale customer cookies never sign anyone into the diary, rota or Admin. Deployment uses the normal PR/Cloudflare workflow and needs no additional secrets or DNS changes.

Migration 12 creates isolated wholesale account and session tables and an order lookup index. No manual migration is required. Account metadata and approval state are backed up; passwords and sessions are not. A restored wholesale account needs an admin password reset.

Review requests under **Admin → Wholesale → Customers → the customer → Review sign-in**. Set Approved and allow sign-in to activate the account. Manage sign-in also disables accounts or resets/unlocks their passwords. Customers with temporary passwords choose their own on first sign-in. Approval does not automatically send an email; contact the customer directly.

Under **Coffee catalogue**, add or edit coffees, descriptions, categories, three bag prices, visibility and stock availability. Save a new coffee before adding photos. Uploads and removals save immediately; JPEG, PNG and WebP are supported, up to six photos per coffee and 5 MB each. Original source photos can be restored after removal. Existing source prices are retail references until an admin sets the agreed wholesale prices.

Under **Customers**, set payment terms and customer-facing instructions. Choices are To be agreed, Before dispatch, 7/14/30/60 days from invoice, or Custom with instructions. Existing accounts default to To be agreed. Customers can read these terms but only admins can change them. Each order keeps the terms agreed at checkout; changing a customer's terms requires a new checkout review. This records the agreement without collecting payment. VAT invoices are reviewed and issued separately in Wholesale → Invoicing.

Catalogue and payment-term fields use the existing versioned JSON records; photos use the existing KV binding. This release adds no schema migration, secret, service or DNS change.

For local development, use `npm run dev -- --var PREVIEW_HOST:` and open `/wholesale-preview/`, `/wholesale-preview/signin` or `/admin#wholesale`. Run both test suites before publishing. Source prices remain retail reference prices until edited by an admin; payment and fulfilment integrations remain manual.

Wholesale uses `strangerscoffee.trade` (`PREVIEW_HOST`), with `preview.staffstrangerscoffee.com` retained as `LEGACY_PREVIEW_HOST`. Records and asset paths stay the same; customers sign in again because cookies and browser storage stay with their original hostname. Customer and admin interfaces use the name Wholesale without Beta badges; the new custom domains use the existing Worker and require no new secret or service. Invoice storage is added by automatic migration 13. Shared `/theme.css` is available on the ordering host, including at sign-in. Checkout persists an unresolved submitted request in browser storage per identity before sending; keep that storage until its receipt is confirmed. Payment collection and fulfilment remain with the team; admins can issue invoices in the app under the recorded terms.

The follow-up wholesale UX update uses the same routes, accounts and schema. Customer order history loads 200 owned records per page with an explicit earlier-orders action. Repeat baskets require confirmation at current prices and preserve existing choices. Admin quick-status controls update only the saved status through the existing versioned API; they never trigger shipping, invoicing or payment. Conflicts require refreshing the order before another quick update.

Admin order removal uses optional JSON metadata in the existing table and needs no migration. Backup exports retain removed records for audit/idempotency; the normal UI and order queries hide them. Removal does not change external payments or shipping.

Saved wholesale locations and defaults use optional JSON fields in existing customer/order records; no migration, secret or hostname change is required. Legacy primary addresses and already-submitted request hashes remain compatible. The approved business name is admin-controlled; new checkout clients send the selected location ID.

## Wholesale invoicing

Migration 13 creates versioned supplier settings and immutable invoice/payment records in the existing D1 database. It runs automatically; do not edit shipped migrations 11 or 12. No additional service, secret or hostname is required. Backups include supplier settings, invoice sequence, issued snapshots and payment metadata. Retain those records when restoring so numbers are never reused.

In **Admin → Wholesale → Invoicing → Invoice settings**, enter the legal supplier name/address, VAT registration number, rates, whether catalogue prices include VAT, default coffee/delivery rates, numbering prefix/first number and payment instructions. Save incomplete setup as a draft; invoices require completed and confirmed settings. Do not guess VAT rates or registrations. The first number cannot change after an invoice has been issued.

Open a real customer order and choose **Open invoice**. Review billing/supply dates, bill-to details, VAT rates and optional delivery charge, then preview and explicitly issue. Drafts allocate no number; exact retries recover the same issued invoice. Payment terms come from the saved order, and net periods calculate the due date. Issued records/PDF financial content are immutable; later customer/settings/order edits and order deletion do not remove them. Record payment separately with a date/reference; this updates status only, without moving money. Customers view their own invoices, amounts due and PDFs in My orders. No automatic email, payment collection or credit-note generation is added.


Wholesale dispatch can save an optional tracking link in the existing order JSON. In Admin, Mark dispatched opens a review window; the order editor can change or remove its link later. Customers open tracking from their own dispatched delivery orders. This uses existing authentication/storage and requires no migration, courier service, secret or hostname change. Mobile Admin now has a direct Wholesale tab and Sites under More. Confirmed checkout clears the submitted basket while preserving uncertain recovery and newer different baskets.


## QuickBooks Online: Sandbox and Live

**Wholesale → Invoicing → QuickBooks** provides separate UK/GBP connections, reviewed invoice exports, payment balances and a Sandbox/Live switch. Additive migration 16 moves the shipped Sandbox connection into scoped storage and adds a durable export ledger, observations, signed-event queue and recovery checkpoints in existing D1. The default is Sandbox. Live requires Production app credentials, confirmed company/mappings, successful Sandbox export plus partial/full payment evidence, and a final admin review. Deployment does not activate Live.

The owner sets the independent `QUICKBOOKS_TOKEN_KEY` once as a Cloudflare secret. Admins then manage separate Development/Production client IDs, write-only client secrets and webhook verifier tokens in **QuickBooks → App credentials and setup**. The page provides copyable URLs; the callback defaults to the Admin address. Migration 17 stores these app settings encrypted, excluding them from JSON backups. Existing hosting credentials remain supported as fallbacks. Follow [QuickBooks setup and recovery](docs/quickbooks-integration.md). The five-minute cron processes bounded export/payment work and recovers missed notifications through CDC and owned-invoice sweeps; existing nightly/weekly jobs are unchanged. No new DNS, queue binding or SDK is needed. Intuit app access, company subscription and any fees must be checked separately. Local tests use a loopback simulator; complete actual UK Sandbox VAT/date/rounding acceptance before enabling Live.

Existing Live payment observations continue while Sandbox is active. Exports retain their original company/request ID and do not send emails or collect money. Customers see only their own Live-linked balances; PDFs keep the issued financial snapshot. JSON backups exclude credentials/nonces/leases/Live approval and pause unlinked exports. Raw D1 restores need the disconnect/pause SQL in the guide before traffic resumes; preserve the namespace, frozen operations and remote links for duplicate protection.

## Page loading

The mobile wholesale header is one 64 px row with Coffee/Orders, cart and a native account popover. Existing account/sign-out actions and staff preview Admin access stay available in that menu; desktop retains inline controls. No migration or configuration is required.

The wholesale footer is a compact logo/Terms/Website row using the existing theme. Terms still opens its native window; My orders and email links use the header action. No migration or configuration is required.

The Strangers logo is centred on wholesale sign-in and registration screens, using the same existing image and light/dark styling.

The staff order status filters and print/selection actions share one desktop row, including selection mode. Narrower layouts wrap the actions; desktop filters scroll horizontally when needed, with 44 px action targets.

Maintenance completion notes retain their text and focus during live list refreshes, so Mark as done saves the typed note. Drafts remain in the current page and follow its existing session clearing; no new browser storage is used.

The shared page loader uses the Strangers logo and lightweight, uncached identity checks. First-load metadata and fresh proof remain separate; network failures retry the same protected startup and the retry action resumes it. No configuration or migration is needed. Phone/iPad/desktop light/dark loader, recovery, request-coalescing and privacy regressions are in `test/loader.e2e.test.mjs` and `test/identity.e2e.test.mjs`.


Admin wholesale preparation labels use saved order metadata and the shared light/dark theme. New line snapshots add optional grind-purpose and Decaf fields without a migration. Branding image/icon failures retry once with a fresh URL; a persistent failure is quietly recorded, while script and stylesheet failures retain their visible error cards.

## Staff order dashboard

`/orders` is served on the existing staff domain; no new domain, credentials or service is required. Migration 18 creates `staff_order_access` automatically, with no grants for existing nonadmin accounts. Admins already have access. After deployment, use **Admin → People → employee → Wholesale orders access** to enable or revoke it, and refresh the employee's diary to update navigation. The staff orders API checks current access on every request; revocation takes effect without ending the employee's ordinary diary session. The staff page rechecks on focus and refreshes while visible.

Staff with that access can now also change an order's status (the quick **Mark preparing / ready / dispatched** button, or the status in the order), edit its internal note and tracking link, **Print new orders**, **Select to print**, see **Bags to process**, and open a read-only **Customers** tab (contact and delivery details only). They never see prices, invoices, payment terms or the minimum-order setting, and can't delete orders or change customers.

JSON backups include grant metadata as `staffOrderAccess`, keyed by stable `users.id`. Restore only reviewed grants to the same stable employee IDs; omitting an old backup's missing grant table leaves nonadmins denied. Do not infer grants from names or roles. Existing private employee-data restrictions remain independent.

HTML responses, including Staff Login, are private/no-store and omit conditional validators because the Worker transforms asset fingerprints. Returning browsers receive current script URLs; fingerprinted scripts/styles keep their one-year cache.

## Security review

The [13 November security/privacy review](docs/security-privacy-review-2026-11-13.md) records application access boundaries, encryption and deployment limitations. Customer ordering uses the shared fresh-identity shield and expected-ordering headers; private downloads are no-store. Cross-app writes trust only configured staff hostnames (`COOKIE_DOMAIN`, `ADMIN_HOST`, `ROTA_HOST`, `LEGACY_PREVIEW_HOST`) over HTTPS, not arbitrary sibling subdomains. No new secret, DNS entry or storage migration is needed for these safeguards. D1/KV encryption at rest is automatic; QuickBooks keeps its separate application encryption key. Keep hosting account membership, two-factor authentication and exported backups under independent review.

The root `/favicon.ico` is a real icon using the existing Strangers artwork and is served signed out on every app host. Logo/favicon element recovery is limited to one fresh retry, including the customer sign-in logo. Persistent image failures remain quiet reports; scripts/styles and app-attributed errors remain visible. The specific browser autofill message “Could not find identifiable element” is ignored only when it has no app-owned frame. Historical Activity reports are retained. Rota email actions use a wrapping flex layout with a consistent gap.

## Holidays and absence management

Rota → Holidays gives employees their own balances, requests and the approved annual-leave team calendar. Admins use Manage leave for individual days-based allowances, explicit carry-over, blackout/capacity rules and private absence types. Migration 24 is automatic and preserves existing time off as unclassified. Requests start disabled until an admin configures the policy and employee years; no entitlement or Who’s Off balance is invented. The default leave year starts 1 April and is editable, including 6 April.

[Setup, bank-holiday days in lieu, reconciliation and privacy](docs/leave-management.md) explains the source-of-truth switch. Inclusive bank-holiday days are reserved and released when an admin confirms they were worked; the same entitlement is never granted twice. No new secret, DNS change or external HR subscription is needed.
