# Deploying and running the Kitchen Diary

**Wholesale:** customers register at **https://strangerscoffee.trade** and wait for admin approval. Manage registrations, customer accounts and orders in **Admin → Wholesale** at `https://admin.staffstrangerscoffee.com/#wholesale`. Wholesale credentials are separate from staff credentials. No new secret or external identity provider is required. See [docs/wholesale.md](docs/wholesale.md).

The customer domain and `www.strangerscoffee.trade` are Worker custom domains declared in `wrangler.jsonc`; `www` redirects to the bare address. Deploying requires the purchased zone to be active in the same Cloudflare account as the Worker, with no conflicting DNS record on these names. Cloudflare provisions the custom-domain DNS records and TLS certificates. The staff, rota and Admin domains stay separate; QuickBooks OAuth/webhook URLs stay on Admin.

The consumer preview at `https://preview.staffstrangerscoffee.com/` serves retail only. Wholesale customers use their existing credentials at `https://strangerscoffee.trade/`, where their accounts, saved orders, catalogue and invoices remain available. Sessions, browser baskets and pending checkout payloads from the former preview address stay with that origin. Staff sign in on the staff domain and open `https://staffstrangerscoffee.com/wholesale/`.

The branded consumer storefront is maintained in `public/consumer-preview/`. The packaging command verifies the current storefront inventory and can export it for local review. Consumer accounts, order snapshots, tracking and the support inbox use a separate retail database. Deploy additive retail database migrations and the signed retail service before releasing storefront and Consumer Admin changes through the normal GitHub workflow. Keep catalogue additions and the shared cart-pricing rules in sync with the retail service build.

Consumer checkout records test payments and fulfilment. A real payment gateway, order email sender and carrier integration require dedicated retail configuration. Staff can review test orders, pack them, record tracking and reply to preview support messages in **Admin → Consumer (Preview)**.

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
   - Build command: leave empty to use the build command in `wrangler.jsonc`. Deploy command: `npx wrangler deploy`.
   - Click **Deploy**. Cloudflare creates the database, the PDF store and the address.
3. **Add the setup code.** In the Worker: **Settings → Variables and Secrets → Add**, type **Secret**, name `SETUP_CODE`, value a long random string (32+ characters). It must be a runtime secret, not a build variable. Keep it somewhere safe.
4. **Create the first admin.** Open the site. With no accounts yet it shows "Set up the first admin": enter your name, a username, a password and the setup code.

## Changing the site

Shared motion and skeleton loading run entirely in the existing theme and shared browser helpers. Admin, rota/holidays, diary records, customer catalogue/history/invoices and staff fulfilment use neutral placeholders for first data loads. Background refreshes retain their content and drafts. The Strangers sign-in shield remains immediate and branded; reduced motion stops shimmer and page reveals, and identity/permission locks cancel decorative exits. No new service, dependency, secret, migration or setup is required.

The wholesale filter and order-history window use locally served motion adapted from the free Transitions.dev dropdown and modal examples. Native popover/dialog controls retain focus, Escape and session verification; reduced-motion and identity locks suppress decorative motion. No external runtime library, account, API key or new setup is required.

Worker initialization caches completed schema readiness and resolved session-signing keys per database, never a pending promise created by another request. An interrupted cold request cannot trap later page/API loads. Existing persisted signing keys and database migrations are retained; this fix requires a normal redeploy and no setup or credential changes.

**Custom coffees:** Admin → Wholesale → Custom coffees manages products for selected customers. Existing white-label assignments appear here automatically. New custom coffees start hidden and remain private when no customers are selected; access is enforced for catalogue responses, new orders and uploaded photos. General coffees remain in Coffee catalogue. These settings use the existing versioned catalogue records; no new migration, secret or setup is required.

The customer catalogue uses a compact Strangers Wholesale/cart/account header. Phones keep Orders & invoices inside the account menu; desktops also have a direct shortcut. All mobile controls stay inside the 64 px header, and the global bag-size control retains its accessible label without extra visible text. The footer uses Strangers Coffee Company. The verified contact-name greeting replaces My account, updates after contact saves, and clears on identity loss. Frame-filling product photos and readable photo labels lead vertical phone cards and horizontal desktop cards; edges may crop to fit. Category filters use a clear segmented track and accent selection. Bag weight and bean/grind use native animated dropdowns. Desktop search expands from its icon beside the weight selector and sort control; mobile keeps full-width search. The cart opens a native basket window, and Order again opens the existing current-price confirmation. Drafts, custom coffees, configured grinds, hidden prices and uncertain checkout recovery retain their existing safeguards. Search and choices survive resizing. Focus feedback is neutral and keyboard-only through the shared local input-modality helper. No service, dependency, database migration, secret or configuration change is required.

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

## Royal Mail for wholesale dispatch

**Admin → Wholesale → Royal Mail** shows which carrier settings are configured and controls new bookings. Bookings start off. Once the Click & Drop key and service are configured, an admin can turn them on. Switching off stops new requests before they are sent. Existing labels, tracking and manual dispatch stay available, and requests already sent to Royal Mail can finish.

In **Admin → Wholesale → Order details**, the **Royal Mail shipping** panel prepares postage for one packed parcel within Great Britain. Review the recipient, delivery address and sealed parcel weight before booking. The packing desk shows label readiness and the latest carrier scan. **Mark dispatched** confirms physical handover and uses the verified Royal Mail tracking link and label address in the dispatch email when available. Existing invoicing rules apply at handover.

Employees with **Wholesale orders access** can also request a label from the staff packing desk. The staff flow uses the delivery address saved on the order and the service enabled by Admin. It checks the account before booking, downloading the PDF and confirming a Royal Mail handover. Staff see a short reason for a hold. Admin manages the underlying invoices, credentials, address corrections and shipment verification.

An account on hold or with an overdue balance needs review even if this order is paid. An order on before-dispatch terms needs a confirmed settlement covering that order. Standard credit terms allow a delivery while payment is within terms. Custom or unspecified terms need settlement evidence or Admin review. The account’s Hide prices and Never invoice settings do not establish payment. Unresolved payment evidence, including a positive invoice marked as billed elsewhere without a verified balance, goes to Admin for review. When QuickBooks supplies the settlement needed to clear a prepayment order, its balance must have been checked within the past 24 hours. Admin can refresh that invoice’s balance and staff can check the order again.

- In **Click & Drop**, save the API key and verified booking service for your account. Add the service register code and shipping account name if your account requires them. Integrated label download requires an Online Business Account. [Click & Drop API](https://help.parcel.royalmail.com/hc/en-gb/articles/360011462338-Integrating-with-the-Click-Drop-API)
- In **Carrier tracking**, enter credentials for a Royal Mail Tracking V2 app and confirm the account holder's acceptance of the Tracking API terms. Staff can then refresh an attached shipment to fetch its latest event. [Tracking API](https://developer.royalmail.net/product/175625/api/76888)
- Admin credential entry derives a separate Royal Mail encryption key from the existing Worker secret `QUICKBOOKS_TOKEN_KEY`. Existing Royal Mail Worker settings are used for each connection until an admin saves credentials for it. Saved secrets are write-only and excluded from JSON backups. Replacing the hosting key means re-entering credentials encrypted with the previous key for both integrations.
- Use **Check label request** after an unconfirmed booking. If a recorded shipment needs verification, compare the reference, destination and parcel details in Click & Drop before entering its tracking number and verifying the existing shipment. Use Click & Drop to finish, cancel or reset postage. The dispatch form also accepts a link from a different courier for a parcel sent separately.

## New wholesale orders in Slack

Every new customer order can be posted to a Slack channel (Strangers uses #C0CH4KT2BS6): the business name, the bags by coffee, size and grind, collection or delivery, any customer comments, and a link to the staff Wholesale orders page. No prices or contact details. Orders placed between 07:45 and 16:45 UK time (Sunday 10:00 to 15:30) are posted straight away; anything earlier or later is held and posted when those hours next start: 07:50, or 10:00 on a Sunday (the 5-minute cron sends it). Nothing is posted until this is set up, once:

1. Go to api.slack.com/apps → **Create New App** → **From scratch**, name it "Wholesale orders", workspace Strangers Coffee. (Free; a Slack admin may need to approve it.)
2. In the app: **Incoming Webhooks** → switch on → **Add New Webhook to Workspace** → pick the orders channel → **Allow**. Copy the webhook URL (it starts `https://hooks.slack.com/services/`). Treat it like a password: anyone with it can post in that channel.
3. In the Worker: **Settings → Variables and Secrets → Add**, type **Secret**, name `SLACK_ORDERS_WEBHOOK_URL`, the URL as its value. Deploy.
4. Admin → Wholesale → Orders → **Order alerts** → **Send a test to Slack**.

Delete the secret to stop the posts. If Slack refuses a post, it's tried again every 5 minutes, up to six times, and then Admin's Overview says so.

## Daily diary reminders in Slack

The Cafe, ASG and the Roastery each get two messages a day in their own channel, saying what's still to do in the Kitchen Diary at that site: today's opening and closing checks, fridge and freezer temperatures and the day's sign-off; the last open day if it wasn't signed off; the end-of-week checks and sign-off (last week if it wasn't signed off, and this week on its last open day); and any overdue cleaning, extra checks, fire safety checks or 4-weekly review. Nothing is sent on a day the site is closed. Times (UK):

| Site | Channel | Secret | Monday–Friday | Saturday | Sunday |
|---|---|---|---|---|---|
| Cafe | #cafe-internal | `SLACK_CAFE_WEBHOOK_URL` | 9:00 and 17:00 | 9:00 and 17:00 | 9:00 and 15:30 |
| ASG | #asg-internal | `SLACK_ASG_WEBHOOK_URL` | 8:15 and 16:30 | 9:00 and 17:00 | 10:45 and 16:00 |
| Roastery | #roastery-internal | `SLACK_ROASTERY_WEBHOOK_URL` | 9:00 and 17:00 | 9:00 and 17:00 | 10:45 and 16:00 |

The times are in `src/slackDiaryText.ts` (`SLACK_DIARY_TIMES`). To set up each channel, once:

1. In the same Slack app as the order posts (api.slack.com/apps → your app; or create one, "Kitchen Diary"): **Incoming Webhooks** → **Add New Webhook to Workspace** → pick the site's channel → **Allow**. Copy the URL (it starts `https://hooks.slack.com/services/`). Each channel has its own URL; treat it like a password.
2. In the Worker: **Settings → Variables and Secrets → Add**, type **Secret**, the name from the table, the URL as its value. Deploy.
3. Admin → Sites → the site's card → **Send a test morning message**.

Delete a secret to stop that site's messages. If Slack refuses one, it's tried again on the next 5-minute runs (three times, within 45 minutes of its time), then Admin's Overview says so.

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

Migration 12 creates isolated wholesale account and session tables and an order lookup index. Migration 28 creates the password-reset table and index automatically on both new and upgraded databases. The customer sign-in page emails one-time, one-hour recovery links using the existing Resend setup; reset tokens stay out of backups. The normal API and browser test commands include the reset journeys. No manual migration is required. Account metadata and approval state are backed up; passwords and sessions are not. A restored wholesale account needs an admin password reset.

Customer sign-in and recovery share the approved compact panel: a smaller logo, visible heading, centred recovery/back links, Show/Hide password controls, and a Help/Terms footer labelled Strangers Coffee Company. Recovery moves to a generic confirmation that never reveals account existence; retries preserve the identifier and prevent duplicate requests. Registration, invitations, temporary-password changes and reset links keep the existing APIs. Credentials stay in form memory, password visibility resets on navigation/page restore, and forms stay disabled until their script initializes. No new migration, dependency, secret or setup is required for this layout update.

Review requests under **Admin → Wholesale → Customers → the customer → Review sign-in**. Set Approved and allow sign-in to activate the account. Manage sign-in also disables accounts or resets/unlocks their passwords. Customers with temporary passwords choose their own on first sign-in. Approval does not automatically send an email; contact the customer directly.

Under **Coffee catalogue**, add or edit coffees, descriptions, categories, three bag prices, visibility and stock availability. Save a new coffee before adding photos. Uploads and removals save immediately; JPEG, PNG and WebP are supported, up to six photos per coffee and 5 MB each. Original source photos can be restored after removal. Existing source prices are retail references until an admin sets the agreed wholesale prices.

Under **Customers**, set payment terms and customer-facing instructions. Choices are To be agreed, Before dispatch, 7/14/30/60 days from invoice, or Custom with instructions. Existing accounts default to To be agreed. Customers can read these terms but only admins can change them. Each order keeps the terms agreed at checkout; changing a customer's terms requires a new checkout review. This records the agreement without collecting payment. VAT invoices are reviewed and issued separately in Wholesale → Invoicing.

Catalogue and payment-term fields use the existing versioned JSON records; photos use the existing KV binding. This release adds no schema migration, secret, service or DNS change.

For local development, use `npm run dev -- --var PREVIEW_HOST:` and open `/wholesale/`, `/wholesale/signin` or `/admin#wholesale`. Run both test suites before publishing. Source prices remain retail reference prices until edited by an admin; payment and fulfilment integrations remain manual.

Wholesale browser assets now ship from `public/wholesale/` at `/wholesale/`. Old `/wholesale-preview/` pages retain their queries when redirected, and old asset URLs resolve to the same deployed files for cached tabs. The client module graph is data-free and loads after session expiry; its catalogue still requires an authenticated API response. The source-price snapshot lives only under `src/wholesale/`. Keep the existing basket/pending-request storage keys, cookies, database names and host variables. This path change requires no migration, secret, DNS or service setup.

The approved desktop/mobile polish is confined to the customer catalogue CSS and its local feedback: lighter cards, tighter spacing, quieter labels, a scroll-only header shadow and Added/check/count confirmation. It uses the shared theme and existing live catalogue; no demo data, new service, migration or setup is needed. Motion respects reduced-motion and session shielding. Standard API/browser suites and phone/iPad light/dark checks remain required before publishing.

Wholesale uses `strangerscoffee.trade` (`PREVIEW_HOST`). Staff ordering is available on the staff domain at `/wholesale/`. Customer and admin interfaces use the name Wholesale without Beta badges. Shared `/theme.css` is available on the ordering host, including at sign-in. Checkout persists an unresolved submitted request in browser storage per identity before sending. Keep that storage until its receipt is confirmed. Payment collection and fulfilment remain with the team. Admins can issue invoices in the app under the recorded terms.

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

The [13 November security/privacy review](docs/security-privacy-review-2026-11-13.md) records application access boundaries, encryption and deployment limitations. Customer ordering uses the shared fresh-identity shield and expected-ordering headers. Private downloads are no-store. HTTPS cross-app writes trust the configured staff hostnames (`COOKIE_DOMAIN`, `ADMIN_HOST` and `ROTA_HOST`). The retail preview is outside this trust list. D1/KV encryption at rest is automatic. QuickBooks keeps its separate application encryption key. Keep hosting account membership, two-factor authentication and exported backups under independent review.

The root `/favicon.ico` is a real icon using the existing Strangers artwork and is served signed out on every app host. Logo/favicon element recovery is limited to one fresh retry, including the customer sign-in logo. Persistent image failures remain quiet reports; scripts/styles and app-attributed errors remain visible. The specific browser autofill message “Could not find identifiable element” is ignored only when it has no app-owned frame. Historical Activity reports are retained. Rota email actions use a wrapping flex layout with a consistent gap.

## Holidays and absence management

Rota → Holidays gives employees their own balances, requests and the approved annual-leave team calendar. Admins use Manage leave for individual days-based allowances, explicit carry-over, blackout/capacity rules and private absence types. Migration 24 is automatic and preserves existing time off as unclassified. Requests start disabled until an admin configures the policy and employee years; no entitlement or Who’s Off balance is invented. The default leave year starts 1 April and is editable, including 6 April.

[Setup, bank-holiday days in lieu, reconciliation and privacy](docs/leave-management.md) explains the source-of-truth switch. Inclusive bank-holiday days are reserved and released when an admin confirms they were worked; the same entitlement is never granted twice. No new secret, DNS change or external HR subscription is needed.

## Daily Admin overview

The Overview uses the existing authenticated admin endpoint and shared theme. Customer-order queues exclude staff previews and deleted records, and aggregate all matching records beyond the first page. Invoices reuse existing manual/Live accounting balances; uncertain balances are marked for review. Annual leave is separated from legacy/other absences. Site deadlines use saved weekday opening/closing hours (no assumed times), with only published unassigned shifts shown as live cover. Set site hours in Rota settings to enable deadline labels. Routine notices and email tests remain under System & accounts. A missing completed backup older than 36 hours and server errors within the last hour are surfaced as alerts. This release adds no migration, service, secret, DNS or dependency.

**Due today** links to customer orders with a saved dispatch date of today in London. Orders without a scheduled date still appear in the wider fulfilment queues. Use the Wholesale section picker on phones or the sidebar on desktop. Section links use `/admin#wholesale/orders`, `/admin#wholesale/invoices` and the equivalent routes for other sections. Order settings contains announcements and order alerts. Insights separates Roast plan, Forecast and Sales. The forecast and roast calculations use the same inputs as before. Activity dates use London calendar days and error references are searchable under Errors.

## Forecast model comparison

The forecast engine can compare recent averages, damped trends, an outlier-resistant fit, intermittent ordering and a repeating order pattern using the existing weekly records. It evaluates at most 16 historical origins and bounded leads, using only outcomes observable at each cutoff; model switches require a measured improvement in root mean squared error over the fallback. This targets expected volume instead of rewarding zero predictions for occasional sellers. No dependency, service, secret, new import, migration or configuration is needed. Model fits use a bounded two-year window.

Each coffee starts at its first positive recorded sale; pre-launch calendar zeros do not become its trading history. Forecast lead lengths use actual week dates, including the unfinished-week gap. Total predicted grams equal the sum of the coffee predictions. Estimated ranges use historical prediction errors from the same bottom-up process, with a limited-history fallback. Insights labels the current week as partial and keeps it out of training, reports historical test error and avoids an unverified 80% coverage claim.

Existing report totals, imports, saved orders, invoice records, source cutover and open-order/stock/batch planning rules remain in place. Unknown import coverage and ambiguous accounting/order matches cannot be inferred by the statistical model. The normal API/browser suites and phone/iPad light/dark checks remain required before publication.

## Production audit corrections — 15 November 2026

This release fixes customer-specific legacy catalogue/photo access, standing-order stock checks and failure recovery, staff order duplicate recovery, invoice/amendment concurrency, actual-hours concurrency, monthly payroll reconciliation, roast dispatch timing and spreadsheet-safe CSV exports. No migration, dependency, secret, DNS or service change is required.

Monthly overtime still uses weekly contract thresholds but is assigned to the dates worked. Calendar-month worked hours now equal basic plus overtime, including month boundaries. Saved shifts, issued invoices and payments are not rewritten. Re-download payroll CSVs when reviewing historic month boundaries. The rota's actual-hours form sends the reviewed revision; a stale or old cached editor must reload before saving.

The existing five-minute cron can recover up to three closed standing runs with missing next deliveries per invocation, including older dangling claims. It preserves the claimed ID where present and never recreates existing or deleted child records. Healthy orders are unaffected. Future dispatches are excluded from next week's roast demand; already booked next-week volume is reconciled with the forecast.

Staff order recovery persists the original, identity-bound business payload before sending. After a lost response or reload, Check submitted order retrieves only that staff member's owned receipt, or retries exactly the same request. Closing the window retains recovery. Close if unplaced recovers any saved order or atomically reserves the unused UUID, allowing a corrected new order without a delayed duplicate; it never cancels an existing order. Browser storage failure prevents submission; user-controlled browser-profile storage is not encryption. Other accounts cannot automatically replay or see that attempt through the app. Live release verification uses reads only.

## Wholesale delivery recovery (migration 30)

A normal deploy automatically appends migration 30; no new secret, service or dependency is needed. Dispatch emails now use a durable D1 event committed in the same transaction as the order status. The five-minute cron retries temporary failures, using the same Resend idempotency key and bounded sending leases. A sent timestamp means provider acceptance, rather than mailbox delivery.

Admin → Wholesale → Orders → Order alerts shows queued, failed and uncertain dispatch emails and Slack posts. Known failures can be retried. Uncertain sends require checking whether they arrived and explicitly accepting the possible duplicate before retrying. Slack webhooks have no idempotency facility, so interrupted Slack attempts pause for review. Old Slack sent markers are preserved: the previous schema cannot distinguish a genuinely acknowledged send from an interrupted claim. They are not automatically replayed. Legacy dispatch failures identifiable in the audit log have a separate explicit review action.

Standing deliveries check current business eligibility, coffee visibility, stock, pack and grind before a new run is priced. Unavailable next deliveries retain the closed run and show an admin review notice plus a generic customer message. Correct the catalogue/account and save the closed standing order again, or untick its standing schedule to stop it. The bounded repair job also retries eligible runs after a short backoff.

Backups now capture all table reads in one D1 batch transaction, retaining matching leave charges, absences, invoice numbering and document sequence/privacy metadata. Dispatch events are included; unsent events export as uncertain with no active lease, requiring delivery review after any manual restore. PDF/photo uploads cancel unknown-length streams at their existing 20/5 MiB limits.

Admin asset recovery serves implementation-only JS/CSS independently of session/database health, while pages, APIs, photos and source-price snapshots remain protected. The ordered Admin bootstrap retries failed network script loads once and stops dependants after a persistent failure; stylesheets also retry once. This fixes expired/cached Safari startup and prevents missing-core `SC` cascades. Existing fingerprint/cache behavior is retained. No new secret, migration, DNS or service is required.

## Email inbox placement and feedback (migration 31)

Wholesale messages use `Strangers Wholesale <orders@staffstrangerscoffee.com>` with an optional `ORDER_EMAIL_FROM` override. Customer emails resolve the current order address. Before sending or retrying dispatch mail, the Worker checks the order status and the customer email preference. If the address changed after an unconfirmed attempt, Admin must review delivery before retrying. Sign-in links use the current order address and expire when that address changes.

Admin → Wholesale → Orders → Order alerts → Email health shows provider acceptance separately from delivery to the receiving mail server, delays, bounces, complaints and suppression. Delivery never proves inbox placement. Opening health and returning preserves unsaved alert settings. Only admins can read message metadata, including staff recipients. No email body, reset/invitation/unsubscribe link or provider credential is persisted in the new feedback tables.

Resend feedback setup:
1. Add `https://admin.staffstrangerscoffee.com/api/email/resend-webhook` in Resend → Webhooks. Select `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`, `suppression.added` and `suppression.removed`.
2. Store its full signing secret in the existing Cloudflare Worker as the **secret** `RESEND_WEBHOOK_SECRET`. Never put it in git, a public variable, chat, an email or a backup. An unset/invalid secret leaves feedback disabled.
3. Keep open/click tracking disabled in the Resend sending-domain settings for operational mail.
4. Verify a received Gmail/Outlook message's original headers for aligned SPF, DKIM and DMARC. Published DNS and provider acceptance are separate from this check. No real test mail is sent automatically.

The host selected `sales@strangerscoffee.com` for DMARC aggregate reports. Add these TXT records (initial monitoring policy):

| DNS zone | Full record name | Value |
| --- | --- | --- |
| `staffstrangerscoffee.com` | `_dmarc.staffstrangerscoffee.com` | `v=DMARC1; p=none; rua=mailto:sales@strangerscoffee.com;` |
| `strangerscoffee.com` | `staffstrangerscoffee.com._report._dmarc.strangerscoffee.com` | `v=DMARC1;` |

Publish the second record with the authoritative DNS provider for `strangerscoffee.com`. `EMAIL_DMARC_REPORT_TO` can override the reporting inbox and changes which receiving domain must publish the authorization. **Email health → Check published DNS** checks the sending policy, reporting address, external authorisation, Resend DKIM and bounce-domain SPF.

Callbacks verify the raw bytes using Svix HMAC-SHA256, header freshness and event-ID deduplication before storage. Invalid requests do not initialize or query D1. Events arriving before the send acknowledgement are retained for later correlation; failure/complaint states cannot be downgraded by older delivery events. Suppression updates use event time, not arrival order, and a replay cannot mutate them. Verified hard bounces, complaints and provider suppression block future sends locally; only verified provider removal clears the block. Resend's own suppression list remains authoritative. Active suppression is retained in backups alongside minimal metadata/events; the signing secret stays outside D1/backups.

Migration 37 records staff rota publication, Monday summary and holiday reminder jobs before sending. The existing five-minute cron retries temporary failures. Holiday history distinguishes a queued or failed attempt from Resend acceptance. Email health shows weekly totals for pending staff email and Activity identifies failures. Backups keep staff job metadata for review after a restore.

Rota mobile leave and Requests refinement (17 November 2026): sheet content/date controls stay inset and scroll within the available viewport. Half-day dates stay synchronized, and stale previews cannot re-enable submission after edits. Time-off decisions open the existing protected review before approve/decline; queue cards identify the absence type and dates. No API, migration, secret, dependency or DNS change. Standard tests plus phone/iPad light/dark layout and decision flows are required before deploy.

## Public retail preview

The public preview is at `https://preview.staffstrangerscoffee.com/`. Older `/shop/` page links forward to the storefront. The retail account and checkout routes are isolated from staff and wholesale. Wholesale sessions, order drafts and browser storage are never imported into retail.

Edit the production storefront in `public/consumer-preview`. Account, cart and availability files live alongside the other storefront assets. The shared Worker handles the retail API, account and checkout routes.

Run `npm run package:branded-retail` to verify the storefront inventory. The production asset build runs the same check. For new storefront files, add them to Git or mark them with `git add -N`. After adding, removing or renaming files, run `npm run package:branded-retail -- --update-manifest` and include the manifest in the change.

For local review, run `npm run package:branded-retail -- --out /tmp/strangers-storefront-review`. Choose a new directory with an existing parent outside the repository. The export copies the storefront files and manifest byte for byte. For account and checkout flows, use the shared Worker and its retail APIs. Historical `--dist` and `--revision` imports are retired.

The [standalone retail preview guide](docs/retail-dev-preview.md) covers the older local shop and its Instagram feed.
