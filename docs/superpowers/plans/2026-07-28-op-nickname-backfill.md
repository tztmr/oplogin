# OP Nickname Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a data-management button that lets both super administrators and operators fill missing OP nicknames only for records owned by their current account.

**Architecture:** Add a focused service function in `lib/managed-records.js` that selects the current owner's historical records with a non-empty OP and blank nickname, deduplicates OP values, performs the existing bounded Tencent lookup before writes, and conditionally updates still-blank rows. Expose it through the authenticated records router and connect a single confirmation-driven button in the existing admin records UI.

**Tech Stack:** Node.js CommonJS, Express 5, PostgreSQL/pg-mem, browser JavaScript, `node:test`, Supertest.

## Global Constraints

- Only records where `owner_id` equals the current authenticated administrator ID are eligible, regardless of whether the role is `super_admin` or `operator`.
- Only records where `op_value <> ''` and `op_nickname = ''` are eligible.
- Existing nicknames must never be overwritten.
- Reuse `lookupOpNicknames`, fixed AppID `1105602870`, maximum concurrency 5, and timeout 5000 ms.
- Identical OP values are sent to the injected lookup dependency once per backfill request.
- Tencent lookup completes before any database update.
- A failed lookup remains blank and cannot fail the batch.
- Update SQL must recheck `owner_id`, `op_value`, and blank `op_nickname`.
- No complete OP credential or Tencent request URL may be logged or returned.
- Tests must inject fake lookups and never contact Tencent.

---

### Task 1: Owner-scoped backfill service

**Files:**
- Modify: `lib/managed-records.js`
- Test: `test/admin-records-api.test.js`

**Interfaces:**
- Consumes: `lookupOpNicknamesImpl(opValues) -> Promise<{ nicknameByOpValue: Map<string,string> }>`
- Produces: `backfillManagedRecordOpNicknames(pool, adminUser, lookupOpNicknamesImpl) -> Promise<{ pendingCount: number, updatedCount: number, failedCount: number }>`

- [ ] **Step 1: Write failing service integration tests**

Add tests to `test/admin-records-api.test.js` that create two operator accounts and use the API seam from Task 2. For the current operator, create:

- two blank-nickname rows sharing `duplicateOp`,
- one blank-nickname row using `failedOp`,
- one row with `opNickname: '已有昵称'`,
- one row with an empty OP.

Create another blank-nickname row owned by the second operator. Inject:

```js
lookupOpNicknamesImpl: async (opValues) => {
  lookupCalls.push([...opValues]);
  return {
    nicknameByOpValue: new Map([
      [duplicateOp, '补全昵称'],
      [failedOp, ''],
    ]),
    detectedCount: 1,
    failedCount: 1,
  };
}
```

Assert:

```js
assert.deepEqual(lookupCalls, [[duplicateOp, failedOp]]);
assert.deepEqual(response.body, {
  pendingCount: 3,
  updatedCount: 2,
  failedCount: 1,
});
```

Then query the database and assert both duplicate rows contain `补全昵称`, the failed row is blank, the existing nickname is unchanged, and the second operator row is blank.

Add a second test with no eligible records:

```js
let lookupCalled = false;
const response = await agent
  .post('/api/admin/records/backfill-op-nicknames')
  .send();
assert.deepEqual(response.body, {
  pendingCount: 0,
  updatedCount: 0,
  failedCount: 0,
});
assert.equal(lookupCalled, false);
```

- [ ] **Step 2: Run the focused API tests and verify RED**

Run:

```bash
node --test test/admin-records-api.test.js
```

Expected: the new requests return 404 because the route and service do not exist.

- [ ] **Step 3: Implement the minimal owner-scoped service**

Add to `lib/managed-records.js`:

```js
async function backfillManagedRecordOpNicknames(
  pool,
  adminUser,
  lookupOpNicknamesImpl,
) {
  const pendingResult = await pool.query(
    `select id, op_value
       from managed_records
      where owner_id = $1
        and op_value <> ''
        and op_nickname = ''
      order by created_at asc`,
    [adminUser.id],
  );
  const pendingCount = pendingResult.rowCount;
  if (!pendingCount) {
    return { pendingCount: 0, updatedCount: 0, failedCount: 0 };
  }

  const uniqueOpValues = Array.from(
    new Set(pendingResult.rows.map((row) => row.op_value)),
  );
  let nicknameByOpValue = new Map();
  try {
    const lookupResult = await lookupOpNicknamesImpl(uniqueOpValues);
    nicknameByOpValue = lookupResult.nicknameByOpValue;
  } catch {
    nicknameByOpValue = new Map();
  }

  let updatedCount = 0;
  for (const opValue of uniqueOpValues) {
    const nickname = String(nicknameByOpValue.get(opValue) || '').trim();
    if (!nickname) continue;
    const updateResult = await pool.query(
      `update managed_records
          set op_nickname = $1, updated_at = now()
        where owner_id = $2
          and op_value = $3
          and op_nickname = ''`,
      [nickname, adminUser.id, opValue],
    );
    updatedCount += updateResult.rowCount;
  }

  return {
    pendingCount,
    updatedCount,
    failedCount: pendingCount - updatedCount,
  };
}
```

Export `backfillManagedRecordOpNicknames`. Keep the network lookup before the first update query.

- [ ] **Step 4: Run the service/API tests**

Run:

```bash
node --test test/admin-records-api.test.js
```

Expected: the service tests still fail only because Task 2 has not mounted the route.

- [ ] **Step 5: Commit the service and failing route-level tests together with Task 2**

Do not commit a knowingly red intermediate tree; Task 2 completes this vertical slice.

---

### Task 2: Authenticated backfill API

**Files:**
- Modify: `routes/admin-records.js`
- Modify: `lib/managed-records.js`
- Test: `test/admin-records-api.test.js`

**Interfaces:**
- Consumes: `backfillManagedRecordOpNicknames(pool, req.adminUser, lookupOpNicknamesImpl)`
- Produces: `POST /api/admin/records/backfill-op-nicknames` with HTTP 200 and the three-count JSON response.

- [ ] **Step 1: Mount the authenticated route**

Import the service:

```js
const {
  backfillManagedRecordOpNicknames,
} = require('../lib/managed-records');
```

Add `backfillManagedRecordOpNicknames` to the existing destructured import without removing its current members.

Add this exact route before parameterized `/:id` routes:

```js
router.post('/backfill-op-nicknames', async (req, res, next) => {
  try {
    const result = await backfillManagedRecordOpNicknames(
      pool,
      req.adminUser,
      lookupOpNicknamesImpl,
    );
    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
});
```

The existing `router.use(requireAdminAuth)` protects both super administrators and operators.

- [ ] **Step 2: Run focused API tests and verify GREEN**

Run:

```bash
node --test test/admin-records-api.test.js
```

Expected: all tests pass, including current-owner isolation, deduplication, non-overwrite, partial failure, and empty inventory.

- [ ] **Step 3: Commit the backend vertical slice**

```bash
git add lib/managed-records.js routes/admin-records.js test/admin-records-api.test.js
git commit -m "Add owner-scoped OP nickname backfill API"
```

---

### Task 3: Data-management backfill button

**Files:**
- Modify: `public/admin/index.html`
- Modify: `public/admin/records.js`
- Test: `test/admin-pages.test.js`

**Interfaces:**
- Consumes: `POST /api/admin/records/backfill-op-nicknames`
- Produces: `buildOpNicknameBackfillSummary(data) -> string` and `backfillOpNicknames() -> Promise<void>`

- [ ] **Step 1: Write failing static and behavior tests**

Extend the admin shell test:

```js
assert.match(response.text, /id="backfillOpNicknamesButton"/);
assert.match(response.text, /批量补全OP昵称/);
```

Add a pure summary test:

```js
assert.equal(
  sandbox.buildOpNicknameBackfillSummary({
    pendingCount: 3,
    updatedCount: 2,
    failedCount: 1,
  }),
  '待补全 3 条，成功 2 条，未识别 1 条',
);
assert.equal(
  sandbox.buildOpNicknameBackfillSummary({
    pendingCount: 0,
    updatedCount: 0,
    failedCount: 0,
  }),
  '没有需要补全的OP昵称',
);
```

Use `loadManagementBehaviorScript('records.js', options)` for an interaction test. Capture `showConfirm`, `adminFetch`, and `loadRecords` effects, trigger the button listener, flush promises, and assert:

```js
assert.equal(confirmMessages[0], '确认补全当前账号名下所有缺失的 OP 昵称吗？');
assert.deepEqual(requests[0], {
  url: '/api/admin/records/backfill-op-nicknames',
  options: { method: 'POST' },
});
assert.equal(button.disabled, false);
assert.equal(button.textContent, '批量补全OP昵称');
assert.deepEqual(toastMessages, ['待补全 3 条，成功 2 条，未识别 1 条']);
```

Also assert the button is disabled with text `正在补全…` while the deferred request is pending.

- [ ] **Step 2: Run page tests and verify RED**

Run:

```bash
node --test test/admin-pages.test.js
```

Expected: FAIL because the button and helpers do not exist.

- [ ] **Step 3: Add the button**

In `public/admin/index.html`, place this beside batch import:

```html
<button id="backfillOpNicknamesButton" type="button" class="btn-cancel">
  批量补全OP昵称
</button>
```

- [ ] **Step 4: Implement the frontend interaction**

Add:

```js
function buildOpNicknameBackfillSummary(data) {
  if (!data.pendingCount) {
    return '没有需要补全的OP昵称';
  }
  return [
    `待补全 ${data.pendingCount} 条`,
    `成功 ${data.updatedCount} 条`,
    `未识别 ${data.failedCount} 条`,
  ].join('，');
}

async function backfillOpNicknames() {
  const button = document.getElementById('backfillOpNicknamesButton');
  if (!(await showConfirm(
    '确认补全当前账号名下所有缺失的 OP 昵称吗？',
    { confirmText: '开始补全' },
  ))) {
    return;
  }

  button.disabled = true;
  button.textContent = '正在补全…';
  try {
    const data = await adminFetch(
      '/api/admin/records/backfill-op-nicknames',
      { method: 'POST' },
    );
    await loadRecords();
    showToast(buildOpNicknameBackfillSummary(data));
  } finally {
    button.disabled = false;
    button.textContent = '批量补全OP昵称';
  }
}
```

Register:

```js
document
  .getElementById('backfillOpNicknamesButton')
  .addEventListener('click', backfillOpNicknames);
```

The common admin event wrapper continues to display rejected request errors.

- [ ] **Step 5: Run page tests and verify GREEN**

Run:

```bash
node --test test/admin-pages.test.js
```

Expected: all page tests pass.

- [ ] **Step 6: Commit the frontend slice**

```bash
git add public/admin/index.html public/admin/records.js test/admin-pages.test.js
git commit -m "Add OP nickname backfill button"
```

---

### Task 4: Full regression and delivery checks

**Files:**
- Verify all files changed in Tasks 1-3.

**Interfaces:**
- Consumes: the backend endpoint and frontend button from earlier tasks.
- Produces: a clean, tested feature branch ready for integration.

- [ ] **Step 1: Run syntax and whitespace checks**

Run:

```bash
node --check lib/managed-records.js
node --check routes/admin-records.js
node --check public/admin/records.js
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 3: Inspect scope and sensitive values**

Run:

```bash
git status --short
git diff --stat main...HEAD
```

Confirm only the approved backend, frontend, tests, spec, and plan are included. Confirm no real access token, openid, pay token, pfkey, or user nickname was added.

- [ ] **Step 4: Use the branch-finishing workflow**

Use `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`. Do not push unless the user selects the push/PR option.
