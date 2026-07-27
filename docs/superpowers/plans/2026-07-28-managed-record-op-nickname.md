# Managed Record OP Nickname Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect QQ nicknames from OP credentials during managed-record batch import, persist them, and show/export the nickname without allowing lookup failures to block imports.

**Architecture:** Add a focused Tencent nickname lookup module that parses OP values with the existing parser, queries with the fixed Douyin AppID, and performs bounded deduplicated lookups before any database transaction begins. Extend `managed_records` and its DTO/import merge rules with `opNickname`, then expose the field through the existing API, admin table, import summary, clear actions, and CSV export.

**Tech Stack:** Node.js CommonJS, Express 5, Axios, PostgreSQL/pg-mem, browser JavaScript, HTML/CSS, `node:test`, Supertest.

## Global Constraints

- Fixed Tencent AppID: `1105602870`.
- Tencent nickname lookup failures must leave the nickname blank and must not fail or roll back the import.
- A batch may run at most 5 nickname requests concurrently; each request times out after 5000 ms.
- Identical complete OP values in one batch are looked up once.
- Nickname lookup completes before opening the import database transaction.
- Existing non-empty nicknames survive a later failed lookup; successful later lookups replace them with the latest nickname.
- Clearing OP fields clears the associated nickname.
- No complete OP, access token, pay token, pfkey, or Tencent request URL may be logged or returned as lookup diagnostics.
- Tests use injected fake lookup dependencies and never send credentials to Tencent.
- Preserve the unrelated untracked `QQ昵称识别API说明.md` unless the user separately asks to commit it.

---

## File Structure

- Create `lib/op-nickname.js`: parse OP credentials, call Tencent, normalize one result, deduplicate inputs, and apply bounded concurrency.
- Create `test/op-nickname.test.js`: unit tests for Tencent parameter mapping, failures, deduplication, and concurrency.
- Modify `lib/schema.js`: add the backward-compatible `managed_records.op_nickname` migration.
- Modify `lib/managed-records.js`: persist/map/merge/clear/export nickname and enrich imports before transactions.
- Modify `routes/admin-records.js`: inject the batch nickname lookup into the import service.
- Modify `app.js`: expose the lookup dependency injection seam.
- Modify `test/helpers/create-admin-test-context.js`: allow integration tests to provide app dependencies separately from environment variables.
- Modify `test/schema-and-crypto.test.js`: verify schema migration and legacy defaults.
- Modify `test/admin-records-api.test.js`: verify import, merge, clear, statistics, and CSV behavior.
- Modify `public/admin/index.html`: add the OP nickname table column.
- Modify `public/admin/records.js`: render escaped nicknames and report detection statistics.
- Modify `public/admin/admin.css`: rebalance fixed table widths for the additional column.
- Modify `test/admin-pages.test.js`: verify header, cell rendering, escaping, import summary, and CSS contract.

---

### Task 1: Tencent OP Nickname Lookup Module

**Files:**
- Create: `lib/op-nickname.js`
- Create: `test/op-nickname.test.js`
- Read: `lib/op-url.js:10-25`

**Interfaces:**
- Consumes: `parseOpToken(opValue)` from `lib/op-url.js`.
- Produces: `DOUYIN_APP_ID`, `lookupOpNickname(opValue, options?)`, and `lookupOpNicknames(opValues, options?)`.
- `lookupOpNickname(opValue, { httpClient, appId, timeoutMs }) -> Promise<string>` returns a trimmed nickname or `''`.
- `lookupOpNicknames(opValues, { lookupOne, concurrency }) -> Promise<{ nicknameByOpValue: Map<string,string>, detectedCount: number, failedCount: number }>` counts unique non-empty OP values.

- [ ] **Step 1: Write failing single-lookup tests**

Create `test/op-nickname.test.js` with tests that prove the OP fields are not reversed and all failures become blank results:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DOUYIN_APP_ID,
  lookupOpNickname,
} = require('../lib/op-nickname');

const OP =
  'OPENID00000000000000000000000001|ACCESS000000000000000000000000001|PAY00000000000000000000000000001|PFKEY00000000000000000000000001|1780747973';

test('lookupOpNickname maps OP openid and access token to the Douyin request', async () => {
  const calls = [];
  const nickname = await lookupOpNickname(OP, {
    httpClient: {
      async get(url, options) {
        calls.push({ url, options });
        return { data: { ret: 0, nickname: '  测试昵称  ' } };
      },
    },
  });

  assert.equal(nickname, '测试昵称');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.qq.com/user/get_simple_userinfo');
  assert.deepEqual(calls[0].options.params, {
    access_token: 'ACCESS000000000000000000000000001',
    oauth_consumer_key: DOUYIN_APP_ID,
    openid: 'OPENID00000000000000000000000001',
  });
  assert.equal(calls[0].options.timeout, 5000);
});

test('lookupOpNickname returns blank for Tencent errors and network errors', async () => {
  const rejected = await lookupOpNickname(OP, {
    httpClient: {
      async get() {
        return { data: { ret: -22, msg: 'openid is invalid' } };
      },
    },
  });
  const failed = await lookupOpNickname(OP, {
    httpClient: {
      async get() {
        throw new Error('network unavailable');
      },
    },
  });

  assert.equal(rejected, '');
  assert.equal(failed, '');
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test test/op-nickname.test.js
```

Expected: FAIL because `../lib/op-nickname` does not exist.

- [ ] **Step 3: Implement the minimal single-lookup function**

Create `lib/op-nickname.js`:

```js
const axios = require('axios');
const { parseOpToken } = require('./op-url');

const DOUYIN_APP_ID = '1105602870';
const NICKNAME_URL = 'https://graph.qq.com/user/get_simple_userinfo';

async function lookupOpNickname(opValue, {
  httpClient = axios,
  appId = DOUYIN_APP_ID,
  timeoutMs = 5000,
} = {}) {
  try {
    const token = parseOpToken(opValue);
    const response = await httpClient.get(NICKNAME_URL, {
      params: {
        access_token: token.accessToken,
        oauth_consumer_key: appId,
        openid: token.openid,
      },
      timeout: timeoutMs,
    });
    if (Number(response?.data?.ret) !== 0) return '';
    return String(response.data.nickname || '').trim();
  } catch {
    return '';
  }
}

module.exports = { DOUYIN_APP_ID, lookupOpNickname };
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
node --test test/op-nickname.test.js
```

Expected: both tests PASS and no credential is printed.

- [ ] **Step 5: Add failing deduplication and concurrency tests**

Extend `test/op-nickname.test.js`:

```js
const { lookupOpNicknames } = require('../lib/op-nickname');

test('lookupOpNicknames deduplicates OP values and reports result counts', async () => {
  const calls = [];
  const secondOp = OP.replaceAll('1', '2');
  const result = await lookupOpNicknames([OP, OP, secondOp, ''], {
    lookupOne: async (opValue) => {
      calls.push(opValue);
      return opValue === OP ? '昵称A' : '';
    },
  });

  assert.deepEqual(calls.sort(), [OP, secondOp].sort());
  assert.equal(result.nicknameByOpValue.get(OP), '昵称A');
  assert.equal(result.nicknameByOpValue.get(secondOp), '');
  assert.equal(result.detectedCount, 1);
  assert.equal(result.failedCount, 1);
});

test('lookupOpNicknames never exceeds configured concurrency', async () => {
  let active = 0;
  let maximumActive = 0;
  const values = Array.from({ length: 9 }, (_, index) => `${OP}-${index}`);

  await lookupOpNicknames(values, {
    concurrency: 3,
    lookupOne: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return '';
    },
  });

  assert.equal(maximumActive, 3);
});
```

- [ ] **Step 6: Run the focused tests and verify RED**

Run:

```bash
node --test test/op-nickname.test.js
```

Expected: FAIL because `lookupOpNicknames` is not exported.

- [ ] **Step 7: Implement bounded deduplicated lookup**

Add a worker-index implementation that:

```js
async function lookupOpNicknames(opValues, {
  lookupOne = lookupOpNickname,
  concurrency = 5,
} = {}) {
  const uniqueValues = Array.from(
    new Set(opValues.map((value) => String(value || '').trim()).filter(Boolean)),
  );
  const nicknameByOpValue = new Map();
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < uniqueValues.length) {
      const index = nextIndex;
      nextIndex += 1;
      const opValue = uniqueValues[index];
      nicknameByOpValue.set(opValue, String(await lookupOne(opValue) || '').trim());
    }
  }

  const workerCount = Math.min(
    uniqueValues.length,
    Math.max(1, Number(concurrency) || 1),
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const detectedCount = Array.from(nicknameByOpValue.values())
    .filter(Boolean).length;
  return {
    nicknameByOpValue,
    detectedCount,
    failedCount: uniqueValues.length - detectedCount,
  };
}
```

Export the function.

- [ ] **Step 8: Run tests and commit**

Run:

```bash
node --test test/op-nickname.test.js
git diff --check
```

Expected: all lookup tests PASS.

Commit:

```bash
git add lib/op-nickname.js test/op-nickname.test.js
git commit -m "Add bounded OP nickname lookup"
```

---

### Task 2: Persist and Clear OP Nicknames

**Files:**
- Modify: `lib/schema.js:35-61,90-101`
- Modify: `lib/managed-records.js:29-78,151-215,307-342,552-613,669-769`
- Modify: `test/schema-and-crypto.test.js:32-62`
- Modify: `test/admin-records-api.test.js`

**Interfaces:**
- Consumes: incoming optional DTO property `opNickname`.
- Produces: database column `op_nickname text not null default ''` and DTO property `opNickname`.
- Manual create/update requests that omit `opNickname` preserve the existing nickname on update and default to blank on create.

- [ ] **Step 1: Write failing schema and DTO tests**

Add to the existing schema test:

```js
assert.ok(
  recordColumns.rows.some((row) => row.column_name === 'op_nickname'),
);
```

Add an admin-record integration assertion after creating a normal record:

```js
assert.equal(createResponse.body.item.opNickname, '');
```

Run:

```bash
node --test test/schema-and-crypto.test.js test/admin-records-api.test.js
```

Expected: FAIL because the column/property is absent.

- [ ] **Step 2: Add the backward-compatible migration and DTO mapping**

In `lib/schema.js`, add `op_nickname text not null default ''` to table creation and:

```sql
alter table managed_records
  add column if not exists op_nickname text not null default '';
```

In `toRecordDto()` add:

```js
opNickname: row.op_nickname || '',
```

Update `createManagedRecord()` to insert `op_nickname`, using:

```js
String(payload.opNickname || '').trim()
```

- [ ] **Step 3: Run schema and DTO tests and verify GREEN**

Run:

```bash
node --test test/schema-and-crypto.test.js test/admin-records-api.test.js
```

Expected: PASS.

- [ ] **Step 4: Write failing preservation and clear tests**

Add these concrete integration tests:

```js
test('manual record updates preserve an existing OP nickname when omitted', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);
  const created = await agent.post('/api/admin/records').send({
    googleAccount: 'nickname-preserve@gmail.com',
    googlePassword: 'nickname-pass',
    googleAssist: 'nickname-assist',
    uidValue: '',
    opValue: 'nickname-op',
    opNickname: '旧昵称',
    remark: '',
  });
  const updated = await agent
    .put(`/api/admin/records/${created.body.item.id}`)
    .send({
      googleAccount: 'nickname-preserve@gmail.com',
      googlePassword: 'nickname-pass',
      googleAssist: 'updated-assist',
      uidValue: '',
      opValue: 'nickname-op',
      remark: '',
    });
  assert.equal(updated.body.item.opNickname, '旧昵称');
});

test('single and batch OP clear also clear OP nickname', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);
  const first = await agent.post('/api/admin/records').send({
    googleAccount: 'nickname-clear-1@gmail.com',
    googlePassword: 'pass-1',
    googleAssist: 'assist-1',
    uidValue: '',
    opValue: 'nickname-clear-op-1',
    opNickname: '昵称一',
    remark: '',
  });
  const second = await agent.post('/api/admin/records').send({
    googleAccount: 'nickname-clear-2@gmail.com',
    googlePassword: 'pass-2',
    googleAssist: 'assist-2',
    uidValue: '',
    opValue: 'nickname-clear-op-2',
    opNickname: '昵称二',
    remark: '',
  });
  const single = await agent.delete(
    `/api/admin/records/${first.body.item.id}/op`,
  );
  await agent.post('/api/admin/records/batch-clear-op').send({
    ids: [second.body.item.id],
  });
  const batch = await agent.get(
    `/api/admin/records/${second.body.item.id}`,
  );
  assert.equal(single.body.item.opValue, '');
  assert.equal(single.body.item.opNickname, '');
  assert.equal(batch.body.item.opValue, '');
  assert.equal(batch.body.item.opNickname, '');
});
```

Run the focused integration file and confirm both tests fail because updates/clears do not handle the field.

- [ ] **Step 5: Implement update preservation and clear behavior**

Extend `updateManagedRecord()` with a nullable nickname parameter:

```js
const hasOpNickname = Object.prototype.hasOwnProperty.call(payload, 'opNickname');
const opNickname = hasOpNickname
  ? String(payload.opNickname || '').trim()
  : null;
```

Add it to SQL values and update with:

```sql
op_nickname = coalesce($12, op_nickname)
```

Extend `mergeImportedRecordData()` with:

```js
opNickname: incoming.opNickname || existing.opNickname || '',
```

Extend comparable payloads with `opNickname` so a newly detected nickname turns a duplicate import into an update.

Add `op_nickname = ''` to single and batch OP clear SQL.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
node --test test/schema-and-crypto.test.js test/admin-records-api.test.js
git diff --check
```

Expected: all focused tests PASS.

Commit:

```bash
git add lib/schema.js lib/managed-records.js test/schema-and-crypto.test.js test/admin-records-api.test.js
git commit -m "Persist managed record OP nicknames"
```

---

### Task 3: Enrich Batch Imports Before the Transaction

**Files:**
- Modify: `lib/managed-records.js:806-1024`
- Modify: `routes/admin-records.js:1-45`
- Modify: `app.js:18-46`
- Modify: `test/helpers/create-admin-test-context.js:11-40`
- Modify: `test/admin-records-api.test.js:554-632`

**Interfaces:**
- Consumes: `lookupOpNicknames(opValues)` from Task 1.
- Produces: `importManagedRecordText(pool, config, rowsText, adminUser, { lookupOpNicknamesImpl })`.
- Import response adds `nicknameDetectedCount` and `nicknameFailedCount`.
- `createApp({ lookupOpNicknamesImpl })` passes the injected lookup through the records router.

- [ ] **Step 1: Add the app injection seam**

Change the test helper signature without breaking existing callers:

```js
async function createAdminTestContext(envOverrides = {}, appOverrides = {}) {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const config = loadConfig({
    DATABASE_URL: 'postgres://user:pass@localhost:5432/op_proxy',
    SESSION_SECRET: 's'.repeat(32),
    GOOGLE_PASSWORD_ENCRYPTION_KEY:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    INITIAL_SUPER_ADMIN_LOGIN: 'root',
    INITIAL_SUPER_ADMIN_EMAIL: 'root@example.com',
    INITIAL_SUPER_ADMIN_PASSWORD: 'change-me-now',
    ...envOverrides,
  });
  await ensureDatabaseSchema(pool);
  await ensureInitialSuperAdmin({ pool, config });
  const sessionMiddleware = createSessionMiddleware({
    config,
    store: new session.MemoryStore(),
  });
  const lookupOpNicknamesImpl = async (opValues) => {
    const uniqueValues = Array.from(new Set(opValues.filter(Boolean)));
    return {
      nicknameByOpValue: new Map(
        uniqueValues.map((opValue) => [opValue, '']),
      ),
      detectedCount: 0,
      failedCount: uniqueValues.length,
    };
  };
  const app = createApp({
    config,
    pool,
    sessionMiddleware,
    lookupOpNicknamesImpl,
    ...appOverrides,
  });
  return { app, agent: request.agent(app), pool, config };
}
```

The default fake lookup is required so every pre-existing import test remains
offline; a test opts into a different result through `appOverrides`.

Add `lookupOpNicknamesImpl` to `createApp()` options and pass it to
`createAdminRecordsRouter()`. In the router, default to the production
`lookupOpNicknames` and pass it to `importManagedRecordText`.

- [ ] **Step 2: Write a failing successful-import test**

Add:

```js
test('batch import detects and stores OP nickname before writing records', async () => {
  const opValue =
    'OPENIDIMPORT000000000000000000001|ACCESSIMPORT00000000000000000001|PAYIMPORT000000000000000000000001|PFKEYIMPORT00000000000000000001|1781212159';
  const lookupCalls = [];
  const { agent, config } = await createAdminTestContext({}, {
    lookupOpNicknamesImpl: async (opValues) => {
      lookupCalls.push([...opValues]);
      return {
        nicknameByOpValue: new Map([[opValue, '批量昵称']]),
        detectedCount: 1,
        failedCount: 0,
      };
    },
  });
  await loginAsSuperAdmin(agent, config);

  const response = await agent.post('/api/admin/records/import-text').send({
    rowsText:
      `nickname-import@gmail.com----nickname-pass----nickname-assist----${opValue}`,
  });

  assert.equal(response.status, 201);
  assert.deepEqual(lookupCalls, [[opValue]]);
  assert.equal(response.body.items[0].opNickname, '批量昵称');
  assert.equal(response.body.nicknameDetectedCount, 1);
  assert.equal(response.body.nicknameFailedCount, 0);
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern="detects and stores OP nickname" test/admin-records-api.test.js
```

Expected: FAIL because the import does not call the lookup or return statistics.

- [ ] **Step 4: Implement pre-transaction enrichment**

At the start of `importManagedRecordText()`:

```js
const records = parseManagedRecordImportText(rowsText);
const lookupResult = await lookupOpNicknamesImpl(
  records.map((record) => record.data.opValue).filter(Boolean),
);

for (const record of records) {
  if (record.data.opValue) {
    record.data.opNickname =
      lookupResult.nicknameByOpValue.get(record.data.opValue) || '';
  }
}

const client = await pool.connect();
```

Do not call `pool.connect()` or `begin` until after `lookupOpNicknamesImpl`
resolves. Return:

```js
nicknameDetectedCount: lookupResult.detectedCount,
nicknameFailedCount: lookupResult.failedCount,
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the same name-pattern command. Expected: PASS.

- [ ] **Step 6: Write failing edge-case integration tests**

Add named tests with these exact assertions:

```js
test('OP-only and combined imports both receive lookup nicknames', async () => {
  assert.deepEqual(
    response.body.items.map((item) => item.opNickname),
    ['OP昵称', '综合昵称'],
  );
});

test('Google-only import reports zero nickname lookups', async () => {
  assert.deepEqual(lookupInputs, [[]]);
  assert.equal(response.body.nicknameDetectedCount, 0);
  assert.equal(response.body.nicknameFailedCount, 0);
});

test('failed nickname lookup keeps import successful and nickname blank', async () => {
  assert.equal(response.status, 201);
  assert.equal(response.body.importedCount, 1);
  assert.equal(response.body.items[0].opNickname, '');
  assert.equal(response.body.nicknameFailedCount, 1);
});

test('reimport fills blank nickname and failed refresh preserves it', async () => {
  assert.equal(first.body.items[0].opNickname, '');
  assert.equal(second.body.items[0].opNickname, '补写昵称');
  assert.equal(third.body.items[0].opNickname, '补写昵称');
});

test('nickname enrichment finishes before import opens a transaction', async () => {
  assert.deepEqual(callOrder.slice(0, 2), ['lookup', 'connect']);
});
```

For the duplicate request boundary, keep the unit assertion from Task 1 as the
proof that the production `lookupOpNicknames()` calls `lookupOne` once per
unique OP; the route integration test asserts that the batch result reports
`detectedCount: 1` for two identical imported OP rows.

- [ ] **Step 7: Implement minimal merge/call-order fixes**

Ensure OP-only complementary binding includes:

```js
opNickname: record.data.opNickname,
```

Ensure duplicate merges use the Task 2 rule:

```js
opNickname: incoming.opNickname || existing.opNickname || '',
```

Do not add per-record lookup calls inside the transaction loop.

- [ ] **Step 8: Run focused and full backend tests**

Run:

```bash
node --test test/op-nickname.test.js test/schema-and-crypto.test.js test/admin-records-api.test.js
```

Expected: all tests PASS with no network calls.

- [ ] **Step 9: Commit**

```bash
git add app.js routes/admin-records.js lib/managed-records.js test/helpers/create-admin-test-context.js test/admin-records-api.test.js
git commit -m "Detect OP nicknames during batch import"
```

---

### Task 4: Admin Table and Import Summary

**Files:**
- Modify: `public/admin/index.html:91-125`
- Modify: `public/admin/records.js:44-75,137-200,430-470`
- Modify: `public/admin/admin.css:435-490,608-624`
- Modify: `test/admin-pages.test.js`

**Interfaces:**
- Consumes: record DTO `opNickname`, import response `nicknameDetectedCount`, and `nicknameFailedCount`.
- Produces: “OP昵称” table header/cell and an import toast containing nickname statistics.

- [ ] **Step 1: Write failing static page tests**

Add assertions:

```js
assert.match(shellResponse.text, /<th>OP<\/th>\s*<th>OP昵称<\/th>\s*<th>OP链接<\/th>/);
assert.match(shellResponse.text, /record-col-op-nickname/);
assert.match(styleResponse.text, /#recordTable col\.record-col-op-nickname\s*\{/);
```

Add a renderer test that calls the existing VM-loaded helper:

```js
const sandbox = loadAdminRecordsScript();
const rendered = sandbox.renderTruncatedText(
  '<img src=x onerror=alert(1)>',
  'cell-truncate-op-nickname',
);
assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
assert.doesNotMatch(rendered, /<img/);
```

- [ ] **Step 2: Run page tests and verify RED**

Run:

```bash
node --test test/admin-pages.test.js
```

Expected: FAIL because the column and safe nickname cell are absent.

- [ ] **Step 3: Add the column and safe rendering**

In `public/admin/index.html`, add `record-col-op-nickname` and “OP昵称”
immediately after OP.

Change `renderTruncatedText()` so its inner text uses the escaped value:

```js
return `<span class="cell-truncate ${className}" title="${safeValue}">${safeValue}</span>`;
```

Render:

```js
<td>${renderTruncatedText(item.opNickname, 'cell-truncate-op-nickname')}</td>
```

immediately after the OP cell.

- [ ] **Step 4: Rebalance the 1920x1080 fixed-width table**

Use exact base widths totaling 100%:

```css
select 3%; order 5%; google-account 10%; google-password 8%;
google-assist 8%; google-expire 7%; uid 5%; uid-created 7%;
op 9%; op-nickname 6%; op-link 9%; op-expire 7%; remark 6%;
actions 10%;
```

Add `.cell-truncate-op-nickname { display: block; }`. Keep the existing
fixed-layout/truncation behavior.

- [ ] **Step 5: Add failing import-summary test**

Add a pure `buildBatchImportSummary(data)` expectation to
`test/admin-pages.test.js`:

```js
const sandbox = loadAdminRecordsScript();
assert.equal(
  sandbox.buildBatchImportSummary({
    importedCount: 4,
    skippedCount: 1,
    nicknameDetectedCount: 3,
    nicknameFailedCount: 1,
  }),
  '已导入 4 条记录，跳过重复 1 条，识别昵称 3 条，未识别 1 条',
);
```

- [ ] **Step 6: Implement the import summary**

Create and use this helper from `submitBatchImportForm()` so zero counts remain
truthful:

```js
function buildBatchImportSummary(data) {
  const summaryParts = [`已导入 ${data.importedCount} 条记录`];
  if (data.skippedCount) {
    summaryParts.push(`跳过重复 ${data.skippedCount} 条`);
  }
  summaryParts.push(`识别昵称 ${data.nicknameDetectedCount || 0} 条`);
  summaryParts.push(`未识别 ${data.nicknameFailedCount || 0} 条`);
  return summaryParts.join('，');
}

showToast(buildBatchImportSummary(data));
```

- [ ] **Step 7: Run page tests and commit**

Run:

```bash
node --test test/admin-pages.test.js
git diff --check
```

Expected: all page tests PASS.

Commit:

```bash
git add public/admin/index.html public/admin/records.js public/admin/admin.css test/admin-pages.test.js
git commit -m "Show OP nicknames in data management"
```

---

### Task 5: CSV Export and Full Regression Verification

**Files:**
- Modify: `lib/managed-records.js:394-423`
- Modify: `test/admin-records-api.test.js:667-764`
- Verify: all project files changed by Tasks 1-4

**Interfaces:**
- Consumes: record DTO `opNickname`.
- Produces: CSV column “OP昵称” immediately after “OP”.

- [ ] **Step 1: Write the failing CSV test**

Update the CSV header assertion to:

```js
/"谷歌号","谷歌密码","谷歌辅助","谷歌到期时间","UID","UID创建时间","OP","OP昵称","OP链接","OP到期时间","备注"/
```

Create the record through the API with an explicit nickname:

```js
await agent.post('/api/admin/records').send({
  googleAccount: 'csv-nickname@gmail.com',
  googlePassword: 'csv-pass',
  googleAssist: 'csv-assist',
  uidValue: '',
  opValue: 'op-csv-1',
  opNickname: 'CSV昵称',
  opLink: 'https://example.com/op/csv-1',
  remark: '',
});

assert.match(response.text, /"op-csv-1","CSV昵称","https:\/\/example\.com\/op\/csv-1"/);
```

- [ ] **Step 2: Run the CSV test and verify RED**

Run:

```bash
node --test --test-name-pattern="CSV export" test/admin-records-api.test.js
```

Expected: FAIL because the CSV omits OP nickname.

- [ ] **Step 3: Add the CSV field**

Insert `'OP昵称'` after `'OP'` in the header and `item.opNickname` after
`item.opValue` in every data row.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern="CSV export" test/admin-records-api.test.js
```

Expected: PASS.

- [ ] **Step 5: Run the complete project suite**

Run:

```bash
npm test
```

Expected: all tests PASS with zero unexpected warnings or real Tencent requests.

- [ ] **Step 6: Run final hygiene and scope checks**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Confirm:

- only planned implementation/test files are modified;
- no credential values appear in the diff;
- `QQ昵称识别API说明.md` remains untouched and outside implementation commits;
- no test calls `graph.qq.com`.

- [ ] **Step 7: Commit the CSV change**

```bash
git add lib/managed-records.js test/admin-records-api.test.js
git commit -m "Export managed record OP nicknames"
```

- [ ] **Step 8: Final verification after commits**

Run:

```bash
npm test
git status --short
git log -6 --oneline
```

Expected: the suite remains green; only the pre-existing unrelated untracked
Markdown file may remain.
