# Employee privacy audit — 10 November 2026

This audit applies the requested rule: employee hours and personal records are accessible to admins and the individual employee. Managers retain business site settings and ordinary food-safety operations; the manager role alone does not grant access to another employee's private records.

## Confirmed findings and changes

| Area | Confirmed exposure | Safeguard |
| --- | --- | --- |
| Rota | Published team views retained colleagues' actual hours and adjustment notes. Manager routes exposed contracts, availability, leave, requests and payroll exports. | Admin-only personnel planning and exports. Nonadmins receive their own assigned published shifts and private records. Unassigned opportunities are stripped of former employee notes and actuals. Request reads, mutation replies, stale conflicts, Today and Mine use the same policy. |
| Training | Signed-in collection, document and poll reads exposed everyone's training, employment details and notes. Display-name ownership could follow a reused name. | Server checks permanent `users.id` through `ownerUserId`, including before query limits and stale conflict replies. Admins review and link legacy records. A matching name or historical copy ID cannot establish ownership. |
| Contacts and onboarding | Business resources and individualized employee records shared the same readable collections. | Admins explicitly classify records as `shared-business` or `employee` and choose the owner of employee records. Unreviewed records remain admin-only. Managers can maintain permitted existing business records, but cannot publish, claim or reassign employee data. |
| Historical metadata | Previously unrecognized JSON fields could contain forged ownership or sharing claims. | Migration 14 adds a separate trusted version column. A privacy classification is effective only when `employee_privacy_version = seq`, stamped atomically by a validated write. Historical JSON alone is never trusted. |
| Emails and PDFs | Manager summaries and inspection exports could disclose other employees' personal records; rota emails included coworker details. | Manager summaries contain business information. Nonadmin training exports contain only the current employee's records. Own rota emails and calendar attachments exclude coworkers. Personal account addresses are no longer used as reply-to addresses. |
| Shared browsers | Another tab could change the account while cached private screens or queued writes still belonged to the previous employee. Failed sign-out could resume the old session. | Screens stay shielded until permanent ID and role are verified. Identity changes clear private caches and editors. Protected requests carry expected identity headers. Queued operational work stays pinned to its owner. Failed sign-out remains protected until completed. |
| Authentication reads | A delayed identity response could reissue an older session cookie after another employee signed in. | `GET /api/auth/me` is read-only and does not set session or device cookies. Initial binding and response-body reads are checked against the current identity. |

## Deployment and legacy records

Migration 14 invalidates all existing staff sessions and trusted PIN devices once, including admin sessions. Everyone must sign in with their password again. Passwords, PIN hashes and saved records are retained. Wholesale customer accounts use separate sessions and are not affected by this staff session cutover.

The migration also advances the document change counter. Existing training, contacts and onboarding remain available to admins, but stay private from all other accounts until an admin explicitly reviews and saves their ownership or business classification. No automatic name matching is used.

Backups retain `documentSequence` and each document's `seq` and `employee_privacy_version` outside its JSON data. Restore the counter and version pair together. Do not infer reviewed ownership from a document's JSON, and do not restore trusted markers from an unrelated version. Older backups without trusted metadata must remain unverified.

## Scope and remaining administrative work

The review covers repository code, server permission paths, browser behavior and local test fixtures. It does not inspect live employee record contents, historic recipients' mailboxes or downloaded files. Existing admin-only backup, account, activity and export routes remain restricted; wholesale customer sessions cannot authorize staff APIs.

Food-safety days, weeks, reviews and maintenance remain shared business records. Free text cannot reliably be classified by software: admins should review historical shared notes for sickness, medical or other personal information and move those details into employee-private records. Removing the old sickness prompt prevents encouraging new entries; it does not redact historical text.

New training, contact and onboarding changes require an authenticated online save and are not persisted as plaintext offline work. Existing unsent queues are retained to avoid deleting people's work and remain pinned to their owner. These old local queues are not encrypted: someone controlling the same browser profile or its developer tools may inspect that profile's storage. A shared browser profile is not an encrypted personal vault. Previously downloaded files, emails and copies already saved on a device cannot be recalled by this update.

## Validation

Regression coverage exercises admin, manager, employee, other-employee and signed-out access; all four diary sites; direct reads and writes; full, limited and delta polls; stale conflicts; name reuse; forged legacy metadata; migration cutover; manager emails; PDF exports; account switching; cached-page restoration; offline work; and failed logout.

Local validation passed: `npm test` (TypeScript and 167 API/PDF tests), `npm run test:e2e` (75 browser tests), the Worker dry build, and 24 phone/iPad/desktop visual states in light and dark mode. The browser suite includes direct PDF downloads and the complete staff and wholesale customer/admin journeys. No production personal data was used or modified by these checks.
