import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { migrateProductionDatabase } from './migrate-d1.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const managedSchema = process.env.STRANGERS_MANAGED_SCHEMA === '1';
const queueEnabled = process.env.STRANGERS_ENABLE_QUEUES === '1';
const path = './.wrangler.production-' + process.pid + '.json';
const source = await readFile('wrangler.jsonc', 'utf8');
const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', source);
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
delete config.build; // Assets are compiled below for both deployment and dry runs.

if (managedSchema) {
  const database = config.d1_databases.find(binding => binding.binding === 'DB');
  if (process.env.CLOUDFLARE_ACCOUNT_ID) config.account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (process.env.STRANGERS_D1_DATABASE_ID) database.database_id = process.env.STRANGERS_D1_DATABASE_ID;
  config.vars.SCHEMA_DEPLOY_ONLY = '1';
}

if (queueEnabled) {
  const producers = [
    { binding: 'DISPATCH_EMAIL_QUEUE', queue: 'strangers-dispatch-email' },
    { binding: 'SLACK_ORDERS_QUEUE', queue: 'strangers-slack-orders' },
    { binding: 'QUICKBOOKS_QUEUE', queue: 'strangers-quickbooks' },
  ];
  const consumers = producers.map(({ queue }) => ({
    queue, max_batch_size: queue === 'strangers-quickbooks' ? 1 : 5, max_batch_timeout: 1, max_concurrency: 1, max_retries: 3,
    dead_letter_queue: 'strangers-integration-recovery',
  }));
  config.queues = { producers, consumers };
}

try {
  execFileSync(process.execPath, ['scripts/build-assets.mjs'], { stdio: 'inherit' });
  await writeFile(path, JSON.stringify(config));
  const deploy = ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', path, ...args];
  if (managedSchema && !dryRun) {
    execFileSync(process.execPath, [...deploy, '--dry-run'], { stdio: 'inherit' });
    await migrateProductionDatabase();
  }
  execFileSync(process.execPath, deploy, { stdio: 'inherit' });
} finally {
  await rm(path, { force: true });
}
