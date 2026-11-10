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
- **Wide-only views**: the full allergen chart and the admin staff training chart need the width, so they only show from 1024 px; phones get the lists.
- **Undo instead of "are you sure"**: Done on a job and Tick all show a toast with **Undo** for 5 seconds; sign-off has its own Undo. Deleting still asks twice (tap Remove, then confirm).
- **The Add button** in the heading opens a section's form, starts a document directly, or shows a short menu when there's a choice (HACCP plan or risk assessment).
- **Records and More rows show live status** (what's overdue, the last result, how many items), so people can see where to go without opening each section.
- **Intros** are two lines on phones; tapping shows the rest.
- **Offline**: a small amber label under the top bar ("Offline · 2 changes waiting") appears only while there's no connection or queued changes are saving; "Back online. All changes saved." confirms when they've gone.
- **Quick switching** uses a 4-digit PIN pad in a bottom sheet (`public/pinpad.js`), with large keys, dots for progress, a shake and message on a wrong PIN, and keyboard support.
- **Status colours**: green done or in range, amber part done or due, red missed, overdue or out of range. Status is never colour alone: each also has text or an icon.

## The rota

The rota (`public/rota/`) shares the system typography, materials, sidebar, phone tabs and sheets. Capability is separated: admins use the full **Week** planner, employee **Requests**, **Hours** and contracts/availability editors. Staff and managers use **My shifts**, safe **Open shifts**, their own requests and **When I can work**. Managers also keep business site opening/minimum-cover settings; this never exposes employee planning.

- **Admin planner**: Monday-to-Sunday site/person grids, publication status, draft checks, staffing cover and employee contract/overtime bars. The publish sheet previews recipient counts before emailing. Day/shift sheets can amend actual hours with a reason while preserving the plan. These views, candidate eligibility, workforce totals and CSV export are admin-only.
- **My shifts**: the employee’s own published assignments, week strip, next shift/calendar action, own hours/contract, availability, leave and request states. Nonadmins have no Everyone/colleague rota or co-worker list. Draft assignments are not shown. Overtime/shortfall styling applies only to their own information.
- **Open opportunities**: business site, date, planned times, break and job, with private former-employee identities, notes and actual data removed. Employees may claim an opportunity or request general cover/cancel for their own shift. Cross-person cover and private request decisions belong to admins. A declined prospective taker receives no other employee’s assigned-shift snapshot.
- **Settings**: managers and admins may change business opening times, weekday variations and minimum cover. Employee contracts and availability are admin-only. Everyone reads their own availability and email preferences; manager Monday-summary settings control business information only.
- Site/person colours accompany visible labels; a colour must not expose a hidden colleague. Every private list/count, empty state, accessibility label, calendar and sheet obeys the same scope as the server.
- Offline or suspended pages cover private content until the expected stable account ID and role have been verified. Identity changes clear cached private lists/editors. Private training/contact/onboarding saves require an online verified session; operational queues continue, while older private queues remain owner-bound and held for authorized recovery.

The designs it was built from are in `docs/rota-designs/`.

## The admin section

The admin section (`public/admin/`, at `admin.staffstrangerscoffee.com`) uses the same theme (`theme.css`) and layout rules as the diary: a sidebar from 1024 px, otherwise a top bar with the account button, one column and a floating tab bar (**Overview**, **Wholesale**, **People**, **Activity**, **More**, with Sites, Security and Backups & exports under More). The header and desktop sidebar use the shared Strangers Coffee logo, which follows the theme colour. Its buttons are flat, without the theme's coloured glow.
- **Overview** leads with "Needs attention": one row per problem, each with its own button. Then four tiles (2×2 on phones, 4 across from 700 px) and "Diary today" and "Rota this week" side by side, one row per site.
- **People** opens a person in place: account actions in one row (Switch off apart, in red), then three cards of equal height, Account, Rota and Kitchen Diary, side by side from 900 px and stacked below.
- Lists wrap their text rather than cut it off. Anything that can't be undone asks in a sheet first; a temporary password is shown once, in a sheet, with a copy button.

## Employee-private diary screens

Training is labelled **Your training** for staff and managers; it contains only records linked to their stable account. Admins can choose/review the owner and see all records, including unlinked legacy imports. Matching display names never link records. Contacts/onboarding editors show an admin-controlled **Shared business information** or **Private employee record** classification and, where private, an employee owner. Legacy unverified fields are shown for review, not presented as trusted ownership. Nonadmins cannot change classification or transfer ownership.

EHO inspection mode retains shared food-safety records. Its training section and PDF explicitly state the own-record scope for nonadmins and omit workforce counts or “staff fully trained” claims. Admin packs retain the complete training section. Stale private training/onboarding records are filtered again at export. In-memory private editor/list content is cleared when sign-in is invalidated or ownership changes.

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

## Wholesale

Wholesale management is a native admin page (**Wholesale** in the sidebar and the mobile tab bar), using the existing Liquid Glass theme, escaped templates and sheets. It has Orders, Customers, Coffee catalogue and Invoicing views, preview-status filters, search, shared D1 records and version-checked forms. The customer ordering app at `PREVIEW_HOST` loads the same `theme.css` Liquid Glass tokens as Admin, with system typography, shared canvas/colours/materials, translucent navigation and cards, rounded controls and native-style sheets, with customer registration/sign-in, business details, order history and baskets per identity. Registration waits for admin approval. Wholesale sessions are isolated from staff sessions; both apps use the shared server-corrected UK clock. Customer checkout creates orders for the team to prepare; staff preview orders are labelled separately. The marketing introduction is removed and product images preserve their full intrinsic proportions.

Coffee catalogue uses native sheets to add/edit details, categories, bag prices and separate Visible/In stock controls. Its photo gallery shows complete thumbnails with Remove, upload and Restore original controls; photo changes save immediately while other form edits stay in place. The customer gallery fits each image inside a fixed frame with `object-fit:contain`, keeps portrait and square uploads whole, provides previous/next controls and shows a placeholder when empty. Out-of-stock cards stay visible with disabled ordering; hidden coffees leave the catalogue. Unavailable basket lines remain removable, and review refreshes prices and availability before confirmation.

Payment terms and customer-facing instructions are set in the customer editor. Customers see current terms read-only in My account and checkout. Receipts, order history and native admin order details show the terms captured with the order. A terms change while checkout is open asks the customer to review again. Customer approval's Save and review sign-in action saves edited business details and terms before opening account review. Staff preview orders are labelled and excluded from the dashboard's preparation totals.

The existing ordering address is retained; both apps use the name Wholesale without Beta badges. The customer help card and ordering-guide window are removed. Customer cards form one column on narrow phones to preserve 44 px controls and two columns on wider screens. Glass, dark mode, safe-area insets, Reduce Transparency, Increase Contrast and Reduce Motion follow the shared design. Retail-shopping links are removed from coffee titles. Admin Wholesale uses the same needs-attention rows, section headings, grouped lists, search, flat buttons, status pills and spaced sheets as the other sections. Search and Load more operate on server pages; full-database stats exclude staff tests. Uploaded-photo deletion asks for confirmation. A pending checkout locks its submitted details and offers Check submitted order / Retry same order until confirmed or rejected.

Wholesale order history uses compact summary cards with text status, an accessible progress strip and native expandable details. Cancelled orders show a cancellation callout without completed steps. The history sheet has Refresh orders, loaded/total count and Load earlier orders. Repeat ordering has a separate confirmation sheet with current price/quantity totals, skipped items and explicit basket-preservation copy. A changed catalogue or basket needs a second review before bags are added.

Admin order rows form a work queue with references, delivery preferences and next-status buttons outside the detail button. Packing sheets lead with the frozen order summary and separate quantities, bag sizes and grinds before contact/delivery/terms. Focus starts at the sheet title. Inline errors include Reload orders; busy states block duplicate actions and focus returns to the next available action without interrupting another open sheet. A background refresh preserves a concurrent-edit error and keeps its next-status action disabled until the admin explicitly reloads or saves a correction.

Delete order is an admin action in the order details sheet. A separate confirmation identifies the order/business and subtotal and explains removal from histories without changing payments. Cancel preserves the editing draft; busy and version-conflict states prevent duplicate or unseen removals. The destructive control uses native warning styling and 44 px targets.

Customer navigation contains the signed-in business and account/sign-out controls in the header. Empty baskets hide zero badges and show concise selection guidance; populated counts use plain bag labels. The footer groups Wholesale branding and useful catalogue/history/website links. Grind and delivery-location choices use built-in dialogs with explicit confirmation. Every customer dialog reserves a separate sticky close-control toolbar, keeping prices and text below it. Approved business names are read-only; My account and native Admin customer sheets stage named location edits before a version-checked save. Checkout shows the chosen location/address, and saved orders keep that snapshot.

The wholesale desktop workspace can use up to 1680 px of the available main pane. Its overview is a compact grouped summary capped at 1120 px; section navigation fits its labels. Search, filters, result counts and records belong to one grouped list panel. At narrower desktop widths, order search and status filters use separate rows; wider screens place them beside each other. Empty lists show a short explanation and filtered empty results offer Clear filters, resetting both search and the section filter. Order totals retain their column alignment when no next action exists. Initial invoice setup sits beside the issued-invoice list on desktop. Phones retain the scrolling section controls and single-column forms.

Customer editors widen to grouped columns with pinned title/close and Save/Cancel controls; phone forms remain single-column. Payment terms, default location and customer status use native in-app choice sheets that preserve drafts, version, focus and scroll on cancellation. Pending account reviews appear beside Customers as a count/action only when needed; the old attention section is removed. Customer account windows group contact/address/locations/settings and retain a separate Save footer. Long desktop baskets scroll their item list while totals and Review remain reachable.

Invoicing is a fourth native Wholesale tab. Supplier settings are explicit and editable; incomplete setup directs admins to required fields. Invoice review separates the editable draft from calculated VAT preview and explicit issuance. Issued invoices show protected PDF access and separate manual payment recording. My orders offers customer-owned invoices with outstanding/overdue summaries, terms, due dates and paid status, with its title, close control and tabs outside the scrolling content. All invoice windows follow shared materials, 44 px actions, keyboard focus, scrolling and phone/desktop layouts. Invoice PDFs use the existing Strangers vector logo, website blue/navy palette and clear payment/totals grouping on a white A4 page; long content retains running branding and page numbers.


On mobile, customer account chrome collapses after scrolling 64 px and returns within 8 px of the top. A stable-height sticky shell prevents scroll jumps; focused account controls remain visible, collapsed controls are inert, and reduced-motion preferences disable the transition. Confirmed cart cleanup and same-identity tab reconciliation preserve unrelated newer baskets and uncertain checkout payloads.

Quick dispatch uses a native sheet with an optional tracking URL, guarded submit/cancel/reload behavior and version checks. The order editor can add, edit or clear tracking. Customer history uses a safe external Track delivery action for dispatched delivery orders.
