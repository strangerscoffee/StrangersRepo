# Strangers dev preview

`strangers-dev-preview` serves the public retail shop. Its bundle contains the shop pages, catalogue, photos, shared theme and Strangers logos. The basket is stored in the browser and checkout is simulated. The Instagram feed reads the public Strangers home page by default.

## Develop locally

From the repository root, run `npm ci` followed by `npm run dev:retail-preview`. Open the URL printed by Wrangler. Changes to the shop, theme and logos are copied into the preview bundle while Wrangler is running.

The focused tests use Chromium and cover desktop and mobile shopping, menu motion, the Instagram gallery and the public route boundary.

```sh
npm install --no-save playwright@1.63.0
npx playwright install chromium
npm run test:retail-preview
```

## Connect the Cloudflare account once

1. In the Cloudflare account that owns `staffstrangerscoffee.com`, enable its Workers subdomain and create an account-scoped API token with **Workers Scripts Edit**. In the [publisher repository’s Actions settings](https://github.com/georgefarrowgreen1/strangers/settings/secrets/actions), add the token as the secret `RETAIL_PREVIEW_CLOUDFLARE_API_TOKEN` and the account ID as the variable `RETAIL_PREVIEW_CLOUDFLARE_ACCOUNT_ID`.
2. Run **initialize** once from [Retail dev preview](https://github.com/georgefarrowgreen1/strangers/actions/workflows/retail-preview.yml). The action builds from StrangersRepo’s `main`. The run summary links to the deployed shop on `workers.dev` and lists its version ID.
3. After checking that link, open **Workers & Pages → strangers-dev-preview → Settings → Domains & Routes** and add a **Route** for `preview.staffstrangerscoffee.com/shop/*` in the `staffstrangerscoffee.com` zone. The existing custom domain routes `/shop` to `/shop/` and handles the legacy wholesale paths.
4. Verify `https://preview.staffstrangerscoffee.com/shop/` returns `x-retail-preview-worker: strangers-dev-preview`, the expected `x-retail-preview-version` and `x-robots-tag: noindex, nofollow`. Confirm `https://preview.staffstrangerscoffee.com/signin` still opens wholesale sign-in.

## Review, promote and roll back

- Run **review** with a branch or commit from StrangersRepo in the `source_ref` field. The workflow runs the focused checks, uploads a version and verifies its URL before publishing it in the run summary.
- Run **promote** with the version ID from the reviewed run to deploy that same build to the stable address. For rollback, promote the previous version.
- Keep review links on `workers.dev`, outside the staff sign-in domain. Use the stable `/shop/` route for versions ready to share. The production publisher remains the route for changes to the shared Worker.
