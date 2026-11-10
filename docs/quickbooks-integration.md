# QuickBooks Online integration research and first development

Research date: 10 November 2026. The host confirmed **QuickBooks Online**. UK/GBP is assumed from the existing Norwich wholesale business and invoices; verify the actual QuickBooks company before connecting.

The first implementation is an **offline foundation** on `feature/quickbooks-research`. It is not routed into the Worker, connected to Intuit, deployed, or capable of transmitting an invoice. No credentials, company records, accounting transactions, employee data or payments were accessed. Existing catalogue deployment is a separate release.

## Recommended first integration

Export **issued wholesale invoices**, not baskets or orders, into the company's QuickBooks bookkeeping. Keep the Strangers invoice number, financial snapshot and customer PDF authoritative. Read QuickBooks balances back into a separate accounting observation. Do not create duplicate customer emails, move money, infer payments from the site's manual paid flag, or change saved invoices to agree with QuickBooks.

| Strangers record | QuickBooks purpose | Required matching |
|---|---|---|
| Approved wholesale business ID | Existing Customer reference | Explicit business-to-customer link, scoped to company and environment; no automatic name matching |
| Issued invoice ID and number | Invoice identity and DocNumber | Preserve number exactly; reconcile existing records before creating |
| Saved coffee lines and delivery | Sales item lines | Reviewed coffee/delivery item references and income accounts; preserve descriptions, packs and grinds |
| Saved VAT rate ID and percentage | Company sales TaxCode reference | Reviewed mapping for each tax treatment; zero-rated and exempt remain distinct |
| Billing/location snapshots | Invoice billing/shipping address | Use historical invoice addresses; don't overwrite a customer's current address |
| Invoice date, supply date, terms, due date | Accounting dates and payment instructions | Preserve explicit dates and terms; verify the API's supply-date representation in a UK sandbox |
| QuickBooks Invoice Balance and totals | Read-only payment observation | Verify company, customer, invoice number, currency, VAT and gross total before showing status |

One customer can have multiple delivery locations. Start with one accounting Customer per approved business, using invoice-level addresses. Sub-customers/jobs or classes need a separate business decision; never infer them from a location name.

Use ordinary service/non-inventory item mappings for the first export. The current immutable invoice lines contain descriptions and pack/grind snapshots, not permanent product IDs. Do not attempt per-product accounting linkage by matching coffee names, or automatically alter QuickBooks inventory.

## Findings from Intuit's documentation

- QuickBooks Online uses OAuth 2.0 and company-specific realm IDs. Request the Accounting scope only. Sandbox and production use different app credentials; production credentials require Intuit's questionnaire/approval. Tokens rotate and expiry/reauthorisation must be handled server-side. [OAuth](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0) · [App credentials](https://developer.intuit.com/app/developer/qbo/docs/get-started/get-client-id-and-client-secret).
- Invoice creation needs a customer and sales lines. Local entity IDs cannot stand in for QuickBooks Customer/Item/TaxCode IDs. International tax calculation distinguishes inclusive and exclusive prices. Actual UK payload, supply-date handling and penny rounding still need sandbox verification; the offline candidate is deliberately **not** an API request. [Invoice reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/invoice).
- QuickBooks `DocNumber` supports 21 characters. Local invoice prefixes may produce longer numbers: block for review, never truncate. `requestid` has a 50-character maximum for a single operation; it and the frozen operation body must be reused after an uncertain result. A document number alone is not an idempotency mechanism. [IDs, request IDs and document numbers](https://static.developer.intuit.com/output_html/qbo/docs/learn/learn-basic-field-definitions.html).
- Webhook notifications require signature verification, quick acknowledgement and asynchronous processing. Notifications can be duplicated or arrive out of order. Intuit recommends change-data-capture reconciliation to recover missed changes. Treat a notification as a prompt to read the actual invoice, not proof of payment. Confirm the current notification format against the app's configured version when implementing. [Configure webhooks](https://static.developer.intuit.com/output_html/qbo/docs/develop/webhooks/configure-webhooks.html) · [Reliability and ordering](https://static.developer.intuit.com/output_html/qbo/docs/develop/webhooks/best-practices.html).
- Intuit's partner programme includes API limits and possible service fees. Check the actual app tier and API classification before enabling a production connection or payment method; no paid service has been enabled for this work. [Partner programme FAQ](https://static.developer.intuit.com/output_html/qbo/docs/get-started/partner-faq.html) · [Limits and throttling](https://static.developer.intuit.com/output_html/qbo/docs/learn/limits-and-throttles.html).

Some developer URLs return a JavaScript sign-in shell. The indexed official references above support the findings; they are not evidence that a UK sandbox API request has succeeded. Neither SDK behaviour nor a successful live connection is claimed.

## What is developed

`src/quickbooks/preview.ts` consumes the existing `InvoiceDocument` type and reviewed, company-scoped mappings. It has no runtime imports, endpoints, persistence or HTTP calls.

- Checks issuance, dates, the document-number limit, supplier VAT/UK/GBP identity, customer/item/VAT mappings and inclusive/exclusive source arithmetic.
- Retains integer pence, mixed VAT, delivery, due date, pack/grind descriptions and payment instructions. It blocks inconsistent line totals or VAT breakdowns instead of rounding away a discrepancy.
- Generates a stable company/environment/installation/invoice request ID, with a separate export fingerprint. Changing payment metadata does not change either; changing mappings changes the fingerprint but cannot silently generate a fresh create identity.
- Detects an existing link or conflicting linkage. This is a planning decision, not a persisted duplicate-prevention ledger.
- Compares a supplied QuickBooks response against an exact link and source totals. Returns unpaid, part-paid, paid or review without mutating the local invoice. Wrong company/customer/currency/number, missing records, void-like zero totals, changed VAT, excess balances or sub-penny values require review.
- Omits employee issuance identity and the site's manual payment metadata from the export candidate. The prototype has no access to rota, hours, payroll, training, private contacts or onboarding.

`canTransmit` is always false. A complete sandbox mapping produces `ready-for-sandbox-review`, not production readiness. References in the demo are **synthetic**, not verified Intuit company IDs. A future server adapter must obtain mappings from authorised server storage and verified company reads, never trust a browser to provide company approval or references.

Run the deterministic demo and tests:

```sh
npm run quickbooks:preview
npm run test:quickbooks
npm run typecheck
```

The demo uses `test/fixtures/quickbooks.mjs`. It reads no database, makes no network requests and shows a mixed-VAT invoice, missing-VAT blocker, duplicate-link decision, partial-payment observation and total-mismatch review. The test is also included in the normal API test command for future CI. There are no new front-end controls or customer-facing claims of connectivity.

## Next development stages

1. **Sandbox connection.** Register an Intuit app and UK sandbox company, then implement admin-only connection/disconnection with server-side OAuth and company confirmation. Client secrets and encryption keys go into Cloudflare secrets through the host's secure configuration; never paste them into chat or store them in source. OAuth state must be random, single-use, short-lived and bound to the initiating admin/session. Recheck the current admin at callback, validate the fixed callback URI and verify the selected company before accepting it.
2. **Credential storage.** Append a migration for integration metadata and encrypted token records. Use AES-GCM with a separately managed encryption key, company/environment binding, key versioning and a refresh concurrency guard. Store the newest rotating refresh token atomically. Never return tokens to the browser, write them into logs, include them in ordinary JSON backups, or revive a connection automatically after restore. Reconnection/expiry must fail closed.
3. **Discovery and mapping.** Read CompanyInfo, active customers, items and sales VAT codes. Confirm the intended legal company/VAT registration and GBP. Let an admin link existing records; don't create duplicates by fuzzy name matching. Validate tax treatments and income accounts with the bookkeeping owner. Keep customer-level and delivery-location data separate.
4. **Review and sandbox export.** Add an Admin → Wholesale → Invoicing accounting section with connection state, mappings, preview and explicit export. Verify inclusive/exclusive, zero-rated, mixed-rate, delivery, short payment terms, custom terms, long invoice numbers and rounding-edge examples against real sandbox responses. Confirm the supply-date field and exact tax payload before producing requests.
5. **Durable operation ledger.** Before an external create, persist the target realm/environment, local invoice ID, stable request ID, complete frozen body, fingerprint, mapping revision and pending state. Enforce one successful remote invoice per local invoice/company. A timeout keeps the same operation; reconcile by stable number plus exact customer/financial identity, handle conflicting matches explicitly, and never create again merely because the first response was lost. A local link alone cannot prevent duplicates after a crash between remote creation and local recording. Preserve links, pending operations, mappings and installation IDs in backup/restore while excluding credentials.
6. **Payment observations.** Persist authenticated reads with company-bound invoice links, observed revision/time and compare-and-swap. The current local payment model is a full-paid boolean; it cannot represent partial payments safely. Add a separate accounting balance model and customer-safe status before exposing partial/overdue balances. Show manual/accounting discrepancies for admin review. Do not create a QuickBooks Payment, debit a bank account or mark local records automatically from an unverified webhook.
7. **Notifications and reconciliation.** Verify raw-body HMAC signatures and the selected realm; use a durable, idempotent outbox/queue and acknowledge promptly. Fetch authoritative invoice data asynchronously. Deduplicate events, prevent older observations replacing newer ones, handle deleted/voided records as review, and recover missed events using scheduled CDC/reconciliation. Respect rate limits and Retry-After, redact provider errors, and bound retries.
8. **Production pilot.** After company consent, approved credentials, confirmed costs/mappings and successful sandbox reconciliation, review one real issued invoice before export. Keep automatic exports off initially. Intuit's email/send and Payments operations are outside the first integration. Deleting an order never deletes its issued invoice or accounting entry; credits, voids and refunds require a separate deliberate workflow.

No production credentials, new migration, DNS change, queue binding, paid service, live company connection, invoice upload, email or payment action is part of this research branch. The next external dependency is the host creating the Intuit app/sandbox and granting its normal company consent when the connection flow is ready; implementation can continue with synthetic fixtures meanwhile.
