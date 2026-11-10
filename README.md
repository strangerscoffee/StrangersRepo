# Strangers Coffee Kitchen Diary

The food safety diary (Safer Food, Better Business) for Strangers Coffee's four Norwich sites, online at **https://staffstrangerscoffee.com**. Staff sign in on a phone, iPad or computer and record the day's checks; managers keep the records an Environmental Health Officer asks to see.

It runs on Cloudflare (one Worker, a D1 database and a KV store for PDFs and catalogue photos), deployed automatically from this repo. **`README-deploy.md`** covers deploying, secrets, backups and running it locally.

## Sites

| Site | Address |
|---|---|
| Roastery | 10 Dove Street, Norwich, NR2 1DE |
| Cafe | 21 Pottergate, Norwich, NR2 1DS |
| ASG | 14 All Saints Green, Norwich, NR1 3NA |
| Factory | 122 Ber Street, Norwich, NR1 3ES |

Each site has its own diary. The site button at the top (or top of the sidebar) switches between them, and each device remembers its site.

## What's in it

- **Today**: mark the day closed with a reason (bank holiday, maintenance, an unexpected closure) so it isn't counted as incomplete. Staff can mark only today closed, and it shows in Admin → Overview; reopening a day or closing an earlier one is for managers and admins, as is undoing a sign-off; managers can also plan closures ahead in Setup → Closures & holidays. Progress through the day (temperatures, opening checks, closing checks, sign-off), anything overdue at the site, fridge and freezer readings with advice when one is out of range, the checklists, problems and changes, and one-tap sign-off as the signed-in person.
- **Week**: the week's days at a glance, end-of-week checks, notes and sign-off.
- **Records**: extra checks, cleaning, Prove it, temperature logs, allergens, deliveries and maintenance. Employees fill in and sign their own training records; admins manage the full staff training record. Training dates, employment dates and notes are private to the employee and admins.
- **More**: last 4 weeks and **EHO inspection mode**, with the business food-safety records for a chosen period and PDF export. Nonadmins see only their own training records, clearly labelled; admins can export the complete staff training pack. **Management** contains EHO, HACCP & risk, suppliers, contacts and onboarding. Shared business information is available to the team; employee contacts and onboarding records are restricted to that employee and admins. Managers and admins retain business Setup access.

On phones, Today, Week, Records and More are tabs at the bottom. On iPads in landscape and computers, every section is in a sidebar.

## The rota

The staff rota is at **https://rota.staffstrangerscoffee.com**: who works where, and when, across the four sites. It's part of the same site (same accounts, same database), and one sign-in covers both. There is one sign-in page, **Staff Login**, at https://staffstrangerscoffee.com/signin: the rota sends people there and back again afterwards, and someone signed in on the diary is signed in on the rota, and the other way round. Signing out, or switching person, does the same on both. The diary links to it (sidebar and More → **Rota**), and the rota links back (account menu → **Open the diary**).

- **Admins** plan, copy and publish each Monday-to-Sunday rota, assign shifts, review staffing checks and requests, and amend actual hours with reasons. The planner, full employee availability, contracts, leave, worked hours, overtime, staffing totals and CSV exports are admin-only. Only admins change employee contracts, availability and assignments. **Managers** retain business site settings such as opening times and minimum cover; this does not grant access to other employees’ records.
- **Employees, including managers**, see only their own assigned shifts in published weeks, their own hours, contract, availability, leave and requests. They can ask for time off, request general cover for their own upcoming shift, cancel their own request and claim a suitable unassigned opportunity. Unassigned opportunities contain business times and job labels, with previous employee notes, actual hours and identities removed. Admins decide requests and cross-person cover. There is no colleague rota or workforce-hours view for nonadmins.
- **Emails** (once set up, see `README-deploy.md`): each employee receives only their own assignments, hours and contract, with their own calendar attachment. Co-worker assignments and personal reply addresses are omitted. Cover and time-off notices reveal only the recipient’s permitted change. Managers can receive a business food-safety summary for their chosen sites; employee planning, leave, requests and training aggregates appear only in admin summaries. Only admins set email addresses; each person controls their own subscriptions.
- **Today** in the diary shows the current employee’s own published shift; admins can see the complete site rota. Nonadmins do not receive colleagues’ names, shifts or actual hours through the diary card.

Which days a site opens comes from diary Setup and planned closures. Managers and admins can set business opening times and minimum cover. Admins also set contracts and availability, assign shifts and publish the rota.

## Admin

Admins have their own section at **https://admin.staffstrangerscoffee.com** (account menu → **Admin** in the diary or the rota). It covers both the Kitchen Diary and the Rota, with the same sign-in; managers and staff who open it are sent back to the diary.

- **Overview**: what needs attention (locked accounts, an unpublished rota, rota requests waiting, a site that isn't set up, someone who hasn't signed in yet, errors on the site in the last day), each with a button to deal with it; how far each site's diary has got today; this week's rota hours and overtime; the last backup; and **Rota emails** (on or not set up, how many went out in the last day, how many people have addresses, and **Send me a test email**).
- **People**: add people, edit accounts, set temporary passwords, unlock, sign out everywhere or switch off. Admins can see each employee’s private rota, contract, availability, leave and training, and review/link older private records to the correct account.
- **Sites**: each site's diary Setup and rota hours side by side, with links to change them, and **Copy setup from another site** for a site that has none yet (the Factory).
- **Activity**: who changed what in the diary, the rota and accounts. The **Errors** tab lists what has gone wrong on staff devices (a page that crashed, a file that didn't load) and on the server, with the page, the device, how many times and when; kept 30 days. Each error has a code such as `E-1V5WJJ`; search for it to find the error, and **Report** lays out everything about it to screenshot or copy.

**When something goes wrong** on a staff device (the page crashes or a file doesn't load), a "Something went wrong" card appears on that screen with the error's code, where it happened and the time, and **Reload** and **Hide** buttons. A screenshot of that card, or of a server message with an `E-` code, is enough to find the problem: send it to whoever looks after the site.

- **Security**: locked accounts, failed sign-ins, quick PINs, **Reset all quick PINs** and **Sign everyone out**.
- **Backups & exports**: the nightly backups (download, or back up now), payroll hours and all shifts as CSV, the people list, and the EHO inspection pack.

Day-to-day business work stays in the diary. Managers use business Setup and site settings, and access their own employee information; admins manage employee planning and private records.

## Accounts

Everyone signs in with a **username and password**. Signed out, only the sign-in page is visible. Three roles:

- **Staff**: complete diary records and their own training, read shared business information and access their own employee records and published shifts. They do not see Setup or other employees’ private records.
- **Managers**: also maintain business EHO, HACCP & risk, suppliers, approved shared contacts/onboarding, Setup and site opening settings. They have the same admin-or-self restrictions as staff for private employee information.
- **Admins**: manage employee planning, private records, record ownership/classification and the **Admin** section, including accounts, security, backups and exports.

**Employee privacy.** A private record belongs to a stable account ID, not a matching display name. Older training, contact and onboarding records remain visible only to admins until an admin reviews and links or classifies them. Shared business contacts and onboarding must be explicitly marked as shared. The privacy rollout signs every staff account out once; sign in again with your existing password. Passwords, PIN hashes, saved records and offline queues are retained.

Records show the person's name (set by an admin), not their username. The first admin account is created on the sign-in page with the **setup code** (see `README-deploy.md`).

**Several devices at once.** Records remain versioned and live updates preserve concurrent changes. Shared-device pages verify the expected stable account ID and role before exposing cached information or replaying queued work. A changed identity/role or unverified session hides private content and clears in-memory private records; offline work stays with its original identity and is not silently deleted.

**Maintenance notifications.** The bell (top right on phones and iPads, in the sidebar on computers) lists maintenance jobs that need someone, across every site: a job assigned to you; for managers and admins, every new job (urgent ones in red); when a job you reported is done (managers see every job done); and a job still open after a day (urgent) or a week. New ones show as a count on the bell and on Maintenance in the menu, and on Today. Opening the bell or Maintenance counts them as seen, on all of that person's devices.

**Shared iPads and phones.** Staff and managers can set a 4-digit **quick PIN** (account menu → Set a quick PIN). On a device where someone has signed in with a password, they then switch to themselves from the account menu (**Switch person**), or tap their name on the sign-in page, and enter the PIN. Five wrong PINs lock the account for 10 minutes and switch the PIN off, so it can't be guessed (tries sent at the same moment count too): the person signs in with their password and sets a new one. A device stays trusted until the person who signed in on it gets a new password, is switched off or is signed out everywhere ("Sign everyone out" in the admin section ends every device's trust); someone then signs in with a password on it again. Admins always use their password.

**Bad Wi-Fi.** Business diary ticks and readings retain their ordinary offline queue. New private training/contact/onboarding saves require a verified online session and are not added to a plaintext local queue. Older unsent private queues are preserved for their original person and held until authorized recovery; they are not automatically replayed under another identity. See [the employee privacy audit](docs/employee-privacy-audit.md) for shared-browser storage limits.

**Backups.** A copy of the whole diary is made every night and the last 30 are kept. Admins can make one or download any of them in Admin → Backups & exports.

## What it costs

Everything fits Cloudflare's free tier (Workers, D1, KV and a custom domain) for a team this size, with no card needed. `README-deploy.md` → "Limits and costs" has the numbers to watch.

## Wholesale

Wholesale keeps its existing address. Wholesale customers register and sign in at **https://preview.staffstrangerscoffee.com**. Admins must approve new registrations in **Admin → Wholesale → Customers** before customers can access the catalogue or order. Wholesale identities never grant staff access. Customers manage delivery details, place orders, view their history and build a repeat basket at current prices. Admins review orders, update statuses and manage accounts at **https://admin.staffstrangerscoffee.com/#wholesale**.

**Coffee catalogue** adds and edits coffees, descriptions, categories, bag prices and photos. Admins can upload or remove photos, mark a coffee out of stock while keeping it visible, or hide it. Out-of-stock and hidden coffees cannot be ordered. **Customers** sets each business's payment terms and instructions; customers see them in My account, checkout and their saved orders. Prices, delivery details and payment terms are saved with each order so later edits preserve its original agreement.

Existing staff can still use Staff sign-in for clearly marked preview orders. Orders and account details are shared in D1; payment, email and fulfilment integrations are not automatic. See [docs/wholesale-preview.md](docs/wholesale-preview.md).

Wholesale uses the same Liquid Glass design system as the staff apps, including phone/iPad layouts, dark mode and accessibility preferences. Admin search and Load more reach older orders/customers; dashboard totals cover all customer orders. Interrupted checkout submissions are recovered or retried using the original request, including after reload.

My orders shows each order’s progress and saved details, with Load earlier orders for the full history. Order again previews current prices and availability, explains skipped coffees and asks before merging bags into the existing basket. Admin order rows offer version-checked preparation shortcuts; the packing view separates quantities, bag sizes, grinds, delivery instructions and saved payment terms.

Admins can remove customer or staff-preview orders after confirmation. Removed orders leave histories and preparation totals; audit and duplicate-request protection are retained, and payments remain unchanged.

Wholesale keeps the approved business name fixed. Customers and admins can maintain named delivery locations and choose a default; checkout selects the destination, and orders retain its original address. Customer navigation, footer and empty baskets are simplified, and grind/location choices use built-in sheets.

Wholesale now uses wider grouped desktop editors, a viewport-sized basket and a wider workspace. Pending account reviews appear only as a count beside Customers. Admins configure supplier/VAT details under Invoicing, preview and issue VAT invoices from saved orders, and record payments. Customers can view issued invoices, payment terms, due dates, outstanding balances and PDFs in My orders.
