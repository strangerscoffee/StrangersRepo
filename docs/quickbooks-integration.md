# QuickBooks Online integration

Updated 10 November 2026. **Admin → Wholesale → Invoicing → QuickBooks** supports separate UK/GBP Sandbox and Live connections, reviewed invoice exports, durable retry/recovery, payment observations and an explicit environment switch. It exports **issued wholesale invoices**, preserving their numbers, dates, terms and financial snapshots. Orders and baskets are not accounting records.

The default is **Sandbox**. Live requires configured Production credentials, confirmed company/mappings, actual Sandbox export and payment evidence, and an admin’s final review. This release has been exercised against a loopback provider with synthetic data; it does **not** establish acceptance by a real UK Intuit sandbox. Complete the real tests below before approving Live. No Production company, paid subscription, app credential or DNS configuration is created by deployment.

## Configure the app

1. Create a QuickBooks Online app and UK/GBP sandbox in the [Intuit developer portal](https://developer.intuit.com/app/developer/homepage). Use Development credentials for Sandbox. Obtain Production access/credentials through Intuit’s current app requirements for Live; confirm the company subscription, app tier and any fees.
2. Register this **same exact HTTPS callback** in the app’s Development and Production settings:

   ```text
   https://admin.staffstrangerscoffee.com/api/admin/wholesale/quickbooks/callback
   ```

3. The site owner configures these Worker variables/secrets in Cloudflare. Never paste credentials into chat or commit them:

   | Worker setting | Purpose |
   |---|---|
   | `QUICKBOOKS_CLIENT_ID` | Development client ID (Sandbox) |
   | `QUICKBOOKS_CLIENT_SECRET` | Development client secret |
   | `QUICKBOOKS_PRODUCTION_CLIENT_ID` | Production client ID (Live) |
   | `QUICKBOOKS_PRODUCTION_CLIENT_SECRET` | Production client secret |
   | `QUICKBOOKS_TOKEN_KEY` | Independent base64-encoded 32-byte AES key; keep a secure recovery copy |
   | `QUICKBOOKS_REDIRECT_URI` | Exact callback URI above |
   | `QUICKBOOKS_SANDBOX_WEBHOOK_TOKEN` | Intuit Development webhook verifier token |
   | `QUICKBOOKS_PRODUCTION_WEBHOOK_TOKEN` | Intuit Production webhook verifier token |

   Store client secrets, encryption key and verifier tokens as **secrets**. Generate the independent encryption key in a trusted terminal with `openssl rand -base64 32` and put it directly into Cloudflare. Do not reuse the app secret, a password or a session key. Missing Production settings do not prevent Sandbox testing. Missing webhook tokens disable that webhook; scheduled reconciliation remains available.

4. In Intuit, subscribe to **Invoice and Payment** notifications with separate environment settings and verifier tokens:

   ```text
   Development: https://admin.staffstrangerscoffee.com/api/quickbooks/webhook/sandbox
   Production:  https://admin.staffstrangerscoffee.com/api/quickbooks/webhook/production
   ```

   Both current CloudEvents arrays and legacy `eventNotifications` are accepted. Register the app’s actual notification format and verify deliveries in its console. Raw-body HMAC-SHA256 verification is mandatory; these service callbacks do not use employee/customer sessions.

5. In the Admin QuickBooks window, connect **Sandbox**, complete Intuit consent, check the returned company ID/name/GB/GBP and confirm its VAT registration. The entered VAT number is an admin attestation, not an Intuit registration validation. It must match the supplier registration on exported invoices.
6. In QuickBooks, enable custom transaction numbers and service dates. Use existing active Service/NonInventory sales items with active Income/OtherIncome accounts. This adapter neither creates customers nor adjusts inventory.

All provider roots are fixed in server code: Intuit OAuth, `sandbox-quickbooks.api.intuit.com` and `quickbooks.api.intuit.com`. The loopback `QUICKBOOKS_TEST_ORIGIN` override is ignored on deployed hosts; never configure it in production. No SDK, new queue binding or external tracker is required.

## Test Sandbox, then switch to Live

1. Complete Strangers invoice settings: legal supplier/address, VAT registration, price basis, rates, invoice numbering and payment instructions. Issue a local invoice from an approved customer’s saved order. Check the local PDF before exporting.
2. Open that issued invoice → **Open QuickBooks**. Explicitly map the approved business to an existing QuickBooks Customer, coffee/delivery items and each saved VAT rate/treatment. Optional QuickBooks terms must match net periods; without a term link the saved due date and terms text are still exported. Zero-rated and exempt are different treatments; compound VAT is blocked.
3. Choose **Save and preview**. Check company, number, billing/shipping address, invoice and supply dates, terms/due date, descriptions, quantities and exact net/VAT/gross totals. The preview itself is side-effect free. Tick the export review and choose **Send to Sandbox**. Sending never emails the invoice or creates a payment.
4. Compare the **actual Intuit invoice and API response** with the issued invoice. Test the price bases, zero/exempt/standard treatments, mixed rates, delivery charges, fractional VAT rounding, pack/grind descriptions, explicit/custom due dates, historical locations and supply dates that the business uses. Intuit document numbers must fit 21 characters; long numbers block instead of being truncated. Reconcile any discrepancy before proceeding.
5. Record a **partial payment in the QuickBooks sandbox**, then use the linked export’s refresh icon. Check the exact remaining amount. Record full settlement and refresh again. Verify a signed notification and scheduled catch-up too. Sandbox balances never change customer-facing invoice payment status.
6. Open **Set up Live** → **Open Live connection and mappings**. Connect and confirm the real company using Production credentials. Review mappings against its own IDs, even when numbers happen to match Sandbox. Preparing Live mappings leaves Sandbox active.
7. Complete **Live readiness**. The server requires a reviewed UK/GBP Live company, supplier VAT match, financial mappings and successful Sandbox-created/reconciled invoice plus partial/full payment evidence for that VAT registration. Review the actual test results, rounding, app requirements and fees. Approval alone does not switch modes.
8. Select **Live**, review the destination and choose **Use Live**. Review/export **one real issued invoice** first, compare it in QuickBooks and check customer visibility. Invoice exports remain explicit admin actions. Every Live invoice’s price basis, line kind, VAT percentage and zero/exempt treatment must have a corresponding successful Sandbox profile; untested profiles are blocked.

The switch controls **new exports**. Existing exports retain their environment/company forever. Existing Live payment updates continue when Sandbox is active. Mapping, company, supplier VAT or relevant financial setup changes invalidate the Live approval; an active export prevents switching mid-send. Approval also becomes invalid if the approving admin is offboarded.

## Export and payment behaviour

- Validation/queueing and processing use separate Worker invocations to stay within hosting budgets. The browser starts processing after the durable acknowledgement; scheduled recovery handles a missing follow-up. Before any Accounting API create, D1 stores a unique operation with company/environment, immutable payload, source/content hashes, original invoice, mapping revision and a stable request ID. Retries reuse the same body/request ID. A lost response is recovered by checking invoice number **and full identity**, including the original request marker, rather than issuing another invoice.
- Existing manual invoices require an explicit **Link existing invoice** review and exact financial match. This does not count as successful Sandbox create evidence. Conflicting or deleted remote records enter review; the app never automatically recreates a deleted invoice, renumbers it, edits it to match, or transfers its link to another company.
- **Export history** pages all saved operations in the selected environment, including previous companies. Paused/review operations can be reviewed and retried only against their original company. Automatic retries are bounded and honour provider throttling; repeated failures require admin review.
- Live-linked invoices display separately stored QuickBooks balance observations: unpaid, part paid, paid, overdue or review. Customer APIs expose only that business’s invoices, remaining amounts and checked time. They omit export IDs, provider diagnostics and internal payment references. Sandbox observations are excluded.
- Payments are recorded/corrected in QuickBooks after a Live link; local full-paid editing is blocked. A local paid flag conflicting with QuickBooks enters review. Missing, voided, edited or financially mismatched invoices never become false payment confirmations. Customer UI asks Strangers to confirm a disputed balance; totals identify saved balances pending review.
- Signed notifications are deduplicated and durably queued before acknowledgement. Workers read authoritative Invoice/Payment records; notifications themselves do not prove payment. A five-minute scheduled job processes bounded export/event work, polls Invoice CDC with overlap, and sweeps owned links after gaps and daily. Overdue CDC recovery receives priority at least every 15 minutes of scheduled opportunities so an event backlog cannot starve it. Refresh controls can request catch-up without changing environment. Out-of-order reads cannot overwrite newer revisions.
- No automatic export on order placement, invoice email/send, Payment creation, bank/card collection, refunds, credit notes or remote deletion is implemented. Deleting a source order leaves issued invoices and accounting links intact. The customer PDF financial snapshot remains unchanged by payment synchronisation.

## Privacy and connection safeguards

All management/export routes require a current admin under existing session, identity, Origin and write-limit guards. No accounting action reads employee hours, payroll, private contacts or onboarding information. The Accounting OAuth scope is broader than this adapter’s actions; server code exposes only fixed allowlisted reads and invoice creates, never a generic API proxy.

OAuth state is hashed, single-use, ten-minute, and tied to the initiating admin/session/connection version/**environment**. Environment comes from that saved state on callback. Tokens remain server-side, encrypted with AES-GCM binding environment, realm and connection generation. Migration preserves legacy Sandbox ciphertext with its original authenticated context; legacy format is never accepted for Live. Refresh leases/token versions protect rotation and disconnect races. Disconnect clears local credentials first and attempts Intuit revocation; failure is shown safely.

Provider bodies are size/time bounded, redirects refused and errors redacted. Paged reference DTOs omit provider addresses, notes and emails. Mapping/export reads cache repeated references and have a 45-distinct-read budget; each queued operation rechecks its source, references, approval, original company and currently active admin before writing. Browser polling stops after a short interval or leaving its window. No token or accounting draft is put into browser storage.

## Storage and recovery

Migration **16** is additive to shipped migration 15. It moves the existing connection/mappings into the Sandbox namespace, retires old token/nonces and creates scoped connections/mappings, environment settings, durable exports, payment observations, minimal event queue, Sandbox evidence and reconciliation checkpoints. It leaves issued invoices and invoice numbering unchanged. `quickbooks_installation.namespace` remains the stable request-ID namespace.

JSON backups preserve company metadata, original request bodies/hashes/IDs, links, observations, verification evidence and checkpoints, while excluding credentials, OAuth nonces, leases and Live approval. Settings default to Sandbox; unlinked operations are restored in review. There is no automatic restore endpoint. A manual JSON restore must reconnect companies and reapprove Live before any export processing.

A **raw D1 export or point-in-time restore may contain credentials and active work**. Before serving a restored database, disconnect both modes and pause pending operations:

```sql
UPDATE quickbooks_connection
SET status='disconnected', token_data=NULL, generation=lower(hex(randomblob(16))),
    version=version+1, lease_owner=NULL, lease_until=0;
DELETE FROM quickbooks_oauth_states;
UPDATE quickbooks_connections
SET status='disconnected', token_data=NULL, generation=lower(hex(randomblob(16))),
    version=version+1, lease_owner=NULL, lease_until=0;
DELETE FROM quickbooks_auth_states;
UPDATE quickbooks_settings
SET active_environment='sandbox', live_approval=NULL, version=version+1;
UPDATE quickbooks_exports
SET state='review', lease_owner=NULL, lease_until=0, retry_at=0, version=version+1,
    last_error='Restored database: reconnect the original company and review before retrying.'
WHERE state<>'linked';
UPDATE quickbooks_events SET state='queued', lease_owner=NULL, lease_until=0;
UPDATE quickbooks_reconciliation SET lease_owner=NULL, lease_until=0;
```

Preserve the installation namespace, original ledger payloads/request IDs/company IDs, remote links, invoice snapshots and both invoice/export sequences. Do not copy a Sandbox link into Live. Reconcile each uncertain operation against its original company; recreating the ledger loses duplicate protection. Keep encryption keys outside database backups; revoke old Intuit grants after an incident and reconnect normally. Intentionally rotating the key requires disconnect/reconsent. Removing app credentials disables provider access without dropping invoice history.

## Implementation and verification

`preview.ts` validates the issued snapshot and returns a non-transmitting review candidate (`canTransmit:false`). `payload.ts` builds the international VAT payload and compares complete remote identity. `connection.ts`/`crypto.ts` handle scoped OAuth and bounded transport. `ledger.ts` handles durable create/recovery, `settings.ts` Live gates, `observations.ts` balances, and `webhooks.ts`/`jobs.ts` notification and CDC recovery. `runtimeSchema.ts` defines migration 16. Native Admin sheets and customer invoice UI use existing site themes/accessibility patterns.

```sh
npm run quickbooks:preview       # deterministic offline example, no network
npm run test:quickbooks          # pure adapter and loopback API/security cases
npm test                        # complete typecheck and API/PDF suite
npm run test:e2e                # complete browser suite, phone/iPad/desktop light/dark
```

The loopback fixture deliberately collides Sandbox/Live IDs and exercises lost responses, throttling, mismatches, partial/full balances, stale reads, signed/replayed notifications and missed-event recovery. These tests verify our implementation; they are not proof of actual Intuit VAT acceptance, configured credentials or a successful real company connection.

## Primary references

- [OAuth](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0) and [Production app credentials](https://developer.intuit.com/app/developer/qbo/docs/get-started/get-client-id-and-client-secret).
- [Invoice API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/invoice): international inclusive/exclusive VAT, tax detail, service dates, customers and items. Inclusive exports use net line amounts plus `TaxInclusiveAmt`; actual UK rounding requires real Sandbox review.
- [IDs and request IDs](https://static.developer.intuit.com/output_html/qbo/docs/learn/learn-basic-field-definitions.html): preserve `DocNumber` within 21 characters and reuse the same ≤50-character request ID/body after uncertainty.
- [Webhook configuration](https://static.developer.intuit.com/output_html/qbo/docs/develop/webhooks/configure-webhooks.html) and [reliability/ordering](https://static.developer.intuit.com/output_html/qbo/docs/develop/webhooks/best-practices.html): raw-body signature, environment verifier keys, replay handling and CDC recovery.
- [Partner programme](https://static.developer.intuit.com/output_html/qbo/docs/get-started/partner-faq.html) and [API limits](https://static.developer.intuit.com/output_html/qbo/docs/learn/limits-and-throttles.html): review the actual app’s access, fees and limits before the Live pilot.

Hosting limits: validation and processing have separate D1 budgets; batched work stays bounded. See [Cloudflare D1 invocation limits](https://developers.cloudflare.com/d1/platform/limits/) and [Worker subrequest limits](https://developers.cloudflare.com/workers/platform/limits/).
