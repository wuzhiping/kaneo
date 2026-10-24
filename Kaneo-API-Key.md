# Kaneo「API Key 链接直接登录」解决方案说明书

| 项目 | 内容 |
| --- | --- |
| 文档日期 | 2026-10-14 |
| 目标仓库 | `kaneo/`（分支 `main` @ `4c89504d`，版本 `2.46.2`） |
| 关键依赖 | better-auth `1.6.26`、better-call `1.3.7`、zod `^4.6.5`、Hono `^4.13.12` |
| 需求 | 不改动任何前端 UI，用「带 API Key 的链接」直接完成浏览器登录 |
| 状态 | 代码已写入工作区；本会话按要求**未执行编译/安装**，因此未跑 typecheck 与集成测试（详见第 10 节） |

---

## 1. 需求与约束

**需求**：访问形如下面的链接，浏览器直接进入已登录状态，不需要在目标浏览器里输入邮箱、密码或验证码。

```
https://<你的站点>/api/auth/api-key/sign-in?key=<API_KEY>&redirect=/dashboard
```

**约束**：

1. 不改前端（不新增页面、不新增路由、不动登录页组件）。
2. 只增加一个后端路由，凭证就是既有 API Key。
3. 尽量复用 Kaneo 已有的鉴权判定，不新造一套凭证体系。

**为什么现版本做不到、必须加代码**：Kaneo 里 API Key 只用于「认证一次请求」——`authenticateApiRequest()` 校验通过后只写入 `userId` + `apiKey` 上下文，`session`/`user` 置空（[`authenticate-api-request.ts:75-88`](kaneo/apps/api/src/utils/authenticate-api-request.ts)）；调用 better-auth 取会话前还会显式删除 `x-api-key`（[`get-user-session.ts:5`](kaneo/apps/api/src/utils/get-user-session.ts)）；敏感账户级路由用 `requireUserSession` 直接拒绝 API Key（403 `SESSION_REQUIRED`，[`require-user-session.ts`](kaneo/apps/api/src/utils/require-user-session.ts)）。也就是说 API Key 本身**无法**产生浏览器会话，必须新增一个「用 Key 换会话」的端点。

---

## 2. 方案总览

新增一个 better-auth 插件端点，挂在 Kaneo 既有的 `/api/auth/*` 转发通道下：

```
浏览器打开链接
   │
   ├─ GET /api/auth/api-key/sign-in?key=…&redirect=/dashboard
   │        │
   │        ├─ 1. 开关检查：API_KEY_SIGN_IN !== "true"  → 404（默认不暴露）
   │        ├─ 2. verifyApiKey(key)  → enabled / 未过期 / owner 未被封禁 / 限流配额记账
   │        ├─ 3. 带权限 scope 的 Key → 403（scope 权限低于会话，禁止提权）
   │        ├─ 4. findUserById → 不存在 → 401
   │        ├─ 5. 可选：API_KEY_SIGN_IN_ADMIN_ONLY=true 时仅实例管理员
   │        ├─ 6. internalAdapter.createSession(userId, dontRememberMe=true)
   │        ├─ 7. setSessionCookie(...) → Set-Cookie（浏览器会话 cookie，无 Max-Age）
   │        └─ 8. 302 Location: ${KANEO_CLIENT_URL}${redirect}
   │
   └─ 浏览器带 cookie 请求 Web 应用 → 已登录
```

**设计要点**：

- 挂 `/api/auth/*` 而不是自己写 Hono 路由，是为了直接复用 better-auth 的会话写入能力（`setSessionCookie`），cookie 的签名算法、`domain`/`SameSite`/`Secure`/`Partitioned` 属性与其它登录方式完全一致（属性来自 [get-default-cookie-attributes.ts](kaneo/apps/api/src/utils/get-default-cookie-attributes.ts)）。
- Kaneo 的 `/api/auth/*` 处理链会把 better-auth 的响应原样返回；`withJsonNotFound` / `withJsonRateLimit` 只改 404 与 429，302 + `Set-Cookie` 不受影响（[`not-found-response.ts:11`](kaneo/apps/api/src/errors/not-found-response.ts)、[`rate-limit-response.ts:19`](kaneo/apps/api/src/errors/rate-limit-response.ts)）。

---

## 3. 接口契约

### 3.1 请求

| 项 | 值 |
| --- | --- |
| 方法 | `GET`（设计为浏览器地址栏直接打开） |
| 路径 | `/api/auth/api-key/sign-in` |
| `key` | **必填**。调用方持有的 API Key 原始值；建议 URL 编码（`encodeURIComponent`） |
| `redirect` | 可选。站内相对路径，如 `/dashboard`、`/settings/account`；默认 `/dashboard` |

### 3.2 成功响应

```
HTTP/1.1 302 Found
Location: https://<web 站点>/dashboard
Set-Cookie: better-auth.session_token=<签名值>; Path=/; HttpOnly; SameSite=Lax
Set-Cookie: better-auth.dont_remember=true; Path=/; HttpOnly; SameSite=Lax
Referrer-Policy: no-referrer
Cache-Control: no-store
```

说明：

- `better-auth.session_token` 是**会话级 cookie**（没有 `Max-Age`/`Expires`，关浏览器即失效），因为实现向 better-auth 传了 `dontRememberMe = true`；对应数据库里的会话有效期被 better-auth 收敛为 1 天。
- cookie 名在 HTTPS 部署下会带 `__Secure-` 前缀（`__Secure-better-auth.session_token`），这是 better-auth 在 `secure` 场景下的既有行为；属性能随 `COOKIE_DOMAIN`、跨子域等既有配置自动适配。
- `redirect` 目标固定拼在运营方配置的 `KANEO_CLIENT_URL` 之后，客户端无法把目标指向别的站点。

### 3.3 错误响应

| 状态 | code | 触发条件 |
| --- | --- | --- |
| 404 | （better-auth 默认 404 体） | `API_KEY_SIGN_IN !== "true"`，端点对外不可见 |
| 400 | `VALIDATION_ERROR` | 缺少 `key` 参数 |
| 401 | `INVALID_API_KEY` | Key 不存在 / 已禁用 / 已过期 / owner 被封禁 / 用户不存在 |
| 403 | `SCOPED_API_KEY_NOT_ALLOWED` | Key 带权限 scope（其权限低于会话，禁止用它换会话） |
| 403 | `INSTANCE_ADMIN_REQUIRED` | 开启了 `API_KEY_SIGN_IN_ADMIN_ONLY`，但 owner 不是实例管理员（user.role 含 `admin`） |
| 429 | `RATE_LIMITED` | 命中插件限流规则（10 次 / 60 秒；仅当 better-auth 限流开启时生效，即 `KANEO_CLOUD=true`） |

失败时不会创建会话。

### 3.4 调用示例

```bash
KEY='<Settings → Account → Developer 里创建的 API Key>'
ENC=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$KEY")

# 直接用链接（浏览器）
echo "https://your-kaneo.example.com/api/auth/api-key/sign-in?key=$ENC&redirect=/dashboard"

# 命令行验证：期望 302 + Location + Set-Cookie
curl -sS -D - -o /dev/null \
  "https://your-kaneo.example.com/api/auth/api-key/sign-in?key=$ENC&redirect=/dashboard"
```

---

## 4. 配置项

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `API_KEY_SIGN_IN` | `false` | **总开关**。只有设为 `true`，端点才存在；否则一律 404 |
| `API_KEY_SIGN_IN_ADMIN_ONLY` | `false` | 为 `true` 时，只有 `user.role` 含 `admin` 的实例管理员能用该链接 |
| `KANEO_CLIENT_URL` | — | 登录成功后的跳转基地址（既有变量，必须与用户实际访问的站点一致） |
| `COOKIE_DOMAIN` | 未设置 | 仅当 Web 与 API 分属同一注册域的不同子域时需要，用于跨子域共享会话 cookie（既有变量） |

`.env.sample` 已补充前两项（[`.env.sample:123-124`](kaneo/.env.sample)）。

---

## 5. 安全设计

| 风险 | 处理 |
| --- | --- |
| 端点被静默暴露 | 默认关闭（`API_KEY_SIGN_IN`），关闭时返回 404；部署方必须显式开启 |
| 用 API Key 提权 | 带 scope 的 Key 一律拒绝——API Key 的 scope 只能收窄权限，会话则是完整权限，不能反向放大 |
| 浏览器会话被永久化 | `dontRememberMe=true`：cookie 为会话级，数据库会话 1 天 |
| 开放重定向 | `redirect` 只接受以 `/` 开头且不含 `//` 的站内路径，否则回退 `/dashboard`（`safeRedirectPath`） |
| Key 泄漏到下游 | 302 响应带 `Referrer-Policy: no-referrer`，避免把含 Key 的 URL 作为 Referer 传给目标页及其子资源 |
| 响应被缓存 | `Cache-Control: no-store` |
| 暴力枚举 Key | Key 为高熵随机串；另加插件限流规则（10 次/60 秒，仅在 better-auth 限流开启时生效） |
| 错误信息泄露 | 无效 Key 一律 401 `INVALID_API_KEY`，不区分「不存在/过期/禁用」 |
| 管理员可进一步收窄 | `API_KEY_SIGN_IN_ADMIN_ONLY=true` |

**必须让使用方知情的固有代价**（无法在服务端消除）：

1. **Key 会留在浏览器历史和 API/反代的访问日志里**。链接方案的本质就是把凭证放进 URL；要消除只能改用「一次性短 TTL 兑换码」。
2. **必须同站点才可靠**。最佳形态是 API 与 Web 同源（例如 `https://pl.feg.cn/api/...` → `https://pl.feg.cn/dashboard`）；若两者是同一注册域的不同子域，需要 `COOKIE_DOMAIN`（HTTPS 下自动 `SameSite=None; Secure; Partitioned`）。若完全是不同注册域，重定向后 cookie 分区不匹配，会「登录成功但仍未登录」。
3. **会消耗 Key 的请求配额**：每次成功兑换算一次请求，配额耗尽的 Key 无法再用于登录（返回 429）。
4. **GET 语义**：邮件扫描器/安全网关可能预取链接，从而产生一次兑换（消耗 1 次配额、建一个会话）。会话仍是短生命周期，影响可控。

---

## 6. 改动清单

### 6.1 新增

| 文件 | 说明 |
| --- | --- |
| [`kaneo/apps/api/src/api-key-sign-in/index.ts`](kaneo/apps/api/src/api-key-sign-in/index.ts) | better-auth 插件端点 `apiKeySignIn()`，116 行（含 `safeRedirectPath` 导出，便于测试） |
| [`kaneo/tests/api-integration/api-key-sign-in.test.ts`](kaneo/tests/api-integration/api-key-sign-in.test.ts) | 集成测试，8 个用例（详见第 9.2 节） |

### 6.2 修改

| 文件 | 改动 |
| --- | --- |
| [`kaneo/apps/api/src/auth.ts`](kaneo/apps/api/src/auth.ts) | 第 40 行新增 `import { apiKeySignIn } from "./api-key-sign-in";`；第 704 行在 `plugins` 数组里 `adminPlugin(...)` 之后、`openAPI()` 之前加入 `apiKeySignIn(),` |
| [`kaneo/.env.sample`](kaneo/.env.sample) | 第 123–124 行新增 `API_KEY_SIGN_IN`、`API_KEY_SIGN_IN_ADMIN_ONLY` 两个开关及注释 |
| [`kaneo/apps/docs/core/installation/environment-variables.mdx`](kaneo/apps/docs/core/installation/environment-variables.mdx) | Authentication 表格新增两行（第 55–56 行） |
| [`kaneo/apps/docs/api-reference/authentication.mdx`](kaneo/apps/docs/api-reference/authentication.mdx) | 新增「Sign in from a link」小节（第 61 行起），说明启用步骤与风险 |

**未改动**：前端任何文件、数据库 schema、迁移、OpenAPI 提交物（`apps/docs/openapi.json` 由 Kaneo 自有 Hono 路由生成，better-auth 插件端点不进该文件）。

---

## 7. 启用与上线步骤

> 本方案是**代码改动**，需要由负责部署的人重新构建/部署容器后才生效。本会话未执行构建（按用户要求）。

1. 合入/保留第 6 节的代码改动。
2. 在部署环境（如 Coolify/Compose 的环境变量面板）设置：
   ```
   API_KEY_SIGN_IN=true
   # 可选，建议对外共享链接时开启
   API_KEY_SIGN_IN_ADMIN_ONLY=false
   ```
   确认 `KANEO_CLIENT_URL` 指向用户实际访问的 Web 地址。
3. 重新部署 API（滚动重启即可，无需数据库迁移）。
4. 按第 9 节验证。
5. 生成专用 Key：登录后进入 **Settings → Account → Developer → API Keys**，命名为 `signin-link` 之类，按需设置过期时间；把链接发给使用方。
6. 链接不再需要时，删除该 Key（立即失效）或把 `API_KEY_SIGN_IN` 改回 `false`（端点立即 404）。

---

## 8. 回滚

| 目标 | 操作 | 生效速度 |
| --- | --- | --- |
| 立即关闭功能 | `API_KEY_SIGN_IN=false` 并重启 API | 重启后端点返回 404 |
| 撤销某个链接 | 在 API Keys 页面删除/禁用对应 Key | 立即（下次请求即 401） |
| 撤销管理员限制 | `API_KEY_SIGN_IN_ADMIN_ONLY=false` | 重启后 |
| 完全移除代码 | 删除 `apps/api/src/api-key-sign-in/`，移除 `auth.ts` 的 import 与 `apiKeySignIn(),` | 重新部署后 |

已建立的会话不受上述开关影响；如需强制下线，删除该用户的会话/Key 或在本地改密（Kaneo 改密会撤销该用户全部会话）。

---

## 9. 验证指引

### 9.1 手工验收（5 步）

```powershell
# Windows PowerShell 5.1 请写 curl.exe；PowerShell 7 下 curl 即 curl.exe
$BASE = 'https://your-kaneo.example.com'
$KEY  = '<API Key>'
$ENC  = [uri]::EscapeDataString($KEY)

# ① 开关关闭时应为 404
curl.exe -s -o NUL -w '%{http_code}' "$BASE/api/auth/api-key/sign-in?key=$ENC"

# ② 开启后：应看到 302 + location + set-cookie + referrer-policy + cache-control
curl.exe -sS -D - -o NUL "$BASE/api/auth/api-key/sign-in?key=$ENC"

# ③ 用第②步的 cookie 调 get-session，确认返回的是 Key 的主人
curl.exe -s "$BASE/api/auth/get-session" -H "Cookie: better-auth.session_token=<第②步的值>"

# ④ 无效 Key 应为 401，且不产生会话
curl.exe -s -o NUL -w '%{http_code}' "$BASE/api/auth/api-key/sign-in?key=not-a-real-key"

# ⑤ 开放重定向应被拦回 /dashboard
curl.exe -sS -o NUL -D - "$BASE/api/auth/api-key/sign-in?key=$ENC&redirect=//evil.example.com"
```

> Linux/macOS 上把 `curl.exe` 换成 `curl`、`NUL` 换成 `/dev/null` 即可；`KEY` 的 URL 编码也可用 `node -e 'console.log(encodeURIComponent(process.argv[1]))' "$KEY"`。

浏览器验收：直接打开链接，应落到看板且处于已登录状态；HTTPS 部署下 cookie 名为 `__Secure-better-auth.session_token`，复制时注意前缀。

### 9.2 自动化测试覆盖的场景

[`tests/api-integration/api-key-sign-in.test.ts`](kaneo/tests/api-integration/api-key-sign-in.test.ts) 覆盖：

1. 开关未开启 → 404；
2. 未知 Key → 401，且 `session` 表为空；
3. 被禁用 / 已过期的 Key → 401；
4. 带 scope 的 Key → 403，且不产生会话；
5. 有效 Key → 302 + `Location: http://localhost:5173/dashboard` + `Referrer-Policy`/`Cache-Control`，并且用返回的 cookie 调 `/api/auth/get-session` 得到 Key 主人的 `user.id`；
6. 会话 cookie 无 `Max-Age`（会话级）；
7. `redirect=//evil.example.com` 回退 `/dashboard`，`redirect=/settings/account` 正常透传；
8. `API_KEY_SIGN_IN_ADMIN_ONLY=true` 时普通成员 403、实例管理员 302。

运行方式（需本机 PostgreSQL，集成测试会使用 `<库名>_test` 数据库）：

```bash
pnpm install
pnpm --filter @kaneo/api typecheck
pnpm --filter @kaneo/api test:integration -- api-key-sign-in
```

---

## 10. 本会话的验证状态（如实说明）

按用户要求**未执行编译与依赖安装**，因此：

- ❌ 未运行 `pnpm typecheck`；
- ❌ 未运行集成测试（另需 PostgreSQL，本机 5432 未监听）；
- ✅ 已针对**发布产物**核对本实现用到的每个 API（避免凭记忆写错类型）：
  - `createAuthEndpoint(path, { method: "GET", query })` 及 `ctx.query` / `ctx.setHeader` / `ctx.redirect` —— 见 better-call `1.3.7` 的 `EndpointContext` 定义与 `createInternalContext` 实现（`redirect` 把 `location` 写入同一个 `responseHeaders` 对象，因此抛出的 302 会同时带上 `Set-Cookie` 与自定义头；`toResponse` 对 `APIError` 使用 `init.headers` 优先级，确认头不会丢）；
  - `internalAdapter.createSession(userId, dontRememberMe?, override?, overrideAll?)`、`findUserById` —— 见 `@better-auth/core@1.6.26` 的 `InternalAdapter` 定义；`dontRememberMe=true` 时数据库会话按 1 天创建；
  - `setSessionCookie(ctx, session, dontRememberMe?, overrides?)` 且 `dontRememberMe=true` 时 `maxAge: undefined` —— 见 `better-auth@1.6.26` 的 `dist/cookies` 类型与 `src/cookies/index.ts`；
  - 上游 magic-link 插件正是「`createSession` → `setSessionCookie` → `throw ctx.redirect(...)`」这一模式，属于 better-auth 官方用法。
- ✅ 工作区状态：本会话为核对依赖曾启动 `pnpm install`，中途已中止并**已完整清理** `kaneo/node_modules`；工作区只保留第 6 节的代码与文档改动（`git status` 可见 4 个修改文件 + 2 个新增文件，无其它副作用）。

**结论**：功能代码已完成且逐条对照依赖实现核对；真正跑通前，请在具备 PostgreSQL 的环境执行第 9.2 节的 typecheck 与集成测试，再做一次第 9.1 节的线上验收。

---

## 11. 已知限制与可选增强

| 限制 | 可选增强 |
| --- | --- |
| Key 明文出现在 URL（历史/日志） | 换成一次性登录码：URL 只带 `code`，服务端存哈希、TTL ≤ 5 分钟、单次消费；用 `internalAdapter.reserveVerificationValue` / `consumeVerificationValue` 或独立表实现 |
| 完全跨站部署 cookie 不生效 | 将 API 与 Web 收敛到同一注册域；或把链接指向 API 域，由前端 `fetch(..., { credentials: "include" })` 兑换 |
| 扫描器预取导致空兑换 | 为兑换加 CSRF/一次性确认（例如链接指向一个只做 POST 的中转，或复用 `one-time-token` 插件） |
| 无法区分「谁用链接登录」 | 在端点内追加审计事件（`publishEvent`）记录 `apiKeyId`、IP、UA |
| 限流在自托管默认不生效 | better-auth 限流仅在 `KANEO_CLOUD=true` 时开启；自托管可在反向代理层按路径限速 |

---

## 附录 A：新增端点完整代码

```ts
// kaneo/apps/api/src/api-key-sign-in/index.ts
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { hasInstanceAdminRole } from "../utils/instance-admin-role";
import { verifyApiKey } from "../utils/verify-api-key";

const DEFAULT_REDIRECT = "/dashboard";

export function safeRedirectPath(value: unknown): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("//")
    ? value
    : DEFAULT_REDIRECT;
}

function isEnabled(name: string) {
  return process.env[name] === "true";
}

export const apiKeySignIn = () => ({
  id: "api-key-sign-in",
  endpoints: {
    signInWithApiKey: createAuthEndpoint(
      "/api-key/sign-in",
      {
        method: "GET",
        query: z.object({
          key: z.string().min(1),
          redirect: z.string().optional(),
        }),
      },
      async (ctx) => {
        if (!isEnabled("API_KEY_SIGN_IN")) {
          throw new APIError("NOT_FOUND");
        }

        const result = await verifyApiKey(ctx.query.key);
        if (result?.status !== "valid") {
          throw new APIError("UNAUTHORIZED", {
            code: "INVALID_API_KEY",
            message: "Invalid API key",
          });
        }

        if (result.key.permissions) {
          throw new APIError("FORBIDDEN", {
            code: "SCOPED_API_KEY_NOT_ALLOWED",
            message: "A key without permission scopes is required",
          });
        }

        const user = await ctx.context.internalAdapter.findUserById(
          result.key.userId,
        );
        if (!user) {
          throw new APIError("UNAUTHORIZED", {
            code: "INVALID_API_KEY",
            message: "Invalid API key",
          });
        }

        if (
          isEnabled("API_KEY_SIGN_IN_ADMIN_ONLY") &&
          !hasInstanceAdminRole(user.role)
        ) {
          throw new APIError("FORBIDDEN", {
            code: "INSTANCE_ADMIN_REQUIRED",
            message: "Only instance administrators may use sign-in links",
          });
        }

        const session = await ctx.context.internalAdapter.createSession(
          user.id,
          true,
        );
        await setSessionCookie(ctx, { session, user }, true);

        const clientUrl = (process.env.KANEO_CLIENT_URL || "").replace(
          /\/$/,
          "",
        );
        ctx.setHeader("Referrer-Policy", "no-referrer");
        ctx.setHeader("Cache-Control", "no-store");
        throw ctx.redirect(
          `${clientUrl}${safeRedirectPath(ctx.query.redirect)}`,
        );
      },
    ),
  },
  rateLimit: [
    {
      pathMatcher: (path: string) => path.startsWith("/api-key/sign-in"),
      window: 60,
      max: 10,
    },
  ],
});
```

## 附录 B：`auth.ts` 的两处改动

```diff
@@ apps/api/src/auth.ts
+import { apiKeySignIn } from "./api-key-sign-in";
 import {
   findBillableWorkspaces,
   formatBillableWorkspacesMessage,
 } from "./billing/controllers/find-billable-workspaces";
```

```diff
     adminPlugin({
       defaultRole: "user",
       adminRoles: ["admin"],
     }),
+    apiKeySignIn(),
     openAPI(),
```

## 附录 C：端点的实际运行语义（核对结论）

| 环节 | 结论 | 依据 |
| --- | --- | --- |
| 路由归属 | `/api/auth/api-key/sign-in` 由 better-auth 处理，跳过 Kaneo 的 `authenticateApiRequest` 中间件（因此链接无需任何请求头） | [index.ts:749-793](kaneo/apps/api/src/index.ts)；测试 `error-shape.test.ts` 中 `/api/auth/does-not-exist` 返回 better-auth 的 404 而非 401 |
| cookie 写入 | `setSessionCookie` 通过 `ctx.setSignedCookie` 追加到 `responseHeaders` | better-auth `src/cookies/index.ts` |
| 302 与 cookie 同时生效 | `ctx.redirect()` 把 `location` 写入同一 `responseHeaders` 后返回 `APIError("FOUND")`；`toResponse` 对 APIError 采用 `init.headers`（即同一份响应头） | better-call `src/context.ts`、`src/endpoint.ts`、`src/to-response.ts` |
| 会话有效期 | `dontRememberMe=true` → cookie 无 `Max-Age`；数据库会话 `expiresAt = now + 1 天` | better-auth `src/cookies/index.ts`、`src/db/internal-adapter.ts` |
| 响应透传 | 302 不被 Kaneo 的 404/429 包装器改写 | [not-found-response.ts:11](kaneo/apps/api/src/errors/not-found-response.ts)、[rate-limit-response.ts:19](kaneo/apps/api/src/errors/rate-limit-response.ts) |
