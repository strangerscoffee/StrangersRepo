# Signed-in wholesale ordering preview

- Ordering: **https://preview.staffstrangerscoffee.com/**
- Management: **https://admin.staffstrangerscoffee.com/#wholesale**

These addresses are the configured deployment targets. They become available when this branch is deployed through the repository’s normal pull-request/Cloudflare workflow. The independent public Site built in the earlier design pass is a separate historical demo and does not connect to these staff records.

## Staff sign-in and Admin integration

The ordering page is a fourth app on the existing Worker, selected by `PREVIEW_HOST`. Every ordering page and preview asset passes the existing staff session check. Signed-out pages redirect to Staff Login; APIs return 401. `/signin` on the preview subdomain redirects to the existing sign-in page on `staffstrangerscoffee.com` with a return URL to the preview. The shared cookie domain and existing account/session revocation rules apply. The preview hostname cannot serve diary, rota, document, blob or admin management APIs.

All signed-in staff roles can browse coffee and save preview orders. Only admins can manage the **Wholesale** menu section, see all preview orders/customers or edit catalogue prices and visibility. It is part of the existing admin page, with the same theme, sidebar, mobile More menu, sheets, clock correction, session checks and live-change notifications. There is no separate dashboard app. The old `/wholesale-preview/dashboard/` address redirects admins to Admin → Wholesale; other roles receive 403.

## Shared backend

Migration 11 creates `wholesale_preview`, with `(kind, id)` as its primary key and JSON data, version and server update time. Its kinds are `order`, `customer` and `catalogue`. Orders and customer records start empty; no fictional customers are silently seeded into staff data. Orders saved from one signed-in device appear in Admin on another. Admin-created preview customers can be linked to orders.

`src/wholesale.ts` validates all requests. The server fixes the creator identity and UK date, validates bag/grind variants and integer quantities (1–99 per variant), calculates prices/weights from the server catalogue and stores immutable line-price snapshots. The client’s quoted price is checked against the current price; stale or hidden coffee choices return 409 for a new review. A UUID request ID makes retried submissions idempotent and cannot be reused by another account or with another payload. Staff may read their own preview orders; admins may read all. Management writes require `ifVersion` and reject stale saves with 409.

Records are rate-limited through the existing per-user write limiter. Preview changes are audited and notify the admin change watcher; the table is included in nightly/manual backups. Admin views show the latest 200 orders/customers and the total record counts. No payment, email, invoice or fulfilment action is performed.

The shopping basket alone is browser-local, stored per signed-in user under `strangers.wholesale-preview.v2.<user-id>`. No old public-demo orders/customers/pricing overrides are imported from localStorage. Blocked browser storage makes only the basket temporary; saved preview orders go to D1.

## Sourced catalogue

`catalogue.js` contains all ten public coffees retrieved from strangerscoffee.com on **9 November 2026**: title, origin, process, tasting notes, original imagery, source URL and one-off retail prices for **250 g, 500 g and 1 kg** bags. Each weight uses its own published price, in integer GBP pence. All 150 source weight/grind variants were verified against the imported snapshot. The same JavaScript catalogue is imported by the server, with `catalogue.d.ts` supplying its TypeScript interface. There is one source snapshot.

These are **retail prices, not agreed wholesale rates**. That distinction is visible on both apps. Admins can set shared preview price/visibility overrides; historical orders keep their original prices. Delivery charges, tax treatment, minimum orders, subscriptions and live inventory are not imported. Product JSON is available at each source URL with `?format=json`; `variants`, `excerpt` and `assetUrl` supply the imported fields. Images are local files; no external scripts, fonts, trackers or runtime image requests are used.

## Files and checks

`public/wholesale-preview/index.html`, `wholesale.css` and `wholesale.js` implement the ordering page; `order.js` is its basket model. `public/admin/wholesale.js` implements the native admin menu section through the existing escaped HTML builder. `src/hosts.ts`, `src/index.ts`, `src/access.ts` and `src/wholesale.ts` own routing, sign-in boundaries and backend access.

Run `npm test` for the typecheck, existing API tests, basket tests and new wholesale routing/API tests. `npm run test:e2e` includes the ordering-to-admin journey, permissions/sign-out and phone/iPad checks in light/dark mode. Use `CHROMIUM_PATH=/usr/bin/chromium` when using the environment’s installed system browser. Optional `WHOLESALE_SCREENSHOT_DIR` captures the new app views during those tests.

## Source products and images

The logo is copied from the repository. Product imagery belongs to Strangers and is used for this Strangers demo.

| Coffee | Product source | Local image |
| --- | --- | --- |
| Brazil Fazenda Bom Jesus Natural | [Source](https://strangerscoffee.com/coffee/p/brazil-fazenda-bom-jesus-natural) | `brazil.webp` |
| Colombia Anserma Natural | [Source](https://strangerscoffee.com/coffee/p/colombia-anserma-natural) | `colombia.webp` |
| Ethiopia Idido Anaerobic Natural | [Source](https://strangerscoffee.com/coffee/p/ethiopia-idido-anaerobic-natural) | `ethiopia.webp` |
| Christmas Blend | [Source](https://strangerscoffee.com/coffee/p/christmas-blend) | `christmas.webp` |
| Decaf Colombia San Lorenzo | [Source](https://strangerscoffee.com/coffee/p/decaf-colombia-san-lorenzo) | `decaf.webp` |
| Ethiopia Rocko Mountain Natural | [Source](https://strangerscoffee.com/coffee/p/ethiopia-rocko-mountain-natural) | `rocko.webp` |
| Honduras Rosalina Ramos Natural | [Source](https://strangerscoffee.com/coffee/p/honduras-rosalina-ramos-natural) | `rosalina.webp` |
| Colombia Campo Santo Washed | [Source](https://strangerscoffee.com/coffee/p/colombia-campo-santo-washed) | `campo.webp` |
| Half Caff Blend | [Source](https://strangerscoffee.com/coffee/p/half-caff-blend) | `half-caff.jpg` |
| House Blend | [Source](https://strangerscoffee.com/coffee/p/house-blend) | `house.jpg` |
