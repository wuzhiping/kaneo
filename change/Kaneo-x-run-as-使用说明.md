# Kaneo `x-run-as` 使用说明

- 适用版本：`daf1a9d2` 之后（含 `8799003739ba "run-as"` 与后续修正）
- 生产环境：`https://pl.feg.cn`
- 开关：`RUN_AS_ENABLED`（默认开启）

---

## 1. 一句话

带 API Key 的请求加一个 `x-run-as` 头，**这次请求就以指定用户的身份执行**——权限、可见数据、工作区成员身份全部换成那个用户的，管理员自己的额外权力不带过去。

```
GET /api/user/me
Authorization: Bearer <ADMIN_KEY>
x-run-as: teammate@example.com
→ 200，返回 teammate 的身份，响应头 x-kaneo-run-as: <teammate 的 user id>
```

---

## 2. 谁能用（三道闸，缺一不可）

| 闸 | 判定 | 失败表现 |
|---|---|---|
| 认证方式必须是 **API Key** | `x-api-key:` 头 **或** `Authorization: Bearer <api key>` | session / cookie 请求**完全忽略** `x-run-as`（不报错，仍是你自己） |
| Key 拥有者必须是 **instance admin** | 每次请求**现读数据库**的 `user.role`（含 `admin` 即算），不信任任何缓存 | 403 `Run-as requires an instance administrator` |
| 目标必须**存在且未被 ban** | 按 user id 或 email 查 `user` 表 | 404 `Run-as target not found` / 403 `Run-as target is banned` |

外加一个总开关 `RUN_AS_ENABLED`：设成 `false` 后全站失效（403 `Run-as is not enabled on this instance`）。

---

## 3. 怎么用

### 3.1 REST —— `x-api-key` 头

```bash
curl -s https://pl.feg.cn/api/user/me \
  -H "x-api-key: $KEY" \
  -H "x-run-as: teammate@example.com"
```

### 3.2 REST —— `Authorization: Bearer`

```bash
curl -s https://pl.feg.cn/api/workspace \
  -H "Authorization: Bearer $KEY" \
  -H "x-run-as: teammate@example.com"
```

### 3.3 PowerShell

```powershell
$KEY = '<你的 admin API key>'
curl.exe -s https://pl.feg.cn/api/user/me `
  -H "x-api-key: $KEY" `
  -H "x-run-as: teammate@example.com"
```

### 3.4 MCP（`POST /api/mcp`）

```bash
curl -X POST https://pl.feg.cn/api/mcp \
  -H "Authorization: Bearer $KEY" \
  -H "x-run-as: teammate@example.com" \
  -H "Content-Type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-method: tools/call" \
  -H "mcp-name: list_workspaces" \
  -H "mcp-protocol-version: 2026-07-28" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_workspaces","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"probe","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
```

MCP 客户端配置文件（streamable HTTP 型客户端通用写法）：

```json
{
  "mcpServers": {
    "kaneo-as-user": {
      "url": "https://pl.feg.cn/api/mcp",
      "headers": {
        "Authorization": "Bearer <ADMIN_KEY>",
        "x-run-as": "teammate@example.com"
      }
    }
  }
}
```

> MCP 通路会把目标 id 转发给内部 REST（`x-run-as: <targetId>`），所以 **每个工具调用都会重新解析一次身份** → 日志里一次 MCP 请求会出现多行 `[run-as]`。

### 3.5 WebSocket（仅非浏览器客户端）

`/api/ws/user`、`/api/ws/:projectId` 走同一套鉴权链，所以也能带 run-as。浏览器 `new WebSocket()` 无法自定义 header，**浏览器端用不了**；curl / node / python 等可以：

```bash
websocat -H="x-api-key: $KEY" -H="x-run-as: teammate@example.com" \
  "wss://pl.feg.cn/api/ws/user"
```

### 3.6 批量遍历（排查用）

```bash
# 列出工作区成员
MEMBERS=$(curl -s "https://pl.feg.cn/api/workspace/$WS_ID/members" -H "x-api-key: $KEY")

# 逐个以他们的身份看同一个东西
for EMAIL in $(echo "$MEMBERS" | jq -r '.[].email'); do
  echo "=== $EMAIL ==="
  curl -s "https://pl.feg.cn/api/task/assigned?workspaceId=$WS_ID" \
    -H "x-api-key: $KEY" -H "x-run-as: $EMAIL" | jq -c 'length'
done
```

---

## 4. 目标怎么写

| 写法 | 匹配 | 大小写 |
|---|---|---|
| user id（如 `yO6O7gZ2PCnrvwGwvW2PUmEHuTxx7VvE`） | 精确匹配 `user.id` | 敏感 |
| email（如 `xie.yuxin@feg.cn`） | 匹配 `user.email` | **不敏感**（内部会转小写） |

两个都找不到 → 404 `Run-as target not found`。传自己的 id/email 也合法（等价于不切换，但会留痕）。

---

## 5. 怎么确认生效

**看响应头**（REST 与 MCP 都会带）：

```bash
curl -sS -D - -o /dev/null https://pl.feg.cn/api/user/me \
  -H "x-api-key: $KEY" -H "x-run-as: teammate@example.com" | grep -i x-kaneo-run-as
# x-kaneo-run-as: yO6O7gZ2PCnrvwGwvW2PUmEHuTxx7VvE   ← 生效了
```

**看身份本身**：`/api/user/me` 的返回体就是当前有效身份。

**看权限是否真的换了**（生产实测过的判据）：

```bash
# 同一个工作区，两种身份的 role 不同
curl -s https://pl.feg.cn/api/workspace -H "x-api-key: $KEY" | jq -r '.[0].role'                 # owner（管理员）
curl -s https://pl.feg.cn/api/workspace -H "x-api-key: $KEY" -H "x-run-as: xie.yuxin@feg.cn" | jq -r '.[0].role'  # member（目标）
```

> 没有 `x-kaneo-run-as` 响应头 = 这次**没有**切换（通常是 key 不是 admin，或走了 session 认证）。

---

## 6. 语义：精确扮演（会失去什么）

这是最容易误解的一点，务必记住：

| | 说明 |
|---|---|
| **获得** | 目标用户的全部权限与可见数据：他的工作区、任务、评论、通知、私有项目、附件 |
| **失去** | 你（管理员）自己的跨工作区 admin 权力。目标看不到的东西，**你也看不到**（会 404/403） |
| **不叠加** | 目标看不到的东西，你也看不到（会 404/403） |

**为什么要这样**：run-as 的用途是"以某人的身份复现他的问题"。如果叠加 admin 权力，看到的画面就跟对方不一样，排查就失去意义。

**想要"既能以目标身份操作、又能看到全部数据"** → 当前实现不支持，需要另加"影子模式"，可另议。

---

## 7. 错误表

| 状态 | body / code | 原因 |
|---|---|---|
| 401 | `Unauthorized` | key 无效 / 禁用 / 过期 / 拥有者被 ban |
| 403 | `Run-as is not enabled on this instance` | `RUN_AS_ENABLED=false` |
| 403 | `Run-as requires an instance administrator` | key 拥有者不是 instance admin |
| 403 | `Run-as target is banned` | 目标用户被封禁 |
| 404 | `Run-as target not found` | 目标不存在（id/email 写错） |
| 403 | `A user session is required` / `SESSION_REQUIRED` | 该路由只认用户会话，API key（含 run-as）一律进不去 |
| 403 | `Insufficient API key scope` / `API_KEY_SCOPE` | key 带 scope 且不覆盖该操作需要的权限 |
| 404 | `Project not found` / `Workspace not found` | 目标用户不在该工作区/项目（**不是** admin 放行） |

---

## 8. 覆盖不到的范围（硬边界）

run-as 走的是 API Key 认证，因此**账户级路由一律进不去**（`requireUserSession` 见到 API key 就拒）：

- `/api/admin/*` —— 用户管理、实例设置、工作区管理
- `/api/billing/*` —— 订阅、账单、用量
- `/api/oauth/id-token`
- 部分 `/api/github-integration/*` 设置路由

> 想以别人身份管理实例？不要用 run-as，改用那个用户自己的会话登录。

---

## 9. 留痕

| 载体 | 内容 |
|---|---|
| API 日志 | `[run-as] actor=<adminId> target=<targetId> method=<M> path=<P>`（每行一次；MCP 场景每个工具调用一行） |
| 实时事件 | `run_as.used` 事件（内存事件总线，非持久） |
| 响应头 | `x-kaneo-run-as: <targetId>` |

⚠️ **业务侧留痕记的是目标，不是你**：任务评论、通知的 `createdBy` 是目标用户。想知道"谁改的"只能看日志。

---

## 10. 配额与 scope

- **配额照扣**：每次 API Key 校验消耗 1 次配额；MCP 场景每次工具调用还会再消耗一次 → 一次 MCP 请求可能扣 1+N。
- **scope 仍是天花板**：key 带 `permissions` 时，run-as 也不能突破。所以可以专门做一把**只读** admin key 用于排查。
- **MCP 响应不带 `X-RateLimit-*`** 头（该路径不暴露限流信息），但配额照样在扣。

---

## 11. 开关与回滚

```bash
# 部署侧 .env
RUN_AS_ENABLED=false
```

- 读 env 在**请求时**进行 → 改完重启 API 即生效（不必等请求缓存）。
- 关闭后带 `x-run-as` 的请求 → 403 `Run-as is not enabled on this instance`。
- 已建的会话不受影响。

---

## 12. 排错

| 现象 | 排查 |
|---|---|
| 没有 `x-kaneo-run-as` 响应头 | ① 走的是 session/cookie 而非 API key；② key 拥有者不是 admin；③ `RUN_AS_ENABLED=false`；④ 中间代理剥掉了 `x-run-as` 头 |
| 403 `Run-as requires an instance administrator` | key 拥有者的 `user.role` 不含 `admin`（注意是**实例级**角色，不是工作区角色） |
| 404 `Run-as target not found` | id/email 写错；或目标邮箱大小写/别名不一致（用 id 更稳） |
| 403 `SESSION_REQUIRED` | 你在打账户级路由（见第 8 节），run-as 不覆盖 |
| 403 `API_KEY_SCOPE` | key 带 scope 且不够用；用无 scope 的 key 或放宽 scope |
| 代理/网关报 400 | 有些网关会过滤未知的 `x-*` 头；确认 `x-run-as` 原样透传 |
| 跨域调用被拦 | 浏览器端自定义头会触发 CORS 预检；服务端 CORS 允许 `Access-Control-Request-Headers` 回显，但父页面 origin 需在 `CORS_ORIGINS` 里 |

---

## 13. 生产实测记录（2026-10-26）

| 场景 | 结果 |
|---|---|
| `x-run-as: 不存在的用户` | 404 `Run-as target not found`（新代码指纹） |
| `x-run-as: <email>` / `<user id>` | 200，返回目标身份，响应头 `x-kaneo-run-as` 正确 |
| 目标用户的 `role` | `user`（不是 admin）→ 精确扮演生效 |
| 同一工作区的 role | 管理员 `owner` → run-as 目标 `member` → 权限按目标走 |
| MCP `list_notifications` | 通知 `userId` 从管理员变为目标 → run-as 已透传到下游 |
| `/api/admin/users` + run-as | 403 `SESSION_REQUIRED` → 硬边界保持 |
| 无凭证 / 无效 key | 401 |

未覆盖：非 admin key 的 403、banned 目标的 403（手上没有对应 key / 用户，生产实测未做；逻辑与 `verifyApiKey` 内部对 owner 的封禁检查同源）。
