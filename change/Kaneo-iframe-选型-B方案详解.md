# Kaneo iframe 嵌入 · 选型 B 方案详解

- 日期：2026-10-15
- 适用场景：**父面板只能放在 `http://127.0.0.1:3080`**、Kaneo 部署在 `https://pl.feg.cn`、iframe 内要直接完成 API Key 登录
- 目标：**最少改动**让 Chrome 内可用；不覆盖 Safari/Firefox
- 状态：**仅设计与规格，不含任何代码改动**

---

## 1. 一句话原理

把会话 cookie 强制为 `SameSite=None; Secure; Partitioned`（CHIPS），让 Chrome 在第三方 iframe 上下文里仍能写入并发送它；Safari/Firefox 不认 CHIPS，因此**这个方案只救 Chrome**。

---

## 2. 为什么是它

实测现在的 cookie 属性（2026-10-15，命令 `POST /api/auth/sign-out`）：

```
set-cookie: __Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax
```

- `Secure` ✅（pl.feg.cn 是 HTTPS）
- `SameSite=Lax` ❌：在 `http://127.0.0.1:3080` 的 iframe 里 → **既不被写入也不被发送**（Chrome 80+ 起 Lax cookie 在 cross-site 子资源/iframe 上下文中拒收）
- 没有 `Partitioned` ❌：缺了第三方 cookie 在 Chrome 里活下来的关键标记
- `domain` 未设 ✅

`apps/api/src/utils/get-default-cookie-attributes.ts` 的现有规则只在 `apiHost !== clientHost && both !== localhost && isHttps` 时才自动给 `None+Secure+Partitioned`。本场景 apiHost=clientHost=`pl.feg.cn`，自动规则落到 `Lax` —— 所以需要显式开关。

---

## 3. 具体改动

### 3.1 后端：cookie 属性计算（核心，约 5 行）

`apps/api/src/utils/get-default-cookie-attributes.ts`，在 `getDefaultCookieAttributes` 返回前加：

```ts
const forceCrossSite = process.env.KANEO_COOKIE_SAMESITE === "none";
return {
  sameSite: forceCrossSite
    ? "none"
    : isCrossSubdomain && isHttps
    ? "none"
    : "lax",
  secure: forceCrossSite ? true : isHttps,
  partitioned: forceCrossSite
    ? true
    : isCrossSubdomain && isHttps,
  domain: cookieDomain || undefined,
};
```

要点：

- 开关 `KANEO_COOKIE_SAMESITE=none` 打开后**强制覆盖**自动判断；`None` 必须配 `Secure`（`SameSite=None` 不带 `Secure` 会被所有浏览器拒绝）。
- `domain` 维持现有逻辑（`COOKIE_DOMAIN` env 显式传入才会设）。本场景 pl.feg.cn 是同一 host，不需要 domain。
- 改动只影响 `getDefaultCookieAttributes` 算出来的会话 token / session_data / dont_remember 三条 cookie 全部一致。

`apps/api/src/auth.ts` 不用改（已经 `enableSessionForAPIKeys: true`，`createSession(user.id, true)` 传了 dontRememberMe 走 `setSessionCookie`）。

### 3.2 环境变量（部署 `.env` + `apps/api/.env.sample`）

```bash
# 在 iframe 嵌入场景下强制使用分区 cookie（CHIPS）
# 警告：仅 Chrome 有效；Safari/Firefox 仍会屏蔽 iframe 内的第三方 cookie
KANEO_COOKIE_SAMESITE=none
```

`apps/api/.env.sample` 在 `Access policy` 段下加这一行带注释，参考之前 `API_KEY_SIGN_IN` 的格式。

> 顺手加一条防御日志（可选）：如果 `KANEO_COOKIE_SAMESITE=none` 但 `isHttps` 为 false，启动时 `console.warn`，提示非 HTTPS 下这条配置无效。

### 3.3 安全收口（无论 B/C 都要做，建议同 PR）

外层 openresty（[nginx.kaneo.conf](kaneo/apps/web/nginx.kaneo.conf) 内的 `X-Frame-Options: SAMEORIGIN` 也应该一并改）：

```nginx
# 用 CSP frame-ancestors 替代裸删的 XFO
add_header Content-Security-Policy "frame-ancestors 'self' http://127.0.0.1:3080" always;
# 不要同时再 add_header X-Frame-Options（XFO 不支持多源；与 CSP 并存时浏览器取更严者）
```

CORS：iframe 内是同源请求，**B 方案下不需要改 `CORS_ORIGINS`**。只有将来父页面要直连 API（譬如升级到 C）才需要把 `http://127.0.0.1:3080` 加进去。

### 3.4 什么**不**动

为了体现"最少改动"：

- 不动 `auth.ts`、`api-key-sign-in/index.ts`
- 不动 `authenticate-api-request.ts`（B 仍然走 cookie 路径）
- 不动 WebSocket（cookie 在 iframe 里有效后 WS 也跟着有效）
- 不动 `packages/libs/hono.ts`、`apps/web/src/lib/auth-client.ts`（前端代码 0 改动）
- 不动 nginx cookie 相关配置
- 不动数据库 schema

---

## 4. 验证（5 分钟）

### 4.1 服务端：用上次同样的"借 sign-out 探 cookie"招数

```powershell
C:\Windows\System32\curl.exe -sS -D - -o NUL -X POST https://pl.feg.cn/api/auth/sign-out -H "content-type: application/json" -d '{}'
```

期望（**核心判读**）：

```
set-cookie: __Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None; Partitioned
set-cookie: __Secure-better-auth.session_data=…  SameSite=None; Partitioned
set-cookie: __Secure-better-auth.dont_remember=…  SameSite=None; Partitioned
```

只要 `Lax` 变成 `None`、多了 `Partitioned`，B 就生效了。

### 4.2 浏览器端

在父页面 `http://127.0.0.1:3080` 的某个页面里嵌一个 `<iframe src="https://pl.feg.cn/dashboard">`：

1. **F12 → Application → Cookies → 选 `pl.feg.cn`**：登录链接执行后应能看到 `__Secure-better-auth.session_token`，属性里 `SameSite=None` + `Partitioned` ✓
2. **Network → 过滤 `get-session`**：请求头应带 `Cookie: __Secure-better-auth.session_token=…`（之前不带）
3. 登录成功后跳到看板，能正常打开项目、看实时更新（WS 也能拿到 cookie）
4. 用 Chrome DevTools 的"Network conditions → Cookie-disabled"复测一次：彻底禁用 cookie 后 iframe 应回到登不上 —— 用以证明它**确实**靠的是 cookie

### 4.3 其它浏览器（预期失败，作为代价记录）

| 浏览器 | 期望 |
| --- | --- |
| Chrome | ✅ 正常 |
| Edge | ✅ 与 Chrome 同源（Chromium） |
| Firefox | ❌ iframe 内仍是登不上，DevTools 报"cookie blocked because the request was cross-site" |
| Safari | ❌ 同 Firefox，3P cookie 被 ITP 屏蔽 |
| DSH GUI 内部嵌入（`http://127.0.0.1:3080` → iframe → `https://pl.feg.cn`） | Chrome/Edge ✅；Firefox/Safari ❌ |

需要在文档里**明确写明**这层代价，避免后续误以为是 bug。

---

## 5. 风险与边界

1. **CHIPS 的 partition key 是顶层站点**。`http://127.0.0.1:3080` 与 `https://pl.feg.cn` 是不同 site：分区 cookie 在该顶层下的所有 iframe 子请求里能命中，**但换一个不同的父页面就会换一套分区**（互不共享）。这是 by design。
2. **父页面用 `<iframe sandbox>`** 时：必须保留 `allow-scripts` 与 `allow-same-origin`；少了后者会让 origin 变 opaque，CHIPS 分区键失效。
3. **混内容方向**：父 `http://` + 子 `https://` → 浏览器允许（这是 Chrome 允许的"upgrade"方向）。反过来不行。父 3080 是 http、子 pl.feg.cn 是 https → 允许 ✓。
4. **`SameSite=None` 必须配 `Secure`**。`get-default-cookie-attributes.ts` 在 pl.feg.cn 上 `isHttps` 已经是 true；如果你将来在 HTTP 上误开此开关，浏览器会**完全拒收**该 cookie，登录不会更坏、只是没用。建议加启动 warn。
5. **第三方 cookie 反作弊告警**：B 方案下 `pl.feg.cn` 的 cookie 在父 `127.0.0.1:3080` 的页面上是"第三方 cookie"。父页面若加载了某些 cookie consent 拦截器、隐私插件或企业网关 → 仍可能阻断。CHIPS 不被这些通用 3P 拦截影响，但专门的 3P 拦截工具会。
6. **API key 链接在 iframe 里的导航行为**：登录链接的 302 跳转在 iframe 文档内是 top-level 导航（在 iframe 里"顶端"就是 iframe 文档），Chrome 把这视同 first-party navigation → 允许写入。即使 3P 拦截器想拦，因为是 navigation 行为 cookie 也通常通过。
7. **CORS 不动**：iframe 内是同源请求，浏览器不放 CORS 预检。若你后面要父页面**直接**调 API 才需要 CORS。

---

## 6. 回滚

回滚是 B 的最大优点之一：

1. **临时关停**（推荐先这步）：`KANEO_COOKIE_SAMESITE=` 留空或设为 `lax`，重 API 进程 → 立刻回到原 `Lax` 行为，iframe 仍登不上但其它流程不变。
2. **彻底回退**：把 `get-default-cookie-attributes.ts` 的 `forceCrossSite` 分支删掉即可（diff 干净）。
3. **不影响**：数据库、API 协议、cookie 之外的配置都不会动到。

---

## 7. 与 A/C 的关系 & 升级路径

| 阶段 | 方案 | 父页面要求 | 浏览器覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| 当前探测后 | **B** | `127.0.0.1:3080`（锁） | Chrome/Edge | 推荐"最少改动" |
| 若父可放到 `*.feg.cn` 同 scheme HTTPS | A（不写代码） | 同 site | 全 | 理想终态 |
| 若要全浏览器且必须 `127.0.0.1:3080` | C（Bearer 免 cookie） | 任意 | 全 | 长期目标 |

B → C 升级时，`KANEO_COOKIE_SAMESITE=none` 关闭（变回 Lax），同时上线 C 的端点 + 前端 token 持有 + WS `?token=`，互不耦合。**两种方案可以共存**：常规用户走 cookie 登录、iframe 走 token 登录。

---

## 8. 改动清单（按文件/行）

| 位置 | 改动 | 行数 |
| --- | --- | --- |
| `apps/api/src/utils/get-default-cookie-attributes.ts` | 加 `forceCrossSite` 分支 | +6 |
| `apps/api/.env.sample` | `Access policy` 段下加 `KANEO_COOKIE_SAMESITE=` 注释行 | +2 |
| 外层 openresty 配置（部署侧） | 替换 `proxy_hide_header X-Frame-Options` 为 `add_header Content-Security-Policy "frame-ancestors …"` | -1 +1 |
| 文档 `Kaneo-iframe-嵌入-选型建议.md` 或 `authentication.mdx` | 补一段 B 的说明、Chrome-only 限制、rollout | 文本 |

合计：后端 8 行，文档若干字，外层 nginx 一行替换。

---

## 9. 排程 & 风险

- 单文件改动 + 一次重启 API，**回滚只需反置 env** → 5 分钟内可恢复。
- 风险 = Chrome 改 cookie 行为带来的兼容性测试（少量），以及 Chrome 团队未来对 CHIPS 的政策微调（目前稳定，已标准化为 Partitioned 属性）。
- 建议的部署顺序：先在 `staging.pl.feg.cn`（或等价预发）开 → 内部 Chrome 浏览器自测登录 + WS → 全员用 Chrome 跑一周 → 再开 prod。期间 Safari/Firefox 用户从 iframe 回到 `https://pl.feg.cn` 顶层 tab 登录（已有 cookie 后 iframe 内的请求仍可能不带 cookie，但顶层有即可看仪表盘）。
