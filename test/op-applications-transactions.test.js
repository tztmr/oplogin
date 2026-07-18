const test = require('node:test');
const assert = require('node:assert/strict');

const {
  setDefaultOpApplication,
  setOpApplicationStatus,
  updateOpApplication,
} = require('../lib/op-applications');

const APP_ID = '00000000-0000-0000-0000-000000000301';

function row(overrides = {}) {
  return {
    id: APP_ID,
    name: '应用',
    app_id: '1104790111',
    is_default: false,
    status: 'active',
    created_at: '2026-07-19T00:00:00.000Z',
    updated_at: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

function createTransactionalPool(steps) {
  const queries = [];
  let released = false;
  const client = {
    async query(sql, values = []) {
      const step = steps.shift();
      assert.ok(step, `unexpected query: ${sql}`);
      assert.match(sql.replace(/\s+/g, ' ').trim(), step.sql);
      if (step.values) {
        assert.deepEqual(values, step.values);
      }
      queries.push({ sql, values });
      return { rows: step.rows || [] };
    },
    release() {
      released = true;
    },
  };

  return {
    async connect() {
      return client;
    },
    async query() {
      assert.fail('writes and lock checks must use the transaction client');
    },
    assertFinished() {
      assert.equal(steps.length, 0, 'all transaction queries should run');
      assert.equal(released, true, 'transaction client should be released');
    },
    queries,
  };
}

test('disabling an application locks it before checking whether it is the default', async () => {
  const pool = createTransactionalPool([
    { sql: /^begin$/i },
    {
      sql: /select \* from op_applications where id = \$1 for update/i,
      values: [APP_ID],
      rows: [row({ is_default: true })],
    },
    { sql: /^rollback$/i },
  ]);

  await assert.rejects(
    setOpApplicationStatus(pool, APP_ID, 'disabled'),
    { message: '当前默认应用不能停用，请先设置其他默认应用' },
  );
  pool.assertFinished();
});

test('setting a default locks the target and current default before switching them', async () => {
  const CURRENT_DEFAULT_ID = '00000000-0000-0000-0000-000000000302';
  const pool = createTransactionalPool([
    { sql: /^begin$/i },
    {
      sql: /select \* from op_applications where id = \$1 for update/i,
      values: [APP_ID],
      rows: [row()],
    },
    {
      sql: /select id from op_applications where is_default = true and id <> \$1 for update/i,
      values: [APP_ID],
      rows: [{ id: CURRENT_DEFAULT_ID }],
    },
    {
      sql: /update op_applications set is_default = false, updated_at = now\(\) where is_default = true and id <> \$1/i,
      values: [APP_ID],
    },
    {
      sql: /update op_applications set is_default = true, updated_at = now\(\) where id = \$1 returning \*/i,
      values: [APP_ID],
      rows: [row({ is_default: true })],
    },
    { sql: /^commit$/i },
  ]);

  const application = await setDefaultOpApplication(pool, APP_ID);

  assert.equal(application.isDefault, true);
  pool.assertFinished();
});

test('changing an AppID locks its application before checking references and updating', async () => {
  const pool = createTransactionalPool([
    { sql: /^begin$/i },
    {
      sql: /select \* from op_applications where id = \$1 for update/i,
      values: [APP_ID],
      rows: [row()],
    },
    {
      sql: /select 1 from short_op_records where application_id = \$1 limit 1/i,
      values: [APP_ID],
    },
    {
      sql: /select id from op_applications where app_id = \$1 and id <> \$2 limit 1/i,
      values: ['1104790999', APP_ID],
    },
    {
      sql: /update op_applications set name = \$2, app_id = \$3, updated_at = now\(\) where id = \$1 returning \*/i,
      values: [APP_ID, '应用新版', '1104790999'],
      rows: [row({ name: '应用新版', app_id: '1104790999' })],
    },
    { sql: /^commit$/i },
  ]);

  const application = await updateOpApplication(pool, APP_ID, {
    name: '应用新版',
    appId: '1104790999',
  });

  assert.equal(application.appId, '1104790999');
  pool.assertFinished();
});
