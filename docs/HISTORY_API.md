# 只读既有历史：接口与接线

状态：2026-11-17 增加 QQ 独立 JSON 导入；已实现读取器、独立索引与网页。当前真实 WS 消息尚未读取，不将目录识别或合成夹具当作真实历史兼容验收。

## 先行可行性结论（2026-11-16，旧 NAS）

- 复用固定版 Agent WeChat `wechat-profile` 的 SQLCipher、官方 Linux 会话/消息映射、正文解码和分页；文字搜索由 SnSBox 自有索引完成。其 `ProfileReader` 明确要求停止写入方或一致性副本，不能对活跃源设置虚假确认。
- 只读核对当前源：1 个微信资料目录，代表性 session/contact/message 三库均加密，三库均有 WAL/SHM；未在有界已知位置发现显式导出的数据库 keys 文件或旧 Agent 缓存。现有 `key_info.db` 是保存登录材料，不等于 SQLCipher 数据库密钥。
- 不对源开启 SQLite 连接、不注册给 native、不创建锁/WAL/SHM、不停止原 WS。主库 immutable 直读不能覆盖 WAL，因此不作为完整历史读取方案。
- 用户已明确没有一致性副本或数据库密钥。下一项最大不确定性是取得真实、授权且独立一致的来源及匹配密钥；就绪前保持阻塞，不自行提取活跃客户端内存、停止服务或猜测密钥。
- QQ 官方 NT 资料与独立网络上游的历史不是同一数据源；没有经验证的官方历史解密路径时明确 unsupported，不以 QQ 登录成功推断旧历史兼容。

## 实际接线与配置

`src/history/` 提供读取、索引及 HTTP 路由，`web/**` 提供独立只读历史页面。主线程统一完成 main/config/store 接线。

已添加精确依赖 `wechat-profile = "=2.5.0"`（MIT），以及测试用 `tempfile = "3"`。现有 SQLx 的 `libsqlite3-sys 0.30.1` 与上游 rusqlite 0.32 对齐；上游打开 SQLCipher 4，沿用其 vendored OpenSSL 构建，Docker Rust 1.96 满足上游 1.93.1 要求，不自制解密器。依赖已加入 Cargo.lock；构建与启动证据由主线程部署记录维护。

接线：`mod history;`；启动时 `let history = history::HistoryService::open(&app.config.data, app.config.legacy.as_deref()).await?;`；在已有鉴权 Router 内 `.merge(history::routes(history))`。模块不新增 App 字段，不新增浏览器可提交的服务器路径或密钥字段。自有历史索引放到 `data/history/`，含明文私人资料，不宣称静态加密；上游读取器只在其私有临时目录处理副本，不改动平台登录资料。启动及刷新前检查临时目录与所有来源/活跃源隔离，不允许 TMPDIR 落入来源。

`SNSBOX_HISTORY_SOURCES_FILE` 指向受保护部署端 JSON 数组。单项字段：`id,platform,displayName,format?,profilePath,keysFile?,allowPlaintext:false,confirmedConsistentSnapshot:false,capturedAt?`。显式确认必须真实；任何与活跃源或自有数据目录重叠的 profilePath 均拒绝，即使声明已确认。无副本/密钥的当前实例保持阻塞，用户已明确继续实现能力，不等待材料。

QQ 来源显式使用 `format:"chatlog-keeper-qq-json"`，`profilePath` 指向导出完成的独立 `qq_messages.json` 文件，需 `confirmedConsistentSnapshot:true` 确认其独立完成条件。这里不使用数据库密钥或微信 `allowPlaintext` 开关；省略 format 的 QQ 官方加密资料仍不支持直接读取。导出只提供部分文字，正文有上游截断、时间范围与附件缺失限制，始终标为 partial；上限为 64 MiB 文件、10 万条记录。参考 [QQ 现场记录](QQ_HISTORY_READINESS.md) 和 [部署说明](../deploy/HISTORY_SETUP.md)。

配置、只读挂载与受保护密钥权限示例见 [部署说明](../deploy/HISTORY_SETUP.md)。明文导出需要显式 allowPlaintext；这不是加密库自动解密开关。未配置时保留阻塞的微信/QQ 来源，不搜索其他个人目录。

## HTTP 合同（前缀 /api/v1，Cookie 鉴权）

- `GET /history/sources`：返回 `{items:[HistorySource]}`。来源 ID 为自有不透明 ID，不暴露实际账号目录、源路径、凭据。
- `POST /history/sources/{sourceId}/refresh`，`{}` + CSRF：刷新只读派生视图，返回来源状态；不会启动或登录原客户端，不把普通热复制称为备份。未满足条件时返回清楚的状态/错误。
- `GET /history/sources/{sourceId}/conversations?cursor=&limit=50&query=`：返回 `{items:[HistoryConversation],nextCursor}`。
- `GET /history/sources/{sourceId}/conversations/{conversationId}/messages?cursor=&limit=50`：返回同消息段模型的只读历史，最新到最旧分页。
- `GET /history/sources/{sourceId}/messages?query=&cursor=&limit=50`：只检索该来源已有派生历史，绝不混入其他账号/平台。

`HistorySource` 字段：`id,platform,displayName,kind:"legacy-readonly",format,canRefresh,status,reason,readOnly:true,sendAllowed:false,capturedAt,indexedAt,consistency,generation,conversationCount,messageCount,partial`。status 区分 `not_loaded,refreshing,ready,partial,keys_required,snapshot_required,unsupported,error`；未取得的时间、代次和数量用 null。`consistency` 为 `operator-confirmed-copy`、`operator-confirmed-export` 或 `unavailable`，表示操作者确认的来源条件，不承诺跨库或全设备历史完整。前端优先遵守显式 `canRefresh`，不按 QQ 平台一律禁用或启用；刷新请求仍由服务端重新检查条件。

`HistoryConversation` 包含 `id,sourceId,accountId,platform,title,kind,lastMessage,lastMessageAt`，并保留 `readOnly:true`；accountId 使用独立的 `history:{sourceId}` 命名空间。`HistoryMessage` 包含 `id,sourceId,conversationId,accountId,platform,senderName,direction,timestamp,segments,readOnly:true`。未知方向、发送者与有效时间用 null，未展开的附件/卡片等保留类型提示，不执行原 XML/HTML、不提供媒体读取路由，不开放发送、账号退出或平台已读动作。

分页响应包含 `items,nextCursor,generation,partial,capturedAt`。游标按来源、查询、会话与派生代次绑定；刷新代次变化返回 409 `history_changed`，前端重取来源并从第一页恢复。读页在同一数据库事务确认代次，避免刷新期间静默返回空页。刷新异步读取并原子替换来源索引；如果旧代次仍可读，刷新期间保留其范围。错误不包含 SQL、源路径、联系人、正文或密钥。

当前读取上限：单库 2 GiB、数据库总量 8 GiB、256 库、单 blob 4 MiB；索引最多约 10 万会话、10 万消息或 64 MiB 已解码正文，达到上限标为 partial。搜索仅覆盖已建立的文字正文索引，不展开媒体/卡片。上限、数据库布局和源版本均可能使真实资料只得到部分记录。

## 隐私与最少验证

- 私密内容仅在本地授权 HTTP 响应与独立自有索引中处理；不打印到工具输出/日志、不纳入截图/Git，不发往上游或外部接口。
- 只对主要风险验证：源零主动写入；来源与游标隔离；缺密钥/不一致明确阻塞；凭据与正文不进入错误信息。界面截图和自动化检查只用合成内容。

## 本轮证据与尚未验证事项

- 主线程的聚焦 Rust 历史检查通过：1 项（6 项无关检查过滤，53.25 秒），覆盖合成加密/明文 WAL 夹具、来源字节未变、分页搜索及跨源游标拒绝、刷新代次与绑定变更、source/data/TMPDIR 隔离。该证据仅属于合成夹具。
- 前端生产构建通过；仅运行两项聚焦 Edge 检查，2 项通过（18.0 秒）。新增历史检查覆盖条件阻塞、CSRF、异步刷新、分页搜索、来源隔离、409 代次恢复及无输入/上传/修改入口；账号检查补验成功任务不再被旧二维码期限标记过期。所有修改请求仅为来源刷新，未运行无关完整套件。
- 已查看 1440×1000 桌面与 390×844 手机合成截图，无横向溢出；证据在忽略提交的 `web/test-results/history-*-synthetic.png`，不含真实记录。
- 当前未读用户真实聊天、未复用真实密钥，未证明用户版本兼容或历史完整。iPad/WebKit 真机、真实大型库分页及媒体覆盖仍待验收；界面与合成夹具完成不改变真实源的阻塞状态。

上游依据：[Agent WeChat / wechat-profile](https://github.com/thisnick/agent-wechat/tree/ce5c0687c0e99e3f93fd85266baa3fad26d63a11/packages/native-client-rust/crates/wechat-profile)。其他候选的只读边界见 [接入研究](INTEGRATION_RESEARCH.md)。
