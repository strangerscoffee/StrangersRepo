# Holidays and absence management

The rota now has **Holidays** for every signed-in employee and **Holiday management** for admins. It extends `rota_time_off`, the same records that the rota planner, shift suggestions, open-shift checks and personal rota already read. There is no second calendar to synchronise and no external HR service receives employee data.

## Agreed policy and setup

The business described an April–March leave year, individual allowances in **days**, carry-over only as an admin-approved exception, and bank-holiday days in lieu for eligible full-time employees who work them.

1. Open **Rota → Holidays → Manage leave → Policy & limits** as an admin. The default year starts `04-01` (1 April, ending 31 March). `04-06` supports 6 April–5 April if that is the actual company policy; the tax year does not automatically decide the holiday year. Existing employee-year records retain their explicit dates if the default changes.
2. Choose the bank-holiday policy. For the stated policy, select the inclusive allowance with worked-bank-holiday days released in lieu. Set company/site limits and add blackout dates as needed.
3. Select each employee and set up their leave year: agreed entitlement, any explicitly approved carry-over, normal daily holiday charges, non-working exceptions and bank-holiday eligibility. No 28-day allowance, full-time status, Monday–Friday contract, automatic accrual or automatic carry-over is inferred.
4. If moving part-way through the year, reconcile the **previously used** amount and its cut-off date with the existing system. This is an opening used balance, not an additional deduction for every old record. Enter remaining approved future bookings as absence records and review existing rota time off.
5. Enable requests after setup. Staff without an allowance for the requested dates receive a setup message instead of an invented balance. New leave years are explicit admin records; carry-over does not roll forward automatically.

Normal weekly charges and shift availability are separate: a zero charge means a non-working day for holiday accounting. Additional non-working dates receive no charge. Requests spanning leave years are allocated to each configured year independently. Days are stored as integer hundredths, avoiding floating-point balance sums.

## Balances

For each employee and leave year:

- **Total** = individual annual entitlement + admin-approved carry-over.
- **Used** = opening used amount + approved recorded charges on or before today (UK date).
- **Booked ahead** = approved charges after today.
- **Pending** = requested charges awaiting a decision; these reserve allowance.
- **Remaining** = total − used − booked ahead.
- **Available to book** = remaining − pending − reserved bank-holiday days.

Declined/cancelled requests do not consume their recorded charges. Changing a working pattern affects new requests, not the saved charges of existing bookings. A reviewed charge must still match at submission; changes require a fresh review. An allowance cannot be reduced below committed/pending/reserved usage, or change its dates/unit after booking history exists.

A current-year allowance is not silently replaced by an old year's balance. Staff can explicitly inspect other configured years. The admin screen identifies employees missing a current-year allocation.

## Inclusive bank holidays and days in lieu

The allowance already includes the employee's applicable bank-holiday entitlement. An admin lists the bank holidays reserved within that total for an eligible full-time contract. The optional **Load England/Wales bank holidays** action reads the fixed GOV.UK public calendar; admins review which dates apply to the individual before saving. Dates covered by an opening used balance are excluded from this helper. Manual entry remains available if the government feed is unavailable or does not publish that future year. A failed optional lookup preserves the form and does not mark the rota itself offline. The local Worker could not reach the real feed during verification; its failure path was checked directly, and browser fixtures verify both the date-loading and manual-entry paths.

For example, with 28 days total and eight reserved bank holidays, 20 days are initially available to book. An approved bank-holiday absence consumes its charge and replaces the reservation; it does not consume the day twice. If an admin confirms that the employee worked a reserved bank holiday, that reservation is released and one day becomes available to book in lieu. **The total stays 28**. This prevents interpreting an inclusive allowance as both 28 days and eight additional bank-holiday credits.

Credits require explicit contract eligibility, a configured reserved date already worked, confirmation and an admin reason. Each date can have only one active credit. A versioned correction reverses a credit without deleting its audit history; it cannot create an overdrawn balance. No credit is inferred from a planned shift, because a planned shift does not prove it was worked.

The government feed request contains no employee identifiers, allowance data, account details or individual request dates. It is a fixed public URL, bounded by a timeout, and does not add a new browser connection origin.

## Changing the dates of an absence

Admins can move a requested or booked absence from its Review absence sheet with **Change dates**: the new dates are checked like a new booking (balance, overlaps, blackouts and limits, with an admin exception if needed) and their charge shown against the old one; nothing changes until **Save new dates**. It stays the same booking with the same status, the old and new dates are kept in its history (`dates_changed`), and the person is emailed. Sickness-form absences are changed in Sickness, and unclassified or opening-balance records must be reconciled first.

## Starting the next leave year

Each leave year is its own allowance, so the next one has to be created. Holiday management → **Start next year for everyone** proposes it for every active person with an allowance this year: the same entitlement, working week (holiday charge each weekday) and bank-holiday setting, with no carry-over (agreed separately at the year end). Anyone whose start date (Admin → People → Staff profile) falls after this leave year began probably had a pro-rated allowance, so they are flagged and proposed at a full year: this year's days divided by the share of the year they were employed, to the nearest half day and at most 28 days. Each flagged person must be ticked as checked. Bank-holiday dates for next year are entered once (or loaded from GOV.UK) and reserved for everyone with "Reserve bank holidays" ticked. "Check and confirm" shows a summary of every year to be created and what changed; nothing is saved until **Create**, which creates them all together or none. People already set up, or with no allowance this year, are listed but left to be set up by hand.

## Requests, approvals and rota integration

Employees request annual leave or unpaid leave; admins may also record sick leave and unauthorised absence, for themselves or another employee. Only annual leave consumes holiday allowance. Notes remain private.

The employee reviews the dates and computed charge before submitting. Full-day bookings charge configured working days only. A half-day booking uses one date and explicit absence start/end times, and charges half the normal daily amount. The rota's conflict and open-shift checks use those times, so a non-overlapping shift remains available. Capacity limits conservatively count people off on that date, rather than treating two half-days as an interchangeable whole person.

Admins review the absence, saved charge, affected allowance years and any already assigned shifts. Approval immediately appears in the rota's absence data; existing assigned shifts are retained and flagged for the admin to resolve. The system does not silently delete or reassign published work or calculate sick/holiday pay.

Beside each absence they review, admins see who else is off (`teamOff` on `GET /api/rota/leave/requests/<id>`, admins only): other people's approved holiday and unpaid leave that overlaps the request, listed first with the days they share ("Overlaps Thu 16 Jan – Fri 17 Jan"), and, kept apart under "Nearby, not overlapping", bookings ending or starting within 7 days of it ("Back 5 days before this starts", "Starts 3 days after this ends"). Names, kind and dates only: no reasons, sickness, pending requests or the person's own other bookings. A List/Calendar switch shows the same people as a calendar of the request's weeks and a week either side: the requested days outlined (amber where someone else is off too), names on each day, and a tap on a day lists who's off.

Blackouts can apply company-wide or to an employee's rota sites, with a reason chosen from a short list (Christmas, New Year, Bank holiday, Peak trading, Stocktake, Staff training, Short-staffed) or typed as a custom reason; that reason is shown on each blocked day of the staff calendar (hatched). Admins can edit a blackout's dates, site or reason later (version-checked, recorded in the leave history) or remove it. A day that has reached a limit is shown in red as "Full (n off)"; tapping a day explains both. The policy can also count approved unpaid leave towards the limits ("Count unpaid leave towards these limits", off by default). Admins can make an exception to a blocked day when booking or approving holiday: the site shows which days are blocked and why, asks for a reason, and records the reason and the blocked days in the leave history. Staff cannot override. A maximum number off can be set globally/per site. Empty means no limit; zero blocks requests. Limits count approved annual leave. Sickness and other private absence types are not disclosed through the staff calendar or its capacity data. Pending requests reserve the individual's allowance, while shared capacity is checked against approvals. Both request and approval recheck the current rules; changes to limits never silently cancel existing approvals.

All leave mutations, including legacy time-off writes, take a global optimistic revision in an atomic D1 batch. A stale revision aborts the entire batch, preventing simultaneous approvals from spending the same allowance or capacity. Individual versions protect open admin forms and decisions. Client request keys make uncertain create retries idempotent; reuse with different details is refused. The form can check the same frozen request after an unconfirmed response.

## Existing records and audit

Migration 24 preserves all existing time off as **unclassified**. It remains in the rota, stays private, and does not acquire an invented annual-leave charge or become visible to colleagues. Admins explicitly classify it and record a reconciliation reason. Where dates are already included in an opening used balance, an explicit reconciliation flag links the historical record without charging those days twice. Any later days outside that opening cut-off receive their own saved charges.

Historical records covered by an opening used total require admin reconciliation on cancellation; the aggregate opening amount is not automatically refunded again. The UI explains this. Employees cannot cancel these reconciled historical records themselves.

Creation, decisions, allowance/policy changes, blackout changes, bank-holiday credits/corrections and legacy reconciliation are recorded in `rota_leave_events` within the same transaction as the change. Only admins can read this detailed event log. Employee-visible credit history and balances are scoped to that employee. Backups include every new table and the original stable employee IDs. No Who's Off records or balances are imported automatically: reconcile them deliberately before switching the source of truth.

## Holiday for extra hours (quarterly)

`src/rota/leave/accrual.ts`, sums in the import-free `accrualMath.ts`. After each quarter of the leave year (from the policy's year start, so 1 April gives Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar), people on contracts under 42 hours (judged on the contract's maximum: the owner's decision of 17 Nov 2026) earn holiday for hours above their minimum contract at the GOV.UK irregular-hours rate, **12.07%** (5.6 weeks ÷ 46.4 weeks). For staff whose hours mostly vary that is the statutory accrual; for others it is a contractual benefit on top.

- Hours counted: paid hours on published rota weeks (amended on-the-day hours), plus planned hours missed through approved sickness, plus an average working day for each day of approved holiday. Unpaid leave isn't counted. Counting starts from the quarter's first day, the first published rota week, or the person's first shift, whichever is latest.
- Minimum: the weekly minimum ÷ 7 for each day, using the contract in force that day (`rota_contract_history`, migration 32: every contract change from the day it's made; contracts before then are taken as today's).
- Holiday: extra hours × 12.07%, turned into days with the person's average working day (hours ÷ days worked in the quarter), to hundredths of a day.
- Admins only: `GET /api/rota/leave/accrual?quarter=` shows everyone's workings; `POST /api/rota/leave/accrual {quarter, people:[{userId, units}], ifVersion}` adds it after the admin reviews it (the reviewed figures must still match, or 409; added once per quarter, so approving again adds nothing). It goes into the leave year that includes the day after the quarter ends (January–March goes into the next year), recorded in the allowance's `accruals` with its workings, counted in the year's total, logged as `hours_accrued` and emailed to the person (email kind `holiday`). `POST …/accrual/reverse {userId, year, key, reason, ifVersion}` takes one off with a reason; the record is kept.
- The Admin Overview and the admins' email say when a quarter is ready to review (a week after it ends, until someone approves it).

## Holiday left to take: reminders

`src/rota/leave/notify.ts`. Untaken statutory holiday can lapse at the year end only if the employer gave a reasonable opportunity to take it, encouraged the person to and told them it would be lost (Working Time Regulations, reg. 13 as amended from 1 January 2024); otherwise up to 4 weeks (all of it for irregular-hours workers) carries over. A worker gives notice of twice the leave plus a day; an employer can require leave to be taken with notice of twice its length.

- The daily run (five-minute cron, once a day from 09:00 UK time, claimed in `rota_leave_notices`) checks everyone with a current leave year. "Left" is the allowance not used, booked, requested or reserved for bank holidays.
- Staff reminders: 6 months before the year ends (only if under 40% used or booked), 3 months, 2 months and 1 month (the formal notice that what isn't taken is lost; sent whatever the person's email choices). Starting part-way through a year sends only the latest due stage. Each is recorded once per person, year and stage in `rota_leave_notices` (migration 32, in backups) and as a `holiday_reminder` event: the evidence that the person was told.
- Admins get one email listing the people at the 3-, 2- and 1-month stages and anyone reaching their **require-by** date (the year end less three times the days left and two weeks: notice of twice the leave, the leave itself and time to spare), and the Admin Overview lists people who need to book soon.
- Staff see their own days still to book, the deadline, the next reminder and the reminders they've had on Holidays (`takeBy` in the dashboard); admins see everyone in Holiday management (`GET /api/rota/leave/take-by`). Policy & limits → "Remind staff about holiday left to take" switches it off.
- Year end: nothing carries over automatically (the owner's decision). Holiday management lists people whose year ended in the last four months with holiday not taken (`GET /api/rota/leave/year-end`), flagging missing reminders and sickness; `POST /api/rota/leave/carry {userId, year, days, reason, ifVersion}` sets the next year's carry-over, at most what wasn't taken, with a reason (`carry_over_agreed`).
- Tests: `holiday-accrual-math.test.mjs`, `holiday-accrual.test.mjs`, `holiday-accrual.e2e.test.mjs`; the routes are in the security matrix.

## Privacy boundary

The authorised exception is narrow: an authenticated employee may see **names and dates of approved holiday and unpaid leave** in the team calendar (each entry marked `annual` or `unpaid`; unpaid leave added by the owner's decision of 17 Nov 2026, shown in its own colour and named in each day's label and sheet), plus generic blackout labels/capacity availability. The calendar shows approved leave whether or not requests are switched on. That response is explicitly constructed and contains no employee IDs, absence IDs, reasons, times, balances, pending requests, sickness/unauthorised/other records, contracts, hours or contact details. The existing private rota/planning filters remain unchanged.

Detailed dashboards, direct absence reads, private notes and balances require the individual employee or an admin. Managers receive no extra employee-private capability. Allowance/policy/credit/blackout administration and audit events require an admin. Identity checks, exact-origin write protection, no-store API responses and the shared session guard cover the new endpoints. Switching account clears dashboard state and private unsaved forms. Nothing is stored in browser localStorage for leave management.

## Implementation and validation

- `src/rota/leave/`: schema migration, integer balance calculations, current calendar rules and protected API routes.
- `public/rota/leave.js`: staff/admin workflows using the existing theme, controls and sheets; loaded after shared helpers and before the rota shell.
- `rota_time_off`: the authoritative approved absence record; `rota_leave_days`: saved per-date accounting charges.
- `rota_leave_allowances`, `rota_leave_settings`, `rota_leave_blocks`, `rota_leave_events`, `rota_leave_state`: yearly allocations, policy, blackouts, immutable events and revision guard.

The dedicated API tests cover ownership, role boundaries, request/approval rules, concurrent capacity, idempotency, days/half-days, cross-year allocation, changed reviewed charges, bank-holiday releases/corrections, legacy reconciliation and opening-balance double counting. Browser tests cover complete staff/admin flows at 320, 393, 820, 1180 and 1440 px in light/dark, plus account-switch clearing and a shared calendar that excludes sensitive absence details. The rest of the rota, employee privacy and site suites also run before publication.

## Research and starting point

Reviewed on 13 November 2026:

- [Who's Off features](https://www.whosoff.com/features/) documents leave balances, restricted dates, policies, an API and webhooks. Keeping it as the source and integrating through those facilities remains an alternative if the business chooses to retain it.
- [Frappe HR leave management](https://frappe.io/hr/leave-management) covers allocations, carry-forward, compensatory leave, approval workflows, a calendar and block lists. It is a useful reference for workflow design; adopting a separate HR suite would add another system, access model and deployment to operate.
- [UK holiday entitlement guidance](https://www.gov.uk/holiday-entitlement-rights) distinguishes individual working patterns and whether bank holidays are included. The implementation uses the business's explicitly configured figures, rather than assuming every person has the same entitlement.
- [GOV.UK bank-holiday dates](https://www.gov.uk/bank-holidays) supplies the optional England/Wales date helper.

The native extension was chosen because the existing rota already has the authoritative absence records, authentication, privacy enforcement and conflict checks. No third-party code, HR service account or new subscription is required.
