# oplogin

`oplogin` 是一个基于 `Node.js + Express + PostgreSQL` 的上号代理与后台管理服务。

它把公开上号页、后台账号体系、业务记录管理、用户专属分发页面，以及一键部署脚本整合在一个项目里，适合把 OP 唤起流程和账号数据统一托管到自有服务器的场景。

## 核心能力

- 公开上号页固定在 `/oplogin`
- `POST /api/submit` 优先本地生成唤起链接，失败时自动回退远程接口
- 管理后台支持登录、记录管理、批量导入、CSV 导出
- 支持 `super_admin` / `operator` 两级权限
- 支持按用户名访问专属页面 `/:username`
- 用户专属页面支持批次分发、UID 占用检查、UID 回填
- 服务启动时自动建表，并在首次启动时初始化默认超管
- 提供 `PM2 + Nginx + HTTPS` 部署脚本

## 技术栈

- `Node.js`
- `Express 5`
- `PostgreSQL`
- `express-session`
- `connect-pg-simple`
- `axios`
- `bcryptjs`

## 目录结构

```text
.
├── app.js
├── server.js
├── deploy-oplogin.sh
├── lib/
├── public/
├── routes/
├── test/
└── .env.example
```

关键文件说明：

| 路径 | 说明 |
| --- | --- |
| [server.js](./server.js) | 服务启动入口，负责加载配置、连接数据库、建表、初始化默认超管 |
| [app.js](./app.js) | 应用装配入口，负责挂载页面、公开接口、后台接口和错误处理 |
| [routes/](./routes) | 路由层，包含公开接口、后台接口、用户公开接口等 |
| [lib/](./lib) | 配置、数据库、会话、权限、加密、批次逻辑等核心模块 |
| [public/](./public) | 管理后台与公开页面静态资源 |
| [deploy-oplogin.sh](./deploy-oplogin.sh) | 一键部署脚本 |

## 角色权限

| 角色 | 能力 |
| --- | --- |
| `super_admin` | 登录后台、管理全部记录、管理后台账号、重置密码、维护二维码配置、启用/禁用用户 |
| `operator` | 登录后台、查看和操作自己权限范围内的数据，不能进入账号管理 |

## 数据与安全

系统管理的核心对象是业务记录，常见字段包括：

- Google 账号
- Google 密码
- Google 辅助信息
- Google 到期时间
- UID 与 UID 录入时间
- OP 值
- OP 链接
- OP 到期时间
- 备注

安全约定：

- Google 密码以加密形式存储
- 管理员密码仅保存哈希，不明文落库
- 会话默认存储在 PostgreSQL 中，服务重启后登录态可保留
- 普通操作员只能访问自己权限范围内的数据

## 环境要求

- `Node.js 18+`，推荐 `20+`
- `PostgreSQL 14+`
- `npm`

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 创建环境变量

```bash
cp .env.example .env
```

### 3. 配置 `.env`

至少需要确认以下配置：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PORT` | 是 | 服务端口，默认 `4399` |
| `DATABASE_URL` | 是 | PostgreSQL 连接串 |
| `SESSION_SECRET` | 是 | 会话密钥，生产环境务必替换 |
| `GOOGLE_PASSWORD_ENCRYPTION_KEY` | 是 | 64 位十六进制字符串，用于加密 Google 密码 |
| `INITIAL_SUPER_ADMIN_LOGIN` | 是 | 首次启动时初始化的默认超管账号 |
| `INITIAL_SUPER_ADMIN_EMAIL` | 是 | 默认超管邮箱 |
| `INITIAL_SUPER_ADMIN_PASSWORD` | 是 | 默认超管密码，生产环境务必替换 |
| `SESSION_COOKIE_SECURE` | 是 | HTTPS 部署完成后改为 `true` |

`.env.example` 示例：

```env
PORT=4399
DATABASE_URL=postgres://postgres:postgres@localhost:5432/op_proxy
SESSION_SECRET=replace-with-a-long-random-string
GOOGLE_PASSWORD_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
INITIAL_SUPER_ADMIN_LOGIN=admin
INITIAL_SUPER_ADMIN_EMAIL=admin@example.com
INITIAL_SUPER_ADMIN_PASSWORD=change-me-now
SESSION_COOKIE_SECURE=false
```

### 4. 启动服务

```bash
npm start
```

### 5. 本地访问

默认端口为 `4399`：

- 首页重定向：<http://localhost:4399/>
- 公开上号页：<http://localhost:4399/oplogin>
- 管理登录页：<http://localhost:4399/admin/login>
- 管理后台首页：<http://localhost:4399/admin>
- 健康检查：<http://localhost:4399/health>

## 启动时会发生什么

服务启动时会按顺序执行：

1. 读取 `.env`
2. 解析并校验运行配置
3. 连接 PostgreSQL
4. 自动创建数据库表结构
5. 检查并初始化默认超管账号
6. 启动 Web 服务

## 公开上号接口

### `POST /api/submit`

用于提交数据号和游戏标识，优先本地编码生成唤起链接；如果本地生成失败，会自动请求远程接口兜底。

请求示例：

```bash
curl -X POST http://localhost:4399/api/submit \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://example.com/data",
    "game": "example-game"
  }'
```

成功响应示例：

```json
{
  "status": "success",
  "url": "oplogin://...",
  "source": "local"
}
```

其中 `source` 可能为：

- `local`：本地编码成功
- `remote`：本地编码失败后走远程接口兜底

## 页面与接口清单

### 页面路由

| 路径 | 说明 |
| --- | --- |
| `/` | 默认重定向到 `/admin` |
| `/oplogin` | 公开上号页 |
| `/admin/login` | 管理员登录页 |
| `/admin` | 管理后台首页 |
| `/admin/users` | 后台账号管理页，仅 `super_admin` 可用 |
| `/:username` | 用户专属页面，用户存在且为启用状态时可访问 |

### 基础接口

| 路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `POST /api/submit` | 提交上号请求 |

### 后台鉴权接口

| 路径 | 说明 |
| --- | --- |
| `POST /api/admin/auth/login` | 登录 |
| `GET /api/admin/auth/me` | 获取当前登录管理员 |
| `POST /api/admin/auth/change-password` | 修改当前管理员密码 |
| `POST /api/admin/auth/change-wifi` | 修改当前管理员的二维码配置 |
| `POST /api/admin/auth/logout` | 退出登录 |

### 后台记录接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/admin/records` | 记录列表 |
| `POST /api/admin/records` | 新增记录 |
| `GET /api/admin/records/:id` | 查看单条记录 |
| `PUT /api/admin/records/:id` | 更新记录 |
| `DELETE /api/admin/records/:id` | 删除单条记录 |
| `DELETE /api/admin/records` | 按条件删除记录 |
| `POST /api/admin/records/batch-delete` | 批量删除 |
| `POST /api/admin/records/import-text` | 文本批量导入 |
| `GET /api/admin/records/export.csv` | CSV 导出 |
| `POST /api/admin/records/export.csv` | 按条件导出 CSV |

### 后台账号接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/admin/users` | 获取后台账号列表 |
| `POST /api/admin/users` | 创建后台账号 |
| `PUT /api/admin/users/:id` | 更新后台账号基础信息 |
| `PUT /api/admin/users/:id/password` | 重置指定账号密码 |
| `PUT /api/admin/users/:id/qrcode-config` | 更新指定账号二维码配置 |

### 用户公开接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/public/user/:username/batch` | 获取当前批次及二维码配置 |
| `POST /api/public/user/:username/batch/slots/:slot/uid` | 提交某个槽位的 UID |
| `POST /api/public/user/:username/batch/advance` | 推进到下一批次 |
| `GET /api/public/user/:username/uid-availability` | 检查 UID 是否可用 |
| `GET /api/public/user/:username/record` | 拉取当前用户可分发记录 |
| `POST /api/public/user/:username/record/:id/uid` | 为指定记录回填 UID |

## 测试

运行全部测试：

```bash
npm test
```

## 部署

项目根目录自带一键部署脚本 [deploy-oplogin.sh](./deploy-oplogin.sh)，用于部署到服务器并配合 `PM2 + Nginx + HTTPS` 运行。

### 交互式部署

```bash
chmod +x ./deploy-oplogin.sh
bash ./deploy-oplogin.sh
```

### 命令模式

```bash
bash ./deploy-oplogin.sh deploy
bash ./deploy-oplogin.sh https
bash ./deploy-oplogin.sh env
bash ./deploy-oplogin.sh status
bash ./deploy-oplogin.sh logs
bash ./deploy-oplogin.sh restart
bash ./deploy-oplogin.sh rebuild
bash ./deploy-oplogin.sh uninstall
bash ./deploy-oplogin.sh admins
bash ./deploy-oplogin.sh reset-admin-password
```

### 推荐部署顺序

1. 执行 `deploy`
2. 执行 `env` 配置 `.env`
3. 用 `status` / `logs` 检查运行状态
4. 服务正常后执行 `https`

## 生产环境注意事项

- 生产环境必须替换默认超管密码
- 生产环境必须替换 `SESSION_SECRET`
- 建议使用独立的 PostgreSQL 数据库
- 完成 HTTPS 反向代理后，再将 `SESSION_COOKIE_SECURE` 改为 `true`
- 如首次部署失败，优先检查 `.env`、数据库连接、`pm2 logs` 和 Nginx 配置

## License

仅供当前项目内部使用。
