# QuickBooks Online integration

Updated 10 November 2026. The first runtime milestone connects **Admin → Wholesale → Invoicing** to a **UK QuickBooks Online sandbox**. It supports OAuth connection/disconnection, company confirmation, browsing existing accounting references, reviewed mappings and previews of issued Strangers invoices.

**Accounting writes remain disabled.** There is no QuickBooks invoice creation, email, payment collection or payment-status synchronisation in this milestone. `canTransmit` is always false. The current tests use a loopback Intuit simulator and synthetic records; a real UK sandbox has not yet been validated. Existing local invoices, PDFs and customer payment status remain authoritative.

## Configure a sandbox connection

1. In the [Intuit developer portal](https://developer.intuit.com/app/developer/homepage), create a QuickBooks Online app and a UK sandbox company using GBP. Use its **development** credentials. A production company cannot be used with this adapter.
2. Register this exact redirect URI in the app's development settings:

   ```text
   https://admin.staffstrangerscoffee.com/api/admin/wholesale/quickbooks/callback
   ```

3. The site owner adds the following Worker configuration in Cloudflare → Worker → Settings → Variables and Secrets. Never paste secrets into chat or commit them to the repository.

   | Name | Value |
   |---|---|
   | `QUICKBOOKS_CLIENT_ID` | Intuit app's development client ID |
   | `QUICKBOOKS_CLIENT_SECRET` | Development client secret; store as a secret |
   | `QUICKBOOKS_TOKEN_KEY` | Independently generated, base64-encoded 32-byte AES key; store as a secret |
   | `QUICKBOOKS_REDIRECT_URI` | Exact HTTPS URI above |

   Generate the encryption key in a trusted local terminal with `openssl rand -base64 32`, then put it straight into Cloudflare's secret configuration. Keep an independent secure recovery copy. Do not reuse a password, session signing key or Intuit client secret.

4. In **Admin → Wholesale → Invoicing → QuickBooks**, choose **Connect QuickBooks sandbox**, complete Intuit's company consent, then review the returned company name, ID, country and currency. Enter the sandbox supplier's VAT registration and explicitly confirm it. This VAT entry is an admin review, not an assertion that Intuit verified the registration. Invoice preview compares it with the supplier registration saved on the issued invoice.
5. Open an **issued invoice**, choose **QuickBooks sandbox preview**, and link its existing business/customer, coffee sales item, optional delivery sales item and VAT codes. Service or non-inventory items need an income-account reference. VAT percentages are checked against current active sales codes/rates. Review zero-rated versus exempt treatment explicitly; compound VAT is not supported.
6. **Save and preview** rechecks the references and shows saved net/VAT/gross amounts or blockers. It does not create an accounting transaction. The site owner and bookkeeping owner must still verify real UK VAT payloads, dates and penny rounding before the export stage can be enabled.

Without valid configuration, the native connection window shows a setup guide and cannot start OAuth. No new domain, queue, external SDK or paid service is provisioned. Review Intuit's actual app tier and fees before production use.

The Worker fixes all provider destinations to Intuit OAuth and the sandbox Accounting API. `QUICKBOOKS_TEST_ORIGIN` is a loopback-only test-harness override, ignored on the deployed admin host; never configure it on a deployed Worker. Local browser tests use fake keys and an ephemeral callback port, not a real Intuit app.

## Connection and privacy safeguards

- Every endpoint is admin-only under the existing staff-session, identity, Origin and write-limit guards. Wholesale customers, managers and staff cannot access connection metadata, references or mappings. Nothing reads employee hours, payroll, private contacts or onboarding data.
- OAuth requests use the Accounting scope only. State is random, hashed in D1, single-use, expires after ten minutes and is tied to the initiating admin's exact session and connection version. The callback rechecks the current role/session, validates its configured URI, and reads CompanyInfo/Preferences before accepting UK/GBP. Tokens never go to the browser.
- Access and rotating refresh tokens are encrypted with AES-GCM using the separate Worker key and authenticated company/connection-generation binding. A D1 lease serialises refresh; version checks prevent an old refresh or read response restoring a disconnected connection. Provider authorisation failures require reconnecting QuickBooks without signing the admin out of the staff site.
- Reference queries are fixed, paged and bounded. Each mapping/preview request caches repeated reference reads and allows at most 45 distinct provider reads, keeping large invoices within the Worker request budget. Browser responses contain IDs, names and minimal type/currency fields; provider addresses, notes and emails are omitted. Mapping saves and previews revalidate active references rather than trusting browser selections. Mappings use compare-and-swap versions and are scoped to the sandbox company.
- Provider responses are bounded, redirects are refused, errors are redacted and network timeouts are finite. Disconnect removes local credentials first and attempts Intuit revocation. If revocation cannot be confirmed, the UI advises checking the app's access in Intuit.

Changing the encryption key invalidates existing encrypted tokens and requires reconnecting. Disconnect before intentionally rotating it. Never switch this adapter to production by merely replacing a hostname or credential; environment-scoped storage and the remaining export safeguards must be implemented first.

## Storage and recovery

Migration 15 creates `quickbooks_connection`, `quickbooks_oauth_states`, `quickbooks_mappings` and `quickbooks_installation` in existing D1. It is additive and leaves issued invoices unchanged. JSON backups include the stable installation namespace, company metadata and reviewed mappings, but omit credentials, OAuth states, refresh leases and active-connection state. A manual JSON restore must keep the integration disconnected and require fresh consent. There is no automatic restore endpoint.

A **raw D1 export or point-in-time restore can contain encrypted credentials and active state**. Before serving a restored database, remove those credentials and pending states:

```sql
UPDATE quickbooks_connection
SET status='disconnected', token_data=NULL, generation=lower(hex(randomblob(16))),
    version=version+1, lease_owner=NULL, lease_until=0;
DELETE FROM quickbooks_oauth_states;
```

Preserve `quickbooks_installation.namespace`, mappings and all invoice snapshots/sequences. Keep the encryption key outside database backups. Revoke the old app grant in Intuit if restoring after an incident, then connect again normally. Schema rollback must not drop issued invoices; removing the optional app credentials disables new connections and previews.

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

## Development and verification

`src/quickbooks/index.ts` provides the admin adapter; `connection.ts` owns fixed provider reads, OAuth and refresh; `crypto.ts` owns token encryption; `schema.ts` contains migration 15. `public/admin/quickbooks.js` uses the existing Admin sheets, materials, escaping, keyboard handling and pinned actions on phone, iPad and desktop.

`src/quickbooks/preview.ts` is a pure planning module using the existing `InvoiceDocument`. It checks issuance, document-number limits, dates, supplier/company identity, explicit mappings and exact inclusive/exclusive pence arithmetic. It preserves due dates, terms, delivery and pack/grind descriptions. Employee issuance identity and manual payment metadata are omitted from its candidate.

A stable company/environment/installation/invoice request ID and separate content fingerprint are generated. Existing-link decisions and read-only balance reconciliation are tested as pure functions; there is **no persisted operation ledger or live balance reader yet**. A ready preview means `ready-for-sandbox-review`, not export readiness.

```sh
npm run quickbooks:preview       # deterministic offline JSON example, no server or network
npm run test:quickbooks         # planning and loopback API/security/concurrency tests
npm test                       # complete typecheck and API/PDF suite
npm run test:e2e                # complete browser suite, including six sandbox viewport/theme cases
```

The test provider is `test/quickbooks-provider.mjs`; it receives only fake credentials and synthetic local records. Tests cover role denial, session-bound OAuth/replay, encrypted storage, company validation, bounded reference paging, mapping conflicts, VAT checks, token rotation, disconnect races during refresh and reference reads, 150-variant invoices, shared historic VAT mappings, redacted failures and backups. Browser cases exercise the native OAuth → company review → mapping → preview flow without accounting writes. Tests are not evidence of a successful connection to a real Intuit company.

## Remaining development stages

1. **Real sandbox acceptance.** The site owner configures the development app and grants consent. Verify company reads, service/non-inventory income accounts, zero-rated versus exempt VAT codes, inclusive/exclusive and mixed-rate invoices, delivery, explicit/custom due dates, supply-date representation, long invoice numbers and penny-rounding edges against real UK sandbox responses. The reviewed candidate is deliberately not an API request body.
2. **Durable export ledger.** Before any external create, persist the realm/environment, local invoice ID, stable request ID, complete frozen operation body, fingerprint, mapping revision and pending state. Enforce one successful remote invoice per local invoice/company. After a timeout, retry the same operation or reconcile exact financial identity; never create a fresh operation because a response was lost. Preserve this ledger and links in backup/restore.
3. **Explicit sandbox export.** Add an admin review/confirm action only after the UK payload has been proven. Keep local issued invoices and PDF snapshots immutable. Existing document-number/customer/financial conflicts must require review rather than silently overwriting QuickBooks records.
4. **Payment observations.** Add persisted authenticated invoice reads, exact local/remote links, observed revisions/times, compare-and-swap and a separate balance model for unpaid/part-paid/paid/overdue states. The current local full-paid boolean cannot safely represent partial payments. Surface manual/accounting discrepancies for admin review before adding customer-visible accounting balances.
5. **Notifications and reconciliation.** Verify webhook raw-body HMAC and realm, acknowledge promptly, then process authoritative reads through a durable idempotent queue/outbox. Deduplicate events, prevent old observations replacing new ones, handle voided/deleted invoices as review and recover missed changes with scheduled CDC. Respect Retry-After and bound retries.
6. **Production pilot.** After approved production credentials, company consent, confirmed app costs/mappings and successful sandbox reconciliation, review one real issued invoice before export. Automatic export stays off initially. Intuit email/send, Payments, refunds, credits and invoice voiding need separate deliberate workflows. Deleting a local order never deletes its issued invoice or accounting entry.
