# Phone Inventory Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate phone imports into per-operator inventory and let user-center slots reserve, reject, or bind a phone before UID completion.

**Architecture:** Add a `phone_inventory` table as the source of truth for available and attempted phones. Keep the existing phone columns on `managed_records` as the final bound-phone projection, and perform reserve/reject/bind transitions transactionally in `lib/public-user-batches.js`.

**Tech Stack:** Node.js 18+, Express 5, PostgreSQL/pg, pg-mem, Node test runner, Supertest, browser JavaScript and HTML.

**Spec:** `docs/superpowers/specs/2026-09-08-phone-inventory-extraction-design.md`

## Global Constraints

- Preserve the six-slot public batch model and the existing Google, OP, and UID import behavior.
- Phone inventory is isolated by `owner_id`; importing users and public user centers may only use their own inventory.
- Public status labels are exactly `未绑定`, `已绑定`, and `老号售后`.
- A reserved phone is not copied to `managed_records`; only binding copies it to Data Management.
- `老号售后` is terminal for that inventory item but permits the slot to reserve another phone.
- A bound phone is immutable from the user center and UID cannot be saved before binding.
- Existing bound phones stay in Data Management; existing unbound owned phones migrate into available inventory and are cleared from `managed_records`.
- Preserve the current uncommitted batch-phone-clear and configurable-duration work while moving duration behavior to the dedicated importer.

---

### Task 1: Phone Inventory Schema and Legacy Migration

**Files:**
- Modify: `lib/schema.js`
- Modify: `test/schema-and-crypto.test.js`

**Interfaces:**
- Produces: table `phone_inventory` with statuses `available | reserved | after_sale | bound`.
- Produces: unique key `(owner_id, phone_number)` and a partial unique active reservation per `reserved_record_id`.
- Consumes: existing `admin_users`, `managed_records`, and `public_user_batch_slots` tables.

- [ ] **Step 1: Write failing schema and migration tests**

Add tests that create the legacy rows before rerunning `ensureDatabaseSchema(pool)`:

```js
test('schema migrates owned legacy phones into inventory without duplicating reruns', async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await ensureDatabaseSchema(pool);
  const ownerId = '00000000-0000-0000-0000-000000000201';
  const unboundId = '00000000-0000-0000-0000-000000000202';
  const boundId = '00000000-0000-0000-0000-000000000203';
  await pool.query(
    `insert into admin_users (id, login, email, password_hash, role, status)
     values ($1, 'legacy-phone', 'legacy-phone@example.com', 'hash', 'operator', 'active')`,
    [ownerId],
  );
  await pool.query(
    `insert into managed_records (
       id, owner_id, google_account, google_password_encrypted,
       google_password_search_hash, google_assist, uid_value,
       phone_number, phone_sms_url, phone_status, op_value, op_link
     ) values
       ($1, $3, 'unbound@example.com', 'enc', 'hash-1', '', '',
        '13000000001', 'https://sms.example/1', '未绑定', 'op-1', '/oplogin/op-1'),
       ($2, $3, 'bound@example.com', 'enc', 'hash-2', '', '',
        '13000000002', 'https://sms.example/2', '已绑定', 'op-2', '/oplogin/op-2')`,
    [unboundId, boundId, ownerId],
  );

  await ensureDatabaseSchema(pool);
  await ensureDatabaseSchema(pool);

  const inventory = await pool.query(
    'select phone_number, status, reserved_record_id from phone_inventory order by phone_number',
  );
  assert.deepEqual(inventory.rows, [
    { phone_number: '13000000001', status: 'available', reserved_record_id: null },
    { phone_number: '13000000002', status: 'bound', reserved_record_id: boundId },
  ]);
  const records = await pool.query(
    'select id, phone_number, phone_status from managed_records where id = any($1::uuid[]) order by phone_number',
    [[unboundId, boundId]],
  );
  assert.equal(records.rows.find((row) => row.id === unboundId).phone_number, '');
  assert.equal(records.rows.find((row) => row.id === boundId).phone_status, '已绑定');
});
```

Also assert that an ownerless legacy row remains unchanged.

- [ ] **Step 2: Run the focused schema test and verify RED**

Run: `node --test test/schema-and-crypto.test.js`

Expected: FAIL because `phone_inventory` does not exist.

- [ ] **Step 3: Add the table, indexes, and idempotent migration**

Add to `ensureDatabaseSchema`:

```sql
create table if not exists phone_inventory (
  id uuid primary key,
  owner_id uuid not null references admin_users(id) on delete cascade,
  phone_number text not null,
  phone_sms_url text not null default '',
  phone_expire_at timestamptz null,
  phone_model text not null default '12mini'
    check (phone_model in ('11', '12mini', '14', 'x')),
  status text not null default 'available'
    check (status in ('available', 'reserved', 'after_sale', 'bound')),
  reserved_record_id uuid null references managed_records(id) on delete set null,
  reserved_batch_slot_id uuid null references public_user_batch_slots(id) on delete set null,
  reserved_at timestamptz null,
  after_sale_at timestamptz null,
  bound_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, phone_number)
);
create index if not exists idx_phone_inventory_owner_status_created
  on phone_inventory (owner_id, status, created_at, id);
create unique index if not exists idx_phone_inventory_active_record
  on phone_inventory (reserved_record_id)
  where status = 'reserved' and reserved_record_id is not null;
```

After table creation, migrate owned rows with `id = managed_records.id`, use `on conflict (owner_id, phone_number) do nothing`, mark `已绑定` rows as `bound`, mark all other rows as `available`, then clear the phone projection only for the non-bound owned rows.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/schema-and-crypto.test.js`

Expected: all tests PASS, including two schema runs against the same database.

- [ ] **Step 5: Commit the schema unit**

```bash
git add lib/schema.js test/schema-and-crypto.test.js docs/superpowers/specs/2026-09-08-phone-inventory-extraction-design.md
git commit -m "feat: add isolated phone inventory schema"
```

---

### Task 2: Dedicated Phone Inventory Import API

**Files:**
- Create: `lib/phone-inventory.js`
- Modify: `lib/managed-records.js`
- Modify: `routes/admin-records.js`
- Modify: `test/phone-import-duration.test.js`
- Modify: `test/admin-records-api.test.js`

**Interfaces:**
- Produces: `parsePhoneInventoryImportText(rowsText, { durationDays, now }) -> Array<PhoneInventoryInput>`.
- Produces: `importPhoneInventoryText(pool, rowsText, adminUser, options) -> { importedCount, updatedCount, skippedCount, items }`.
- Produces: authenticated `POST /api/admin/records/phone-inventory/import-text` with `{ rowsText, phoneDurationDays }`.
- Changes: `parseManagedRecordImportText(rowsText)` rejects two-part phone lines.

- [ ] **Step 1: Rewrite duration tests against the dedicated parser and add API isolation tests**

Move the existing duration expectations to `parsePhoneInventoryImportText` and change the API path. Add assertions that inventory import does not create a managed record:

```js
const response = await agent
  .post('/api/admin/records/phone-inventory/import-text')
  .send({
    rowsText: '85251964683----https://example.com/sms',
    phoneDurationDays: 90,
  });
assert.equal(response.status, 201);
assert.equal(response.body.importedCount, 1);
assert.equal((await agent.get('/api/admin/records')).body.total, 0);
const inventory = await pool.query(
  'select owner_id, phone_number, status, phone_expire_at from phone_inventory',
);
assert.equal(inventory.rows[0].status, 'available');
```

Add operator A/operator B tests proving the same phone may exist once per owner and each import writes the authenticated user's `owner_id`. Add a test that `/import-text` returns 400 for `number----url` with an error directing the user to the dedicated phone importer.

- [ ] **Step 2: Run import tests and verify RED**

Run: `node --test test/phone-import-duration.test.js test/admin-records-api.test.js`

Expected: FAIL because the new module and endpoint do not exist and the old parser still accepts phone lines.

- [ ] **Step 3: Implement `lib/phone-inventory.js`**

Use these constants and signatures:

```js
const crypto = require('node:crypto');
const PHONE_DURATION_DAYS = [30, 60, 90, 120, 150];

function createPhoneImportError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function derivePhoneExpireAt(now = Date.now(), durationDays = 30) {
  return new Date(now + durationDays * 86400000).toISOString();
}

function parsePhoneInventoryImportText(rowsText, { durationDays = 30, now = Date.now() } = {}) {
  const normalizedDays = Number(durationDays);
  if (!['number', 'string'].includes(typeof durationDays)
      || !PHONE_DURATION_DAYS.includes(normalizedDays)) {
    throw createPhoneImportError('手机有效期请选择 30、60、90、120 或 150 天');
  }
  const lines = String(rowsText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw createPhoneImportError('请先输入要导入的手机号');
  return lines.map((line, index) => {
    const parts = line.split('----').map((part) => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw createPhoneImportError(`第 ${index + 1} 行格式不正确: 请使用手机号----接码链接`);
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(parts[1]);
    } catch {
      throw createPhoneImportError(`第 ${index + 1} 行接码链接格式不正确`);
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw createPhoneImportError(`第 ${index + 1} 行接码链接仅支持 HTTP 或 HTTPS`);
    }
    return {
      phoneNumber: parts[0],
      phoneSmsUrl: parts[1],
      phoneExpireAt: derivePhoneExpireAt(now, normalizedDays),
      phoneModel: '12mini',
    };
  });
}

async function importPhoneInventoryText(pool, rowsText, adminUser, options = {}) {
  if (!adminUser || !adminUser.id) throw createPhoneImportError('手机号库存必须关联运营账号');
  const rows = parsePhoneInventoryImportText(rowsText, options);
  const client = await pool.connect();
  let importedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const items = [];
  try {
    await client.query('begin');
    for (const row of rows) {
      const existing = await client.query(
        'select * from phone_inventory where owner_id = $1 and phone_number = $2 for update',
        [adminUser.id, row.phoneNumber],
      );
      let result;
      if (!existing.rows.length) {
        result = await client.query(
          `insert into phone_inventory
             (id, owner_id, phone_number, phone_sms_url, phone_expire_at, phone_model, status)
           values ($1, $2, $3, $4, $5, $6, 'available') returning *`,
          [crypto.randomUUID(), adminUser.id, row.phoneNumber, row.phoneSmsUrl,
            row.phoneExpireAt, row.phoneModel],
        );
        importedCount += 1;
      } else if (['available', 'reserved'].includes(existing.rows[0].status)) {
        result = await client.query(
          `update phone_inventory
           set phone_sms_url = $3, phone_expire_at = $4, updated_at = now()
           where owner_id = $1 and phone_number = $2 returning *`,
          [adminUser.id, row.phoneNumber, row.phoneSmsUrl, row.phoneExpireAt],
        );
        updatedCount += 1;
      } else {
        result = existing;
        skippedCount += 1;
      }
      items.push(result.rows[0]);
    }
    await client.query('commit');
    return { importedCount, updatedCount, skippedCount, items };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
```

Normalize SMS URLs with the existing `normalizePhoneSmsUrl` behavior, moving/exporting the helper without creating a cyclic dependency. Return 400 for missing owner identity because inventory must never be global.

- [ ] **Step 4: Route the dedicated importer and remove phone parsing from managed records**

In `routes/admin-records.js` add the specific route before `/:id` routes:

```js
router.post('/phone-inventory/import-text', async (req, res, next) => {
  try {
    const result = await importPhoneInventoryText(
      pool,
      req.body.rowsText,
      req.adminUser,
      { durationDays: req.body.phoneDurationDays },
    );
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
});
```

Delete the two-part branch and phone duration option from `parseManagedRecordImportText`/`importManagedRecordText`. Preserve Google, OP, and four-part combined behavior.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test test/phone-import-duration.test.js test/admin-records-api.test.js`

Expected: PASS with invalid durations importing zero inventory rows and managed record counts unchanged by phone imports.

- [ ] **Step 6: Commit the import unit**

```bash
git add lib/phone-inventory.js lib/managed-records.js routes/admin-records.js test/phone-import-duration.test.js test/admin-records-api.test.js
git commit -m "feat: import phones into operator inventory"
```

---

### Task 3: Transactional Reserve, After-Sale, Bind, and UID Rules

**Files:**
- Modify: `lib/public-user-batches.js`
- Modify: `routes/user-public.js`
- Modify: `test/user-public-api.test.js`

**Interfaces:**
- Produces: `extractBatchSlotPhone(pool, config, user, slotNumber) -> Batch`.
- Produces: `setBatchSlotPhoneStatus(pool, config, user, slotNumber, targetStatus) -> Batch` where target status is `已绑定 | 老号售后`.
- Produces: `updateBatchSlotPhoneModel(...)` updates only a reserved inventory item.
- Produces: `POST /:username/batch/slots/:slot/phone/extract` and `POST /:username/batch/slots/:slot/phone/status`.
- Changes: slot DTO includes `phoneInventoryId`, `phoneNumber`, `phoneSmsUrl`, `phoneExpireAt`, `phoneStatus`, and `phoneModel` from either the reserved item or final managed-record projection.

- [ ] **Step 1: Add failing lifecycle tests**

Add tests that import inventory directly or through the new admin endpoint, then assert this sequence:

```js
const extracted = await request(app)
  .post('/api/public/user/phone-user/batch/slots/1/phone/extract')
  .send({});
assert.equal(extracted.status, 200);
assert.equal(extracted.body.batch.slots[0].record.phoneStatus, '未绑定');
assert.equal((await pool.query(
  'select phone_number from managed_records where id = $1', [record.id],
)).rows[0].phone_number, '');

const afterSale = await request(app)
  .post('/api/public/user/phone-user/batch/slots/1/phone/status')
  .send({ phoneStatus: '老号售后' });
assert.equal(afterSale.status, 200);
assert.equal(afterSale.body.batch.slots[0].record.phoneNumber, '');

const replacement = await request(app)
  .post('/api/public/user/phone-user/batch/slots/1/phone/extract')
  .send({});
const bound = await request(app)
  .post('/api/public/user/phone-user/batch/slots/1/phone/status')
  .send({ phoneStatus: '已绑定' });
assert.equal(bound.status, 200);
assert.equal(bound.body.batch.slots[0].record.phoneStatus, '已绑定');
```

Also test FIFO selection, inventory exhaustion, owner isolation, repeated extraction idempotency/conflict behavior, concurrent extraction returning distinct numbers, changing the reserved model, rejection of `未绑定` as a transition command, and rejection of extract/status/model changes after binding.

Add a UID test that gets 400 before binding and succeeds after binding; confirm slot status changes to `done` only after UID save.

- [ ] **Step 2: Run the public API tests and verify RED**

Run: `node --test test/user-public-api.test.js`

Expected: FAIL on missing extract/status routes and because UID currently saves without a bound phone.

- [ ] **Step 3: Extend batch loading with the active reservation**

In `loadBatch`, left join at most one reserved inventory item by record ID and owner. Build phone DTO precedence as:

```js
const hasFinalPhone = Boolean(String(row.phone_number || '').trim());
const activePhone = hasFinalPhone
  ? {
      phoneInventoryId: null,
      phoneNumber: row.phone_number,
      phoneSmsUrl: row.phone_sms_url,
      phoneExpireAt: row.phone_expire_at,
      phoneStatus: '已绑定',
      phoneModel: row.phone_model || '12mini',
    }
  : {
      phoneInventoryId: row.inventory_id || null,
      phoneNumber: row.inventory_phone_number || '',
      phoneSmsUrl: row.inventory_phone_sms_url || '',
      phoneExpireAt: row.inventory_phone_expire_at || null,
      phoneStatus: row.inventory_id ? '未绑定' : '',
      phoneModel: row.inventory_phone_model || '12mini',
    };
```

- [ ] **Step 4: Implement transactional extraction**

Validate the open batch slot and owner, reject a final bound phone, and return the existing reservation for a repeated request on the same slot. Otherwise select FIFO inventory with a PostgreSQL locking query equivalent to:

```sql
select id
from phone_inventory
where owner_id = $1 and status = 'available'
order by created_at asc, id asc
for update skip locked
limit 1
```

Update it to `reserved` with both `reserved_record_id` and `reserved_batch_slot_id`. If no row is available, throw a 400 error with `手机号库存不足`.

- [ ] **Step 5: Implement terminal status transitions and model changes**

For `老号售后`, update only the current `reserved` item to `after_sale` and set `after_sale_at`; retain record and slot IDs for history. For `已绑定`, update the reserved row to `bound`, set `bound_at`, and in the same transaction copy its phone fields plus `phone_status = '已绑定'` into the owned managed record. Do not expose any transition out of `bound`.

Make model changes target the current `reserved` inventory row. A final bound phone remains read-only in the public API.

- [ ] **Step 6: Enforce the UID precondition and add routes**

Before the managed-record UID update, add `m.phone_number` and `m.phone_status` to the locked slot query and reject unless the record has a phone and status is `已绑定`:

```js
if (!String(slot.phone_number || '').trim() || slot.phone_status !== '已绑定') {
  throw createPublicError('请先完成手机号绑定', 400);
}
```

Wire the extract/status routes in `routes/user-public.js`, retaining the 1-to-6 slot validation. Remove the old reversible `/phone/bind` behavior.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `node --test test/user-public-api.test.js`

Expected: PASS; after-sale numbers remain historical, bound data is projected once, and UID is the only action that turns the slot green.

- [ ] **Step 8: Commit the lifecycle unit**

```bash
git add lib/public-user-batches.js routes/user-public.js test/user-public-api.test.js
git commit -m "feat: reserve and bind phones from user center"
```

---

### Task 4: Separate Admin Import UI and Correct User-Center Slot Rendering

**Files:**
- Modify: `public/admin/index.html`
- Modify: `public/admin/records.js`
- Modify: `public/user-page.html`
- Modify: `test/admin-pages.test.js`
- Modify: `test/user-public-api.test.js`

**Interfaces:**
- Consumes: `POST /api/admin/records/phone-inventory/import-text`.
- Consumes: public extract/status/model endpoints from Task 3.
- Produces: dedicated admin phone-import dialog and user-center phone lifecycle controls.

- [ ] **Step 1: Add failing page contract tests**

Assert the admin HTML contains separate `phoneImportButton`, `phoneImportDialog`, `phoneImportForm`, `phoneImportDurationDays`, and `phoneImportText` elements. Assert the general import help does not describe two-part phone import.

For the user page, replace the old assertions with contracts for:

```js
assert.match(response.text, /id="extractPhoneButton"/);
assert.match(response.text, /提取手机号/);
assert.match(response.text, /id="markPhoneBoundButton"/);
assert.match(response.text, /id="markPhoneAfterSaleButton"/);
assert.doesNotMatch(response.text, /function buildPhoneVisibleBatch\(/);
assert.match(response.text, /submitButton\.disabled\s*=\s*slot\.status !== 'available' \|\| phoneStatus !== '已绑定'/);
```

- [ ] **Step 2: Run page tests and verify RED**

Run: `node --test test/admin-pages.test.js test/user-public-api.test.js`

Expected: FAIL because the admin controls are combined and the public page still hides phone-less records.

- [ ] **Step 3: Split the admin dialogs and submission functions**

Keep `batchImportDialog` for Google/OP/combined text only. Add a second dialog containing the phone format help, duration select, textarea, progress section, cancel, and submit controls. Post:

```js
await adminFetch('/api/admin/records/phone-inventory/import-text', {
  method: 'POST',
  body: JSON.stringify({
    rowsText: document.getElementById('phoneImportText').value.trim(),
    phoneDurationDays: Number(document.getElementById('phoneImportDurationDays').value),
  }),
});
```

Show `已导入 X 个手机号，更新 Y 个，跳过 Z 个` and do not call `loadRecords()` merely to make available phones appear, because inventory is intentionally absent from Data Management.

- [ ] **Step 4: Render all real batch slots and add phone controls**

Delete `buildPhoneVisibleBatch` and all phone-number requirements from `getFirstSelectableSlot`, `resolveSelectableSlot`, and `renderSelectedSlot`. A real server slot must remain selectable with no phone.

Render states as follows:

```js
const phoneStatus = currentRecord.phoneStatus || '';
extractPhoneButton.hidden = Boolean(currentRecord.phoneNumber) || phoneStatus === '已绑定';
markPhoneBoundButton.hidden = phoneStatus !== '未绑定';
markPhoneAfterSaleButton.hidden = phoneStatus !== '未绑定';
phoneModelSelect.disabled = phoneStatus !== '未绑定';
submitButton.disabled = slot.status !== 'available' || phoneStatus !== '已绑定';
```

Implement `extractCurrentSlotPhone()` and `setCurrentSlotPhoneStatus(phoneStatus)` using the new endpoints. While a request is running, disable all phone action buttons. After a successful mutation, replace `currentBatch`, rerender slots/details/summary, and show specific success messages.

Keep card colors based solely on `slot.status`: red `available`, green `done`, gray `empty`. Change explanatory copy so phone progress is not represented by the color legend.

- [ ] **Step 5: Run page tests and verify GREEN**

Run: `node --test test/admin-pages.test.js test/user-public-api.test.js`

Expected: PASS; a phone-less real slot remains visible and UID controls are disabled until binding.

- [ ] **Step 6: Commit the UI unit**

```bash
git add public/admin/index.html public/admin/records.js public/user-page.html test/admin-pages.test.js test/user-public-api.test.js
git commit -m "feat: add phone extraction controls to user center"
```

---

### Task 5: Documentation, Regression Cleanup, and Full Verification

**Files:**
- Modify: `README.md`
- Modify as needed from test evidence only: files changed in Tasks 1-4

**Interfaces:**
- Documents: admin import endpoint, public extract/status endpoints, status rules, migration behavior, and UID precondition.
- Verifies: the complete application test suite.

- [ ] **Step 1: Update README behavior and endpoint tables**

Replace the current statement that `/api/admin/records/import-text` accepts `phoneDurationDays`. Document:

```text
POST /api/admin/records/phone-inventory/import-text
POST /api/public/user/:username/batch/slots/:slot/phone/extract
POST /api/public/user/:username/batch/slots/:slot/phone/status
PUT  /api/public/user/:username/batch/slots/:slot/phone-model
```

Explain that phone import creates per-owner inventory, `老号售后` allows another extraction, `已绑定` projects the phone into Data Management and locks it, and saving UID requires binding.

- [ ] **Step 2: Run targeted feature tests**

Run:

```bash
node --test \
  test/schema-and-crypto.test.js \
  test/phone-import-duration.test.js \
  test/admin-records-api.test.js \
  test/admin-pages.test.js \
  test/user-public-api.test.js
```

Expected: all targeted tests PASS without warnings or unhandled rejections.

- [ ] **Step 3: Run the full regression suite**

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 4: Inspect the final diff and verify scope**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD
```

Expected: no whitespace errors; changes are limited to schema, phone inventory, admin/public routes, the two pages, tests, README, the approved spec, and this plan. Confirm the pre-existing batch-clear-phone behavior remains covered.

- [ ] **Step 5: Commit documentation and final integration fixes**

```bash
git add README.md docs/superpowers/plans/2026-09-08-phone-inventory-extraction.md
git commit -m "docs: describe phone inventory workflow"
```
