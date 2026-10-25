# Kaneo MCP · API Key 直传整改方案

- 日期：2026-10-16
- 目标：让 `Authorization: Bearer <api_key>` 直接通过 MCP 传输层（`/api/mcp`），跳过 OAuth2 / device-flow 流程
- 范围：**只动 `validateBearerToken`**（`apps/api/src/mcp/index.ts:51`），加上 API Key 分支
- 状态：仅方案，未执行

---

## 1. 现状与目标

**现状**（`apps/api/src/mcp/index.ts:51-67`）：`validateBearerToken` 只调 `auth.api.getSession` 解 Bearer；`getSession` 找不到就 `null` → 401。整个 `/api/mcp` 路径在 `apps/api/src/index.ts:797` 的 `authenticateApiRequest` 里被**显式排除**（`if (path.startsWith("/api/mcp")) return next();`），所以即便前端 REST 有 `verifyApiKey` 这条路，MCP 也没沾边。`grep -r "verifyApiKey|x-api-key|apiKey" apps/api/src/mcp` 在 MCP 目录里 **0 处**命中。

**目标**：保留现有 OAuth session 路径，新增一条 "Bearer = API key" 的分支。MCP 客户端可以直接拿 API key 当 Bearer，省掉 register / authorize / token 三步。

---

## 2. 方案 A：直接透传（最小改动，推荐先上）

### 2.1 改动

**单点**：`apps/api/src/mcp/index.ts` 的 `validateBearerToken`（第 51–67 行）。

新增 import：
```ts
import { verifyApiKey } from "../utils/verify-api-key";
```

`validateBearerToken` 改为：
```ts
async function validateBearerToken(
  req: Request,
): Promise<{ userId: string; token: string } | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match?.[1]) return null;
  const token = match[1];

  // 1) 原 OAuth2 / device-flow session token 路径（保持不变）
  const headers = new Headers();
  headers.set("authorization", `Bearer ${token}`);
  const session = await auth.api.getSession({ headers });
  if (session?.user?.id) {
    if (isBanActive(session.user as BanState)) return null;
    return { userId: session.user.id, token };
  }

  // 2) 新增：API key 直接放行（默认开启；显式设 MCP_ALLOW_API_KEY=false 可关闭）
  if (process.env.MCP_ALLOW_API_KEY !== "false") {
    const result = await verifyApiKey(token);
    if (result?.status === "valid") {
      return { userId: result.key.userId, token };
    }
  }

  return null;
}
```

### 2.2 行为

- 客户端 `POST /api/mcp` 时带 `Authorization: Bearer kn_...` → MCP 资源服务器不再要求走 OAuth；MCP 工具调用下游 REST（`@kaneo/libs` 客户端，`apps/api/src/mcp/tools.ts:38` 已设 `Authorization: Bearer <token>`）→ 下游 `authenticateApiRequest`（`apps/api/src/utils/authenticate-api-request.ts:106-125`）会**先当 API key 验**（成功）→ 整个调用链都用这把 key。
- 没有 API key 的客户端继续走 OAuth，**零行为变化**。
- **默认开启**：`MCP_ALLOW_API_KEY` 未设或为 `"true"` 都启用 API key 分支；只有显式设 `"false"` 才禁用（关闭后回到原 OAuth 行为）。

### 2.3 配额（**重要**，要先看）

每次 `verifyApiKey` 调用**消耗 1 次 key 配额**（`apps/api/src/utils/api-key-usage.ts` 的窗口/配额会计）。MCP 的链路是：

```
[1]  MCP 入口  validateBearerToken       → verifyApiKey(token)         × 1
[N]  每个工具调用  authenticateApiRequest → verifyApiKey(token)         × N
─────────────────────────────────────────────────────────────────────────
     1 个 MCP 请求 = 1 + N 次配额
```

默认 key 配额是 10 次 / 24h（schema 里 `rateLimitMax: 10, rateLimitTimeWindow: 86400000`）。一个触发 3 个工具的 MCP 请求就烧掉 40% 日配额。**生产前要么给 MCP 专用 key 调高配额，要么用方案 B**。

### 2.4 安全

- `verifyApiKey` 内部已检查 `notBannedCondition`（`verify-api-key.ts:47`）、`enabled`、`expiresAt` → 已禁用的 key / 过期 / 所有者被封都返回非 `"valid"`，不会进入 MCP。
- 下游 REST 尊重 key 的 `permissions` scope（`require-workspace-permission.ts:37-41` 用 `apiKeyPermissions(c)` 判定）。带 scope 的 key 调写类工具会 403 —— 这是 least-privilege，**预期行为**。
- MCP 路径不走 `authenticateApiRequest`，**不会**把 Bearer 写进任何 Kaneo 自带的访问日志（`authenticateApiRequest` 是唯一会带 userId 上下文的地方）。外层 nginx 也没默认记 `$http_authorization`（要看你们 nginx.conf 里 `log_format` 有没有 `'$http_authorization'`，默认没有）。但**如果**有，API key 会进 nginx access log —— 上线前确认一下。
- **默认开启的安全含义**：新部署的实例**一上线**就支持 API key 直传 MCP。这不是后门（仍然要 valid、未禁、未过期的 key），只是把 OAuth 流程从"必经"放宽到"可选"。想要强制走 OAuth 的实例（合规/审计需要）必须显式设 `MCP_ALLOW_API_KEY=false`。

### 2.5 范围

**只动 1 个文件、~15 行**。无 schema 变更、无迁移、无新依赖、无前端改动、WS 不受影响（WS 走 cookie/header 不变）。

---

## 3. 方案 B：如果方案 A 的配额成本不可接受

在 `validateBearerToken` 验证 API key 之后，**临时为该用户 mint 一个短会话 token**，用会话 token 作为 `token` 返回。下游 REST 收到的是会话 token，`authenticateApiRequest` 走 session 分支，**不再消耗 key 配额**。

### 3.1 改动（仅 `validateBearerToken` 内不同）

```ts
if (process.env.MCP_ALLOW_API_KEY !== "false") {
  const result = await verifyApiKey(token);
  if (result?.status === "valid") {
    const { internalAdapter } = await auth.$context;
    const ttl = Number(process.env.MCP_API_KEY_SESSION_TTL_SECONDS) || 300; // 5 分钟默认
    const session = await internalAdapter.createSession(
      result.key.userId,
      true,
      { expiresAt: new Date(Date.now() + ttl * 1000) },
    );
    if (!session) return null;
    return { userId: result.key.userId, token: session.token };
  }
}
```

- 1 个 MCP 请求 = 1 次 `verifyApiKey`（入口）+ 1 次 `createSession`（DB insert）+ 0 次下游配额。
- `session` 表多 1 行，会话到 `expiresAt` 后被 better-auth 后台清理（或被 `requireUserSession` 检查时拒）。
- 默认 TTL 5 分钟可控（`MCP_API_KEY_SESSION_TTL_SECONDS`）。MCP 请求通常几秒内完成；5 分钟足够。

### 3.2 缺点

- 每个 MCP 请求多 1 个 DB insert。表上有索引，写入快；量级在「每秒几十次」以内没问题。
- 会话 5 分钟过期；如果 MCP 客户端保活长连接（`Streamable HTTP`）跨过 5 分钟，下游 `getSession` 会失败 → 客户端需用 key 重连。**默认 5 分钟对一般用法够，对长时间保活不够**。要更长就调 `MCP_API_KEY_SESSION_TTL_SECONDS`。
- 行为上与 OAuth 的 "每次重新走 device flow 拿 24h session token" 不同：OAuth 一次性拿 24h，方案 B 每次新 mint 5min。OAuth 客户端体验反而更好（拿一次用一天）。所以方案 B **不是**对 OAuth 体验的替代，只是给 "拿不到 OAuth 流程、只能用 API key" 的客户端用的折中。

### 3.3 推荐

- **先用方案 A**（最小改动、行为最可预测），给 MCP 专用 key 配高配额（譬如 1000/24h 或不限），观察实际工具调用数。
- 如果发现一次 MCP 请求确实触发 N 个工具、配额吃紧，再升级到方案 B（**几乎只是把"返回 raw key"换成"返回 mint 的 session token"**，十几行替换）。

---

## 4. 环境变量与文档

### 4.1 新增 env

```bash
# apps/api/.env（或部署环境）
MCP_ALLOW_API_KEY=true    # 默认开启：/api/mcp 接受 Authorization: Bearer <api_key>（绕过 OAuth）
                         # 设 false 可禁用（回到只走 OAuth 的旧行为）
# MCP_API_KEY_SESSION_TTL_SECONDS=300   # 仅方案 B 用；方案 A 不读
```

### 4.2 `.env.sample` 加这两行

位置：`Access policy` 段（在 `API_KEY_SIGN_IN_ADMIN_ONLY` 那块附近）：
```bash
# MCP_ALLOW_API_KEY=true                     # allow Authorization: Bearer <api_key> on /api/mcp (skip OAuth); set false to disable
# MCP_API_KEY_SESSION_TTL_SECONDS=300       # only for plan B (mint short-lived session); ignored by plan A
```

### 4.3 docs

- `apps/docs/core/installation/environment-variables.mdx` 的 Authentication 表加两行。
- 视情况在 MCP 相关文档（`apps/docs/core/integrations/mcp.mdx` 或 skill README）加一节"直接用 API Key 跳过 OAuth"。

---

## 5. 测试方案

`tests/api-integration/mcp-api-key.test.ts`（新文件）。8 个用例：

| 场景 | 期望 |
|---|---|
| 1. 有效未带 scope 的 API key + `MCP_ALLOW_API_KEY=true` | POST `/api/mcp` 一个工具调用 → 200，工具被调用，下游用同一个 Bearer |
| 2. 有效未带 scope 的 API key + 显式 `MCP_ALLOW_API_KEY=false` | 401 invalid_token |
| 3. 已知 session token（OAuth 流程发的） | 仍然 200，**回归**确认 OAuth 路径没破 |
| 4. 未知 / 格式错 | 401 invalid_token |
| 5. 已被禁用的 key（`enabled=false`） | 401（`verifyApiKey` 内部就拒） |
| 6. 已过期的 key | 401 |
| 7. 所有者被封禁的 key | 401 |
| 8. 带 scope 的 key 调写类工具 | MCP 200，但下游返回 403（验证 least-privilege 透传） |

每个用例：`resetTestDatabase()` → 用 `createWorkspaceMember()` 准备用户 → 插一条 API key（参考 `tests/api-integration/error-shape.test.ts:14-28` 的 `seedApiKey`）→ `vi.stubEnv('MCP_ALLOW_API_KEY', 'true')` → 用 `app.request('/api/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: ... })` 验证。

每个用例末尾 `vi.unstubAllEnvs()`（参考 `tests/api-integration/auth-registration-policy.test.ts:68`）。

---

## 6. 回滚

- 把 `MCP_ALLOW_API_KEY` 留空 / 设 `false` → API key 分支不进入，**秒级回滚**，无需重启（env 在请求时读）。
- 完全回滚：把 `validateBearerToken` 改回原版 ~12 行，删 1 行 import。

---

## 7. 风险清单

| 风险 | 缓解 |
|---|---|
| 配额被吃光（方案 A） | 用专用 key + 调高配额；或升方案 B |
| 外层 nginx access log 含 `$http_authorization` | 上线前查 `log_format`；没有就 OK，有就改 |
| 带 scope 的 key 调不了写类工具 | 文档写明；创建 MCP 专用 key 时留空 scope |
| key 泄露 | 与现在 REST 直接用 key 同样的风险面，没有放大 |
| 并发 / 重放 | `verifyApiKey` 内置窗口 / 配额；MCP 客户端应保护 key |

---

## 8. 建议落地顺序

1. 直接在 staging / prod 部署**方案 A**（最小改动，**默认开启**），用 1 个高配额专用 key 做端到端验证（1 个 MCP 请求 → 几个工具调用 → 记录配额消耗；如可接受即保留）。
2. 文档写明"需要高配额 key / 避免高频率工具调用 / 一次性短任务适用"，以及"不希望此特性的实例显式设 `MCP_ALLOW_API_KEY=false`"。
3. 若生产观察出配额吃紧，**无停机**升级到方案 B：把方案 A 的 1 块替换为方案 B 的几行（同一个函数内），重启 API 即可。

---

## 9. 一句话结论

**方案 A**：在 `validateBearerToken` 里加 `if (MCP_ALLOW_API_KEY !== 'false') verifyApiKey(token)` 这一个分支，~15 行，`MCP_ALLOW_API_KEY` **默认开启**（只有显式设 `false` 才禁用），零停机可回滚。配额成本 1+N/MCP 请求（MCP 专用 key 调高配额即可）。

**方案 B**：把"返回 raw key"换成"return mint 的 5 分钟 session token"，配额成本降到 1/MCP 请求，但每个请求多 1 个 DB insert。

需要的话告诉我**用 A 还是 B**，我照此执行。