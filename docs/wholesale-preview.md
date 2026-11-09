# Wholesale: accounts and ordering

Wholesale retains the existing address and data, with no Beta labels in the interface. Ordering: **https://preview.staffstrangerscoffee.com/**. Management: **https://admin.staffstrangerscoffee.com/#wholesale**, in the existing Admin sidebar or More menu. The independent public Site from the earlier design pass is a separate historical demo.

## Registration and approval

Customers request an account on the wholesale sign-in page with their business, contact name, email, username and password. Registration creates a pending sign-in and an On hold customer record; it issues no session. An admin reviews it under **Wholesale → Customers → the customer → Review sign-in**, selects Approved and leaves Allow sign-in checked. Approval activates the customer. Pending and declined accounts cannot access ordering or change their password through a session. No registration or approval email is sent automatically.

Admins may also create a customer and use Create sign-in, which generates an approved account with a one-time temporary password. The customer chooses their own password on first sign-in. Manage sign-in lets admins change usernames, disable access, decline applications, or reset passwords and unlock accounts. Resets return a temporary password once and invalidate existing sessions. Customers change their own password in My account; that signs out their other devices.

Wholesale passwords and sessions are separate from staff accounts. Migration 12 adds `wholesale_accounts` and `wholesale_sessions`. The host-only `sf_wholesale_session` cookie is HttpOnly, Secure and SameSite=Lax, valid for 30 days. Only its SHA-256 hash is stored in D1. Sessions check approval, account activity and session version on every request. They never authorize diary, rota or Admin access. Five wrong account passwords lock it for ten minutes; sign-in attempts are also limited per IP, and registration is limited to five requests per IP per hour.

Staff retain their existing Staff Login through the Staff sign-in link. Their ordering page shows a Staff preview banner and creates `PREVIEW-…` test orders. Customer orders use `WS-…` IDs and `preview:false`; the admin list distinguishes them. Staff sessions retain their existing shared-cookie behavior. The preview hostname refuses diary, rota, document and management APIs.

## Ordering and business details

Approved customers maintain contact details and saved delivery locations in My account, using version checks. The approved business name is displayed read-only; only admins can change it. Internal account notes, approval, hold status and payment-term changes are admin-only fields. An account on hold can still view its orders but cannot submit a new one.

Customers select coffee, pack size, grind and quantity, review their basket and choose delivery or collection. Review reloads the current catalogue and business profile, including payment terms. Delivery requires an address and postcode. The server fixes business ownership and identity, checks current prices, stock and variants, and snapshots delivery details, line descriptions/prices and payment terms. Checkout carries the reviewed `customerVersion`; changed business details or terms require closing the review and reviewing again. An older client without that version must reload. Later edits do not rewrite old orders. UUID request IDs make identical retries idempotent, including after stock or terms change; another account or payload cannot reuse one. Successful checkout clears the basket.

Orders arrive in Admin → Wholesale for the team to prepare and update through New, Preparing, Ready, Dispatched or Cancelled. Customers see only their business's orders and public statuses in My orders. Internal order notes remain admin-only. Customer orders cannot be reassigned to another business. Order again builds a new basket at current catalogue prices and waits for confirmation; it never submits automatically.

There is no payment gateway, automatic email, invoice or shipping integration. The coffee subtotal excludes delivery-charge calculations; Strangers confirms delivery separately. Default prices remain the source retail snapshot until admins edit them; negotiated wholesale rates are not invented.

## Payment terms

Admins set each business's terms under **Customers**: To be agreed (the default), Before dispatch, 7/14/30/60 days from invoice, or Custom. Payment instructions are customer-facing, up to 500 characters; Custom requires instructions describing the agreement. Customers see their current terms read-only in My account and checkout. The receipt, My orders and admin order details show the terms captured with that order. Older orders without a terms snapshot are preserved. The system records terms; invoicing and payment remain manual.

## Data and backups

Migration 11's versioned `wholesale_preview` records remain in place for customers, orders and catalogue records. Migration 12 adds an index for customer order lookups. Catalogue editing and terms need no new schema migration. Customer histories load 200 owned records per page, with Load earlier orders and loaded/total counts. Admin lists load 200 records per page, with server search/status/approval filters and Load more for older records. Dashboard counts and preparation totals cover all real customer orders, not just a loaded page. The basket alone is browser-local, per identity. No old browser-local demo records are imported.

All writes validate server-side, use the same Origin protection and rate limits, and are audited. Record edits use `ifVersion` and reject stale copies with 409. Wholesale writes notify the existing Admin change watcher. Backups include the shared records and wholesale account metadata, including approval status; password hashes, salts and sessions are excluded. Restoring an account therefore requires an admin password reset. Photo bytes in KV are not included in JSON or D1 backups; keep original files and reupload any missing photos after restoring to an empty KV namespace.

## Catalogue and presentation

`public/wholesale-preview/catalogue.js` is the shared ten-coffee source snapshot retrieved from strangerscoffee.com on 9 November 2026. It contains original imagery, descriptions, source URLs and independently published 250 g, 500 g and 1 kg prices for 150 weight/grind variants. Images are local originals; CSS preserves their full intrinsic proportions instead of forcing a tall crop. The introductory marketing block has been removed.

**Admin → Wholesale → Coffee catalogue** adds coffees and edits their full/short names, origin, process, tasting notes, photo label, categories and independent 250 g/500 g/1 kg bag prices. The catalogue supports up to 500 coffees. Visible and In stock are separate: an out-of-stock coffee stays visible with ordering disabled; a hidden coffee is removed from the ordering list. Existing basket lines are kept so customers can remove unavailable items. The server refuses new orders for either state. Added coffees appear in the customer catalogue without a code change.

Save a new coffee before adding photos. Upload or remove photos in its editor; these operations save immediately and update its version while keeping other unsaved form fields. Each coffee can have up to six JPEG, PNG or WebP photos, 5 MB each, served using the detected raster type (some source files have misleading extensions). An original bundled image can be unlinked and restored; uploaded images are removed from KV when deleted. Customer and admin image routes require their respective sessions and verify the current product reference. The customer gallery preserves every photo's proportions and shows a placeholder when there are no images. Refresh availability and checkout review fetch current data.

`public/wholesale-preview/` holds ordering, account/registration UI and the basket model. `public/admin/wholesale.js` is the native admin view and uses the existing escaped HTML helpers and sheets. `src/wholesaleAccounts.ts` owns customer authentication and account management; `src/wholesale.ts` owns profiles and orders; `src/wholesaleCatalogue.ts` owns catalogue edits and KV photos; `src/wholesaleStore.ts` owns versioned D1 record access. Host isolation is in `src/index.ts` and `src/hosts.ts`.

Run `npm test`, then `CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e` when using system Chromium. Tests cover registration/approval, cross-business privacy, staff isolation, version conflicts, reset/disable/logout revocation, holds, catalogue creation/editing, raster uploads/removal and limits, stock enforcement, admin-only terms, immutable order snapshots and retry safety. Browser journeys cover customer/staff ordering and catalogue/photo/terms management on phones and iPads in light and dark mode, full-image proportions, admin approval, history and reorder.

For local development: `npm run dev -- --var PREVIEW_HOST:`. Ordering is at `/wholesale-preview/`, customer sign-in at `/wholesale-preview/signin`, and management at `/admin#wholesale`.

## Interface and checkout recovery

Customer ordering and sign-in now use the staff apps’ shared Liquid Glass theme (`/theme.css`): system fonts, translucent cards and chrome, rounded controls, dark mode, safe areas and accessibility preferences. Admin Wholesale follows the existing admin section patterns. The hostname, API paths, storage keys and account/session/data identifiers are retained for compatibility; `preview` flags still distinguish staff test orders from real customer orders. Catalogue/session/bootstrap responses carry `stage:"beta"`.

Before sending checkout, the browser keeps the exact submitted payload and review summary under the signed-in identity’s basket key plus `.pending-order`. Unknown outcomes (network failure, malformed response or server error) keep that request frozen across closing/reloading; Check submitted order retrieves the owned receipt, or Retry same order resubmits the original UUID/payload. Successful receipts clear it; confirmed validation rejections permit a fresh review. Browser storage must be available before a new submission can be sent. A lost response cannot silently become a new request ID.

## Order history and packing UX

My orders shows explicit progress for received, preparing, ready and dispatched orders. Cancelled orders have their own callout and no completed progress timeline. Saved lines, delivery details and payment terms expand inside each card. Refresh orders starts again from the current first page; Load earlier orders appends and deduplicates older records while retaining expanded details.

Order again refreshes the catalogue and opens a repeat-basket confirmation showing available bags, current subtotal and unavailable/limited quantities. Existing basket lines are preserved and matching variants merge up to the existing 99-bag limit. Confirmation checks prices, availability and the current basket again; changes require another review. It never submits an order, and unresolved checkout attempts block repeat baskets.

Admin customer-order rows show references and delivery preferences and offer Mark preparing / Mark ready / Mark dispatched shortcuts. Each uses the displayed version and preserves internal notes, business ownership and immutable snapshots. Busy rows reject repeat taps. Failed or conflicting saves show an inline error and require Reload orders before another quick update. That guard remains through background updates and section redraws; a new server version alone does not dismiss it. Staff preview rows have no shortcuts. The full order sheet remains available for status changes, and opens at its accessible title above a packing list with distinct bag quantities, sizes and grinds.

Returning to a page from the browser’s back/forward cache closes private dialogs and reloads against the current session. Profile saves also check the signed-in identity in the browser and server; switching accounts cannot copy one business’s open form into another account. Pending checkout and basket recovery keep their existing per-identity keys.

## Removing orders

Admins can choose Delete order from the order details sheet, then confirm the identified business/order and subtotal. Cancelling confirmation keeps the order and the editor draft. Successful removal hides the order from admin, customer and staff lists, history, counts and preparation totals. Staff, managers and wholesale customers cannot delete orders. A stale version is rejected so another admin’s updated order cannot be removed without review. Deletion does not change any existing payment or trigger a refund.

The server retains the removed record with `deletedAt`/`deletedBy` for audit and duplicate-submission protection; backup exports retain it. The original successful request UUID cannot recreate a removed order: matching retries return 410 `order_deleted`. Removed orders return 404 on reads and further edits/deletes. This adds no table or schema migration.

## Saved delivery locations and ordering controls

Each business can keep up to 20 named delivery locations and choose a default. The main location remains linked to the existing primary address; additional locations can be added, edited and removed. Edits are staged in My account or the admin customer sheet and saved atomically with the customer version. At checkout, the business name stays fixed and a location picker shows the selected address and instructions. Receipts, history and admin packing views retain the chosen location as it was when ordered. Pending submissions retain the exact reviewed location/payload until resolved.

The customer header groups account identity, account actions, catalogue/history navigation and basket access. Empty baskets use plain guidance; populated counts show bags. Grind choices open a built-in dialog with explicit confirmation; cancellation preserves the card selection. The footer groups Wholesale branding and catalogue, order-history and website links. Help-card/ordering-guide windows and visible Beta labels are removed. Dialog close controls sit in their own sticky toolbar above the content.
