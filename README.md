# Strangers Coffee Kitchen Diary

The food safety diary (Safer Food, Better Business) for Strangers Coffee's four Norwich sites, online at **https://staffstrangerscoffee.com**. Staff sign in on a phone, iPad or computer and record the day's checks; managers keep the records an Environmental Health Officer asks to see.

It runs on Cloudflare (one Worker, a D1 database and a KV store for PDFs), deployed automatically from this repo. **`README-deploy.md`** covers deploying, secrets, backups and running it locally.

## Sites

| Site | Address |
|---|---|
| Roastery | 10 Dove Street, Norwich, NR2 1DE |
| Cafe | 21 Pottergate, Norwich, NR2 1DS |
| ASG | 14 All Saints Green, Norwich, NR1 3NA |
| Factory | 122 Ber Street, Norwich, NR1 3ES |

Each site has its own diary. The site button at the top (or top of the sidebar) switches between them, and each device remembers its site.

## What's in it

- **Today**: mark the day closed with a reason (bank holiday, maintenance, an unexpected closure) so it isn't counted as incomplete; managers can also plan closures ahead in Setup → Closures & holidays. Progress through the day (temperatures, opening checks, closing checks, sign-off), anything overdue at the site, fridge and freezer readings with advice when one is out of range, the checklists, problems and changes, and one-tap sign-off as the signed-in person.
- **Week**: the week's days at a glance, end-of-week checks, notes and sign-off.
- **Records**: extra checks, cleaning schedule, Prove it checks (pass or fail worked out as you type), a temperature log (every reading by day, with missed readings added and mistakes corrected, keeping the original), allergens (with search, "free from" filters and an allergen matrix PDF generated from the items for all 14 UK allergens), deliveries (temperature, packaging and order checks, accept or reject) and maintenance (equipment problems and jobs, assigned to a person from the team, per site or all sites together).
- **More**: last 4 weeks, **EHO inspection mode** (everyone: pick a period such as the last 1, 2, 3, 6 or 12 months or your own dates, see the daily diary, temperature log, corrective actions, cleaning, Prove it, deliveries, training, maintenance, reviews, allergens, suppliers, the last inspection and HACCP & risk documents in one view, and export it all as a PDF), then **Management** (everyone can read; managers and admins change): the last EHO inspection report, HACCP plans and risk assessments, suppliers, contacts, staff training, onboarding documents and the 4-weekly review; and **Admin** (managers and admins only): Setup.

On phones, Today, Week, Records and More are tabs at the bottom. On iPads in landscape and computers, every section is in a sidebar.

## Accounts

Everyone signs in with a **username and password**. Signed out, only the sign-in page is visible. Three roles:
- **Staff**: record everything in Today, Week and Records; read (but not change) the Management sections. They don't see Setup.
- **Managers**: also change the Management sections (EHO, HACCP & risk, suppliers, contacts, staff training with one tap to add new accounts, onboarding, the 4-weekly review) and use Setup.
- **Admins**: everything, plus the **Admin** page (account menu → Admin), where they add people, change roles, set temporary passwords and switch accounts off.

Records show the person's name (set by an admin), not their username. The first admin account is created on the sign-in page with the **setup code** (see `README-deploy.md`).

**Shared iPads and phones.** Staff and managers can set a 4-digit **quick PIN** (account menu → Set a quick PIN). On a device where someone has signed in with a password, they then switch to themselves from the account menu (**Switch person**), or tap their name on the sign-in page, and enter the PIN. Five wrong PINs lock the account for 10 minutes. Admins always use their password.

**Bad Wi-Fi.** If the connection drops, ticks and readings still work: they show straight away, an "Offline" label says how many are waiting, and they save by themselves when the connection returns.

**Backups.** A copy of the whole diary is made every night and the last 30 are kept. Admins can make one or download any of them from the Admin page.

## What it costs

Everything fits Cloudflare's free tier (Workers, D1, KV and a custom domain) for a team this size, with no card needed. `README-deploy.md` → "Limits and costs" has the numbers to watch.
