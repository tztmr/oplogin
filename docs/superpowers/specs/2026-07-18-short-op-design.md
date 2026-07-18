# 8 位短 OP 与 AppID 管理设计

## 1. 目标

在保留现有 `/oplogin` 全参登录流程的前提下，新增一套完全独立的短 OP 业务：

- 新增公开页面 `/op`，仅接受 8 位数字短码。
- 每个短码全局唯一，并绑定一条 OP 全参和一个已配置的 AppID。
- 服务端根据短码直接生成应用唤醒链接，不向公开页面返回 OP 明文。
- `/admin` 保持同一路由，通过左侧导航新增“短 OP 管理”和“应用管理”。
- 短 OP、现有数据记录和应用配置分别使用独立表格、筛选及分页状态。
- 普通员工只能管理自己的短 OP；超级管理员可以管理全部短 OP，并独占 AppID 配置权限。

## 2. 非目标

- 不修改现有 `/oplogin`、`/api/submit` 和全参 OP 使用方式。
- 不把短 OP 功能加入离线 APK；短码解析依赖服务端数据库和网络。
- 不允许通过公共接口把短码兑换为 OP 明文。
- 不允许手工指定或修改短码。

## 3. 总体架构

采用两个新表和两组新接口，与现有 `managed_records` 解耦：

```text
op_applications
  应用名称 + AppID + 默认状态 + 启用状态
               │
               ▼
short_op_records
  8位短码 + OP全参 + 应用 + 所属员工 + 到期时间 + 状态
               │
               ▼
/op 输入短码 → 公共解析接口 → 服务端生成唤醒链接 → 打开应用
```

这种设计使短 OP 可以独立导入、分页、授权和停用，不受现有谷歌号、UID、公开批次或 OP 链接字段影响。

## 4. 数据模型

### 4.1 `op_applications`

字段：

- `id uuid primary key`
- `name text not null`
- `app_id text not null unique`
- `is_default boolean not null default false`
- `status text not null`，仅允许 `active`、`disabled`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

规则：

- 初始化数据库时幂等写入“抖音 / `1105602870`”，并在没有默认项时将其设为默认。
- 使用部分唯一索引保证同一时刻最多一个 `is_default = true` 的应用。
- 只有启用的应用可以成为默认项或用于新增、修改、批量导入短 OP。
- 已被短 OP 引用的 AppID 数值不允许修改；应用名称、状态和默认项仍可修改。
- 停用应用不会删除已有短 OP，但这些短 OP 在应用恢复前不能公开唤起。
- 当前默认应用不能直接停用；超级管理员必须先把另一个启用应用设为默认。
- 只有超级管理员可以新增、编辑、启停或设置默认应用。

### 4.2 `short_op_records`

字段：

- `id uuid primary key`
- `owner_id uuid not null references admin_users(id)`
- `code char(8) not null unique`
- `op_value text not null`
- `application_id uuid not null references op_applications(id)`
- `op_expire_at timestamptz not null`
- `status text not null`，仅允许 `active`、`disabled`、`deleted`
- `remark text not null default ''`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- `deleted_at timestamptz null`

规则：

- 数据库检查约束保证短码匹配 `^[0-9]{8}$`。
- 短码在全表中永久唯一，包括已禁用和已软删除的记录。
- 短码由安全随机数生成，范围为 `00000000` 至 `99999999`；插入遇到唯一冲突时重试。
- OP 必须包含现有系统可识别的参数，并包含有效的到期时间戳；`op_expire_at` 从 OP 中派生。
- 对未软删除记录，`op_value + application_id` 组合唯一，避免重复导入同一映射。
- 编辑 OP、应用或备注时保留原短码。
- 删除使用软删除，将状态改为 `deleted` 并写入 `deleted_at`；旧短码永不重新分配。
- 短码可在 OP 到期前重复使用；管理员可以手动禁用或重新启用。

## 5. 权限模型

### 普通员工

- 可以分页查看、筛选、新增、编辑、启停和软删除自己创建的短 OP。
- 不能读取或修改其他员工的短 OP。
- 可以读取启用的应用列表，用于新增、编辑和导入。
- 不能进入或调用 AppID 配置的写接口。

### 超级管理员

- 可以查看和操作全部员工的短 OP。
- 短 OP 列表额外显示所属员工。
- 可以完整管理应用配置，并设置默认应用。

权限必须同时落实在 SQL 查询条件和写接口中，不能只通过前端隐藏按钮实现。

## 6. 公共 `/op` 页面

### 6.1 路由

- `GET /op`：显示空的短 OP 页面。
- `GET /op/:code`：显示页面并自动填入路径中的短码。
- `/oplogin` 的现有兜底路由和页面保持不变。
- `op` 必须加入通用 `/:username` 用户页面路由的保留名称，确保 `/op` 及其子路径不会被员工用户名页面抢占。

### 6.2 页面行为

- 视觉结构参考现有 `/oplogin`，但输入框只接受 8 位数字。
- 页面不提供应用选择框；应用由短码绑定关系决定。
- 输入合法短码后可以提交；非法格式在前端立即提示。
- 提交成功后显示应用名称并唤起对应 AppID。
- 页面不会显示、缓存或复制 OP 全参。

### 6.3 公共接口

```http
POST /api/op/submit
Content-Type: application/json

{ "code": "12345678" }
```

成功响应：

```json
{
  "status": "success",
  "appName": "抖音",
  "url": "tencent1105602870://..."
}
```

服务端依次验证：

1. 输入是恰好 8 位数字。
2. 短 OP 存在且状态为 `active`。
3. OP 尚未到期。
4. 关联应用处于启用状态。
5. OP 全参仍能被现有 `buildWakeUrl` 正确处理。

任一步失败都不返回 OP 明文。

## 7. 后台 `/admin` 页面

### 7.1 页面结构

`/admin` 改为左侧导航和右侧内容区，地址始终保持 `/admin`。左侧入口：

1. 数据管理
2. 短 OP 管理
3. 应用管理

三个区域为客户端切换，不创建新的后台页面路由。每个区域独立保存自己的筛选条件、当前页和每页条数，切换区域时互不覆盖。

### 7.2 短 OP 管理

表格列：

- 8 位短码
- 短链接 `/op/:code`
- 应用名称
- AppID
- 脱敏 OP
- 到期时间
- 状态
- 所属员工（仅超级管理员显示）
- 备注
- 操作

操作：

- 新增短 OP
- 编辑 OP、应用和备注
- 复制短码或短链接
- 启用、禁用
- 软删除
- 批量导入
- 按短码、应用、AppID、状态、员工和到期范围筛选
- 独立分页，每页支持 20、50、100 和全部

新增时只填写 OP、应用和备注，短码由服务端生成。编辑时不允许修改短码。

### 7.3 应用管理

表格列：

- 应用名称
- AppID
- 是否默认
- 状态
- 创建、更新时间
- 操作

功能：

- 按名称或 AppID 搜索
- 新增应用
- 修改名称
- 设置默认应用
- 启用、停用
- 独立分页，每页支持 20、50、100 和全部

普通员工可以读取应用选项，但页面中的应用管理入口和写操作仅对超级管理员开放。

## 8. 批量导入

支持两种逐行格式：

```text
OP全参
OP全参----AppID
```

规则：

- 只有 OP 时使用当前启用的默认应用，初始为抖音。
- 带 AppID 时，该 AppID 必须存在且启用。
- 每条成功数据生成一个全局唯一 8 位短码。
- 同一批次的重复行以及数据库中已有的 `OP + AppID` 组合均跳过。
- 每一行独立校验；部分错误不回滚已经成功的其他行。
- 响应包含成功数、重复数、失败数、生成结果和逐行失败原因。
- 普通员工导入的数据归属于自己；超级管理员导入的数据归属于当前超级管理员。

后台导入结束后只刷新短 OP 表格，不改变原数据管理区域的分页状态。

## 9. 管理接口

短 OP：

- `GET /api/admin/short-ops`
- `POST /api/admin/short-ops`
- `GET /api/admin/short-ops/:id`
- `PUT /api/admin/short-ops/:id`
- `POST /api/admin/short-ops/:id/enable`
- `POST /api/admin/short-ops/:id/disable`
- `DELETE /api/admin/short-ops/:id`，执行软删除
- `POST /api/admin/short-ops/import-text`

应用配置：

- `GET /api/admin/op-applications`
- `POST /api/admin/op-applications`
- `PUT /api/admin/op-applications/:id`
- `POST /api/admin/op-applications/:id/default`
- `POST /api/admin/op-applications/:id/enable`
- `POST /api/admin/op-applications/:id/disable`

列表接口采用与现有后台一致的服务端分页响应：`items`、`page`、`pageSize`、`total`。

## 10. 异常与安全

- 非 8 位数字返回 `400`，提示“请输入正确的 8 位短码”。
- 不存在、禁用、软删除、过期或应用停用统一返回相同的 `404` 提示“短 OP 无效或已过期”，避免探测具体状态。
- 访问频率过高返回 `429`。
- 公共接口按客户端 IP 做固定窗口尝试次数限制；部署为多实例时应迁移到共享的 Redis 等存储。
- OP 解析内部错误写入服务端日志时必须脱敏，不记录 OP 明文。
- 公共响应只包含应用名称和最终唤醒 URL，不提供独立的 OP 明文字段。
- 后台表格默认脱敏显示 OP；只有已授权编辑接口可以读取当前员工有权限的完整值。
- 所有 AppID、短码、分页和导入字段均由服务端重新校验。

## 11. 测试与验收

### 数据与服务测试

- 建表、默认抖音应用和幂等初始化。
- AppID、短码、默认应用和 `OP + AppID` 唯一约束。
- 8 位随机格式、前导零和唯一冲突重试。
- OP 到期时间解析。
- 短 OP 新增、编辑、启停、软删除、筛选和分页。
- 应用新增、启停、默认切换、引用保护和分页。
- 普通员工所有权隔离；超级管理员全局权限；AppID 写权限限制。
- 两种批量格式、默认应用、指定应用、重复和逐行失败报告。

### 公共流程测试

- `/op` 与 `/op/:code` 均返回新页面。
- 合法短码使用绑定 AppID 生成唤醒链接。
- 不合法、不存在、禁用、删除、过期和应用停用场景。
- 限流返回 `429`。
- 响应不包含 OP 明文。

### 回归与页面测试

- 原 `/oplogin` 和 `/api/submit` 测试继续通过。
- `/admin` 左侧导航、角色可见性和三个独立分页区域。
- 批量导入及表格刷新行为。
- 完整运行项目测试套件。
- 对 `/op` 和 `/admin` 进行浏览器级页面验证。

## 12. 验收标准

- 管理员能在 `/admin` 左侧进入短 OP 与应用管理区域。
- 默认抖音 AppID 可直接用于只包含 OP 的批量导入。
- 每条有效数据获得不可手填、全局唯一且永不复用的 8 位数字短码。
- 用户只输入短码即可唤起绑定 AppID，不需要选择应用或接触 OP 明文。
- 普通员工与超级管理员权限符合本设计。
- 三套后台表格分页互不干扰。
- 原 `/oplogin` 业务无行为回归。
