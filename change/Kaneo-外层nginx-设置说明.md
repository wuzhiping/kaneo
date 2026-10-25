# Kaneo · 最外层 nginx 设置说明

> 适用：浏览器 → **最外层 nginx**（即你维护的前置反代；本例为 openresty/1.19.9.1）→ Kaneo 容器（web 5173 / api 1337）。Kaneo 部署在 `https://pl.feg.cn`，父面板在 `http://127.0.0.1:3080`。

---

## 1. 你需要做的事情（总览）

| # | 位置 | 改动 | 目的 |
|---|---|---|---|
| 1 | 最外层 nginx 配置 | `proxy_hide_header Content-Security-Policy;` + `add_header CSP frame-ancestors …; always` | 让浏览器允许父页面 iframe 嵌入 pl.feg.cn |
| 2 | Kaneo API `.env` | `KANEO_COOKIE_SAMESITE=none` | 让会话 cookie 走 `None+Secure+Partitioned`（CHIPS）→ Chrome 在跨站 iframe 里能保存与发送 |
| 3 | Kaneo API `.env`（可选） | `API_KEY_SIGN_IN=true` | 启用 API Key 登录链接（如果你也想用这个） |
| 4 | Kaneo API `.env`（可选） | `API_KEY_SIGN_IN_ADMIN_ONLY=true` | 把 API Key 登录限制在实例管理员 |
| 5 | Kaneo API `.env` | `KANEO_CLIENT_URL=https://pl.feg.cn` | 必须与浏览器实际访问的 Web 地址一致（既有变量，没动） |

下面的内容假设你只关心"iframe 能用 + 登录能进"这一条最短路径；其它 env 沿用现状。

---

## 2. 最外层 nginx 改动

### 2.1 复制粘贴即可

**关键**：必须**先** `proxy_hide_header Content-Security-Policy;`，**再** `add_header Content-Security-Policy …`。否则两条 CSP 会被浏览器取**交集**（CSP3 规范），反而把父源排除。

```nginx
# /etc/nginx/conf.d/kaneo.conf  （或你的 server 块内）

# 1. 隐藏容器内 nginx 自带的 frame-ancestors 'self'（避免与下面的外层 CSP 取交集）
proxy_hide_header Content-Security-Policy;

# 2. 注入允许父源嵌入的 CSP；多个父源用空格分隔；always 让所有响应都带
add_header Content-Security-Policy "frame-ancestors 'self' http://127.0.0.1:3080" always;

# 3. B 方案后容器已不再发 X-Frame-Options；这行保留无害（防御性）
proxy_hide_header X-Frame-Options;
```

### 2.2 放在哪个上下文里

nginx 的 `add_header` 继承规则：

- 写在 `server { }` 块 → 该 server 下所有 location 都继承
- 写在 `location / { }` 块 → 只影响该 location

最干净是放在**转发到 pl.feg.cn 静态 web（5173）**的 location 块里（或更简单：直接放在该 server 块顶层）。**不要**放在转发到 `/api/` 的 location 块里——CSP `frame-ancestors` 对 JSON 响应无意义，但加了也无害，只是浪费字节。

完整模板（如果你的 server 块之前只有 `proxy_pass`，这是最简形态）：

```nginx
server {
    listen 443 ssl;
    server_name pl.feg.cn;

    # ... 你的 ssl_certificate 等配置（保持原样）...

    # === B 方案：iframe 嵌入 ===
    proxy_hide_header Content-Security-Policy;
    add_header Content-Security-Policy "frame-ancestors 'self' http://127.0.0.1:3080" always;
    proxy_hide_header X-Frame-Options;

    # === HTML 静态 web 反代（Kaneo 内置 nginx @ :5173）===
    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # === API 反代（Kaneo 内置 api @ :1337）===
    location /api/ {
        proxy_pass http://127.0.0.1:1337/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 2.3 应用与回滚

```bash
nginx -t && nginx -s reload
```

回滚：把这三行注释掉或加 `# ` 前缀 → `nginx -s reload` → 立刻回到当前状态（无 framing 限制头，Chrome 仍登不上）。

---

## 3. Kaneo API `.env` 改动

编辑 Kaneo API 容器的环境变量（`compose.yml` 的 `environment:`、Coolify 面板、或 `apps/api/.env` 取决于你的部署方式）：

```bash
# B 方案：跨站 iframe cookie
KANEO_COOKIE_SAMESITE=none

# API Key 登录（可选）
API_KEY_SIGN_IN=true
# API_KEY_SIGN_IN_ADMIN_ONLY=true    # 如果只允许实例管理员用

# 既有，必须与浏览器访问的 Web 地址一致
KANEO_CLIENT_URL=https://pl.feg.cn
```

然后重启 API 让 env 生效（`docker compose restart api` 或 Coolify redeploy）。

---

## 4. 验证（3 条命令，1 分钟）

```powershell
# ① 框架头：应该看到一条 CSP，无 X-Frame-Options
C:\Windows\System32\curl.exe -sSI https://pl.feg.cn/ | Select-String -Pattern 'content-security|frame-options'
# 期望: content-security-policy: frame-ancestors 'self' http://127.0.0.1:3080
#        （没有 x-frame-options 那一行）

# ② B 方案 cookie：SameSite=None + Partitioned
C:\Windows\System32\curl.exe -sS -D - -o NUL -X POST https://pl.feg.cn/api/auth/sign-out -H "content-type: application/json" -d '{}' | Select-String set-cookie
# 期望: set-cookie: __Secure-better-auth.session_token=…; Path=/; HttpOnly; Secure; SameSite=None; Partitioned

# ③ API Key 端点：401 表示端点已部署并启用
C:\Windows\System32\curl.exe -sS -o NUL -w '%{http_code}\n' "https://pl.feg.cn/api/auth/api-key/sign-in?key=invalid"
# 期望: 401
```

浏览器侧：父页面 `http://127.0.0.1:3080` 嵌 `<iframe src="https://pl.feg.cn/dashboard">` → Chrome/Edge 内 F12 → Network → `get-session` 应带 `Cookie: __Secure-better-auth.session_token=…` → 看到看板内容（之前没这条 Cookie，所以一直停在登录页）。

---

## 5. 常见坑（一旦没生效就回来查这里）

### 5.1 CSP 交集陷阱

如果外层 nginx 写了 `add_header CSP` 但**漏掉** `proxy_hide_header Content-Security-Policy;`，浏览器会收到两条 CSP：

- 容器内：`frame-ancestors 'self'`（即 pl.feg.cn）
- 外层：`frame-ancestors 'self' http://127.0.0.1:3080`

按 CSP3 规范，多条策略对 `frame-ancestors` 取**交集** = {pl.feg.cn}，父源 `127.0.0.1:3080` 反而被拒。**症状：iframe 在 Chrome 下仍然 "Refused to frame"，但 DevTools Network → `get-session` 之前能看到状态码 200 + 文档成功返回**。  → **必须隐藏容器那条**。

### 5.2 `always` 漏了

`add_header` 在 server/location 块里**默认只对 200/201/204/206/301/302/303/304/307/308 响应生效**。HTML 入口是 200，没问题；但若任何中间层返回了非这些状态码（例如 5xx 错误页），CSP 头就会丢。**统一加 `always`**。无副作用。

### 5.3 `proxy_hide_header` 与 `proxy_pass` 的位置

`proxy_hide_header` 必须在对应的 `proxy_pass` 之后（或同一 location 块）。如果放错位置不会报错但无效。建议**放在 server 块顶层**（影响所有 location），或者**与 `proxy_pass` 同 location**。

### 5.4 父页面用 `<iframe sandbox="…">`

如果父页面（`127.0.0.1:3080`）用了 `sandbox` 属性，**必须保留 `allow-same-origin allow-scripts`**。少了 `allow-same-origin`，iframe 的 origin 变成 opaque/null，CHIPS 分区键失效，Chrome 会再次丢弃第三方 cookie。

### 5.5 父页面是 `http://`、Kaneo 是 `https://` —— 混内容方向

浏览器允许 "upgrade" 方向（http 父 → https 子），所以**本场景不混内容**。反过来不行（https 父 → http 子会被浏览器直接拦）。

### 5.6 `SameSite=None` 必须配 `Secure`

`KANEO_COOKIE_SAMESITE=none` 开启时，如果 API 是 HTTP（非 HTTPS），浏览器**直接拒收**该 cookie，且后端会 `console.warn`：
> [cookies] KANEO_COOKIE_SAMESITE=none is set but the API is not served over HTTPS. SameSite=None requires Secure; browsers will reject the cookie. Use HTTPS or unset the env var.

pl.feg.cn 是 HTTPS，没问题。若以后迁回 HTTP，先关 env。

### 5.7 CORS（不影响 B 方案）

iframe 内的请求是同源（pl.feg.cn → pl.feg.cn/api），**不触发 CORS**。只有当父页面**直连** API（例如做 Bearer 方案的 postMessage 握手）才需要把 `http://127.0.0.1:3080` 加进 `CORS_ORIGINS`。当前 B 方案不需要。

---

## 6. 与其它变更的关系

- **`kaneo-changes-2026-10-15.zip`**（48 KB，本工作区全量变更包）已含本说明涉及的所有代码改动：cookie 属性、API Key 登录、文档、内置 nginx 的 CSP frame-ancestors。
- **`nginx-outer-frame-ancestors.conf`**（10.8 KB）只含**外层** nginx 的 3 行有效配置。
- **`Kaneo-iframe-选型-B方案详解.md`** 是 B 方案的设计说明（含风险、边界、与 A/C 的关系）。
- **`Kaneo-iframe-选型建议.md`** 是三方案（A/B/C）的总览与选型决策。

部署顺序推荐：先在外层 nginx 临时注释掉那 3 行，只配 env → 看 Chrome 是否能进 → 出现 iframe 加载失败再放回 nginx 配置。这样能定位是哪一段没生效。
