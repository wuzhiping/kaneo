# Kaneo Fork · 交接与上游同步手册

> 本文件是 `wuzhiping/kaneo` 这个 fork 的**唯一入口文档**。
> 它回答两个问题：① 四个自研变更分别是什么、代码在哪、怎么验证；② 长期怎么持续跟上 upstream。
>
> - upstream：`https://github.com/usekaneo/kaneo`
> - fork：`https://github.com/wuzhiping/kaneo`
> - 本目录（`change/`）里的 zip / md 是**历史归档**，本文件是**活文档**，两者冲突时以本文件 + 仓库实际代码为准。

---

## 0. 速查

| 项 | 值 |
| --- | --- |
| fork 基线（分叉点） | `4c89504d` — `fix(web): show the priority mark in the bulk toast`（2026-10-13） |
| fork 侧提交 | `daf1a9d2` → `87990037` → `ca16b5fd` → `335f4b18`（共 4 个） |
| 基线版本 | upstream `v2.46.2` |
| 编写时 upstream 状态 | `v2.47.1`，main = `d58b7b33`，**领先基线 193 个提交** |
| 合并 upstream/main 的冲突数 | **2 个文件**（都在 `apps/api/src/mcp/`），解法见 §4.4 |
| 是否有 schema / 迁移 | **无**。四个变更都不建表、不改列 |
| fork 补丁规模（对 upstream/main） | 22 个文件，+1556 / −34 |

四个变更一句话版：

1. **API-Key 直接登录** — 用 `GET /api/auth/api-key/sign-in?key=...` 把一把 API Key 换成浏览器会话。
2. **放宽 iframe 嵌入** — 仓库内把 `X-Frame-Options: SAMEORIGIN` 换成 CSP `frame-ancestors`，让**部署侧的外层 nginx** 可以按需放宽到指定父源。
3. **MCP 允许 API-Key** — `POST /api/mcp` 直接吃 `Authorization: Bearer <api_key>`，跳过 OAuth2 / device-flow。
4. **Run As** — API-Key 请求带 `x-run-as: <userId|email>`，以**目标用户**身份执行。

---

## 1. 仓库拓扑

```
upstream/main  ────────────────● d58b7b33 (v2.47.1)   ← 下次同步到这里
                     │
4c89504d (基线) ●───┼──● daf1a9d2  api-key and mcp      ← 变更一 + 三
                     │    ● 87990037  run-as            ← 变更四
                     │    ● ca16b5fd  run as            ← 变更四的 3 处修正
                     └──● 335f4b18  Add files via upload ← change/ 归档文档
```

要点：

- `4c89504d` 同时是 upstream 的 `claude/aws-ses-migration-413ea1` 分支头，**也是 upstream/main 的祖先**。
  所以 fork 是干净的「从 upstream 切出去」的结构，`git merge upstream/main` 可以直接用，不需要 `--allow-unrelated-histories`。
- fork 侧**没有**改动 `packages/`（`packages/mcp`、`packages/libs`、`packages/permissions` 全部与 upstream 一致）。
- fork 侧**没有**改动数据库 schema，也没有新增 migration。

---

## 2. 变更总览

| # | 变更 | 入口 | 默认 | 一键回滚 | 需要重启 API |
| --- | --- | --- | --- | --- | --- |
| 一 | API-Key 直接登录 | `GET /api/auth/api-key/sign-in?key=` | **关**（`API_KEY_SIGN_IN=true` 才开） | 去掉 env | 否（每请求读） |
| 二 | 放宽 iframe 嵌入 | 内置 nginx 的 CSP + cookie 属性 | **关**（`KANEO_COOKIE_SAMESITE=none` 才开） | 去掉 env + 撤外层 nginx 3 行 | **是**（模块加载时求值） |
| 三 | MCP 允许 API-Key | `POST /api/mcp` 的 Bearer 分支 | **开**（`MCP_ALLOW_API_KEY=false` 才关） | 设 `false` | 否（每请求读） |
| 四 | Run As | `x-run-as` 请求头 | **开**（`RUN_AS_ENABLED=false` 才关） | 设 `false` | 否（每请求读） |

> ⚠️ 变更三和四是**默认开启**的，且四者的爆炸半径都比 vanilla API Key 大。上线前请逐条看 §7 风险登记册。

---

## 3. 变更详解

### 3.1 变更一 · API-Key 直接登录

**语义**：把一把长期有效的 API Key 换成一个浏览器会话，然后跳回 Web 应用。

```
GET /api/auth/api-key/sign-in?key=<API_KEY>&redirect=/dashboard
  → 302 Location: ${KANEO_CLIENT_URL}/dashboard
  → Set-Cookie: __Secure-better-auth.session_token=…  (会话级，关浏览器即失效)
```

**准入与约束**

| 规则 | 实现 |
| --- | --- |
| 需显式开启 | `API_KEY_SIGN_IN=true`，否则端点直接 404 |
| 复用普通 API Key 校验 | enabled / 未过期 / owner 未 ban / 限流配额，全走 `verifyApiKey` |
| **拒绝带 scope 的 Key** | 带 scope 的 Key 权限小于会话，不允许它铸会话 |
| 可限定仅 instance admin | `API_KEY_SIGN_IN_ADMIN_ONLY=true` |
| 开放重定向防护 | `redirect` 只接受 `/` 开头且不含 `//` 的同站路径，否则回落 `/dashboard` |
| 不留痕 URL | `Referrer-Policy: no-referrer` + `Cache-Control: no-store` |

**代码面**

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `apps/api/src/api-key-sign-in/index.ts` | 新增 | better-auth 插件端点（`createAuthEndpoint`），含 `safeRedirectPath` |
| `apps/api/src/auth.ts` | +2 行 | `import { apiKeySignIn }` + 在 `plugins:` 里注册 `apiKeySignIn()` |
| `apps/api/src/utils/get-default-cookie-attributes.ts` | 改动 | 见变更二 |
| `apps/docs/api-reference/authentication.mdx` | +13 行 | "Sign in from a link" 小节 |
| `apps/docs/core/installation/environment-variables.mdx` | +2 行 | Authentication 表 |
| `tests/api-integration/api-key-sign-in.test.ts` | 新增 | 8 个用例（开关关闭 / 未知 Key / 禁用 / 过期 / 带 scope / 登录成功 / 会话级 cookie / 同站 redirect / 仅 admin） |
| `Kaneo-API-Key.md`（仓库根） | 新增 | 该特性的完整说明书（420 行） |

**参考**：`change/Kaneo-API-Key.md` 的方案书、`change/kaneo-changes-2026-10-15.zip` 的 `_kaneo-changes-2026-10-15/README.md`。

**风险**：Key 出现在 URL 里 → 浏览器历史 / 代理日志 / 聊天工具都会看到。用**专用 Key**，用完在 *Settings → Account → Developer* 吊销。

---

### 3.2 变更二 · 放宽 iframe 嵌入

**这个变更分两半，务必分清：**

| 半边 | 在哪 | 作用 |
| --- | --- | --- |
| **仓库内（代码）** | `apps/web/nginx.conf`、`apps/web/nginx.kaneo.conf`、`apps/api/src/utils/get-default-cookie-attributes.ts` | **只是"松绑的前提"，本身不放宽任何东西** |
| **部署侧（运维）** | 你自己的最外层 nginx（前置反代） | **真正的放宽在这里** |

仓库内做的两件事：

1. **把 `X-Frame-Options: SAMEORIGIN` 换成 `Content-Security-Policy "frame-ancestors 'self'"`**。
   原因：XFO 只支持单一来源，且不能叠加。外层 nginx 想「保留同源、额外允许某个父源」，只能靠 CSP `frame-ancestors`（支持空格分隔多源）。
   换完之后，外层 nginx 可以 `proxy_hide_header Content-Security-Policy` 掉容器这条，再自己 `add_header` 一条带父源的。

2. **`KANEO_COOKIE_SAMESITE=none` 开关**（`apps/api/src/utils/get-default-cookie-attributes.ts`）：
   强制会话 cookie 变成 `SameSite=None; Secure; Partitioned`（CHIPS），Chrome 才肯在第三方 iframe 上下文里写入并回传 cookie。
   非 HTTPS 时会 `console.warn`（`SameSite=None` 没有 `Secure` 会被浏览器直接拒收）。

> 换 XFO → CSP 之后**默认仍然是禁止跨源嵌入**（`frame-ancestors 'self'`）。不配外层 nginx 就是原样。

**部署侧要做的事（`change/Kaneo-外层nginx-设置说明.md` 有完整模板）**

```nginx
# 必须先 hide 容器那条 CSP，再 add 自己这条 —— 否则两条 CSP 取交集，父源反而被拒
proxy_hide_header Content-Security-Policy;
add_header Content-Security-Policy "frame-ancestors 'self' http://127.0.0.1:3080" always;
proxy_hide_header X-Frame-Options;
```

**浏览器代价（必须写进文档/告知用户）**

| 浏览器 | 第三方 iframe 内登录 |
| --- | --- |
| Chrome / Edge | ✅（CHIPS 生效） |
| Firefox / Safari | ❌（不认 CHIPS，且默认屏蔽第三方 cookie） |

**长期方案**：本 fork 落地的是「选型 B」。更彻底的「选型 C」（Bearer token 免 cookie + `postMessage` 握手 + WebSocket `?token=`）见 `change/Kaneo-iframe-嵌入-选型建议.md` 第 3 节，**尚未实现**。若要支持任意第三方嵌入，应升级到 C。

**参考**：`change/Kaneo-iframe-嵌入-选型建议.md`（A/B/C 三方案对比与决策）、`change/Kaneo-iframe-选型-B方案详解.md`（B 的改动清单、验证步骤、风险）。

---

### 3.3 变更三 · MCP 允许 API-Key

**语义**：`POST /api/mcp` 的传输层直接接受 `Authorization: Bearer <api_key>`，客户端不用走 OAuth2 / device-flow 三步。

**代码面**

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `apps/api/src/mcp/index.ts` | 改 | `validateBearerToken` 由 `req: Request` 改成 `c: Context`；新增 API Key 分支；返回体多带 `runAsTargetId` |
| `apps/api/src/mcp/tools.ts` | 改 | `ApiClient` 多一个 `runAsTargetId`，下游 REST 请求带上 `x-run-as` |
| `apps/api/src/mcp/modern.ts` | 改 | 透传 `runAsTargetId` |
| `apps/api/scripts/create-mcp-api-key.ts` | 新增 | `pnpm --filter @kaneo/api mcp:create-key -- --user <email>`，建一把**关闭限流**的 Key |
| `apps/api/package.json` | +1 行 | `mcp:create-key` script |
| `tests/api-integration/mcp-api-key.test.ts` | 新增 | 8 个用例（有效 Key / `MCP_ALLOW_API_KEY=false` / OAuth 回归 / 未知 Bearer / 禁用 / 过期 / owner 被 ban / 带 scope） |
| `tests/api/mcp-internal-api-url.test.ts` | 改 | 首个用例 timeout 5s → 15s |

**配额成本（重要）**

```
1 个 MCP 请求 = 1（入口 verifyApiKey）+ N（每个工具调用下游再验一次）
```

默认 Key 配额 10 次 / 24h，一个触发 3 个工具的 MCP 请求就烧掉 40%。**必须**用 `mcp:create-key` 建的关闭限流的专用 Key，或把 `rateLimitMax` 调大。

**与 upstream `packages/mcp` 的关系（别搞混）**

upstream 的 `packages/mcp`（已发布的 stdio MCP 包）**早就**支持 `KANEO_API_KEY` 环境变量 —— 但那是「用 API Key 当 Bearer 打 REST API」。本变更是**传输层**（`/api/mcp`）也接受 API Key。两者互补，不重复。

**参考**：`change/Kaneo-MCP-API-Key-支持-整改方案.md`（方案 A/B 对比；本 fork 实现的是 **方案 A**，方案 B 未实现）。

---

### 3.4 变更四 · Run As

**语义**：API-Key 认证的请求可以带 `x-run-as: <userId|email>`，**完全以目标用户身份**执行。

```bash
curl -X GET https://pl.feg.cn/api/user/me \
  -H "Authorization: Bearer $KEY" \
  -H "x-run-as: teammate@example.com"
# → 200，返回目标用户；响应头 x-kaneo-run-as: <目标 userId>
```

**四条准入闸**

| # | 条件 | 失败响应 |
| --- | --- | --- |
| 1 | 必须是 API-Key 认证（session/cookie 请求**完全忽略**该 header） | 静默忽略（不报错） |
| 2 | Key owner 必须是 instance admin（**每请求现读 DB 的 `role`**） | 403 |
| 3 | 目标用户存在且未被 ban | 404 / 403 |
| 4 | `RUN_AS_ENABLED` 开关 | 403 |

**精确扮演，不叠加**：目标是普通成员 → 你**失去**跨工作区 admin 权力；目标是另一个 admin → 你获得他的 admin 权力。目标不是某工作区成员 → 该工作区 404（不会因执行者是 admin 而放行）。

**Key 的 scope 仍是天花板**：`c.get("apiKey")` 原样保留，`assertApiKeyScope` 照常生效。只读 scope 的 admin Key 做 run-as 就只能读。

**代码面**

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `apps/api/src/utils/run-as.ts` | 新增（唯一新文件） | `applyRunAs(c, actor)`：解析目标 → 校验执行者是 admin → 交换 `c.set("userId"/"userEmail"/"user")` → 留痕 |
| `apps/api/src/utils/authenticate-api-request.ts` | 改 | `setApiKeyContext` 改 async 并调 `applyRunAs`；`resolveAssetBearerOrCookie` 的两个 Key 分支也调（asset 路由会重新解析身份） |
| `apps/api/src/utils/validate-workspace-access.ts` | 改 | 去掉「Key 归属 == effective userId」的比较（原本恒真）。run-as 下 effective user 是目标、Key 属于执行者，**3 个调用点零改动** |
| `apps/api/src/mcp/index.ts` | 改 | `validateBearerToken` 里也调 `applyRunAs`，把目标 id 传给下游 |
| `apps/api/src/mcp/modern.ts` / `tools.ts` | 改 | 透传 `runAsTargetId`，下游 REST 请求带 `x-run-as` |
| `tests/api-integration/run-as.test.ts` | 新增 | 8 个用例（非 admin 403 / email 生效 / userId 生效 / 目标不存在 404 / 目标被 ban / **session 忽略 header** / scope 仍是天花板 / 目标的工作区权限） |

**留痕**：不建审计表。`console.log("[run-as] actor=… target=… method=… path=…")` 进容器日志 + `publishEvent("run_as.used", …)` 进事件总线。
留存期取决于你的日志系统。要长期留痕就把 `console.log` 换成写日志服务。

**回滚**：`RUN_AS_ENABLED=false` → 每请求读 env，**立即全站失效，不用重启**。

**参考**：`change/Kaneo-Run-As-设计方案.md`（v2 简化方案，含行为矩阵、风险、测试清单）、`change/kaneo-changes-2026-10-24.zip`、`change/kaneo-run-as-fixes-2026-10-24.zip`。

---

## 4. 长期目标：持续同步 upstream

### 4.1 前置

仓库已配置 `upstream` remote（`https://github.com/usekaneo/kaneo`）。若没有：

```bash
git remote add upstream https://github.com/usekaneo/kaneo
```

### 4.2 标准同步流程

```bash
# 1. 拉 upstream
git fetch upstream --tags
git log --oneline HEAD..upstream/main | wc -l     # 看落后多少

# 2. 在干净工作区里合
git checkout main
git status                     # 必须干净
git merge upstream/main

# 3. 解决冲突（见 §4.4）——目前只有 apps/api/src/mcp/ 两个文件

# 4. 验证
pnpm install --frozen-lockfile
pnpm --filter @kaneo/api typecheck
pnpm --filter @kaneo/api test
pnpm --filter @kaneo/web typecheck
pnpm --filter @kaneo/api test:integration   # 需要 PostgreSQL

# 5. 重新生成 fork 补丁（§4.6），连同本文件一起更新
```

**不要**用 `git rebase` 改写这 4 个 fork 提交的历史 —— 它们已经是公开发布过的历史（`daf1a9d2` 等），改写会让已经部署过的版本对不上。

### 4.3 冲突热区

fork 与 upstream 同时改过的文件（`git diff --name-only $(git merge-base HEAD upstream/main)..upstream/main` ∩ fork 侧改动文件）：

| 文件 | 冲突概率 | 备注 |
| --- | --- | --- |
| `apps/api/src/mcp/index.ts` | **高** | upstream 持续重构 MCP 目录，见 §4.4 |
| `apps/api/src/mcp/modern.ts` | **高** | 同上 |
| `apps/api/src/utils/authenticate-api-request.ts` | **中** | upstream 会给 `resolveAssetBearerOrCookie` 加返回字段（如 `apiKeyPermissions`） |
| `apps/api/src/auth.ts` | **中** | upstream 在 `plugins:` / `hooks:` 大改；fork 只加 2 行，一般能自动合 |
| `apps/api/package.json` | 低 | 依赖版本 + script 段 |
| `apps/docs/core/installation/environment-variables.mdx` | 低 | 表格不同位置 |
| `apps/web/nginx.conf` / `nginx.kaneo.conf` | 低 | upstream 改 root 路径、加 `access_log off` |
| `.env.sample` | 低 | 注释块位置不同 |

### 4.4 已验证的冲突解法（对 upstream v2.47.1 / `d58b7b33`）

**实测结果：`git merge upstream/main` 只产生 2 个冲突文件。**

upstream 在基线之后对 MCP 做了重构，fork 的改动要**落到新结构上**：

| upstream 的变化 | 对 fork 的影响 |
| --- | --- |
| `createMcpServerForUser` 从 `mcp/index.ts` 移到**新文件** `apps/api/src/mcp/legacy-server.ts`，签名变成 `(token, internalApiUrl)` | fork 的 `runAsTargetId` 要加到**新文件**上；`index.ts` 里那份本地拷贝要删掉 |
| `mcp/modern.ts` 加了 `maxToolInputElements` / `maxRequestBodySize` / `ReturnType<typeof createMcpHandler>` 返回类型 | fork 的 `runAsTargetId` 参数要**加在**这些新约束之上，两者都要保留 |
| `mcp/index.ts` 加了 `await mcpRequestBounds(c, ...)` 和 `MCP_BODY_BYTES` 限流 | 不能被 fork 覆盖掉 |
| `mcp/tools.ts` upstream **没动** | fork 的 `runAsTargetId` 直接保留 ✓ |

**`apps/api/src/mcp/legacy-server.ts`（upstream 新文件 + fork 参数）**

```ts
export function createMcpServerForUser(
  token: string,
  internalApiUrl: string,
  runAsTargetId?: string,
): McpServer {
  const server = new McpServer(
    { name: "kaneo-mcp", version: "1.0.0" },
    { maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS },
  );
  registerMcpTools(
    toMcpToolRegistrar(server),
    internalApiUrl,
    token,
    runAsTargetId,
  );
  return server;
}
```

**`apps/api/src/mcp/modern.ts`**

```ts
export function createModernMcpHandler(
  token: string,
  apiUrl: string,
  runAsTargetId?: string,
): ReturnType<typeof createMcpHandler> {
  return createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "kaneo-mcp", version: "1.0.0" },
        { maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS },
      );
      registerMcpTools(toMcpToolRegistrar(server), apiUrl, token, runAsTargetId);
      return server;
    },
    { legacy: "reject", maxRequestBodySize: MCP_BODY_BYTES },
  );
}
```

**`apps/api/src/mcp/index.ts`**

- 删掉 fork 里那份本地 `createMcpServerForUser`（已移到 `legacy-server.ts`），同时删掉随之失效的 `LegacyMcpServer` / `registerMcpTools` / `toMcpToolRegistrar` import。
- `validateBearerToken(c: Context)` **保留 fork 版本**（upstream 仍是 `req: Request`；run-as 需要 Context）。
- 保留 upstream 的 `await mcpRequestBounds(c, async () => {})` 与 `maxRequestBodySize: MCP_BODY_BYTES`。
- 调用点补上第三个参数：

```ts
const modern = createModernMcpHandler(
  authResult.token,
  internalApiUrl,
  authResult.runAsTargetId,
);
// ...
const server = createMcpServerForUser(
  authResult.token,
  internalApiUrl,
  authResult.runAsTargetId,
);
```

### 4.5 语义冲突（不是文本冲突，更容易漏）★

upstream 在 `tests/api/mcp-request-bounds.test.ts` 新增了一条用例：

> 「invalid Bearer token」必须返回 **401**，且在读取请求体之前就拒绝。

fork 的 MCP API-Key 分支会调 `verifyApiKey(token)` → 访问数据库。**在没有数据库的单元测试环境里这一步会抛 `ECONNREFUSED`，响应变成 500**，于是 upstream 这条用例失败。

实测（合并 upstream v2.47.1 后）：

```
AssertionError: expected 500 to be 401 // Object.is equality
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**解法（已验证）**：把 MCP 的 Key 分支改成 fail-closed —— 查不动 Key 就当「未通过认证」，返回 401 而不是 500。

```ts
if (process.env.MCP_ALLOW_API_KEY !== "false") {
  // A key lookup needs the database. If it cannot run, the credential
  // cannot be authenticated, so the request stays unauthorized instead of
  // failing as a server error.
  let result: Awaited<ReturnType<typeof verifyApiKey>> = null;
  try {
    result = await verifyApiKey(token);
  } catch (error) {
    console.error("[mcp] API key lookup failed", error);
    return null;
  }
  if (result?.status === "valid") {
    // ...原有 run-as 逻辑
  }
}
```

> 代价：数据库不可用时，MCP 的 Key 认证从 500 变成 401（不再暴露「库挂了」这一信息，也不会把数据库故障伪装成凭据错误以外的东西）。
> **每次同步 upstream 都要重跑这条用例** —— upstream 很可能再加类似的「传输层必须在读 body 前拒绝」测试。

### 4.6 重新生成 fork 补丁（同步后必做）

fork 相对 upstream 的净差异就是「四个变更」本身。每次同步完 upstream，把它重新导出成一份可复用的补丁：

```bash
# 在合并完成、且 §4.4 / §4.5 都解完之后
git fetch upstream
BASE=$(git merge-base HEAD upstream/main)
git diff --binary $BASE..HEAD \
  -- .env.sample \
     Kaneo-API-Key.md \
     apps/api/package.json \
     apps/api/scripts/create-mcp-api-key.ts \
     apps/api/src/api-key-sign-in/ \
     apps/api/src/auth.ts \
     apps/api/src/mcp/ \
     apps/api/src/utils/authenticate-api-request.ts \
     apps/api/src/utils/get-default-cookie-attributes.ts \
     apps/api/src/utils/run-as.ts \
     apps/api/src/utils/validate-workspace-access.ts \
     apps/docs/api-reference/authentication.mdx \
     apps/docs/core/installation/environment-variables.mdx \
     apps/web/nginx.conf \
     apps/web/nginx.kaneo.conf \
     tests/api-integration/api-key-sign-in.test.ts \
     tests/api-integration/mcp-api-key.test.ts \
     tests/api-integration/run-as.test.ts \
     tests/api/mcp-internal-api-url.test.ts \
  > change/kaneo-fork.patch

git apply --check change/kaneo-fork.patch   # 自检
```

写这份补丁时的实测规模：

| 参照基准 | 文件数 | 增删 |
| --- | --- | --- |
| 合并后 vs `upstream/main`（**推荐基准**） | 22 | +1556 / −34 |
| 合并后 vs 旧基线 `4c89504d` | 21 | +1555 / −36 |

差 1 个文件是因为 upstream 后来新增了 `apps/api/src/mcp/legacy-server.ts`，相对 upstream/main 它算「本 fork 改动的文件」。
两种基准都能用；**用 `upstream/main` 作基准**更贴近「把这四个变更搬到任意 upstream 版本上」这个用途。

> `apps/docs/openapi.json` **不在**补丁里：fork 的四个变更没有新增任何 Hono OpenAPI 路由（`/api/auth/api-key/sign-in` 是 better-auth 端点，不进 OpenAPI 规范）。
> 但 upstream 会重新生成这个文件 —— 同步时**直接接受 upstream 的版本**，不要用 fork 的旧版本覆盖。

### 4.7 同步后 checklist

```
[ ] git status 干净；合并前先备份（git branch backup/pre-sync-$(date +%F)）
[ ] §4.4 的 2 个 MCP 冲突按上面的解法处理
[ ] §4.5 的 fail-closed 逻辑在位（否则 upstream 的 mcp-request-bounds 用例会红）
[ ] pnpm --filter @kaneo/api typecheck   → exit 0
[ ] pnpm --filter @kaneo/api test        → 全绿（注意 MCP 的那两条）
[ ] pnpm --filter @kaneo/web typecheck   → exit 0
[ ] pnpm --filter @kaneo/api test:integration   → 需要 PostgreSQL
[ ] apps/docs/openapi.json 采用 upstream 版本
[ ] .env.sample / environment-variables.mdx 没有与 upstream 重复或矛盾的条目
[ ] 重新生成 change/kaneo-fork.patch（§4.6）
[ ] 更新本文件的「速查」表：基线版本、upstream 领先提交数、冲突数
[ ] 部署前把 §6 的 env 矩阵与新版本对齐
```

---

## 5. 验证

### 5.1 单元测试 / 类型检查（不需要数据库）

```bash
pnpm install --frozen-lockfile
pnpm --filter @kaneo/api typecheck
pnpm --filter @kaneo/api test
pnpm --filter @kaneo/web typecheck
```

编写本文件时的实测（fork 当前 HEAD `335f4b18`）：

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter @kaneo/api typecheck` | ✅ exit 0 |
| `pnpm --filter @kaneo/api test` | ✅ 158 文件 / 1166 用例全过 |
| `pnpm --filter @kaneo/web typecheck` | ✅ exit 0 |

合并 upstream v2.47.1 并按 §4.4 / §4.5 解冲突后：

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter @kaneo/api typecheck` | ✅ exit 0 |
| `pnpm --filter @kaneo/api test` | ✅ 170 文件 / 1268 用例全过 |

### 5.2 集成测试（需要 PostgreSQL）

```bash
pnpm --filter @kaneo/api test:integration -- api-key-sign-in
pnpm --filter @kaneo/api test:integration -- mcp-api-key
pnpm --filter @kaneo/api test:integration -- run-as
```

> 写本文件的环境没有 PostgreSQL，这三条**未在本地跑过**。同步 upstream 后请务必在有库的环境跑一遍。

### 5.3 部署后的手工验收

```bash
# ① API Key 登录端点（401 = 已部署且已开启）
curl -sS -o /dev/null -w '%{http_code}\n' \
  "https://<host>/api/auth/api-key/sign-in?key=invalid"

# ② B 方案的 cookie 属性（期望 SameSite=None; Partitioned）
curl -sS -D - -o /dev/null -X POST https://<host>/api/auth/sign-out \
  -H "content-type: application/json" -d '{}' | grep -i set-cookie

# ③ 框架头（期望恰好一条 CSP，含父源；没有 X-Frame-Options）
curl -sSI https://<host>/ | grep -i 'content-security\|frame-options'

# ④ MCP 接受 API Key（期望 200）
curl -X POST https://<host>/api/mcp \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

# ⑤ Run As（期望 200 + 响应头 x-kaneo-run-as）
curl -sS -D - https://<host>/api/user/me \
  -H "Authorization: Bearer $KEY" -H "x-run-as: <目标email>"
```

---

## 6. 部署

### 6.1 环境变量矩阵

| 变量 | 默认 | 读值时机 | 需重启 API | 说明 |
| --- | --- | --- | --- | --- |
| `API_KEY_SIGN_IN` | `false`（关） | 每请求 | 否 | 开启 API-Key 链接登录 |
| `API_KEY_SIGN_IN_ADMIN_ONLY` | `false` | 每请求 | 否 | 只允许 instance admin 用登录链接 |
| `KANEO_COOKIE_SAMESITE` | 未设 → 自动判断 | **模块加载时** | **是** | 设 `none` 强制 `SameSite=None; Secure; Partitioned`（CHIPS） |
| `MCP_ALLOW_API_KEY` | `true`（开） | 每请求 | 否 | 设 `false` 强制 MCP 走 OAuth |
| `MCP_API_KEY_SESSION_TTL_SECONDS` | — | **未实现** | — | 方案 B 预留，当前代码不读 |
| `RUN_AS_ENABLED` | `true`（开） | 每请求 | 否 | 设 `false` 全站关闭 Run As |
| `KANEO_CLIENT_URL` | — | — | 否 | 登录链接跳转的基准地址，**必须**与浏览器实际访问地址一致 |

### 6.2 部署顺序建议

1. 先只配 env，不动外层 nginx → 看 Chrome 里 iframe 能否登录 → 定位是哪一段没生效。
2. 再放外层 nginx 那 3 行（`proxy_hide_header` → `add_header` → `proxy_hide_header X-Frame-Options`）。
3. 变更三、四是默认开的，**先确认外部 nginx 的 `log_format` 没有 `$http_authorization`**，否则 API Key 会进 nginx access log。

### 6.3 回滚

| 变更 | 回滚动作 | 生效时间 |
| --- | --- | --- |
| 一 | `API_KEY_SIGN_IN` 去掉/设 false | 立即（端点 404） |
| 二 | `KANEO_COOKIE_SAMESITE` 留空 + 撤外层 nginx 3 行 | 需重启 API |
| 三 | `MCP_ALLOW_API_KEY=false` | 立即 |
| 四 | `RUN_AS_ENABLED=false` | 立即 |
| 全部 | `git revert` 对应的 fork 提交 | 需重新构建部署 |

---

## 7. 风险登记册

| # | 风险 | 影响面 | 缓解 |
| --- | --- | --- | --- |
| R1 | **Run As 让 Key 泄露的爆炸半径变大** | 持 admin Key 的人能读任意用户的私有内容（评论、通知、私有项目、附件） | 专用 Key + 只读 scope + 定期轮换 + `RUN_AS_ENABLED=false` 一键关 |
| R2 | 留痕不是审计表 | 只有容器日志 + 内存事件总线，留存期由日志系统决定 | 长期留痕就把 `console.log` 换成写日志服务 |
| R3 | 业务活动被记成目标用户 | 任务评论/通知的 `createdBy` 是目标而非执行者 | 排查「谁改的」看日志，不看活动流 |
| R4 | Run As 期间 Key 的 scope 仍生效但语义不同 | 读写混用 Key 做 run-as 时容易误判 | 用只读 Key 做排查 |
| R5 | MCP 配额被吃光 | 默认 10 次/24h；1 个 MCP 请求 = 1+N 次 | `mcp:create-key` 建关闭限流的专用 Key |
| R6 | API Key 进 nginx access log | 密钥落盘 | 上线前查外层 nginx 的 `log_format` |
| R7 | 登录链接里的 Key 泄露 | 浏览器历史 / 代理日志 / 聊天工具 | 专用 Key + 用完吊销 |
| R8 | iframe 场景 Safari/Firefox 登不上 | 第三方 cookie 被浏览器屏蔽 | 已知代价，写进用户文档；或升级到选型 C |
| R9 | 外层 nginx 两条 CSP 取交集 | 父源反而被拒，iframe "Refused to frame" | 必须先 `proxy_hide_header Content-Security-Policy` |
| R10 | upstream 将来自己实现同名功能 | 功能重复 / 语义打架 | 每次同步先搜 upstream 的 `api-key-sign-in` / `run-as` / `mcp` 目录 |

---

## 8. 已知缺口（下次同步时可以顺手补）

| # | 缺口 | 说明 |
| --- | --- | --- |
| G1 | `packages/mcp`（已发布的 stdio MCP 包）**不支持 `x-run-as`** | 只有服务端 `/api/mcp` 传输层能带 `x-run-as`；stdio 包发的是 REST 请求，可以自己加头 |
| G2 | `apps/docs/core/integrations/mcp.mdx` 没写 API Key 章节 | 目前只写在 `api-reference/authentication.mdx` |
| G3 | MCP 方案 B（`MCP_API_KEY_SESSION_TTL_SECONDS`）未实现 | env 与文档已预留，实现见 `change/Kaneo-MCP-API-Key-支持-整改方案.md` §3 |
| G4 | 变更一没有 i18n 文案 | 端点是纯跳转，无 UI 文案；但若要加「用 API Key 登录」的按钮，需要在 `i18n/en-US.json` 加 key |
| G5 | 选型 C（Bearer 免 cookie 方案）未实现 | iframe 跨浏览器支持的终态方案，见 `change/Kaneo-iframe-嵌入-选型建议.md` |
| G6 | Run As 没有前端入口 | 目前只能用 curl / MCP，没有 Web UI |
| G7 | `apps/docs/openapi.json` 未由 fork 重新生成 | fork 没新增 OpenAPI 路由，所以一直没变；同步 upstream 时直接用 upstream 的 |

---

## 9. 归档索引

| 文件 | 内容 |
| --- | --- |
| `Kaneo-API-Key.md`（仓库根） | 变更一的完整说明书（方案、接口契约、安全设计、验收步骤） |
| `change/Kaneo-iframe-嵌入-选型建议.md` | iframe 嵌入的 A/B/C 三方案对比与选型决策 |
| `change/Kaneo-iframe-选型-B方案详解.md` | 选型 B 的改动清单、验证步骤、风险与回滚 |
| `change/Kaneo-MCP-API-Key-支持-整改方案.md` | 变更三的方案 A/B 对比、测试方案、风险清单 |
| `change/Kaneo-Run-As-设计方案.md` | 变更四的 v2 简化方案、行为矩阵、风险、测试清单 |
| `change/Kaneo-外层nginx-设置说明.md` | 部署侧最外层 nginx 的完整配置与排查清单 |
| `change/kaneo-changes-2026-10-15.zip` | 变更一 + 变更二 的全量包（含 `CHANGES.patch`） |
| `change/kaneo-changes-2026-10-16.zip` | 变更三 的全量包（含 `CHANGES.patch`） |
| `change/kaneo-changes-2026-10-24.zip` | 变更四 的全量包（含 `CHANGES.patch`） |
| `change/kaneo-run-as-fixes-2026-10-24.zip` | 变更四的 3 处修正（含 `CHANGES.patch`） |

zip 里的 `CHANGES.patch` 是**历史快照**，基线已经过时，只用于考古。**当前可用的补丁请按 §4.6 重新生成。**

---

## 10. 每次同步后的三句话总结模板

```
同步到 upstream <版本/commit>（领先 <N> 个提交）
冲突 <N> 个：<文件列表>，按 change/HANDOFF.md §4.4 / §4.5 解决
验证：typecheck ✅ / api test ✅ (<N> 用例) / integration <✅|需人工跑>
```
