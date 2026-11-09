# Design notes

How the Kitchen Diary looks and why, for anyone changing it. The style follows Apple's Liquid Glass conventions, since most staff use iPhones and iPads.

## Layout

- **Phones and iPads in portrait** (under 1024 px): a top bar with the site button and the account button (initials), a large page title, and a floating tab bar at the bottom: **Today**, **Week**, **Records**, **More**. Records and More are lists of sections; a section opened from them has a back link to its list.
- **iPads in landscape and computers** (1024 px and up): a sidebar with the site button, every section the person can open (grouped Diary, Records, Management) and the account button at the bottom.
- Sections a person's role can't open aren't shown; the Worker refuses them anyway.
- `html` has scroll padding so anything scrolled into view (a focused field, an opened form) stays clear of the top bar and tab bar.

## Patterns

- **Today** leads with a progress bar (Temps, Opening, Closing, Sign off) and anything overdue at the site (two reminders at most; any more fold under one "N more overdue" row, so the day's checks stay near the top), then one card per part of the day. On a phone in the morning, Closing checks start folded until the opening checks are done or it's 2pm. A card is open while it has something to do and collapses to a one-line summary when done; tapping its header opens or closes it.
- **Sign-off** signs as the signed-in person, so nobody types a name. The big "Sign off as …" button appears once everything is done and floats above the tab bar until you reach it. With gaps, "Sign off anyway" needs a note under Problems first.
- **Temperatures** turn green or red as they're typed, with a tick or warning. An out-of-range reading shows what to do and a button that starts the Problems note.
- **List sections** (cleaning, extra checks, allergens, suppliers, contacts, staff training) list items as rows that open in place for details, history and Edit. Their add/edit form stays closed until someone taps **Add …** in the page heading or **Edit** on a row; it closes on save or Cancel.
- **Quick actions sit on the row**: Done on a cleaning job, a call button on a contact or supplier, "Trained today" on a training topic.
- **Wide-only views**: the full allergen chart and the staff training chart need the width, so they only show from 1024 px; phones get the lists.
- **Undo instead of "are you sure"**: Done on a job and Tick all show a toast with **Undo** for 5 seconds; sign-off has its own Undo. Deleting still asks twice (tap Remove, then confirm).
- **The Add button** in the heading opens a section's form, starts a document directly, or shows a short menu when there's a choice (HACCP plan or risk assessment).
- **Records and More rows show live status** (what's overdue, the last result, how many items), so people can see where to go without opening each section.
- **Intros** are two lines on phones; tapping shows the rest.
- **Offline**: a small amber label under the top bar ("Offline · 2 changes waiting") appears only while there's no connection or queued changes are saving; "Back online. All changes saved." confirms when they've gone.
- **Quick switching** uses a 4-digit PIN pad in a bottom sheet (`public/pinpad.js`), with large keys, dots for progress, a shake and message on a wrong PIN, and keyboard support.
- **Status colours**: green done or in range, amber part done or due, red missed, overdue or out of range. Status is never colour alone: each also has text or an icon.

## The rota

The rota (`public/rota/`, at `rota.staffstrangerscoffee.com`) is its own app in the same look: it loads the diary's three stylesheets and adds `rota.css`. Same top bar, sidebar, account menu, sheets and toasts; its own tabs: **My shifts**, **Open shifts**, **When I work** for staff; **Week**, **My shifts**, **Requests** (with a count) and **More** for managers.
- **Week planner**: the heading is the week ("Week of 9 November") with its status as a pill (Draft, Published, or "Published · N changes not sent"), the week's hours, shifts and people, and week arrows with **This week**. One main button says the next step (**Publish week**, **Publish N changes**, or a disabled **Up to date**) and opens a summary sheet (shifts and hours, who'll see it, anything still to check) before anything goes out. **Before you publish** groups the problems into must fix (red), to check (amber) and notes, each tile with a coloured inside edge and its fix button (Fill, Fix, See); repeats are joined up ("No one closes Cafe on Mon–Fri and Sun", "Overtime: Lena +16h, Cassian +13h"). It's open on wide screens until the week is published, folded on phones. On iPad landscape and wider, a grid (a row per site or per person, a column per day, today shaded): each open site-day starts with its cover, people on against the site's minimum ("1/2") with a bar, amber when short, and the + to add a shift; shifts are compact cards (the time, the first name, one small tag: Opens, Closes, Overtime, Clash, Fill); a People on row totals each day; sites not set up in the diary are one line with a link, not empty rows. **People this week** lists everyone's hours against their contract (a bar to the maximum, the minimum ticked, overtime in pink, short in amber) with holiday, days they can't work and single-site notes; tapping someone highlights their shifts and fades the rest. It sits beside the grid from 1560px, below it otherwise. On phones, one day at a time (a day strip with a dot per day: red for a problem, amber for a warning) with a card per site showing its cover, then the people panel. Open shifts are dashed and red with "Fill"; clashes amber with "Clash"; closed days say "Closed" (with the closure's reason). By person shows hours against the contracted range and "Off", "Holiday" (striped) or "Can't work".
- **My shifts** (everyone): week arrows (four weeks back to eight ahead), then two columns from 900px. Left: the next shift (accent card, with Add to calendar and Ask for cover) or, with nothing coming up, what to do now (check when you can work, ask for time off); **Your week**, a Monday-to-Sunday strip with each shift in its site's colour (on narrow strips just the times and the site's first letter, with a key), Off, Holiday (striped), Can't work (struck through), "Not out yet" before the week's published, and past days faded; then **Coming up**. Right: the week's hours against the contract as a bar; **Needs you** (cover asked of you, with Cover it; open shifts you could take, with Take it); **Your requests** (time off and cover or pickups, with their status); **When you can work** as day chips, set by an admin. **Everyone** still shows the whole published week.
- **Overtime** (hours over someone's maximum contracted hours) has its own colour, pink (`--ot` in `rota.css`), always with the word "Overtime": a pink outline and label on the shift, "Nh overtime" on the person's hours, in Hours (+) and in My shifts. Short of the minimum is a quiet "Nh short" note.
- **Shift sheet** (bottom sheet): site, day, times, unpaid break, job, note; for an open shift, who can do it, best fit first, people who can't dimmed with the reason. Changes show a toast with **Undo**; Delete asks twice.
- **Day view**: a site's day as bars from that day's opening to closing (each weekday can have its own hours, set in Rota settings), with a bar per hour showing how many are on (red under the minimum, and the number on each bar), and the day's problems with a one-tap fix where there's an obvious one. From the day itself, **Amend hours on the day** gives each person on shift a Started and a Finished slider (5-minute steps), the break, a reason with quick picks ("Went home sick", "Left early", "Came in late", "Stayed late") and the paid hours against the plan; an amended bar keeps the plan as a dashed outline behind it. The same control is at the top of the shift sheet.
- Site colours (Roastery blue, Cafe green, ASG orange, Factory purple) always come with the site's name.
- **Person colours**: each person has their own colour (`hue` on each person from the rota API, fixed by the order accounts were made, spaced round the colour wheel so a new person never changes anyone's). By site, each shift carries a stripe and light tint in that colour and an initials badge, with the name first and the time under it; avatars use it too. By person, shifts keep the site colours. Always with the name and initials, never colour alone. Status is never colour alone.
- Offline, the rota shows what was last loaded with the "Offline" label and editing switched off; it doesn't queue changes like the diary.

The designs it was built from are in `docs/rota-designs/`.

## The admin section

The admin section (`public/admin/`, at `admin.staffstrangerscoffee.com`) uses the same theme (`theme.css`) and layout rules as the diary: a sidebar from 1024 px, otherwise a top bar with the account button, one column and a floating tab bar (**Overview**, **People**, **Sites**, **Activity**, **More**, with Security and Backups & exports under More). Its buttons are flat, without the theme's coloured glow.
- **Overview** leads with "Needs attention": one row per problem, each with its own button. Then four tiles (2×2 on phones, 4 across from 700 px) and "Diary today" and "Rota this week" side by side, one row per site.
- **People** opens a person in place: account actions in one row (Switch off apart, in red), then three cards of equal height, Account, Rota and Kitchen Diary, side by side from 900 px and stacked below.
- Lists wrap their text rather than cut it off. Anything that can't be undone asks in a sheet first; a temporary password is shown once, in a sheet, with a copy button.

## Motion

Short and purposeful, and all of it is off with Reduce Motion:
- A section slides up slightly as it opens; cards, rows and forms ease open.
- Buttons, rows and tabs press down slightly when tapped.
- A tick, or a card's badge, pops once when it becomes done (on this device or another), not on every refresh.
- The toast rises above the tab bar; the sign-off button rises into place when the day is ready.

## Files

No build step: each page loads plain scripts in order. The diary's logic is in `public/diary/` (classic scripts sharing one global scope: `core.js` first, then one file per area, `start.js` last), the rota's in `public/rota/rota.js`, the admin section's in `public/admin/admin.js`; `public/shared/core.js` (loaded first on the diary, rota and admin pages) holds what they share: the element and icon builders, toasts, Europe/London dates and the sign-in and session checks.

## Styles

Three stylesheets, loaded in this order (later rules win):

1. `public/app.css`: base styles: tokens, panels, form fields, tables and the editors for HACCP plans, EHO inspections and onboarding documents.
2. `public/theme.css`: the Liquid Glass theme: colour tokens for light and dark, glass materials, buttons, fields, checklists, and the accessibility settings below.
3. `public/ui.css`: the app layout: top bar, tab bar, sidebar, sheets and menus, page heading, section cards, list rows, Today, Week and the Records and More sections.

## Accessibility

- Every tap target is at least 44 pt on touch screens; text fields use 16 px text so iPhones don't zoom in.
- **Reduce Transparency** (iOS Settings → Accessibility) makes every glass surface solid, **Increase Contrast** firms up edges and text, and **Reduce Motion** removes animation.
- Full dark mode follows the device setting.
- Status pills and text pass WCAG AA contrast in light and dark.
- The diary content is a `<main>` landmark, the page is marked British English, and the site sheet, account menu and section cards use the matching ARIA roles and states (`dialog`, `menu`, `aria-expanded`, `aria-current`).
- Blur is GPU work. It's fine on recent iPhones and iPads; on an old kitchen tablet that feels slow, turning on Reduce Transparency switches it off.

## Wholesale beta

Wholesale management is a native admin page (**Wholesale** in the sidebar, **More → Wholesale** on phones), using the existing Liquid Glass theme, escaped templates and sheets. It has Orders, Customers and Coffee catalogue views, preview-status filters, search, shared D1 records and version-checked forms. The customer ordering app at `PREVIEW_HOST` loads the same `theme.css` Liquid Glass tokens as Admin, with system typography, shared canvas/colours/materials, translucent navigation and cards, rounded controls and native-style sheets, with customer registration/sign-in, business details, order history and baskets per identity. Registration waits for admin approval. Wholesale sessions are isolated from staff sessions; both apps use the shared server-corrected UK clock. Customer checkout creates orders for the team to prepare; staff preview orders are labelled separately. The marketing introduction is removed and product images preserve their full intrinsic proportions.

Coffee catalogue uses native sheets to add/edit details, categories, bag prices and separate Visible/In stock controls. Its photo gallery shows complete thumbnails with Remove, upload and Restore original controls; photo changes save immediately while other form edits stay in place. The customer gallery fits each image inside a fixed frame with `object-fit:contain`, keeps portrait and square uploads whole, provides previous/next controls and shows a placeholder when empty. Out-of-stock cards stay visible with disabled ordering; hidden coffees leave the catalogue. Unavailable basket lines remain removable, and review refreshes prices and availability before confirmation.

Payment terms and customer-facing instructions are set in the customer editor. Customers see current terms read-only in My account and checkout. Receipts, order history and native admin order details show the terms captured with the order. A terms change while checkout is open asks the customer to review again. Customer approval's Save and review sign-in action saves edited business details and terms before opening account review. Staff preview orders are labelled and excluded from the dashboard's preparation totals.

The existing ordering address is retained; both apps show Beta. Customer cards form one column on narrow phones to preserve 44 px controls and two columns on wider screens. Glass, dark mode, safe-area insets, Reduce Transparency, Increase Contrast and Reduce Motion follow the shared design. Retail-shopping links are removed from coffee titles. Admin Wholesale uses the same needs-attention rows, section headings, grouped lists, search, flat buttons, status pills and spaced sheets as the other sections. Search and Load more operate on server pages; full-database stats exclude staff tests. Uploaded-photo deletion asks for confirmation. A pending checkout locks its submitted details and offers Check submitted order / Retry same order until confirmed or rejected.
