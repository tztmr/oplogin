# oplogin

`oplogin` 是一个基于 `Node.js + Express + PostgreSQL` 的上号代理服务，包含：

- 前台上号页：提交数据号和游戏标识，生成本地唤起链接
- 远程兜底：本地编码失败时回退到远程接口
- 管理后台：管理员登录、账号管理、记录管理
- 用户独立页面：支持按用户名访问专属页面
- 一键部署脚本：支持 `PM2 + Nginx + HTTPS`

## 功能概览

- `POST /api/submit` 处理上号请求
- 根路径 `/` 默认跳转到 `/admin`
- 公开上号页固定在 `/oplogin`
- 自动初始化数据库表结构
- 首次启动自动创建默认超管
- 管理后台登录态使用 `express-session`
- 支持 `PostgreSQL` 持久化管理员、会话和业务数据
- Google 密码字段加密存储
- 支持按角色进行数据隔离
- 默认服务端口为 `4399`

## 技术栈

- `Node.js`
- `Express 5`
- `PostgreSQL`
- `express-session`
- `connect-pg-simple`
- `axios`
- `bcryptjs`

## 项目结构

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

## 角色与权限

- `super_admin`：可登录后台、管理业务记录、管理后台账号、重置密码、启用或禁用用户
- `operator`：可登录后台、管理自己可见的业务记录，但不能进入账号管理

## 数据说明

后台核心管理的是业务记录，常见字段包括：

- Google 账号
- Google 密码
- Google 辅助信息
- Google 到期时间
- UID 与 UID 录入时间
- OP 值
- OP 链接
- OP 到期时间
- 备注

说明：

- Google 密码在数据库中加密保存
- 管理员密码只保存哈希，不会明文存储
- 普通操作员只能看到和操作自己权限范围内的数据
- 超级管理员可以查看和管理全量数据

## 环境要求

- `Node.js 18+`
- `PostgreSQL 14+`
- `npm`

## 本地启动

1. 安装依赖

```bash
npm install
```

2. 复制环境变量

```bash
cp .env.example .env
```

3. 修改 `.env`

至少确认以下变量：

- `PORT=4399`
- `DATABASE_URL=postgres://postgres:postgres@localhost:5432/op_proxy`
- `SESSION_SECRET=请替换为随机长字符串`
- `GOOGLE_PASSWORD_ENCRYPTION_KEY=64位十六进制字符串`
- `INITIAL_SUPER_ADMIN_LOGIN=admin`
- `INITIAL_SUPER_ADMIN_EMAIL=admin@example.com`
- `INITIAL_SUPER_ADMIN_PASSWORD=改成你自己的密码`
- `SESSION_COOKIE_SECURE=false`

4. 启动服务

```bash
npm start
```

5. 访问页面

- 根路径会跳转到后台首页：[http://localhost:4399/](http://localhost:4399/)
- 公开上号页：[http://localhost:4399/oplogin](http://localhost:4399/oplogin)
- 管理登录页：[http://localhost:4399/admin/login](http://localhost:4399/admin/login)
- 管理后台首页：[http://localhost:4399/admin](http://localhost:4399/admin)

## 测试

运行全部测试：

```bash
npm test
```

## 启动行为

服务启动时会自动执行以下动作：

- 读取 `.env`
- 连接 PostgreSQL
- 自动创建数据库表结构
- 自动检查并初始化默认超管账号
- 启动 Web 服务

入口文件：

- [server.js](file:///Users/edking/Documents/网赚学习/op东鹏转发器/server.js)
- [app.js](file:///Users/edking/Documents/网赚学习/op东鹏转发器/app.js)

## 主要页面与接口

- `/`：默认重定向到 `/admin`
- `/oplogin`：公开上号页
- `/admin/login`：管理员登录页
- `/admin`：后台首页
- `/admin/users`：后台账号管理页，仅 `super_admin` 可用
- `/:username`：用户专属页面
- `/api/submit`：上号提交接口
- `/api/admin/auth/login`：后台登录接口
- `/api/admin/auth/logout`：后台退出接口
- `/api/admin/auth/me`：获取当前登录管理员
- `/api/admin/records`：后台记录查询与新增
- `/api/admin/records/import-text`：文本批量导入
- `/api/admin/records/export.csv`：CSV 导出
- `/api/admin/users`：后台账号管理接口，仅 `super_admin` 可用

## 服务器部署

项目根目录提供了一键部署脚本：

- [deploy-oplogin.sh](file:///Users/edking/Documents/网赚学习/op东鹏转发器/deploy-oplogin.sh)

脚本默认值：

- 仓库地址：`https://github.com/tztmr/oplogin.git`
- 安装目录：`/opt/oplogin`
- 默认端口：`4399`
- 进程管理：`PM2`

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
```

### 推荐部署流程

1. 先执行 `deploy`
2. 再执行 `env` 填写 `.env`
3. 确认服务启动正常
4. 最后执行 `https` 绑定域名证书

## 运行机制

- `server.js` 负责读取环境变量、连接数据库、初始化表结构和启动服务
- `app.js` 负责挂载后台页面、公开页面、管理接口和错误处理
- 会话存储在 PostgreSQL 中，服务重启后登录态可继续保留
- 首次启动且后台用户表为空时，会根据 `.env` 自动创建默认超管

## 后台能力

- 管理员使用“用户名或邮箱 + 密码”登录
- 后台记录支持分页、筛选、新增、编辑、删除
- 支持文本批量导入和 CSV 导出
- 支持按用户名生成专属用户页面
- 用户专属页面可配合库存分发和 UID 占用逻辑使用

## 注意事项

- 生产环境必须修改默认超管密码
- 生产环境必须替换 `SESSION_SECRET`
- 生产环境建议使用真实的 PostgreSQL 独立库
- `SESSION_COOKIE_SECURE=true` 仅在 HTTPS 反代完成后开启
- 如服务器首次部署失败，优先检查 `.env`、数据库连接和 `pm2 logs`
- 如果需要后台多账号协作，建议优先使用 `super_admin` + `operator` 角色划分

## License

仅供当前项目内部使用。
