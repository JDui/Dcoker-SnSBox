# SnSBox HTTP API v1

状态：2026-11-15 后端/前端并行实现契约。JSON 字段采用 camelCase；API 前缀 `/api/v1`。所有 ID 是字符串。数组返回 `{ "items": [...], "nextCursor": null }`；分页 cursor 为不透明字符串。错误统一 `{ "error": { "code": "...", "message": "..." } }`。未配置上游时返回真实空列表和账号阻塞原因，不自动填充演示消息。

## 管理员会话

- `GET /health`：无鉴权，进程健康 `{ "status": "ok" }`。
- `GET /api/v1/session`：无会话返回 401；成功 `{ "authenticated": true, "csrfToken": "..." }`。
- `POST /api/v1/session`，JSON `{ "password": "..." }`：设置 HttpOnly SameSite=Strict cookie，返回上面的会话对象。密码由部署 secret 提供。前端不得保存密码。
- `DELETE /api/v1/session`：登出 SnSBox。登录后的所有 POST/PUT/PATCH/DELETE 请求必须带 `X-CSRF-Token`。所有 API 同源，禁止跨域访问。登录接口需 JSON，校验 Origin（存在时）。

## 账号与能力

- `GET /api/v1/accounts`
- `GET /api/v1/accounts/{accountId}`
- `POST /api/v1/accounts/{accountId}/login`，`{}`：请求上游登录；返回 `{ "state": "pending|blocked|accepted", "message": "...", "loginUrl": null, "qrCode": null }`。pending 必须提示用户到上游受保护管理界面继续；不能显示登录成功。二维码没有安全接入时不下发。
- `POST /api/v1/accounts/{accountId}/logout`，`{}`：上游不支持远程注销时返回 422 `unsupported`，保留记录与凭据。
- `POST /api/v1/accounts/{accountId}/sync`，`{}`：主动拉取上游会话及最近历史，返回 `{ "synced": true, "message": "..." }`；错误不会伪装成功。后台也定期同步。

账号对象：

```json
{
  "id": "wechat-main", "platform": "wechat", "displayName": "微信",
  "status": "unconfigured", "statusMessage": "尚未配置上游接口",
  "adapter": "agent-wechat", "upstreamConfigured": false,
  "capabilities": {
    "text": { "status": "unavailable", "reason": "尚未配置上游" },
    "image": { "status": "unverified", "reason": "接口已实现，真实账号未验收" }
  },
  "historyScope": "SnSBox 已同步的本地历史；不保证全设备完整记录",
  "mailUrl": null
}
```

platform: `wechat|qq`；status: `unconfigured|connecting|online|offline|error`。capabilities 固定键 `login,logout,text,image,video,file,sticker,miniApp,history,realtime,mail`，每项 `{status,reason}`；status: `supported|unsupported|unverified|unavailable`。unverified 可发起人工验证；unsupported/unavailable 应禁用。`online` 表示上游报告有效登录/连接状态，不等于发送或真实账号验收。QQ mailUrl 固定 `https://mail.qq.com/`，独立网页入口，无邮箱授权联动。

## 会话、历史和搜索

- `GET /api/v1/conversations?accountId=...&query=...&cursor=...&limit=50`
- `GET /api/v1/conversations/{conversationId}/messages?cursor=...&limit=50&query=...`
- `GET /api/v1/messages?query=...&accountId=...&cursor=...&limit=50`：搜索本地已同步历史。
- `POST /api/v1/conversations/{conversationId}/read`，`{}`：仅清除 SnSBox 本地未读。

会话对象：`{ id, accountId, platform, upstreamId, title, kind: "direct|group", unreadCount, lastMessage: string|null, lastMessageAt: string|null, avatarUrl: null }`。消息列表按时间从新到旧分页；前端渲染时反转为聊天顺序。

消息对象：

```json
{
  "id": "...", "conversationId": "...", "accountId": "...", "platform": "wechat",
  "upstreamId": "...", "senderId": "...", "senderName": "...",
  "direction": "incoming", "timestamp": "2026-11-15T12:00:00Z",
  "segments": [{ "type": "text", "text": "内容" }],
  "status": "received", "error": null
}
```

segment：`text {text}`；`image|video|file|sticker|audio {mediaId?,url?,name?,mimeType?,unavailableReason?}`；`link|miniApp {title?,url?,text?}`；`unknown {text}`。只渲染文字和安全 http(s) 链接，不插入上游 HTML/XML。媒体 `url` 始终是 `/api/v1/media/{id}`：首次读取可能从已配置上游安全缓存，也可能返回 422（上游未下载、过期、不支持、超过上限）；前端需提供加载失败提示。未提供地址的媒体返回 unavailableReason。小程序卡片保留可读提示；没有安全 URL 时不能启动。收到无法映射的类型保留 unknown 提示。来源缺失的时间/发送者/方向可能是 null，UI 使用未知提示，不假造时间与身份。

## 发送与附件

- `POST /api/v1/conversations/{conversationId}/messages`，必须带 `Idempotency-Key`（建议每次用户发送生成一个 UUID，同一请求重试复用），JSON `{ "segments": [...] }`。返回 HTTP 202 消息对象。仅允许 text 或单个已上传的 image/video/file/sticker 段。链接可作为 text 发送；任意 URL/本地文件路径不允许用作媒体发送来源。
- `POST /api/v1/media?accountId=...&name=photo.jpg`：原始二进制 body，Content-Type 设为媒体 MIME，最大 32 MiB，返回 `{ "id": "...", "url": "/api/v1/media/...", "name": "...", "mimeType": "...", "size": 123 }`。Cookie+CSRF 鉴权；媒体归属账号必须匹配发送会话。
- `GET /api/v1/media/{id}`：鉴权后读取 SnSBox 自有附件或账号范围内的上游已知附件并缓存；支持单 Range。微信只能读取上游 available 缓存，不在 GET 中发起远端下载任务；QQ 限制 CDN 域、公网解析和重定向。不能任意读取官方资料目录或任意 URL。非图片/视频/音频以下载方式返回，所有响应 nosniff。

发送状态 `queued|submitting|accepted|failed|uncertain`；收到消息 `received`。accepted 表示上游接受，不是送达/已读。网络超时或崩溃导致的 uncertain 不自动重发。相同幂等键不同请求返回 409；重放原请求返回原持久化消息对象（不会重复提交）。查询消息列表可看到状态变化。客户端不得将 HTTP 202 当成发送成功。

## 事件与资料检查

- `GET /api/v1/events?after=0`：Cookie 鉴权 SSE；标准 `id` 为持久化递增数字，`event: update`，data `{ "kind": "message|account|conversation", "accountId": "...", "conversationId": "..." }`。前端收事件后刷新相关查询；重连使用 Last-Event-ID，优先于 after。不设置事件保留期限；进程重启可重放。事件最多保留在当前自有数据库生命周期内，不含消息正文或令牌。
- `GET /api/v1/system`：`{ "version": "0.1.0", "dataPolicy": "...", "legacyConfig": { "configured": false, "readOnly": true, "entries": [{ "path": ".xwechat", "present": true, "purpose": "..." }], "message": "..." } }`。只检查固定目录存在性，不读取令牌或消息、不自动导入；SnSBox 数据必须独立于旧 config。目录存在不等于解密/收发兼容。

账号由服务端 `SNSBOX_ACCOUNTS_FILE` 指定 JSON 配置。前端不持有、不提交、不显示上游 Bearer token。首次启动默认两个 unconfigured 账号用于引导配置，空状态必须说明“尚未接入”。
