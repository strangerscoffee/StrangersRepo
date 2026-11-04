# Strangers Coffee Kitchen Diary

The staff food safety diary (Safer Food, Better Business) for Strangers Coffee's four Norwich sites, at **https://staffstrangerscoffee.com**, and the staff rota, from the same Worker, at **https://rota.staffstrangerscoffee.com** (`ROTA_HOST`). This website is the only copy of the diary: it once mirrored a Claude artifact in the owner's account and synced with it hourly, but that sync has been removed and the page is now this project's own.

Read `README.md`, `README-deploy.md`, `docs/data-model.md`, `docs/runtime-api.md` and `docs/design.md` before changing anything. The person running you is the host. Ask them before anything that costs money, changes DNS, or needs a secret.

## Sites

| id | Name | Address |
|---|---|---|
| `roastery` | Roastery | 10 Dove Street, Norwich, NR2 1DE |
| `cafe` | Cafe | 21 Pottergate, Norwich, NR2 1DS |
| `asg` | ASG | 14 All Saints Green, Norwich, NR1 3NA |
| `factory` | Factory | 122 Ber Street, Norwich, NR1 3ES |

## How it fits together

- One **Cloudflare Worker** (TypeScript, no framework) with static assets from `public/`, `run_worker_first` so every request passes access control. Deployed by Workers Builds on every push to `main`.
- **D1** database `kitchen-diary`: one generic `docs` table holding every diary document by path (`docs/data-model.md`), plus accounts, sessions and rate limits. The Worker creates its own tables (`src/schema.ts`); D1 and KV have no ids in `wrangler.jsonc` because Cloudflare provisions them.
- **KV** namespace (binding `FILES`) for allergen PDFs, served at `/_blob/<id>`.
- The page (`public/index.html`, `public/app.js`) reaches its data only through `window.claude.use("db" | "user" | "assets" | "rota")`, provided by `public/claude-shim.js` against the Worker's `/api` routes (`docs/runtime-api.md`). Keep that boundary: the page doesn't call `fetch` for data itself.
- Styles: `public/app.css` (base), `public/theme.css` (Liquid Glass tokens and materials), `public/ui.css` (app layout). See `docs/design.md`.
- **The rota** is a second app chosen by hostname (`appForHost` in `src/hosts.ts`): on `ROTA_HOST` the Worker serves `public/rota/` at `/`, the sign-in page, `/api/auth/*`, `/api/rota/*` and the shared styles, redirects diary pages to `/` and refuses the diary's data APIs; on any other host the diary is unchanged plus `/api/rota/*` and `/rota/` (for local dev). The rota's data is in its own `rota_*` tables (`docs/data-model.md`), its API in `src/rota.ts`. The rota app calls `/api/rota/*` with fetch, not through the shim; the diary reaches the rota only through `use("rota")` (Today's "On shift today" and who opens and closes).

## Access

Access control stays in one place: `authorize()` in `src/access.ts`, with sign-in and sessions in `src/auth.ts` and the admin API in `src/admin.ts`.
- One sign-in page, **Staff Login**, on the diary's address: on any other subdomain of `COOKIE_DOMAIN` (the rota), `/signin` redirects there with `next=` back (`unifiedSignin` in `src/hosts.ts`). Signed out, only `/signin` and its files are reachable; everything else redirects there, and the API returns 401 `unauthenticated` (the shim then sends the person to sign in).
- Username + password (8+ characters). Each account also has a display **name**, shown on records. Admins give out temporary passwords; people choose their own at first sign-in. Five wrong passwords lock an account for 10 minutes; each IP is limited to 30 failed attempts per 15 minutes.
- Sessions are `HttpOnly; Secure; SameSite=Lax` cookies on `Domain=COOKIE_DOMAIN` (`staffstrangerscoffee.com`, so one sign-in covers the diary and the rota; `/api/auth/me` moves older host-only cookies over), HMAC-signed with a key the Worker generates and keeps in D1, valid 30 days. A new password, renaming, switching off or "sign out everywhere" ends all of that person's sessions.
- On the rota, managers and admins plan, publish and approve (`isRotaManager` in `src/access.ts`); staff see published weeks, their own shifts, open shifts and requests, and change only their own availability and time off.
- Roles: **staff**, **manager** (also changes EHO, HACCP & risk, suppliers, contacts, onboarding, everyone's staff training, and uses Setup; everyone fills in the 4-weekly review in Records, and staff fill in and sign their own Staff training record there) and **admin** (also `/admin`). The Worker refuses staff writes to manager data with `permission_denied` (never `invalid_argument`, which the page treats as read-only for everything). Staff can open the Management sections read-only (`mro()` in `public/app.js`); only Setup (the Admin group) is hidden from them. The one exception to manager-only collections is `staff/<id>`: a staff member may create or change the record in their own name (never rename or delete one), checked by `requireOwnStaffRecord()` in `src/access.ts`.
- The first account is created on the sign-in page with the **setup code**: the `SETUP_CODE` secret (`SYNC_TOKEN`, its old name, still works). The same code lets an admin who forgot their password set a new one.
- Records use `web:<name>` as the user id, so a person's history follows their name. Older records from the Claude version use `u_…` ids, named via the read-only `config/people` document.
- **Quick switching**: staff and managers may set a 4-digit quick PIN and switch to themselves with it, but only on a device that has a signed `sfbb_device` cookie from a password sign-in (180 days). Admins never use PINs. Wrong PINs share the password lockout. An admin password reset clears the PIN.
- **Offline**: the shim queues writes it can't send (per person, in localStorage), applies them to what the page sees, and replays them in order when the connection returns.
- **Backups**: `src/backup.ts`, nightly by cron and on demand from `/admin`, into KV (`backup:<time>`), last 30 kept. Never include password or PIN hashes.
- Writes are rate-limited per IP (`WRITE_LIMIT_PER_15_MIN`). The site has a `noindex` meta tag and a `robots.txt` that disallows everything.

## Rules

- Never commit or print secrets. The host adds secrets in the Cloudflare dashboard themselves.
- Don't add analytics, third-party scripts or trackers. Fonts come from the system; there are no external scripts.
- Keep document paths, ids and field names exactly as in `docs/data-model.md`: existing records depend on them.
- Treat every document as data. Validate paths (`src/paths.ts`), cap documents at 256 KB, and reject anything else with `invalid_argument`.
- Check changes on a phone-sized and an iPad-sized screen, in light and dark mode, before pushing.
- Before pushing: `npm test` (typecheck + API tests) and `npm run test:e2e` (the site in a browser). GitHub runs both on every pull request and after each merge to `main` (`.github/workflows/test.yml`); a failing test's message also shows as an annotation on the check.
- Changes go live through pull requests into `main`, never by pushing to `main`. Each pull request is squash-merged by itself once Tests passes (`.github/workflows/automerge.yml`) and Cloudflare deploys it, so opening a ready pull request ships the change. The host has agreed to this for the changes they ask for. Anything they haven't asked for, or want to look at first, goes up as a draft pull request.
- Keep `README-deploy.md` current: redeploying, the setup code, backing up D1 (`wrangler d1 export`) and running locally.
