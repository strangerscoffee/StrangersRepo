# Production release and background jobs

## Releases

When the workflow update is published with workflow-write access, Tests will run typechecking and API coverage alongside three browser shards. The required `test` check passes once every shard and the API job succeed. A separate production smoke check waits for the Cloudflare Workers build on the merged commit, then verifies release markers, public assets and sign-in boundaries. It uses read-only requests.

Publish releases through the existing Strangers publisher. A change to `.github/workflows/test.yml` requires GitHub workflow-write access as well as repository write access.

## Database cutover

Use the Cloudflare Workers Builds deploy command `npm run deploy:production` to apply migrations before the production Worker starts. Enable it by setting these values in the Workers Builds environment.

| Value | Purpose |
| --- | --- |
| `STRANGERS_MANAGED_SCHEMA=1` | Applies migrations during deployment and switches the Worker to a read-only readiness check |
| `CLOUDFLARE_ACCOUNT_ID` | Identifies the production Cloudflare account |
| `STRANGERS_D1_DATABASE_ID` | Identifies the existing `kitchen-diary` database and binds it to the deployed Worker |
| `STRANGERS_D1_MIGRATION_TOKEN` | A Cloudflare API credential with D1 Edit access to the account |

The release command builds and checks the Worker first, applies the existing migrations to the specified database, confirms the expected schema, then deploys. A Worker started with deployment-managed migrations returns a retryable 503 if the schema is incomplete. Local fixtures and legacy builds can still initialise missing migrations. Additive migrations let the preceding Worker run while a new one is released. Retain old columns and tables until they are outside the rollback window.

`npm run migrations:apply` applies the same migrations separately if the hosting setup already has a migration step. `npm run deploy:production -- --dry-run` builds without applying remote migrations or deploying.

## Browser assets and Admin reporting

Production builds publish content-addressed JavaScript and CSS for the current and preceding commits. A build needs Git history for both commits. An approved rollback should use a build with the needed asset versions or confirm the current and older shells in open tabs. Legacy asset paths remain available for tabs opened before the transition.

The Admin Overview reads dispatch-date and status totals maintained in the same D1 writes as order changes. Insights stores derived weekly sales, forecasts and roast plans for the current London date. Orders, catalogue entries, imports, mappings and forecasting settings invalidate those results. The scheduled reporting job warms the shared view, and the first request after a change can calculate it immediately. Advance the Insights cache namespace when changing the report model or shape. The invoice and order records remain authoritative.

## Independent integration queues

Create the following queues in the production Cloudflare account.

- `strangers-dispatch-email`
- `strangers-slack-orders`
- `strangers-quickbooks`
- `strangers-integration-recovery` for messages that exhaust retries

Set `STRANGERS_ENABLE_QUEUES=1` alongside the Cloudflare deploy command above. Each provider has an independent consumer. The queues carry references to durable work only. Existing state and lease rules control sending, retries and the handling of uncertain delivery. The five-minute scheduled sweep recovers due database records if a wake-up is missed. The notification settings show how long the oldest due dispatch email or Slack post has been waiting.

After enabling the queues, confirm the bindings on the deployed Worker and observe test deliveries from the normal provider test or sandbox flows. For rollback, recover the durable outbox and accounting states before replaying dead-letter messages.
