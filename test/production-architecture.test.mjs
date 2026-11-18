import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { loadSchemaModule, remoteDatabase } from '../scripts/migrate-d1.mjs';
import { wakeIntegration } from '../src/integrationSignals.ts';

test('release migrations apply in D1 batches and the managed request path only checks readiness', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const statements = [];
  const account = '0'.repeat(32);
  const id = '00000000-0000-0000-0000-000000000000';
  const DB = remoteDatabase(account, id, 'fixture-token', async (url, request) => {
    assert.match(url, /\/query$/);
    const { batch } = JSON.parse(request.body);
    assert.ok(batch.length);
    sqlite.exec('BEGIN');
    try {
      const result = batch.map(({ sql, params }) => {
        statements.push(sql);
        const prepared = sqlite.prepare(sql);
        const results = prepared.all(...params);
        const meta = sqlite.prepare('SELECT changes() AS changes').get();
        return { success: true, results, meta };
      });
      sqlite.exec('COMMIT');
      return Response.json({ success: true, result });
    } catch (error) {
      sqlite.exec('ROLLBACK');
      return Response.json({ success: false, errors: [{ message: error.message }] }, { status: 400 });
    }
  });
  try {
    const schema = await loadSchemaModule();
    const env = { DB, SCHEMA_DEPLOY_ONLY: '1' };
    await assert.rejects(schema.ensureSchema(env), { code: 'schema_pending' });
    assert.equal(statements.length, 1, 'missing deployed migrations only issue a read');
    await schema.applySchema(env);
    assert.equal(await schema.schemaCurrent(env), true);
    const before = statements.length;
    await schema.ensureSchema(env);
    await schema.ensureSchema(env);
    assert.deepEqual(statements.slice(before).map(sql => sql.split(' ')[0]), ['SELECT']);

    const insert = sqlite.prepare("INSERT INTO wholesale_preview(kind,id,data,updated_at) VALUES ('order',?,?,0)");
    const order = (status, grams, createdAt, other = {}) => JSON.stringify({
      status, grams, createdAt, dispatchDate: '2026-11-18', preview: false, ...other,
    });
    insert.run('early', order('New', 2000, 100));
    insert.run('later', order('Preparing', 1000, 200));
    insert.run('test', order('New', 99999, 0, { preview: true }));
    const totals = () => sqlite.prepare('SELECT COUNT(*) AS buckets, SUM(orders) AS orders, SUM(grams) AS grams FROM reporting_order_totals').get();
    assert.deepEqual({ ...totals() }, { buckets: 2, orders: 2, grams: 3000 });
    const revision = () => sqlite.prepare('SELECT revision FROM reporting_revision').get().revision;
    const previous = revision();
    sqlite.prepare('UPDATE wholesale_preview SET data=? WHERE id=?').run(order('Ready', 2000, 100), 'early');
    sqlite.prepare("UPDATE wholesale_preview SET data=? WHERE id='later'").run(order('Preparing', 1000, 200, { deletedAt: 500 }));
    assert.deepEqual({ ...totals() }, { buckets: 1, orders: 1, grams: 2000 });
    assert.equal(revision(), previous + 2);
    sqlite.exec("DELETE FROM wholesale_preview WHERE id='early'");
    assert.equal(totals().buckets, 0);
  } finally {
    sqlite.close();
  }
});

test('an integration wake-up uses the queue and can fall back to the durable delivery ledger', async () => {
  const sent = [];
  let fallback = 0;
  const job = { key: 'dispatch:example' };
  const recover = async () => { fallback++; };
  await wakeIntegration({ send: async value => sent.push(value) }, job, recover);
  assert.deepEqual(sent, [job]);
  assert.equal(fallback, 0);
  await wakeIntegration(undefined, job, recover);
  await wakeIntegration({ send: async () => { throw new Error('temporarily unavailable'); } }, job, recover);
  assert.equal(fallback, 2);
});
