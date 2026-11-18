import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The REST query endpoint accepts the same prepared statement batches as the Worker binding.
export function remoteDatabase(account, database, token, fetchQuery = fetch) {
  if (!/^[a-f0-9]{32}$/i.test(account || '') ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database || '') || !token) {
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID, STRANGERS_D1_DATABASE_ID and STRANGERS_D1_MIGRATION_TOKEN.');
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`;
  async function query(statements) {
    const response = await fetchQuery(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ batch: statements }),
      signal: AbortSignal.timeout(60000),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success || !Array.isArray(payload.result) ||
        payload.result.length !== statements.length || payload.result.some(result => !result.success)) {
      const errors = [...(payload.errors || []), ...(Array.isArray(payload.result) ? payload.result.filter(result => !result.success) : [])];
      throw new Error('D1 migration failed (' + response.status + '): ' +
        (errors.map(error => error.message || error.error).filter(Boolean).join('; ') || 'query batch did not complete'));
    }
    return payload.result;
  }
  function prepare(sql, params = []) {
    return {
      statement: { sql, params },
      bind: (...bound) => prepare(sql, bound),
      async run() { return (await query([{ sql, params }]))[0]; },
      async all() { return this.run(); },
      async first(column) {
        const [row] = (await this.run()).results || [];
        return row ? (column ? row[column] : row) : null;
      },
    };
  }
  return { prepare, batch: statements => query(statements.map(statement => statement.statement)) };
}

export async function loadSchemaModule() {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/schema.ts', import.meta.url))],
    bundle: true, platform: 'node', target: 'node22', format: 'esm', write: false,
  });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
}

export async function migrateProductionDatabase() {
  const DB = remoteDatabase(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.STRANGERS_D1_DATABASE_ID, process.env.STRANGERS_D1_MIGRATION_TOKEN);
  const { applySchema, schemaCurrent } = await loadSchemaModule();
  if (!await schemaCurrent({ DB })) await applySchema({ DB });
  if (!await schemaCurrent({ DB })) throw new Error('D1 did not reach the expected schema version.');
  console.log('D1 schema is ready for this release.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await migrateProductionDatabase();
