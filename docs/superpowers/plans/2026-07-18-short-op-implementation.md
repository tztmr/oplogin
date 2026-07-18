# 8 位短 OP 与 AppID 管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 `/oplogin` 的前提下，新增 `/op` 8 位短码登录、短 OP 管理、AppID 管理、权限隔离、批量导入和独立分页。

**Architecture:** 新建 `op_applications` 与 `short_op_records` 两个领域表，并用独立 service/router 文件承载应用配置、短 OP CRUD 和公开解析。`/admin` 保持单一路由，通过左侧导航切换三个独立区域；公共 `/op` 仅提交短码，服务端查询 OP 与 AppID 后复用 `buildWakeUrl` 返回唤醒 URL。

**Tech Stack:** Node.js 22、Express 5、PostgreSQL/pg、原生 HTML/CSS/JavaScript、Node test runner、Supertest、pg-mem。

## Global Constraints

- `/oplogin`、`/api/submit` 和现有全参 OP 行为必须保持不变。
- 8 位短码匹配 `^[0-9]{8}$`、全局唯一、自动生成、不可手填、软删除后永不复用。
- 相同 `OP 全参 + AppID` 的未删除记录只能存在一条；相同 OP 绑定不同 AppID 允许存在。
- 默认应用初始化为抖音 `1105602870`；只填 OP 的批量导入使用当前默认应用。
- 普通员工只能管理自己的短 OP；超级管理员可以管理全部短 OP，并独占应用写权限。
- `/op` 不返回独立 OP 明文字段；无效、禁用、删除、过期和应用停用使用统一公共错误。
- 当前工作区已有未提交修改：`public/index.html` 和 `test/config-and-public-app.test.js`。不得覆盖或回退这些修改；为新功能创建独立文件和测试。
- 不新增运行时依赖；公共限流使用项目内固定窗口中间件。

---

## File Responsibility Map

### Create

- `lib/op-applications.js`：应用配置校验、分页查询、CRUD、默认项事务和下拉选项。
- `lib/short-op-records.js`：短码生成、OP 校验、权限范围、CRUD、批量导入和公共解析。
- `lib/fixed-window-rate-limiter.js`：按客户端 IP 的固定窗口限流中间件。
- `routes/admin-op-applications.js`：已登录用户读取应用，超级管理员执行写操作。
- `routes/admin-short-ops.js`：短 OP 管理接口。
- `routes/op-submit.js`：公开短码解析和唤醒 URL 生成接口。
- `routes/op-pages.js`：提供 `/op` 与 `/op/:code` 页面。
- `public/op.html`：短码输入与结果对话框页面。
- `public/op.js`：路径短码提取、格式校验、接口提交和唤起。
- `public/admin/admin-shell.js`：左侧导航、区域切换和角色可见性。
- `public/admin/short-ops.js`：短 OP 表格、筛选、分页、弹窗、导入和状态操作。
- `public/admin/op-applications.js`：应用表格、筛选、分页、弹窗、默认和状态操作。
- `test/op-applications-api.test.js`：应用领域、权限和接口测试。
- `test/short-op-api.test.js`：短 OP CRUD、所有权、分页、重复和导入测试。
- `test/short-op-public.test.js`：`/op`、公开解析、统一错误和限流测试。
- `test/fixed-window-rate-limiter.test.js`：限流窗口单元测试。

### Modify

- `lib/schema.js`：创建两个新表、约束、索引和默认抖音记录。
- `app.js`：挂载三组新接口和 `/op` 页面路由，并保留 `op` 路由名。
- `public/admin/index.html`：加入左侧导航、三个区域、短 OP/应用表格与对话框。
- `public/admin/admin.css`：后台左右布局和新表格响应式样式。
- `test/schema-and-crypto.test.js`：覆盖新表、默认应用和数据库约束。
- `test/admin-pages.test.js`：覆盖左侧导航、新区域、脚本和独立分页控件。

---

### Task 1: 数据库表、约束和默认抖音应用

**Files:**
- Modify: `lib/schema.js`
- Modify: `test/schema-and-crypto.test.js`

**Interfaces:**
- Produces: `op_applications`、`short_op_records`、默认抖音行和所有数据库约束。
- Consumes: 现有 `admin_users(id)` 外键。

- [ ] **Step 1: 写失败的 schema 测试**

在 `test/schema-and-crypto.test.js` 增加测试，查询两个新表的列，并断言默认行：

```js
test('ensureDatabaseSchema creates short OP tables and seeds default Douyin app', async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await ensureDatabaseSchema(pool);

  const applications = await pool.query(
    `select name, app_id, is_default, status from op_applications`,
  );
  const shortOpColumns = await pool.query(`
    select column_name from information_schema.columns
    where table_name = 'short_op_records'
  `);

  assert.deepEqual(applications.rows, [{
    name: '抖音', app_id: '1105602870', is_default: true, status: 'active',
  }]);
  assert.ok(shortOpColumns.rows.some((row) => row.column_name === 'code'));
  assert.ok(shortOpColumns.rows.some((row) => row.column_name === 'application_id'));
  assert.ok(shortOpColumns.rows.some((row) => row.column_name === 'deleted_at'));
});
```

再增加数据库拒绝重复 AppID、重复短码、非法短码和未删除 `op_value + application_id` 重复组合的测试；同时断言软删除后相同组合可以再次插入，但原 `code` 仍不可复用。

- [ ] **Step 2: 运行测试并确认因表不存在而失败**

Run: `node --test test/schema-and-crypto.test.js`

Expected: FAIL，错误包含 `relation "op_applications" does not exist` 或默认应用断言失败。

- [ ] **Step 3: 在 schema 中创建表和约束**

在 `ensureDatabaseSchema()` 的同一 SQL 批次中加入：

```sql
create table if not exists op_applications (
  id uuid primary key,
  name text not null,
  app_id text not null unique,
  is_default boolean not null default false,
  status text not null check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists short_op_records (
  id uuid primary key,
  owner_id uuid not null references admin_users(id),
  code char(8) not null unique check (code ~ '^[0-9]{8}$'),
  op_value text not null,
  application_id uuid not null references op_applications(id),
  op_expire_at timestamptz not null,
  status text not null check (status in ('active', 'disabled', 'deleted')),
  remark text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create unique index if not exists idx_op_applications_single_default
  on op_applications (is_default) where is_default = true;
create unique index if not exists idx_short_ops_active_value_app
  on short_op_records (op_value, application_id) where status <> 'deleted';
create index if not exists idx_short_ops_owner_updated
  on short_op_records (owner_id, updated_at desc);
create index if not exists idx_short_ops_application
  on short_op_records (application_id);
```

在表创建后幂等插入固定 ID 的默认应用，并只在当前没有默认项时设为默认：

```sql
insert into op_applications (id, name, app_id, is_default, status)
values ('00000000-0000-0000-0000-000000000110', '抖音', '1105602870', false, 'active')
on conflict (app_id) do nothing;

update op_applications
set is_default = true, updated_at = now()
where app_id = '1105602870'
  and not exists (select 1 from op_applications where is_default = true);
```

- [ ] **Step 4: 运行 schema 测试并确认通过**

Run: `node --test test/schema-and-crypto.test.js`

Expected: PASS，包含新表、默认应用和唯一约束测试。

- [ ] **Step 5: 提交数据库任务**

```bash
git add lib/schema.js test/schema-and-crypto.test.js
git commit -m "Add short OP database schema"
```

---

### Task 2: AppID 应用领域与管理接口

**Files:**
- Create: `lib/op-applications.js`
- Create: `routes/admin-op-applications.js`
- Create: `test/op-applications-api.test.js`
- Modify: `app.js`

**Interfaces:**
- Produces: `listOpApplications(pool, filters)`、`listActiveOpApplicationOptions(pool)`、`createOpApplication(pool, payload)`、`updateOpApplication(pool, id, payload)`、`setDefaultOpApplication(pool, id)`、`setOpApplicationStatus(pool, id, status)`。
- Produces HTTP: `GET/POST /api/admin/op-applications`、`PUT /:id`、`POST /:id/default|enable|disable`。
- Consumes: `requireAdminAuth` 和 `requireSuperAdmin`。

- [ ] **Step 1: 写应用接口失败测试**

在 `test/op-applications-api.test.js` 使用 `createAdminTestContext()`，覆盖：

```js
test('authenticated operators can list active applications but cannot create them', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  await createOperator(agent, 'operator-apps');
  await agent.post('/api/admin/auth/logout');
  await login(agent, 'operator-apps', 'operator-pass');

  const listResponse = await agent.get('/api/admin/op-applications?page=1&pageSize=20');
  const createResponse = await agent.post('/api/admin/op-applications').send({
    name: '拼多多', appId: '1104790111',
  });

  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.items[0].appId, '1105602870');
  assert.equal(createResponse.status, 403);
});
```

另写超级管理员新增、搜索分页、AppID 重复、设置默认、拒绝停用当前默认项、拒绝修改已引用 AppID 的测试。

- [ ] **Step 2: 运行应用接口测试并确认 404 失败**

Run: `node --test test/op-applications-api.test.js`

Expected: FAIL，接口返回 `404`。

- [ ] **Step 3: 实现应用 service**

`lib/op-applications.js` 导出以下签名：

```js
module.exports = {
  createOpApplication,
  getOpApplicationById,
  listActiveOpApplicationOptions,
  listOpApplications,
  setDefaultOpApplication,
  setOpApplicationStatus,
  updateOpApplication,
};
```

统一 DTO：

```js
function toOpApplicationDto(row) {
  return {
    id: row.id,
    name: row.name,
    appId: row.app_id,
    isDefault: row.is_default,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

`setDefaultOpApplication()` 使用同一客户端事务，先锁定目标启用应用，再清空旧默认并设置新默认。`setOpApplicationStatus(..., 'disabled')` 在目标为默认项时抛出 `400 当前默认应用不能停用，请先设置其他默认应用`。`updateOpApplication()` 在 AppID 改变且存在 `short_op_records` 引用时抛出 `409 已使用的 AppID 不能修改`。

- [ ] **Step 4: 实现应用 router 并挂载**

`routes/admin-op-applications.js` 先执行 `requireAdminAuth`，允许所有登录管理员执行 GET；从 POST 开始执行 `requireSuperAdmin`：

```js
router.use(requireAdminAuth);
router.get('/', listHandler);
router.use(requireSuperAdmin);
router.post('/', createHandler);
router.put('/:id', updateHandler);
router.post('/:id/default', defaultHandler);
router.post('/:id/enable', enableHandler);
router.post('/:id/disable', disableHandler);
```

在 `app.js` 的 `pool && sessionMiddleware` 分支挂载：

```js
app.use('/api/admin/op-applications', createAdminOpApplicationsRouter({
  pool, requireAdminAuth,
}));
```

- [ ] **Step 5: 运行应用接口测试并确认通过**

Run: `node --test test/op-applications-api.test.js`

Expected: PASS。

- [ ] **Step 6: 提交应用管理任务**

```bash
git add app.js lib/op-applications.js routes/admin-op-applications.js test/op-applications-api.test.js
git commit -m "Add AppID management API"
```

---

### Task 3: 短 OP CRUD、权限、分页和批量导入

**Files:**
- Create: `lib/short-op-records.js`
- Create: `routes/admin-short-ops.js`
- Create: `test/short-op-api.test.js`
- Modify: `app.js`

**Interfaces:**
- Produces: `generateShortOpCode(randomIntImpl)`、`createShortOpRecord(pool, payload, adminUser, options)`、`listShortOpRecords(pool, filters, adminUser)`、`getShortOpRecordById(pool, id, adminUser)`、`updateShortOpRecord(...)`、`setShortOpRecordStatus(...)`、`deleteShortOpRecord(...)`、`importShortOpText(...)`、`resolveActiveShortOpByCode(pool, code)`。
- Produces HTTP: `/api/admin/short-ops` CRUD、状态接口和 `/import-text`。
- Consumes: `parseOpToken()`、`deriveOpExpireAt(opValue, { strict: true })`、应用 service。

- [ ] **Step 1: 写短 OP 接口失败测试**

在 `test/short-op-api.test.js` 覆盖以下行为：

```js
test('creating a short OP generates an eight-digit code and binds the app', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const appResponse = await agent.get('/api/admin/op-applications?page=1&pageSize=20');

  const response = await agent.post('/api/admin/short-ops').send({
    opValue: validOpValue,
    applicationId: appResponse.body.items[0].id,
    remark: 'first short op',
  });

  assert.equal(response.status, 201);
  assert.match(response.body.item.code, /^\d{8}$/);
  assert.equal(response.body.item.appId, '1105602870');
  assert.equal(response.body.item.shortLink, `/op/${response.body.item.code}`);
});
```

拆分测试覆盖：短码冲突重试、相同 OP+应用返回 `409`、相同 OP+不同应用允许、OP 格式/时间戳错误、员工所有权隔离、超级管理员查看全部、编辑保留短码、启停、软删除、筛选和 20/50/100/all 分页。

批量测试发送：

```js
await agent.post('/api/admin/short-ops/import-text').send({
  rowsText: `${opA}\n${opB}----1104790111\n${opA}`,
});
```

断言默认抖音、指定 AppID、同批重复、数据库重复和逐行错误分别计数，响应字段固定为：

```js
{
  importedCount,
  duplicateCount,
  failedCount,
  items,
  errors,
}
```

- [ ] **Step 2: 运行短 OP 测试并确认 404 失败**

Run: `node --test test/short-op-api.test.js`

Expected: FAIL，接口返回 `404`。

- [ ] **Step 3: 实现短 OP domain service**

短码生成：

```js
function generateShortOpCode(randomIntImpl = crypto.randomInt) {
  return String(randomIntImpl(0, 100_000_000)).padStart(8, '0');
}
```

新增时先用 `parseOpToken(opValue)` 验证前三段，再用现有 `deriveOpExpireAt(opValue, { strict: true })` 得到与当前后台一致的“第五段时间戳 +30 天”到期时间。查询应用必须存在且为 `active`。插入最多重试 20 次唯一短码冲突；其他数据库冲突映射为 `409 该 OP 与应用已存在`。

列表 DTO 不返回完整 OP：

```js
{
  id, code, shortLink: `/op/${code}`,
  maskedOpValue, applicationId, appName, appId,
  opExpireAt, status, owner, remark, createdAt, updatedAt,
}
```

详情 DTO 仅在所有权验证后额外返回 `opValue`。普通员工 SQL 强制加入 `owner_id = $n`，超级管理员不加该条件。

批量解析只允许一行一个 `OP` 或 `OP----AppID`；从右侧最后一个 `----` 分割可选 AppID。逐行执行并捕获错误，不用一个错误回滚整批。重复项加入 `duplicateCount`，校验错误加入 `{ lineNumber, message }`。

- [ ] **Step 4: 实现管理 router 并挂载**

`routes/admin-short-ops.js` 所有接口先执行 `requireAdminAuth`，调用 service 时始终传入 `req.adminUser`。DELETE 返回软删除后的 `{ item }`，不返回 `204`，便于 UI 更新。

在 `app.js` 挂载：

```js
app.use('/api/admin/short-ops', createAdminShortOpsRouter({
  pool, requireAdminAuth,
}));
```

- [ ] **Step 5: 运行短 OP 接口和相关回归测试**

Run: `node --test test/short-op-api.test.js test/admin-records-api.test.js`

Expected: PASS。

- [ ] **Step 6: 提交短 OP 后台任务**

```bash
git add app.js lib/short-op-records.js routes/admin-short-ops.js test/short-op-api.test.js
git commit -m "Add short OP management API"
```

---

### Task 4: 公共 `/op` 解析、统一错误和限流

**Files:**
- Create: `lib/fixed-window-rate-limiter.js`
- Create: `routes/op-submit.js`
- Create: `routes/op-pages.js`
- Create: `public/op.html`
- Create: `public/op.js`
- Create: `test/fixed-window-rate-limiter.test.js`
- Create: `test/short-op-public.test.js`
- Modify: `app.js`

**Interfaces:**
- Produces: `createFixedWindowRateLimiter({ limit, windowMs, now })` Express middleware。
- Produces: `createOpSubmitRouter({ pool, buildWakeUrlImpl, rateLimitMiddleware })`。
- Produces HTTP: `GET /op`、`GET /op/:code`、`POST /api/op/submit`。
- Consumes: `resolveActiveShortOpByCode(pool, code)` 和 `buildWakeUrl(opValue, appId)`。

- [ ] **Step 1: 写限流和公共接口失败测试**

`test/fixed-window-rate-limiter.test.js` 使用可注入时钟，断言同一 IP 在窗口内第 21 次返回 `429`，窗口推进 60 秒后恢复。

`test/short-op-public.test.js` 覆盖：

```js
test('POST /api/op/submit resolves the bound app without exposing OP plaintext', async () => {
  const response = await request(app).post('/api/op/submit').send({ code });
  assert.equal(response.status, 200);
  assert.equal(response.body.appName, '抖音');
  assert.match(response.body.url, /^tencent1105602870:\/\//);
  assert.equal('opValue' in response.body, false);
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(openid));
});
```

另测格式错误 `400`；不存在、禁用、删除、过期和应用停用均返回 `404` 与完全相同的 `{ error: '短 OP 无效或已过期' }`；限流返回 `429`；GET `/op` 和 `/op/12345678` 返回新页面；员工用户名 `op` 不抢占页面。

- [ ] **Step 2: 运行公共测试并确认失败**

Run: `node --test test/fixed-window-rate-limiter.test.js test/short-op-public.test.js`

Expected: FAIL，模块不存在或路由返回 `404`。

- [ ] **Step 3: 实现固定窗口限流**

中间件按 `req.ip` 保存 `{ count, resetAt }`，默认 `limit = 20`、`windowMs = 60_000`。超过限制时返回：

```js
res.status(429).json({ error: '请求过于频繁，请稍后重试' });
```

每次请求时清理已过期的当前键；当 Map 超过 10,000 个键时遍历删除所有过期键，避免无限增长。

- [ ] **Step 4: 实现公共解析 router**

`routes/op-submit.js` 固定响应契约：

```js
if (!/^\d{8}$/.test(code)) {
  return res.status(400).json({ error: '请输入正确的 8 位短码' });
}
const record = await resolveActiveShortOpByCode(pool, code);
if (!record) {
  return res.status(404).json({ error: '短 OP 无效或已过期' });
}
const url = buildWakeUrlImpl(record.opValue, record.appId);
return res.json({ status: 'success', appName: record.appName, url });
```

捕获 OP 解析错误时服务端日志仅记录短码和记录 ID，不记录 `opValue`，公开响应仍为统一 `404`。

- [ ] **Step 5: 实现 `/op` 页面和脚本**

`public/op.js` 导出可测试的 `extractShortCode(locationLike)` 与 `isValidShortCode(value)`，浏览器中：

- 从 `/op/:code` 提取短码。
- 输入时移除非数字并限制 8 位。
- POST `{ code }` 到 `/api/op/submit`。
- 成功时显示 `appName`，再把 `window.location.href` 设为返回 URL。
- 页面文案只提“8 位短码”，不出现 OP 全参输入或应用选择框。

`routes/op-pages.js` 使用正则 `^/op(?:/.*)?$` 返回 `public/op.html`。

- [ ] **Step 6: 挂载路由并保留 `op` 名称**

在 `app.js`：

- 有 `pool` 时挂载 `/api/op`。
- 在通用 `/:username` 之前挂载 `createOpPagesRouter()`。
- 将保留列表改为 `['admin', 'api', 'favicon.ico', 'oplogin', 'op']`。

- [ ] **Step 7: 运行公共和 `/oplogin` 回归测试**

Run: `node --test test/fixed-window-rate-limiter.test.js test/short-op-public.test.js test/op-login-bugs.test.js test/op-url.test.js`

Expected: PASS。

- [ ] **Step 8: 提交公共短码任务**

```bash
git add app.js lib/fixed-window-rate-limiter.js routes/op-submit.js routes/op-pages.js public/op.html public/op.js test/fixed-window-rate-limiter.test.js test/short-op-public.test.js
git commit -m "Add public short OP login flow"
```

---

### Task 5: `/admin` 左侧导航与三个独立内容区域

**Files:**
- Create: `public/admin/admin-shell.js`
- Modify: `public/admin/index.html`
- Modify: `public/admin/admin.css`
- Modify: `test/admin-pages.test.js`

**Interfaces:**
- Produces DOM: `#adminSidebar`、`[data-admin-section]`、`#recordsSection`、`#shortOpsSection`、`#opApplicationsSection`。
- Produces: `initializeAdminShell(user)`，由 DOMContentLoaded 调用。
- Consumes: `requireAdminSession()`。

- [ ] **Step 1: 写后台 shell 失败测试**

在 `test/admin-pages.test.js` 断言 `/admin` 包含：

```js
assert.match(response.text, /id="adminSidebar"/);
assert.match(response.text, /data-section-target="recordsSection"/);
assert.match(response.text, /data-section-target="shortOpsSection"/);
assert.match(response.text, /data-section-target="opApplicationsSection"/);
assert.match(response.text, /id="shortOpsPageStatus"/);
assert.match(response.text, /id="opApplicationsPageStatus"/);
assert.match(response.text, /\/admin\/admin-shell\.js/);
assert.match(response.text, /\/admin\/short-ops\.js/);
assert.match(response.text, /\/admin\/op-applications\.js/);
```

另断言原 `#recordTable`、`#pageStatus` 和现有脚本仍存在。

- [ ] **Step 2: 运行后台页面测试并确认失败**

Run: `node --test test/admin-pages.test.js`

Expected: FAIL，缺少 `adminSidebar`。

- [ ] **Step 3: 重排 HTML 而不改原记录控件 ID**

在 header 下面建立 `.admin-layout`。原 action bar、筛选、记录表、分页和相关 dialog 整体放入 `<main id="recordsSection">`，所有已有 ID 保持不变。新增 `shortOpsSection` 与 `opApplicationsSection`，初始 `hidden`。

左侧按钮文案固定为“数据管理”“短 OP 管理”“应用管理”。应用按钮添加 `data-super-admin-only`，普通员工隐藏。

- [ ] **Step 4: 实现 shell 脚本和响应式 CSS**

`initializeAdminShell(user)`：

- 普通员工隐藏 `[data-super-admin-only]`。
- 点击导航时只显示目标 section，设置按钮 `.is-active`。
- 通过 `sessionStorage` 保存最后区域，但普通员工恢复到无权限区域时回退 `recordsSection`。
- 触发 `window.dispatchEvent(new CustomEvent('admin-section-shown', { detail: { sectionId } }))`，供两个新表首次加载。

CSS 桌面宽度使用 220px 左栏；小于 900px 时左栏变为顶部横向滚动导航。现有 `#recordTable` 的固定布局规则保留。

- [ ] **Step 5: 运行后台页面测试并确认通过**

Run: `node --test test/admin-pages.test.js`

Expected: PASS。

- [ ] **Step 6: 提交后台 shell 任务**

```bash
git add public/admin/index.html public/admin/admin.css public/admin/admin-shell.js test/admin-pages.test.js
git commit -m "Add admin sidebar sections"
```

---

### Task 6: 短 OP 与应用管理前端

**Files:**
- Create: `public/admin/short-ops.js`
- Create: `public/admin/op-applications.js`
- Modify: `public/admin/index.html`
- Modify: `public/admin/admin.css`
- Modify: `test/admin-pages.test.js`

**Interfaces:**
- Produces independent state: `shortOpsPage/shortOpsPageSize` 与 `opApplicationsPage/opApplicationsPageSize`。
- Consumes: `adminFetch()`、`showToast()`、`showConfirm()`、`formatDateTime()` 和 `admin-section-shown`。

- [ ] **Step 1: 写管理前端失败测试**

在 `test/admin-pages.test.js` 分别请求两个新脚本并断言：

```js
assert.match(shortOpsScript.text, /let shortOpsPage = 1/);
assert.match(shortOpsScript.text, /\/api\/admin\/short-ops/);
assert.match(shortOpsScript.text, /\/import-text/);
assert.match(applicationsScript.text, /let opApplicationsPage = 1/);
assert.match(applicationsScript.text, /\/api\/admin\/op-applications/);
assert.match(applicationsScript.text, /\/default/);
```

HTML 断言短 OP 新增/编辑 dialog、批量导入 dialog、应用 dialog、各自 page-size/上一页/下一页 ID 全部存在。CSS 断言长 OP 脱敏单元格使用省略号。

- [ ] **Step 2: 运行页面测试并确认失败**

Run: `node --test test/admin-pages.test.js`

Expected: FAIL，新脚本返回 `404` 或缺少 dialog。

- [ ] **Step 3: 实现短 OP 管理 UI**

`public/admin/short-ops.js` 使用独立变量：

```js
let shortOpsPage = 1;
let shortOpsPageSize = '20';
let shortOpsLoaded = false;
```

列表请求只在首次显示区域或筛选/分页变化时执行。新增表单发送 `{ opValue, applicationId, remark }`；编辑前 GET 详情以取得完整 OP；列表只渲染 `maskedOpValue`。状态和删除操作必须先 `showConfirm()`。批量导入发送 `{ rowsText }`，完成后显示 `成功 X，重复 Y，失败 Z` 并在 dialog 中列出逐行错误。

应用下拉通过 `GET /api/admin/op-applications?status=active&pageSize=all` 加载，默认应用排在第一位并预选。

- [ ] **Step 4: 实现应用管理 UI**

`public/admin/op-applications.js` 使用独立变量：

```js
let opApplicationsPage = 1;
let opApplicationsPageSize = '20';
let opApplicationsLoaded = false;
```

新增/编辑发送 `{ name, appId }`。设置默认、启用、停用均先确认并调用对应 POST 接口。普通员工不会加载此区域；超级管理员首次打开时加载。

- [ ] **Step 5: 完成新表格 CSS 与独立分页行为**

短 OP 表使用固定列宽，短链接和脱敏 OP 用 `.cell-truncate`；每个 section 内分页按钮只修改自己的状态变量，不调用原 `loadRecords()`。应用表在 1920×1080 下无需横向滚动，在移动端由 `.table-wrap` 允许横向滚动。

- [ ] **Step 6: 运行页面与 API 测试**

Run: `node --test test/admin-pages.test.js test/short-op-api.test.js test/op-applications-api.test.js`

Expected: PASS。

- [ ] **Step 7: 提交管理前端任务**

```bash
git add public/admin/index.html public/admin/admin.css public/admin/short-ops.js public/admin/op-applications.js test/admin-pages.test.js
git commit -m "Add short OP admin interfaces"
```

---

### Task 7: 完整回归、页面验证和文档同步

**Files:**
- Modify: `README.md`
- Verify only: all source and test files from Tasks 1-6

**Interfaces:**
- Produces: 用户可执行的短 OP 使用和管理说明。
- Consumes: 全部已实现接口和页面。

- [ ] **Step 1: 更新 README 使用说明**

增加以下内容：

- `/op` 与 `/op/:code` 的用途。
- `/admin` 左侧“短 OP 管理”“应用管理”。
- 批量格式 `OP` 和 `OP----AppID`。
- 默认抖音 AppID `1105602870`。
- 普通员工和超级管理员权限差异。
- 短码依赖在线数据库，离线 APK 不解析短码。

- [ ] **Step 2: 运行完整测试套件**

Run: `npm test`

Expected: exit code `0`，全部测试通过且无未处理异常。

- [ ] **Step 3: 启动测试服务器并做 HTTP 验证**

在已配置 PostgreSQL 的环境运行 `npm start`，验证：

```bash
curl -i http://127.0.0.1:4399/op
curl -i http://127.0.0.1:4399/op/12345678
curl -i -X POST http://127.0.0.1:4399/api/op/submit \
  -H 'Content-Type: application/json' \
  -d '{"code":"not-eight"}'
```

Expected: 两个 GET 为 `200`；非法 POST 为 `400` 且 JSON 提示 8 位短码格式错误。

- [ ] **Step 4: 浏览器验证 `/admin` 与 `/op`**

检查：

- `/admin` 左侧三个入口；普通员工隐藏应用管理。
- 三个区域分页状态互不改变。
- 批量导入只填 OP 时显示抖音。
- 复制链接得到 `/op/八位短码`。
- `/op/八位短码` 显示应用名称并尝试打开对应 scheme。
- `/oplogin` 仍显示原页面并允许全参和应用选择。

- [ ] **Step 5: 检查差异和用户原改动**

Run: `git status --short && git diff --check && git diff --stat`

Expected: 没有空白错误；`public/index.html` 与 `test/config-and-public-app.test.js` 的原有用户修改未被回退。

- [ ] **Step 6: 提交文档与最终验证变更**

```bash
git add README.md docs/superpowers/plans/2026-07-18-short-op-implementation.md
git commit -m "Document short OP workflow"
```

完成前再次运行 `npm test`，只有最新完整输出为 0 失败时才报告完成。
