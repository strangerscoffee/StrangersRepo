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

## Requests, approvals and rota integration

Employees request annual leave or unpaid leave; admins may also record sick leave and unauthorised absence, for themselves or another employee. Only annual leave consumes holiday allowance. Notes remain private.

The employee reviews the dates and computed charge before submitting. Full-day bookings charge configured working days only. A half-day booking uses one date and explicit absence start/end times, and charges half the normal daily amount. The rota's conflict and open-shift checks use those times, so a non-overlapping shift remains available. Capacity limits conservatively count people off on that date, rather than treating two half-days as an interchangeable whole person.

Admins review the absence, saved charge, affected allowance years and any already assigned shifts. Approval immediately appears in the rota's absence data; existing assigned shifts are retained and flagged for the admin to resolve. The system does not silently delete or reassign published work or calculate sick/holiday pay.

Blackouts can apply company-wide or to an employee's rota sites. A maximum number off can be set globally/per site. Empty means no limit; zero blocks requests. Limits count approved annual leave. Sickness and other private absence types are not disclosed through the staff calendar or its capacity data. Pending requests reserve the individual's allowance, while shared capacity is checked against approvals. Both request and approval recheck the current rules; changes to limits never silently cancel existing approvals.

All leave mutations, including legacy time-off writes, take a global optimistic revision in an atomic D1 batch. A stale revision aborts the entire batch, preventing simultaneous approvals from spending the same allowance or capacity. Individual versions protect open admin forms and decisions. Client request keys make uncertain create retries idempotent; reuse with different details is refused. The form can check the same frozen request after an unconfirmed response.

## Existing records and audit

Migration 24 preserves all existing time off as **unclassified**. It remains in the rota, stays private, and does not acquire an invented annual-leave charge or become visible to colleagues. Admins explicitly classify it and record a reconciliation reason. Where dates are already included in an opening used balance, an explicit reconciliation flag links the historical record without charging those days twice. Any later days outside that opening cut-off receive their own saved charges.

Historical records covered by an opening used total require admin reconciliation on cancellation; the aggregate opening amount is not automatically refunded again. The UI explains this. Employees cannot cancel these reconciled historical records themselves.

Creation, decisions, allowance/policy changes, blackout changes, bank-holiday credits/corrections and legacy reconciliation are recorded in `rota_leave_events` within the same transaction as the change. Only admins can read this detailed event log. Employee-visible credit history and balances are scoped to that employee. Backups include every new table and the original stable employee IDs. No Who's Off records or balances are imported automatically: reconcile them deliberately before switching the source of truth.

## Privacy boundary

The newly authorised exception is narrow: an authenticated employee may see **names and dates of approved annual leave** in the team calendar, plus generic blackout labels/capacity availability. That response is explicitly constructed and contains no employee IDs, absence IDs, reasons, balances, pending requests, sickness/unpaid/unauthorised records, contracts, hours or contact details. The existing private rota/planning filters remain unchanged.

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
