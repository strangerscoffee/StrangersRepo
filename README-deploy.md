# Deploying and running the Kitchen Diary

**Wholesale preview:** ordering is at **https://preview.staffstrangerscoffee.com** using the existing Staff Login; admins manage it in **Admin → Wholesale** at `https://admin.staffstrangerscoffee.com/#wholesale`. The same Worker serves both and stores shared preview orders, customers and catalogue settings in D1. No payment, email or fulfilment action is triggered. See [docs/wholesale-preview.md](docs/wholesale-preview.md).

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

Data lives in a D1 database (`kitchen-diary`) and allergen PDFs in a KV namespace. Cloudflare creates both on the first deploy and the Worker creates its own tables, so there are no ids to copy and no migrations to run. The only secret is the **setup code**.

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

Edit the files in `public/` (or `src/` for the API), run the tests, and push to `main`. The deploy takes about a minute. If a deploy fails, the build log is in the Cloudflare dashboard under the Worker → **Deployments**, and GitHub shows a red cross next to the commit.

**Tests on GitHub.** Every pull request, and every merge to `main`, runs the typecheck, the API tests and the browser test (the "Tests" check). If one fails, its error message is shown as an annotation on the check. Cloudflare deploys whatever reaches `main`, so the safe way to change the site is a branch and a pull request, merged once Tests is green. That's a rule on `main` (GitHub → the repo → **Settings → Rules → Rulesets**: "Tests must pass", requiring the **test** status check).

**Auto-merge.** Every pull request into `main` is squash-merged by itself as soon as Tests passes (`.github/workflows/automerge.yml`), then Cloudflare deploys it, so there's nothing to press. If Tests fails, the pull request stays open with a red cross until it's fixed. To hold a change back, open it as a **draft** pull request (or "Convert to draft" on an open one): drafts aren't merged until they're marked "Ready for review". Auto-merge needs **Settings → General → Allow auto-merge** switched on (it is), and squash merging allowed.

## The rota's address

The rota is served by the same Worker on its own hostname, set in `wrangler.jsonc`: the var `ROTA_HOST` (`rota.staffstrangerscoffee.com`) and a third custom-domain route for it, after the diary's two. On deploy, Cloudflare creates the `rota` DNS record and its certificate in the `staffstrangerscoffee.com` zone (it has to be in the same Cloudflare account, as it is for the diary; if a `rota` record already exists, delete it first, as for the diary's own addresses). Nothing about the diary's address changes.

On `ROTA_HOST`, `/` is the rota app; the sign-in page, `/api/auth/*`, `/api/rota/*` and the shared styles work as on the diary; diary pages redirect to `/` and the diary's data API (`/api/db/*`, `/api/assets*`, `/_blob/*`) returns 404. Sign-in is shared: the session cookie is set on the whole domain (`COOKIE_DOMAIN` in `wrangler.jsonc`, `staffstrangerscoffee.com`), so signing in, switching person or signing out on either address does the same on both. There is one sign-in page (**Staff Login**) on the diary's address: `/signin` on the rota redirects there with `next=` as a full link back (`unifiedSignin` in `src/hosts.ts`), and the sign-in page only follows `next=` to its own paths or https subdomains. Anyone signed in from before this was shared is moved over the next time they open the diary or the rota where they are signed in. Locally there's no second hostname: the rota is at `http://localhost:8787/rota/` (`wrangler dev` sends every request as the first route's hostname, `staffstrangerscoffee.com`, which is why the tests start a second server with `--var ROTA_HOST:staffstrangerscoffee.com` to test the rota's own address).

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

Managers and admins with an address also get a summary every Monday at 07:30 (each chooses the sites, or an admin does in People; Overview → **Send me this week's summary** previews it). Emails come from `Strangers Rota <rota@staffstrangerscoffee.com>` (the `EMAIL_FROM` variable changes it); replies go to the manager who made the change. At most 100 are sent a day (`EMAIL_DAILY_LIMIT`), Resend's free allowance. To stop all emails, delete the secret.

## Change the setup code

In the Worker: **Settings → Variables and Secrets**, edit `SETUP_CODE`. It takes effect immediately and only affects creating the first admin and the "Admin? Forgotten password" recovery. Existing accounts and sessions are unaffected. (`SYNC_TOKEN`, the secret's name before the Claude sync was removed, is still accepted if `SETUP_CODE` isn't set.)

## Back up

The website is the only copy of the diary. **It backs itself up every night** (03:17 UTC, the cron in `wrangler.jsonc`) into the KV namespace, keeping the last 30. In Admin → Backups & exports, **Back up now** makes one straight away and **Download** saves any of them: a JSON file with every record (by path), the list of accounts (no passwords or PINs) and the rota's tables (`rota`: shifts, weeks, site settings, contracts and availability, time off and requests). Keep a download somewhere safe now and then; those copies survive even if the Cloudflare account doesn't.

To restore, the JSON's `docs` are documents to write back at their `path`s (ask Claude Code to do it with the db API or `wrangler d1 execute`). For a full copy of the database from a terminal:

```sh
npx wrangler d1 export kitchen-diary --remote --output backup-$(date +%F).sql
```

Keep backups private: they contain the whole diary, including staff names. D1 also keeps point-in-time history (7 days on the free plan, 30 on paid): `npx wrangler d1 time-travel restore kitchen-diary --timestamp=<ISO time>`. Allergen PDFs live in KV and aren't in the export; keep the originals.

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

Access is decided in one function, `authorize()` in `src/access.ts`. Sign-in and sessions are in `src/auth.ts`, the admin API in `src/admin.ts` (accounts) and `src/adminView.ts` (the admin section's overview, people, sites, activity, security and exports). Section permissions are `MANAGER_TABS` and `MANAGER_COLLECTIONS` in `src/access.ts`; the page mirrors `MANAGER_TABS` in `public/diary/shell.js` to hide those sections from staff, but the Worker is what enforces them.

## Wholesale ordering preview

`PREVIEW_HOST=preview.staffstrangerscoffee.com` selects the ordering app on that hostname. Its custom-domain route in `wrangler.jsonc` lets the normal Cloudflare deployment provision DNS/TLS for that subdomain in the existing zone. The domain must be available to this Worker; resolve any conflicting route or DNS record in Cloudflare if deployment reports one. The user requested this hostname. No new secret or separate identity provider is needed.

Staff sign in at the existing domain; the shared `COOKIE_DOMAIN` cookie carries the session back to the preview. Admins open **Wholesale** from the admin sidebar or **More → Wholesale** on phones. The old `/wholesale-preview/dashboard/` path redirects admins to that menu section and refuses non-admins. The preview hostname serves no diary, rota, admin-management or document APIs.

For local development, clear the hostname variables so both apps are reachable locally:

```sh
npm ci
npm run dev -- --var PREVIEW_HOST:
```

Then sign in and use `/wholesale-preview/` and `/admin#wholesale`. Alternatively, keep `PREVIEW_HOST` set and access the configured hostname when testing a deployed Worker.

Migration 11 creates `wholesale_preview` automatically, without changing diary or rota records. The shared preview data is included in nightly and manual backups. Preview edits use record versions, so stale edits return 409 rather than overwrite another admin’s changes. Default prices are sourced retail prices, and admins can change preview prices/visibility. Production customer login, agreed wholesale rates, billing and fulfilment remain outside this preview.
