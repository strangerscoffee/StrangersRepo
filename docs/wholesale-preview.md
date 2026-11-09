# Wholesale ordering public demo

- Ordering page: https://strangers-wholesale-preview.magicloom512.chatgpt.site
- Dashboard: https://strangers-wholesale-preview.magicloom512.chatgpt.site/dashboard/

The user requested a public demo. Both pages are published as an independent public Site, using a static copy of `public/wholesale-preview/`. Changes to the GitHub repository do not automatically update that copy. The staff Worker, its sign-in, diary, rota, admin, database and APIs have not been changed.

## Data from strangerscoffee.com

`catalogue.js` contains a snapshot of all ten coffees on the public shop, retrieved **9 November 2026**. It includes the published product title, short display name, tasting notes, original product image, product URL and one-off retail prices for **250 g, 500 g and 1 kg** bags. Prices are stored in integer GBP pence and weights in integer grams. Each bag size uses its independently listed price. The five grind options follow the public product listings. Images are downloaded locally; there are no external runtime fonts, scripts, trackers or image dependencies.

These are **retail prices, not wholesale rates**. That distinction and the snapshot date are visible on the ordering page and dashboard. Delivery, tax treatment, minimum orders and wholesale account terms are not calculated. The public retail free-shipping offer has not been assumed to apply to wholesale. Live stock and subscription offers are not imported. The single-origin/blend/decaf filters are demo groupings based on the products, not claims about brew suitability.

The public product JSON can be read at the source product URL with `?format=json`. The imported `variants` provide weight, grind and one-off retail prices; `excerpt` supplies tasting notes; `assetUrl` supplies imagery. Every product record retains its source URL and source update timestamp. This is a snapshot, not an automatic sync.

## Trying the demo

1. Browse or search the catalogue, choose a weight, grind and whole number of bags from 1 to 99, and add to the basket. Matching variants combine; different weights and grinds stay separate.
2. Review the order. **Create demo order** saves a fictional order in this browser and offers a direct link to its dashboard record. It does not submit a real order, email anyone, take payment or contact the roastery. The basket is retained.
3. Open **Dashboard preview** to filter orders, change a demo status, edit an order note, create/edit fictional customer accounts, or edit demo catalogue prices and visibility. A new dashboard order can also be built from the current browser basket.
4. Reload the ordering page after editing the catalogue to see new demo prices/visibility. A visible notice identifies locally edited prices. Historical sample orders keep their original price snapshots. Hidden coffees cannot be reviewed from an existing basket until removed.
5. **Reset demo data** restores fictional orders/customers and the imported retail prices after a review dialog. The ordering basket keeps its items.

The initial six orders and three customers are fictional. Customer email examples use `example.test`. Orders created from the shop use a fictional “Ordering preview account”. No real customer data was obtained from Strangers. The dashboard is a functional UI prototype, **not a server-backed admin system**.

## Local storage and privacy

Each visitor has their own browser-local demo state; edits are not shared with other visitors or devices. The keys are `strangers.wholesale-preview.v1` (basket), `strangers.wholesale-dashboard-preview.v2` (demo customers/orders, including optional reference, notes and delivery preference), and `strangers.wholesale-catalogue-preview.v2` (price/visibility overrides). Stored input is validated and rendered as escaped text. Blocked/full browser storage is reported; the UI never claims a demo order was saved when storage failed. Do not enter real customer or account details in this public demo.

## Files and verification

`index.html`, `wholesale.css` and `wholesale.js` own the shop. `order.js` holds the basket model. `catalogue.js` is the sourced product snapshot. `dashboard/index.html`, `dashboard.css`, `dashboard.js` and `store.js` implement the management demo and browser storage. No server, secrets or API configuration is required.

For local staff Worker development, use `npm ci`, `npm run dev`, sign in and visit `/wholesale-preview/` or `/wholesale-preview/dashboard/`. For an independent static demo, serve only `public/wholesale-preview/` as the document root. Relative asset URLs support either location.

`test/wholesale.test.mjs` covers variants, weight/retail-price totals, quantity limits, storage validation, catalogue overrides, checkout-to-dashboard records, historical prices and blocked storage. It is included in `npm test`; run it alone with `node --test test/wholesale.test.mjs`. Browser QA remains limited by this environment's missing Chromium executable and unavailable managed browser-control tool. The initial hosted desktop screenshot was inspected; interactive phone/iPad and dark-mode browser checks remain unverified.

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
