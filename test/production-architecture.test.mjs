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

test('concurrent requests finish QuickBooks migrations after seeing the same old columns', { timeout: 15000 }, async () => {
  const sqlite = new DatabaseSync(':memory:');
  const schema = await loadSchemaModule();
  const collisions = [];
  let readsUntilReady = 0;
  const gate = Promise.withResolvers();
  const binding = () => remoteDatabase('0'.repeat(32), '00000000-0000-0000-0000-000000000000', 'fixture-token', async (_url, request) => {
    const { batch } = JSON.parse(request.body);
    try {
      const result = batch.map(({ sql, params }) => ({ success: true, results: sqlite.prepare(sql).all(...params) }));
      if (readsUntilReady && batch[0].sql === "SELECT name FROM pragma_table_info('quickbooks_observations')") {
        if (--readsUntilReady === 0) gate.resolve();
        await gate.promise;
      }
      return Response.json({ success: true, result });
    } catch (error) {
      const duplicate = /duplicate column name: (\w+)/.exec(error.message)?.[1];
      if (duplicate) collisions.push(duplicate);
      return Response.json({ success: false, errors: [{ message: error.message }] }, { status: 400 });
    }
  });
  try {
    await schema.applySchema({ DB: binding() });
    sqlite.exec(`
      DELETE FROM schema_migrations WHERE id >= 42;
      ALTER TABLE quickbooks_observations DROP COLUMN due_date;
      ALTER TABLE quickbooks_observations DROP COLUMN invoice_issue;
      INSERT INTO quickbooks_exports(id,environment,realm_id,company_name,company_vat,invoice_id,request_id,fingerprint,
        payload,payload_hash,source_hash,created_by,preview,profiles,connection_generation,mapping_version,state,remote_id,created_at,updated_at)
        VALUES(1,'production','123','Test','GB123',1,'test','test','{}','test','test','tester','{}','[]','test',1,'linked','100',1,1);
      INSERT INTO quickbooks_observations(export_id,status,reason,read_started_at,observed_at)
        VALUES(1,'review','The QuickBooks billing or delivery address differs.',1,1);
    `);
    readsUntilReady = 2;
    const requests = await Promise.allSettled([schema.ensureSchema({ DB: binding() }), schema.ensureSchema({ DB: binding() })]);
    assert.deepEqual(requests, [{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
    assert.deepEqual(collisions, ['due_date', 'invoice_issue']);
    assert.ok(await schema.schemaCurrent({ DB: binding() }));
    assert.deepEqual(sqlite.prepare('SELECT event_key FROM quickbooks_events ORDER BY event_key').all().map(row => row.event_key),
      ['address-recheck:1', 'balance-recheck:1']);
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
