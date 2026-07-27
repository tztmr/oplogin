# 通过 OP 全参识别 QQ 昵称

## 1. 功能说明

腾讯 QQ 互联的用户信息接口可以通过 OP 全参中的 `openid` 和
`access_token` 查询用户授权公开的 QQ 基本资料，包括昵称、头像、性别和地区。

> 本接口只能用于已获得用户授权的应用。`access_token`、`pay_token` 和
> `pfkey` 均属于敏感登录凭证，不应写入日志、公开链接或提交到代码仓库。

## 2. OP 全参格式

OP 全参通常由五段内容组成，使用 `|` 分隔：

```text
openid|access_token|pay_token|pfkey|auth_time
```

字段对应关系：

| 位置 | 字段 | 查询昵称时是否使用 |
| --- | --- | --- |
| 第 1 段 | `openid` | 是 |
| 第 2 段 | `access_token` | 是 |
| 第 3 段 | `pay_token` | 否 |
| 第 4 段 | `pfkey` | 否 |
| 第 5 段 | `auth_time` | 否 |

`AppID` 不包含在 OP 全参中，需要根据 OP 所属应用另外提供。当前抖音应用的
AppID 为：

```text
1105602870
```

## 3. 请求接口

### 请求地址

```text
GET https://graph.qq.com/user/get_simple_userinfo
```

### 请求参数

| 参数 | 取值 |
| --- | --- |
| `access_token` | OP 全参第 2 段 |
| `oauth_consumer_key` | 应用 AppID，抖音为 `1105602870` |
| `openid` | OP 全参第 1 段 |

### 请求示例

不要把真实 Token 固定写入代码或文档，调用时使用变量拼接并进行 URL 编码：

```text
https://graph.qq.com/user/get_simple_userinfo?access_token=<OP第2段>&oauth_consumer_key=1105602870&openid=<OP第1段>
```

如果将前两段写反，接口通常会返回：

```json
{
  "ret": -22,
  "msg": "openid is invalid"
}
```

## 4. 本次成功返回

```json
{
  "ret": 0,
  "msg": "",
  "is_lost": 0,
  "nickname": "svdsnqh",
  "gender": "男",
  "gender_type": 2,
  "province": "广东",
  "city": "深圳",
  "year": "1990",
  "figureurl": "http://thirdqq.qlogo.cn/ek_qqapp/AQBWwyF8HXS5Uiblgdrv37kZtjYfnibiaU0PYtSickiaQttRyPZccWrhn8Xna66Ric5g/40",
  "figureurl_1": "http://thirdqq.qlogo.cn/ek_qqapp/AQBWwyF8HXS5Uiblgdrv37kZtjYfnibiaU0PYtSickiaQttRyPZccWrhn8Xna66Ric5g/40",
  "figureurl_2": "http://thirdqq.qlogo.cn/ek_qqapp/AQBWwyF8HXS5Uiblgdrv37kZtjYfnibiaU0PYtSickiaQttRyPZccWrhn8Xna66Ric5g/100",
  "figureurl_qq_1": "http://thirdqq.qlogo.cn/ek_qqapp/AQBWwyF8HXS5Uiblgdrv37kZtjYfnibiaU0PYtSickiaQttRyPZccWrhn8Xna66Ric5g/40",
  "figureurl_qq_2": "http://thirdqq.qlogo.cn/ek_qqapp/AQBWwyF8HXS5Uiblgdrv37kZtjYfnibiaU0PYtSickiaQttRyPZccWrhn8Xna66Ric5g/100",
  "figureurl_qq": "http://thirdqq.qlogo.cn/ek_qqapp/AQBWwyF8HXS5Uiblgdrv37kZtjYfnibiaU0PYtSickiaQttRyPZccWrhn8Xna66Ric5g/0",
  "is_yellow_vip": "0",
  "vip": "0",
  "yellow_vip_level": "0",
  "level": "0",
  "is_yellow_year_vip": "0"
}
```

## 5. 返回结果解读

本次请求执行成功：

- 返回码：`ret = 0`
- QQ 昵称：`svdsnqh`
- 性别：男
- 地区：广东深圳
- 资料年份：1990
- 黄钻状态：未开通
- QQ 会员状态：未开通
- `is_lost = 0`：返回资料没有被标记为丢失

头像字段的区别：

| 字段 | 说明 |
| --- | --- |
| `figureurl` / `figureurl_1` | 40 像素头像 |
| `figureurl_2` | 100 像素头像 |
| `figureurl_qq_1` | 40 像素 QQ 头像 |
| `figureurl_qq_2` | 100 像素 QQ 头像 |
| `figureurl_qq` | 原始尺寸 QQ 头像 |

昵称、头像及其他资料可能随用户修改而变化，不应将昵称当作账号唯一标识。
业务侧如需关联记录，应使用相同 AppID 下的 `openid`。

## 6. 常见错误

### `openid is invalid`

常见原因：

1. 把 OP 第 1 段与第 2 段写反。
2. `openid` 与 `access_token` 不属于同一份授权。
3. AppID 与签发该 OP 的应用不匹配。

### Token 无效或过期

`access_token` 已失效，需要重新取得用户授权，不能仅通过修改
`auth_time` 恢复。

### 应用无权限

应用没有获得 `get_simple_userinfo` 权限时，即使 OP 格式正确也可能无法查询。

## 7. 安全建议

1. 请求只在服务端发起，避免将完整 URL 暴露在前端和浏览器历史记录中。
2. 日志只记录返回码、AppID 和脱敏后的 `openid`，不要记录完整 OP。
3. 接口返回给前端时只保留业务需要的昵称和头像字段。
4. 数据库存储昵称时应允许更新，不要把昵称作为唯一键。
5. 如果完整 OP 已公开，应重新授权，使旧凭证失效。
