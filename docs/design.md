# Design notes

How the Kitchen Diary looks and why, for anyone changing it. The style follows Apple's Liquid Glass conventions, since most staff use iPhones and iPads.

## Layout

- **Phones and iPads in portrait** (under 1024 px): a top bar with the site button and the account button (initials), a large page title, and a floating tab bar at the bottom: **Today**, **Week**, **Records**, **More**. Records and More are lists of sections; a section opened from them has a back link to its list.
- **iPads in landscape and computers** (1024 px and up): a sidebar with the site button, every section the person can open (grouped Diary, Records, Management) and the account button at the bottom.
- Sections a person's role can't open aren't shown; the Worker refuses them anyway.
- `html` has scroll padding so anything scrolled into view (a focused field, an opened form) stays clear of the top bar and tab bar.

## Patterns

- **Today** leads with a progress bar (Temps, Opening, Closing, Sign off) and anything overdue at the site, then one card per part of the day. A card is open while it has something to do and collapses to a one-line summary when done; tapping its header opens or closes it.
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
- **Week planner**: on iPad landscape and wider, a grid (a row per site or per person, a column per day); on phones, one day at a time (the Week page's day strip) with a card per site. Problems sit above as chips; tapping one opens the shift or the day. Open shifts are dashed and red with "Fill"; clashes amber with "Clash"; closed days say "Closed" (with the closure's reason). By person shows hours against contract as a bar that turns red when over, and "Off", "Holiday" (striped) or "Can't work".
- **Shift sheet** (bottom sheet): site, day, times, unpaid break, job, note; for an open shift, who can do it, best fit first, people who can't dimmed with the reason. Changes show a toast with **Undo**; Delete asks twice.
- **Day view**: a site's day as bars from opening to closing, with a bar per hour showing how many are on (red under the minimum, and the number on each bar), and the day's problems with a one-tap fix where there's an obvious one.
- Site colours (Roastery blue, Cafe green, ASG orange, Factory purple) always come with the site's name. Status is never colour alone.
- Offline, the rota shows what was last loaded with the "Offline" label and editing switched off; it doesn't queue changes like the diary.

The designs it was built from are in `docs/rota-designs/`.

## Motion

Short and purposeful, and all of it is off with Reduce Motion:
- A section slides up slightly as it opens; cards, rows and forms ease open.
- Buttons, rows and tabs press down slightly when tapped.
- A tick, or a card's badge, pops once when it becomes done (on this device or another), not on every refresh.
- The toast rises above the tab bar; the sign-off button rises into place when the day is ready.

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
