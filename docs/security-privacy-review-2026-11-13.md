# Security and privacy review — 13 November 2026

Scope: the current Worker, staff diary/rota/Admin, staff wholesale dashboard, customer ordering, accounting integration, files/backups, browser state, notifications and tracked dependencies. Reviewed against main `d23a061` and the access-description correction. Tests use isolated synthetic accounts and local provider simulators. Production checks are anonymous reads only; no real accounts, orders or payment records were changed.

## Findings and changes

| Area | Finding | Correction |
|---|---|---|
| Customer browser sessions | The ordering page rechecked identity on focus, but did not immediately cover private dialogs, bind every request to the page's identity, or guard delayed response bodies. A shared browser could retain another business's details while a check ran. | Reuse the shared session guard with a separate wholesale profile/proof. Hide immediately on blur/restore/focus verification, clear private state on account loss, reject stale bodies and bind ordering API requests to the expected immutable identity and role. Account storage/recovery remains scoped to its original owner. |
| Request origins | Write and WebSocket origin checks trusted arbitrary subdomains of the staff cookie domain and compared hostnames without scheme/port. | Trust only the exact current origin and explicit configured HTTPS staff app origins. Unconfigured siblings, alternate ports, insecure schemes and malformed origins are rejected. Machine requests still require their normal authentication/signature. |
| Protected downloads | Uploaded business PDFs could remain in a browser cache for an hour after sign-out. | Authenticated PDFs and uploaded catalogue images use `private, no-store`. Responses declare `Cross-Origin-Resource-Policy: same-origin`; public static code retains its normal caching. |
| Request bodies | JSON limits were checked after buffering the full body when Content-Length was absent. | Stop reading chunked requests at the byte limit, including public sign-in/registration routes, while preserving split UTF-8 decoding. |
| Verification recovery | A native customer dialog's top layer could block interaction with a section-based sign-in shield. | The verification shield uses a native modal dialog above private dialogs. Retry remains reachable, Escape cannot dismiss the privacy shield, and previous dialogs remain inaccessible until verification completes. |
| Browser-history restore | The customer page's old restore handler reloaded while the shared guard was navigating an expired session to sign-in. | Let the shared guard verify and navigate once; dismiss private dialogs without closing the verification shield. Restored pages remain covered until the current identity is proved. |

## Access boundaries reviewed

- Deployment declares Worker-first asset routing and disables workers.dev and preview URLs. Static branding and application code are public; database records, custom business prices and private files are protected separately.
- Anonymous and forged sessions: employee/account/admin data, exports, backups, staff orders, customer orders/invoices, stored files and secret settings require authentication. Twenty-two live unsigned route checks across the staff, Admin and customer hosts returned only denial or sign-in redirects, with no cross-origin read permission.
- Employee privacy: stable account IDs govern ownership of training, private contacts/onboarding, accidents, hours, shifts, contracts, leave and requests. Managers remain nonadmins for other employees' personal records. SQL filtering precedes limits/paging; conflict bodies and polling must not reveal another owner. Existing employee privacy and identity regressions remain required.
- Wholesale tenants: customer sessions are separate host-only opaque tokens. Business scope is enforced on orders, invoices/PDFs, account updates, white-label catalogue choices and uploaded images. Pending/rejected accounts cannot order. Staff dashboard grants do not confer Admin or employee-data rights; its expanded fulfilment/customer-contact access is intentional.
- Accounting: Admin-only credentials/mappings/exports; OAuth state bound to initiating admin/session and expiry; signed webhooks restricted to the configured host/environment; provider errors sanitized. Customer invoices omit employee issuance attribution and internal payment references. Sandbox observations cannot become customer Live balances.
- Files/backups: arbitrary KV keys cannot be read through `/_blob`; its IDs are constrained. Allergen PDFs are shared business files for signed-in staff, not an employee-private document store. JSON backup routes are admin-only and omit password hashes, sessions, OAuth nonces and encrypted QuickBooks app credentials.
- Browser and output: self-only scripts/connections, escaped customer text, raster-only photo uploads, protected response body readers and no persistent staff order/accounting caches. Customer baskets and uncertain checkout payloads intentionally persist under owner-specific keys to prevent duplicate orders. These browser keys are not encryption: a person with access to the browser profile or developer tools can inspect stored recovery data. Passwords and API secrets are not stored there. Use separate browser profiles on hardware shared between different businesses.
- Notifications: Resend, Slack and QuickBooks are intentional configured processors. Employee emails contain recipient-scoped information; wholesale notifications contain operational order details. No real provider messages were sent during this review.
- Tracked source and the reachable local Git history scan found no matching private-key, GitHub-token, AWS-access-ID or live Stripe-key patterns. `npm audit` reported zero known vulnerabilities in the installed dependency set at review time. These pattern-based checks are bounded evidence, not a guarantee about every secret format, unreachable/deleted history or future vulnerabilities.

## Encryption

HTTPS is enforced for deployed hosts, with HSTS. Cloudflare documents automatic encryption at rest and in transit for [D1](https://developers.cloudflare.com/d1/reference/data-security/) and [Workers KV](https://developers.cloudflare.com/kv/reference/data-security/), including stored database/file/backup values. Provider encryption keys are managed by Cloudflare; no extra application setting enables that protection.

QuickBooks client credentials and OAuth tokens additionally use application-level AES-256-GCM with random IVs and authenticated environment/purpose/generation context. The separate `QUICKBOOKS_TOKEN_KEY` remains in Cloudflare secret configuration, outside D1 and JSON backups. Passwords use per-account salted PBKDF2-SHA-256 hashes. Session identifiers and invitation tokens use cryptographic randomness; customer sessions/invitations store token hashes, not bearer tokens.

Employee hours, addresses and other ordinary records are not individually field-encrypted by the application. The authenticated Worker must be able to read them to serve authorized users. Storage encryption does not prevent an authorized or compromised hosting administrator from accessing data.

## Limits and follow-up

Cloudflare/GitHub account membership, two-factor authentication, secret rotation and copies exported outside the application cannot be established from repository inspection and anonymous HTTP checks. Review those administrative controls separately. Downloaded files, screenshots and data already seen by an authorized recipient cannot be recalled by changing server permissions.

The existing PBKDF2 work factor is 10,000 iterations. Benchmark a higher password hashing cost within the Workers CPU budget as a further defense against an offline attack after a database compromise. This review does not silently change password formats or hosting resource requirements.

Validation records: `security-boundary.test.mjs` covers anonymous/forged sessions, configured origins, employee ownership, ordering identity mismatches, compact proof privacy and protected PDF caching. `wholesale-session-security.e2e.test.mjs` covers phone/iPad light/dark identity changes, held history responses and offline Retry. Existing staff/employee identity, checkout recovery, customer isolation and QuickBooks suites remain part of the full checks. Final release results are recorded in the pull request.


### Holiday-management addendum

The later holiday-management request explicitly authorises a narrow colleague calendar. The new calendar constructs only approved annual-leave names/dates and generic blackout availability. It does not change the general rota privacy filter or expose colleagues’ contracts, hours, reasons, pending requests, balances or sickness/other absence. Detailed reads remain owner/admin; settings, allowances, credits, blackout changes, classification and events remain admin-only. The shared session guard clears dashboard/editor state on identity changes, and leave data is not persisted in localStorage.

The optional GOV.UK lookup sends no personal information and uses a fixed public URL. Leave records/audit history stay in D1 and admin-only backups under the existing transport/storage controls. Dedicated API and browser regressions exercise ownership, role boundaries, no-store responses, shared-calendar minimisation, account switching, approval concurrency and duplicate/double-count prevention.
