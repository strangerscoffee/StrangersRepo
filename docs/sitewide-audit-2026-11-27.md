# Strangers sitewide audit, 27 November 2026

The audit started from StrangersRepo production commit `105b0bdd8d89d6e5b56c450eb067593b17245bc9` and retail service commit `a50d191`. Astra 6.2 agents reviewed the code by domain. Sol 6.2 agents implemented the repairs. Astra reviewed the resulting changes and sent concrete failures back to the builders.

## Findings and repairs

| Area | What could happen | Change and verification |
| --- | --- | --- |
| Staff accounts | A pending password or PIN operation could overwrite an administrator’s reset. A database interruption during a session lookup could make a signed-in user appear signed out. | Credential writes check the account and credential they verified when they commit. Session-bound PIN changes also check revocation and expiry. Setup and recovery reserve attempts atomically. Local regression tests interrupt the operations at their database writes and distinguish an unavailable database from an invalid session. |
| Rota contracts and holiday accrual | Contract hours could save without their effective-dated history. Retrying could leave the history missing permanently. Simultaneous changes could also erase each other. | The current record and history commit together. Concurrent edits merge disjoint fields or return a conflict. Tests inject a history write failure, retry, and overlap edits. No historical contract dates were inferred. |
| Diary, rota and people | A delayed rota response could attach the wrong week’s Publish action to another screen. Duplicate diary loads could replace newer data. Some safety instructions were clipped on phones. Impossible start dates could be saved. | Rendering checks the active view before updating actions. Diary reads coalesce and discard obsolete results. Mobile instructions stay readable, the availability disclosure announces its state, and profile dates are validated against the calendar. API and Chromium tests cover each regression. |
| Wholesale ordering and fulfilment | A recurring delivery could move to the wrong branch. Account, session or coffee changes during checkout could allow a stale order. Large packing selections exceeded D1’s parameter limit. | Direct orders verify the reviewed information and identity in the insert. Standing runs guard coffee revisions and the original location. Missing branches and incomplete addresses have different recovery instructions. The print query takes one parameter for up to 200 selected IDs. A sold-out catalogue still permits standing-order reductions, and order history uses the saved delivery charge and address. |
| Invoicing and QuickBooks | A matching name could override a verified customer ID. Currency, competing orders and truncated searches could produce misleading matches. A failed bulk confirmation could affect another operator’s work. A blocked batch could delay later invoices. | Suggestions respect the verified customer and currency. Paged reviews consider competing orders, report incomplete searches and revalidate before an atomic confirmation. Failed batch items are eligible again after a delay, and manual retry remains available. Tests use a local provider to cover competing confirmations, a company switch, large reviews and independent batch progress. |
| Consumer packing and support | Stale packing selections could undo another operator’s ticks. Older support messages fell outside the 50-row inbox and search. | Packing reconciles line edits with the latest order. The separately signed retail service supports full-inbox literal search, counts and cursor pagination. Tests include competing packers, messages with tied timestamps and more than 50 unresolved enquiries. Older service responses have an explicitly limited fallback. |
| Consumer accounts, checkout and cart | A restored tab could show a previous customer’s private details or write under another login. Changes from another tab could cause basket items to disappear. | The branded gateway binds signed-in operations to the session that supplied the details. The browser revalidates identity before restoring private views. Cart operations address a specific product variant and apply changes to the latest basket. Tests use synthetic accounts and separate browser tabs. |
| Stock and storefront startup | An upstream stock lookup blocked navigation on editorial pages. A failed lookup could make unavailable products appear orderable. | Navigation can start before stock is known. Ordering controls check availability where it is needed and offer recovery after a failure. The retail service retains the final stock check when accepting an order. |
| Admin startup and recovery | A slow or missing optional module could block the dashboard. Hiding an error could suppress subsequent error cards. | The loader fetches independent assets together, preserves execution order, bounds optional preload waits and keeps unrelated areas usable. Failed sections offer a reload action. A required startup failure leaves a recovery control in the main content. Browser tests include delayed, missing and throwing scripts. |
| Shared reliability and release tooling | A failed notification counter could make a committed mutation look unsuccessful. Automatic retries could replay a one-use QuickBooks callback. Browser CI omitted the full diary journey. The old storefront importer could not reproduce the current preview. | A committed write retains its successful response if the notification step fails. Side-effecting reads have explicit retry handling. CI includes the diary journey. The current consumer site is the canonical packaging source, with a verified public-file inventory and an export to a new directory. |

## Coverage and boundaries

Source review covered the shared Worker, host routing, staff and customer access, diary, rota, staff fulfilment, the trade storefront, Admin, the branded consumer preview, the standalone preview Worker and the separate retail service. It included the notification, email, scheduled job, asset, finance, shipping and release paths. Automated tests used local data and provider fixtures. No customer accounts, live payments, real email deliveries or carrier labels were used to validate changes.

A local Chromium sweep rendered 33 staff and Admin views and 12 consumer routes at 320, 393, 820 and 1440 CSS pixels. All 180 route-and-width combinations loaded without page-level horizontal overflow. The sweep covered populated and empty surfaces through a combination of dedicated browser fixtures and navigation checks. It does not establish device-specific Safari behavior or assistive-technology compatibility. Both projects' lockfiles returned zero known advisories from npm audit at the time of review.

A second Chromium check measured a cold Admin More page with 80 ms of emulated latency, a fresh browser context for each run and three runs per revision. Median time from the first to last Admin module transfer fell from 1.72 s to 0.41 s. Median time to the rendered page fell from 2.70 s to 1.59 s. These are local measurements against the same synthetic account.

The current public shop at strangerscoffee.com is hosted by Squarespace. Its homepage and 92-entry sitemap were reachable. The homepage HTML response measured 1,420,355 bytes and included 95 image elements, 32 external script elements and 13 stylesheet links. Two image elements lacked an alt attribute. The third-party CMS configuration, template editor, checkout backend and source are outside these codebases. Those observations are separate from the repairs to the branded consumer preview.

Very dense QuickBooks searches return an explicit incomplete result and disable confirmation. Local tests establish application behavior against fixtures. Live provider limits, production configuration, traffic latency and historical business records require separate evidence. For a release, the retail service can go first, followed by the staff Worker and bundled storefront assets. The changes were prepared for review locally.

## Final verification

The application gates ran on a frozen checkout of `67d063be5cb3df6c12b1b60baf044b4541e15895`. The separate retail service build was verified at `018e21b59635c189beb7f9ab86914e1be974be5e`.

| Gate | Result |
| --- | --- |
| Staff Worker API and logic suite | 570 passed, 0 failed, 0 skipped |
| Full Chromium browser suite | 461 passed, 0 failed, 0 skipped |
| Separate retail service suite | 5 passed, 0 failed, 0 skipped |
| TypeScript, production browser assets, standalone preview and retail service build | Passed |
| Branded storefront file inventory | 104 files verified |

Both repositories have local review branches. No production deployment or historical data migration was performed.
