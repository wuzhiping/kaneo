# Kaneo iframe 嵌入：选型建议书

- 日期：2026-10-15
- 目标服务：`https://pl.feg.cn`（自托管、同源部署、HTTPS、外层 openresty）
- 触发场景：Kaneo 页面被 iframe 嵌入到**别的站点**（例：`http://127.0.0.1:3080`），API Key 登录链接在 iframe 内不生效
- 状态：**仅选型，不含任何代码改动**

---

## 1. 实测证据（本次探测得出）

| 探测项 | 实测结果 | 含义 |
| --- | --- | --- |
| `GET https://pl.feg.cn/` | 200，**无 `X-Frame-Options`**、**无 CSP** | 框架限制已由外层 `proxy_hide_header` 解除；⚠️ 同时变成"任何站点都能嵌" |
| `POST /api/auth/sign-out`（探 cookie 属性） | `set-cookie: __Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`（`session_data`、`dont_remember` 同） | 会话 cookie = **`Secure; SameSite=Lax`，无 `Partitioned`，无 `Domain`** |
| `GET /api/auth/api-key/sign-in?key=invalid` | 401 | 新端点已部署且 `API_KEY_SIGN_IN=true` |
| `GET /api/auth/api-key/sign-in`（无 key） | 400 | zod 校验链正常 |
| `GET /api/auth/does-not-exist` | 404 | 基线正常，排除误判 |
| `Origin: http://127.0.0.1:3080` 的 GET / OPTIONS 预检 | 有 `access-control-allow-credentials: true`，**无 `access-control-allow-origin`** | 父页面**直连** API 会被浏览器 CORS 拦（iframe 内的同源请求不受影响） |
| `GET /api/config` | `isCloud:false, hasSmtp:false, hasGuestAccess:false, disableRegistration:true` | 非 cloud → better-auth 限流未启用；无 SMTP → 魔术链接不可用 |

## 2. 根因（为什么 iframe 内登不上）

iframe 的文档是 `https://pl.feg.cn`，但**顶层站点是嵌入方**（例：`127.0.0.1:3080`），因此对 `pl.feg.cn` 而言这是 **cross-site 上下文**：

1. 点击登录链接时请求带 `Sec-Fetch-Site: cross-site`、`Sec-Fetch-Dest: iframe` → 浏览器**拒绝写入 `SameSite=Lax` 的 cookie**（Chrome/Firefox/Safari 均如此）；
2. 即便先在顶层标签页登录、cookie 已存在（第一方），跨站 iframe 内的请求也**不会携带** `Lax` cookie；
3. 结果：iframe 内 `/api/auth/get-session` 恒为 `null` → 停在登录页；
4. 另需注意 **schemeful same-site**：`http://` 父页面 嵌 `https://` 子页面，即便同注册域也算 cross-site。

**结论：只要嵌入方与 Kaneo 不同 site，"`SameSite=Lax` cookie"这条路就是无解，与业务代码无关。**

## 3. 三条路线对比

| 维度 | A. 同 site（域名对齐） | B. 分区 cookie（CHIPS） | C. 免 cookie Bearer |
| --- | --- | --- | --- |
| 做法 | 嵌入方用 `*.feg.cn` 域 + HTTPS，与 `pl.feg.cn` 同 site 同 scheme | cookie 强制 `SameSite=None; Secure; Partitioned` | 用 API Key 换 session token，走 `Authorization: Bearer`；token 经 `#fragment`/`postMessage` 传入 |
| 代码改动 | **0** | 小：`get-default-cookie-attributes.ts` 加开关（约 5 行）+ env | 中：后端 1 个换票端点；前端 3 处（token 获取、auth client、API 客户端）；WebSocket 加 `?token=` |
| 浏览器覆盖 | Chrome / Safari / Firefox **全部** | **仅 Chrome**（Safari/Firefox 不认 CHIPS，且默认全屏蔽第三方 cookie） | **全部**（包括 Safari ITP、Chrome 3P 淘汰后） |
| 前提 | 嵌入方域名可控、能上 HTTPS | API 已 HTTPS（已满足）；用户只用 Chrome 系 | 无需任何 cookie 前提 |
| CORS | 不需要（iframe 内同源） | 不需要 | 需要把嵌入方 origin 加入 `CORS_ORIGINS`（当前实测不含） |
| 实时更新(WS) | 正常 | 正常 | 需补 `?token=`，否则 iframe 内无实时更新 |
| 风险 | 需自评同 site 下的 XS-Leak 面 | 浏览器策略收紧后随时失效，属过渡方案 | 改动最大，但一次到位 |
| 适用 | 嵌入方数量可控（自有面板/内部系统） | 短期、仅 Chrome 用户 | 任意第三方嵌入，或要长期稳定 |

## 4. 推荐与触发条件

**主选：A** —— 前提是"嵌入方域名可控"。
- 生产：把嵌入面板放到 `https://dsh.feg.cn` 之类，与 `https://pl.feg.cn` 同 site 同 scheme → cookie、CORS、WebSocket **全都不用改**，三种浏览器都稳。
- 本地自测：让父页面与 Kaneo 都在 `127.0.0.1`（或都在 `localhost`）+ 同为 http。注意 `localhost` 与 `127.0.0.1` 是**两个不同 site**，不可混用。
- 若坚持"用本地 `127.0.0.1:3080` 的 GUI 去嵌线上的 `https://pl.feg.cn`"：A 不会自动成立（IP 无法做子域 + scheme 不同）。变通办法是给本机加 hosts 解析（如 `127.0.0.1 dsh.feg.cn`）并把本地 GUI 也跑成 **https**，使顶层站点变成 `https://dsh.feg.cn`。

**若嵌入方不可控 / 必须支持任意第三方：选 C。**
- 只有 C 不依赖第三方 cookie；B 会随浏览器策略波动，Safari/Firefox 用户直接不可用。
- 建议 C 与现有 API Key 链接复用同一套兑换逻辑：把"校验 Key → 建会话"改为**返回 session token**（JSON），cookie 只是其中一种投递方式。

**B 的定位：过渡/兜底。** 若短期内只有 Chrome 用户且急着要，B 是最小改动版本；但要在文档里写明"Chrome only，后续迁 C"。

**无论选哪个，先做安全收口（见第 6 节）**，因为当前 XFO 被整体移除后没有任何 framing 限制。

## 5. 待确认（决定选型的三问）

1. **嵌入方是谁、域名能不能改？** 能否给它一个 `*.feg.cn` 域名并上 HTTPS → 决定 A 是否成立。
2. **必须支持哪些浏览器？** 若只要求 Chrome/Electron → B 可接受；否则只有 C。
3. **将来是否要开放给更多第三方/客户嵌入？** 若是，直接上 C，避免走 B→C 的二次迁移。

## 6. 无论选哪条都要做的安全收口

1. **把裸删的 XFO 换成白名单**（否则任何站点都能嵌 + 点击劫持）：
   ```nginx
   # 外层 nginx
   add_header Content-Security-Policy "frame-ancestors 'self' https://dsh.feg.cn" always;
   # 不要再 add_header X-Frame-Options（XFO 不支持多源，且与 CSP 并存时取更严者）
   ```
2. **CORS 只在需要父页面直连 API 时放开**（选 C 时必需）：
   `CORS_ORIGINS=https://pl.feg.cn,https://dsh.feg.cn`
3. **收尾核对**：`/api/config` 显示 `isCloud:false` → better-auth 限流未启用，登录链接的插件限流规则实际不生效；如需防护，在外层 nginx 对该路径限速。

## 7. 选定后的执行清单（本次不做）

- 选 A：给嵌入方域名 + HTTPS，改一条 nginx `frame-ancestors`；Kaneo 侧零改动；用 "iframe 内打开 API Key 链接 → 落到看板且已登录" 验收。
- 选 B：改 `apps/api/src/utils/get-default-cookie-attributes.ts` 加 `KANEO_COOKIE_SAMESITE=none` 开关；`apps/api/src/auth.ts` 无需改；文档补 Chrome-only 说明；验收同上，并加一条"`set-cookie` 含 `Partitioned`"的检查。
- 选 C：新增 `POST /api/auth/api-key/session`（返回 token，不写 cookie）→ 前端从 `#fragment`/`postMessage` 取 token 并注入 auth client 与 API 客户端 → WebSocket 支持 `?token=` → 验收含"无 cookie 情况下 get-session/WS 均正常"。
