# Wholesale ordering preview

**Private design preview:** https://strangers-wholesale-preview.magicloom512.chatgpt.site — published as a separate owner-private Site for review. This is a static copy of the preview directory; changes to the GitHub repository do not automatically update it.

The first wholesale ordering concept is at **`/wholesale-preview/`**. On the staff Worker it uses the existing sign-in boundary and is reached by its direct URL. It has its own page, stylesheet and modules; it doesn't change the diary, rota, admin, routing, schema or APIs.

The cream background, green controls, serif headings and original coffee images follow the supplied Strangers shop screenshots. The page adapts to phone, tablet and desktop widths, with a sticky order panel on wide screens and a basket shortcut on smaller screens. Dark mode follows the device setting. Keyboard focus, native modal dialogs, labelled controls, a search empty state, quantity errors and reduced motion are included.

## Trying it

With the usual `npm ci` and `npm run dev`, sign in and visit `http://localhost:8787/wholesale-preview/`. See [README-deploy.md](../README-deploy.md) for staff app setup.

For a standalone static preview, serve **only** `public/wholesale-preview/` as the document root. All of its assets use relative paths, so the same files also work at `/`. No runtime configuration, staff credentials or database is needed for that standalone copy.

1. Filter the coffees or search by name, origin or tasting note.
2. Choose a 1 kg bag or a case of six 250 g bags, a grind, and a whole number of packs from 1 to 99.
3. Add to the basket. Matching coffee, pack and grind variants combine; different variants stay separate. Change quantities or remove lines in the order panel.
4. Review the sample order and try the delivery preference/reference controls. **Finish preview** ends the demo. It does not submit or transmit anything, and keeps the basket available for changes.

The basket is stored under `strangers.wholesale-preview.v1` in this browser's localStorage. It is a shared browser demo basket, not a wholesale account or a staff record. Invalid stored lines are discarded. If storage is blocked or full, the basket works in memory and the page says it is temporary. Delivery preference and purchase reference are never persisted and are cleared when the dialog closes.

## What is illustrative

**Every price, wholesale pack offering, grind offering and brew-style grouping is an example for design review.** These are not imported wholesale prices, guaranteed stock, account entitlements or agreed terms. The page makes that explicit. Delivery charges, minimum orders, tax treatment, customer authentication, availability, dispatch dates, payments and order submission are not implemented. The retail site's free-shipping offer has not been applied to wholesale orders.

`public/wholesale-preview/order.js` contains the demo catalogue and the basket model. Prices use integer pence; weights use integer grams. One case counts as one pack, weighs 1.5 kg, and has its own example case price. `wholesale.js` owns the page interactions and calls no APIs. `wholesale.css` is scoped by being loaded on this page alone. `index.html` contains the shell and dialogs. There are no external fonts, scripts, trackers or runtime image dependencies.

`test/wholesale.test.mjs` checks variant merging, pack/weight/price calculations, quantity limits and storage validation. It is included in `npm test` and can be run alone with `node --test test/wholesale.test.mjs`.

## Image sources

Product images were downloaded from Strangers' own website, [strangerscoffee.com](https://strangerscoffee.com/), for this Strangers preview. The logo is the existing repository logo, copied into the preview so it can be served independently.

| Local image | Original Strangers asset |
| --- | --- |
| `brazil.webp` | [Bom Jesus](https://images.squarespace-cdn.com/content/v1/52192929e4b0f11bee53437a/7c5f16b4-a267-4d11-93e4-433582b01c8c/Bom+Jesus+.webp) |
| `colombia.webp` | [Anserma](https://images.squarespace-cdn.com/content/v1/52192929e4b0f11bee53437a/ba998547-1746-40b4-b863-6313152429cc/Anserma.webp) |
| `ethiopia.webp` | [Idido](https://images.squarespace-cdn.com/content/v1/52192929e4b0f11bee53437a/eb952ef6-105b-4011-871b-e52ecd6c4bf6/Idido.webp) |
| `christmas.webp` | [Christmas Blend](https://images.squarespace-cdn.com/content/v1/52192929e4b0f11bee53437a/82e28567-d431-4f85-a357-7fdf8bdf68f5/Xmas.webp) |
| `decaf.webp` | [Decaf San Lorenzo](https://images.squarespace-cdn.com/content/v1/52192929e4b0f11bee53437a/261d70a5-bdd6-433f-ad25-a22b7c06a959/Decaf+San+Lorenzo.webp) |
| `rocko.webp` | [Rocko](https://images.squarespace-cdn.com/content/v1/52192929e4b0f11bee53437a/0998a209-74b7-434c-a7f6-d8dd88d3600a/Rocko.webp) |
