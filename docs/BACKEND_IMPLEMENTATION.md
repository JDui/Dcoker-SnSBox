# 后端实现与验证记录

日期：2026-11-15。范围：Rust 聚合服务、SQLite、自有附件、安全鉴权和 Linux AMD64 构建。真实微信/QQ 账号未接通、旧 config 未导入、未发布镜像、未修改旧项目或现有容器。

## 固定上游源码依据

2026-11-17 解密后加载增量：新增 [qq-decrypted 离线转换](../tools/qq-decrypted/README.md)，直接支持独立明文 QQNT 数字列 SQLite（`c2c_msg_table` / `group_msg_table`），复用固定 chatlog-keeper MIT 消息解析器。仅复制输入文件后连接私有副本，拒绝活跃根、链接、未确认副本、WAL/SHM/journal 和覆盖输出。产物为 JSON、来源配置、无正文报告，格式 `snsbox-qq-decrypted-v1` 接入原历史 API。去掉上游底层 1000 字符最终截断；普通长文本保留到 64 KiB，超限/不可解析保留占位，复杂内容仍有摘要限制。旧 `chatlog-keeper-qq-json` 继续兼容。数字账号/发送人能确认时保留入站/出站方向，无法确认时为 null。来源初始化、刷新与重启恢复均按格式说明限制。

本增量必要检查：`python -B -m unittest discover -s tools/qq-decrypted -p test_convert.py -v` 在 Windows 2 项通过（0.192 秒）、Linux 2 项通过（0.020 秒）；覆盖真实 SQLite/最小合成 protobuf 经同一转换器、5029 字符正文、同秒记录、账号范围、未知内容不泄露二进制 URL、原文件字节和目录不变、边界拒绝与超限占位。`cargo test --locked --offline qq_export -- --nocapture` 2 项通过（0.26 秒，另有增量编译），保留旧格式回归。初次 Windows 检查修复了 fd/path ctime 语义不一致；测试中的 SQLite 句柄也已显式关闭，避免仅测试清理失败。没有 SHA 摘要检查或全量测试。

主线程已报告 AMD64 构建与实际 HTTP 集成通过：使用 `fixture.py → convert.py` 生成的两个来源，124 + 2 条消息，长文尾部检索、未知占位无附件 URL 泄露、上下文分页、跨会话 404 和旧代际 409 均通过。测试源全部合成，尚未读取实际用户解密库或取得真实密钥。本协作线程未访问 X:、未登录、未改动现用客户端、未提交推送；主线程负责阶段提交。下一项最大不确定性为真实明文 QQNT 版本和消息变体兼容，而非本轮继续取钥。

最新历史增量（2026-11-17）：Rust 历史服务新增 `chatlog-keeper-qq-json` 导入器，直接适配固定上游 `qq_messages.json`，复用已有事务索引、分页、搜索与来源隔离。配置 `format` 可省略以保留旧微信行为；QQ 默认仍不接受加密 `nt_msg.db`。`SourceStatus` 新增 `format` / `canRefresh`，前端按能力开放读取，不再以 QQ 平台一律禁用。JSON 读取始终只读、不打开 SQLite 来源、不调用网络/取钥/CLI、不处理附件路径；64 MiB / 10 万条上限和字段校验失败整批拒绝。身份包含来源、账号、会话类型和会话 ID，同秒消息用行号保留。上游导出存在时间范围与 1500 字符正文截断，成功始终 `partial`，刷新和重启恢复均保留说明。

本增量针对性验证：Linux AMD64 缓存构建环境运行 `cargo test --locked --offline qq_export -- --nocapture`，2 项通过（0.29 秒，不含编译）：5 条同秒记录 / 4 会话，账号与群私聊隔离、来源间不可串用会话、原导出字节不变、附件私有路径不进入响应、未知方向保留 null、无效替换不覆写旧索引、重启恢复、64 MiB 超限及冲突字段拒绝。无全量应用测试、无手工文件摘要校验。HTTP 镜像验收由主线程另行执行，以上不代表该验收完成；全部记录均合成，未读取用户真实 QQ 历史。

配置与挂载示例见 [QQ 历史准备](../deploy/HISTORY_SETUP.md#qq导入现成-json-导出)。最大未决项是实际授权 QQ 导出的取得及真实版本兼容；既有活跃 NAS 的密钥和一致性副本仍未获得。新增文件和共享代码交主线程审查与提交，本协作线程不提交推送。

- Agent WeChat：`ce5c0687c0e99e3f93fd85266baa3fad26d63a11`（2026-11-15）。核对 [native-client.ts](https://github.com/thisnick/agent-wechat/blob/ce5c0687c0e99e3f93fd85266baa3fad26d63a11/packages/shared/src/native-client.ts)、[native.generated.ts](https://github.com/thisnick/agent-wechat/blob/ce5c0687c0e99e3f93fd85266baa3fad26d63a11/packages/shared/src/native.generated.ts)、[actions.rs](https://github.com/thisnick/agent-wechat/blob/ce5c0687c0e99e3f93fd85266baa3fad26d63a11/packages/native-client-rust/crates/wechat-api/src/actions.rs)、[runtime.rs](https://github.com/thisnick/agent-wechat/blob/ce5c0687c0e99e3f93fd85266baa3fad26d63a11/packages/native-client-rust/crates/wechat-core/src/runtime.rs)。使用 `/v1/accounts/{id}`、`threads`、`messages`、`events`、`sends`、`uploads`、`jobs`、`login-attempts`、`logout`。普通 HTTP listener 限 loopback；独立网络访问需要 HTTPS。
- Lagrange.Core V2 / Milky：`fe789c4a23796fbc82fa09e70a9c44c8a5cf2948`（2026-11-07）。核对 [HttpApiHandler.cs](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Milky/Api/HttpApiHandler.cs)、[SSEEventHandler.cs](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Milky/Events/SSEEventHandler.cs)、[MilkyConverter.Sequence.cs](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Milky/Converters/MilkyConverter.Sequence.cs)、Message/System handlers、Models/Segments。源码已有 `POST /api/{name}` 和 `GET /event` SSE，README 对 HTTP/SSE 的未勾选清单落后于源码。图片/语音/视频同时返回 `resource_id` 和 `temp_url`；market_face 返回 `url`。发送图片/视频使用源码 ResourceConverter 支持的 `base64://`，没有向上游传递本地路径或用户指定 URL。
- `C:\Users\Muxinzheng\Desktop\Wechat-C` 仅只读核对源码：`root/scripts/stable-desktop-environment.py` 识别 `/config/.xwechat`、`/config/xwechat_files` 并保存 `.system-identity`；README 附件表说明 `/config/.config/QQ/nt_qq_*/nt_data`。没有读取实际账号 config、消息数据库或令牌文件。

获取和独立启动命令见 [UPSTREAM_SETUP.md](../deploy/UPSTREAM_SETUP.md)。这些上游版本不意味着已通过 SnSBox 真实账号验收；QQ 上游签名服务与登录前置条件未验证。

## 本次实际实现

- 单 Rust crate，模块化 config / adapters / store / remote_media / HTTP；Axum + Tokio + SQLx SQLite WAL；显式 SQL 迁移和 Cargo.lock。
- 首次随机管理员凭据文件、Argon2 密码验证、12 小时内存 Cookie 会话、限速、Origin + CSRF、无跨域上游令牌暴露。日志不记录正文、二维码或 token。
- 账号状态和能力矩阵；初始两个 unconfigured 账号不生成假会话。微信要求 `authenticated=true` 且 `connection=online`。第二轮已修正 QQ：有效 UIN/API 成功不能单独证明在线；详见下方新增记录。健康检查与账号在线分开。
- 账号/会话/上游 ID 隔离；最近历史分页、本地完整文本搜索、本地未读；微信事件游标先持久化消息再推进，重复事件按稳定上游 ID 去重；QQ SSE 支持 LF/CRLF，断线重连但不能保证补齐缺口。
- 发送请求持久化幂等键和原请求；同键变参 409；上游提交前已入库。accepted 仅指上游接受；未知/失败响应保守标记 uncertain。重启不重发未决请求；微信有任务 ID 时仅查询 sends/jobs。处理上游事件先于发送回执到达的竞态，保留本地 outbox 身份而合并远端投影。
- 单附件上传与安全回读，32 MiB 单文件和默认 2 GiB 总配额；UUID 文件名、账号归属、内容类型识别、Range、下载 disposition、nosniff。微信接收通过已配置上游鉴权 `/messages/{id}/media` + `/media/{assetId}/content` 读取 available 附件；未下载/过期明确失败。QQ 只用上游返回的地址，限定 `qq.com/qpic.cn/gtimg.cn/gtimg.com` 域及子域，解析后拒绝私网 IP，固定解析结果、禁止重定向和代理，不提供任意 URL 抓取。
- 图片/视频发送双方可配置；微信文件发送。接收媒体、表情、卡片按现有类型展示；微信表情发送、QQ 表情/文件发送、可执行小程序未开放。第二轮新增可选 LLBot QQ 登录管理。QQ 邮箱是独立网页入口。
- 旧 config 仅固定目录存在性检查。解析已有祖先和 symlink，**创建 SnSBox 数据目录之前**拒绝与源目录嵌套；自己的 SQLite、媒体和凭据独立存放。
- Docker 多阶段构建、AMD64、非 root 运行、只读根文件系统、持久数据卷、健康检查、可选隔离上游示例。默认 Compose 不挂载旧 config，不安装或启动第三方上游。

## 必要验证与当前证据

- Linux AMD64 `cargo test --locked`：4 项针对性测试通过（2026-11-15）：旧目录误配置在 mkdir 前拒绝，包含 Linux symlink；发送回执/事件竞态去重 + 长文本搜索 + 重启 uncertain；SSE LF/CRLF；媒体私网地址拒绝。合成 SQLite 和测试目录，无真实账号。
- 编译环境：本机 Docker Linux AMD64，`rust:1.96-bookworm` 内 Rust 1.96.1。crates.io 索引网络长时间等待，构建临时使用上海交通大学公开 sparse 镜像；没有关闭 TLS 或包管理器完整性校验，没有手工 SHA 文件校验。
- 本地镜像 **`snsbox:0.1.0` 已构建并验证**：Linux AMD64，默认完整 Node + Rust 多阶段 target 成功（另一个 `runtime-prebuilt` target 也成功）；运行用户 `10001:10001`，镜像约 123 MiB，未 push。使用 Docker Hub 同版本的 DaoCloud 基础镜像镜像站绕过下载故障；没有修改现有服务。
- `node deploy/smoke.mjs` 通过：真实运行该 AMD64 镜像，使用全合成 HTTP 上游，验证未登录 401、登录 Cookie、CSRF/Origin 拦截、两侧会话映射、QQ CRLF SSE、新消息、超过 160 字符的搜索、64 位消息 ID 保真、微信鉴权附件读取和本地缓存/Range、幂等重复/冲突、accepted 持久化及重启后同键不重发。测试退出时只删除自己的临时容器、匿名卷和合成文件。此项不是上游守护进程或真实账号验收。
- 该冒烟首次发现双平台并发同步时 SQLite deferred transaction 的先读后写升级竞争；`conversation()` 已改为单条带条件 UPSERT，先写入再记录变更事件，不再通过读快照判断是否更新。修复后完整冒烟通过，并只补跑相关 store 测试通过。
- `docker compose config --quiet`、`node --check deploy/smoke.mjs` 和差异空白检查通过。浏览器界面验收由主线程独立记录；本后端线程没有重复 UI 验收。
- 最终 `snsbox:0.1.0` 包含上述并发 UPSERT 修复，修复后重建的默认完整 target 通过同一端到端冒烟。线程创建的测试容器、匿名数据卷、合成凭据目录和构建进程已退出/清理；只保留交付镜像及 `snsbox-cargo-cache`、`snsbox-build-target` 编译缓存卷。没有停止主线程或已有业务容器。

## 未验证和明确限制

没有真实账号、真实对端或官方配置迁移验收。微信仅初始化各会话最近 50 条并继续重放上游事件；不是全部历史导入。QQ 初始群历史取最近 20 条，私聊不能缺少起始消息序号，因此没有冒充完整私聊历史恢复。接收媒体受上游 available 状态、CDN 有效期、32 MiB 上限和浏览器编解码器限制；不会自动修改官方媒体目录或发起微信远端下载。QQ SSE 没有可重放游标；断线缺口仍需解决。

QQ 的 `get_login_info` 仅返回 UIN/昵称，没有独立网络在线字段。第二轮不再将其视作 online：普通 Milky 等待事件证据；LLBot 管理模式使用 online 字段并核对预期 UIN。真实收发与掉线状态一致性仍属于后续账号验收；微信检查 authenticated/connection 字段。

静态加密、自动缓存清理、完整备份恢复验收、消息撤回控制、群管理、官方 token 互换、NAS 性能和长时间常驻均未完成。事件暂不清理以保留重放，数据库生命周期决定回放窗口；生产长时容量需后续测量。下一项最大不确定性：在单写者、完整独立资料副本与测试账号条件下，验证两侧登录、一次真实文本/媒体收发和冷启动恢复。

## 第二轮：本地偏好、登录任务和真实 daemon（2026-11-15）

实际实现：

- `0003` 增量迁移增加本地 pinned/muted/unread；PATCH 会话持久化，置顶优先的 keyset 分页，置顶变更使旧游标返回 409。上游会话刷新不覆盖本地偏好。
- `0004` 持久化账号任务与幂等请求。微信 managed 账号创建只在明确 404 后执行；不接受源路径。登录/注销、任务读取、取消和 PNG 二维码均受账号作用域、Cookie/CSRF 保护。成功登录还要检查 authenticated/connection；注销完成显示 offline。重复轮询不产生无变化的事件。
- 真实上游 expiresAt 为 Unix 秒，统一转为 RFC3339；QR generation 转发并保留旧代次 409。明确处理 starting/resuming/authenticating，未知阶段归 uncertain。
- 元数据兼容预检只查看固定布局和数量，未打开数据库/密钥/令牌，不创建源锁/WAL。活跃源的下一步明确为 `exclusive-copy-required`，没有自动导入或接管接口。
- 新增可选 LuckyLilliaBot 管理适配，通信继续复用 Milky。核对 release `v8.3.2` 对应源码 `7dec94b7a0fb2ed5fa49677841afe5074a46b3cf`，不是旧 NapCat 镜像。参考 [登录/注销路由](https://github.com/LuckyLilliaDev/LuckyLilliaBot/blob/7dec94b7a0fb2ed5fa49677841afe5074a46b3cf/src/webui/BE/routes/login.ts)、[QR 生命周期](https://github.com/LuckyLilliaDev/LuckyLilliaBot/blob/7dec94b7a0fb2ed5fa49677841afe5074a46b3cf/src/main/qqProtocol/base.ts)、[Docker 入口](https://github.com/LuckyLilliaDev/LuckyLilliaBot/blob/7dec94b7a0fb2ed5fa49677841afe5074a46b3cf/docker/startup.sh)。只支持 direct 模式，要求预期 UIN；管理、Milky 同步/SSE、发送前分别核对身份。PNG 仅内存缓存，注销/过期/重启撤销，不保存 QR URL 或 secret 到任务 JSON。Auth Token 是独立上游前置条件，不是官方 QQ 令牌。

针对性证据：

1. `old_schema_migration_preserves_preferences_across_sync_and_restart` 通过：先用仅 0001/0002 的真实 SQLx 迁移创建旧数据库和会话，再升级，核对历史会话保留、默认未读正确、本地设置跨上游刷新及重启保留。
2. `node deploy/smoke.mjs snsbox:round2` 及管理模式 `--llbot` 通过。新增覆盖置顶分页边界、旧游标 409、账号操作幂等、权限错误不创建、任务终态、跨账号 QR 拒绝、Unix 秒/高精度日期规范化、QR generation、LLBot 登录/注销、错误 UIN 发送前拒绝。仍为合成 HTTP fixture，不是真实 QQ 验收。
3. 固定微信源码在 Linux AMD64、Rust 1.96.1、cmake/libpulse0 环境完成 `cargo build --release --locked -p wx-native`，耗时约 3 分 13 秒（可用 rsproxy sparse 镜像）。此前 SJTU 缺锁定 thiserror 2.0.21，官方索引慢；没有修改上游 lock 或关闭完整性检查。
4. **真实微信 daemon 已运行**，使用全新的命名数据卷，未挂载任何官方 config。首次因目录权限不私有拒绝启动，调整本测试自有目录为 0700、token/config 为 0600 后启动。`/health` ok，managed 账号创建成功。实际发现 alias 只允许字母数字下划线连字符，已移除把中文显示名传作 alias 的错误。
5. **SnSBox → 真实微信 daemon 链路已检查**：中文本地显示名的独立账号 provision 返回 created=true；登录 starting/pending 后，任务变为 failed，产品显示 blocked、qrCode=null；upstream error code 为 login_failed，authenticated=false、connection=disconnected，二维码端点 404。注销 queued/pending 后变为 succeeded/accepted，产品显示 offline。没有扫码、真实账号授权、消息收发、旧令牌导入或历史读取验收。
6. `snsbox:round2` 是后端集成检查镜像（runtime-prebuilt），**不是包含最终 RC UI 的交付镜像**；主线程合并前端后再构建最终镜像。

QQ 实际部署尝试与阻塞：Lagrange 固定源码 Docker build 在 alpine 基础镜像 metadata 请求 EOF 失败。LLBot v8.3.2 直接 Docker Hub manifest EOF，DaoCloud 明确不在 allowlist，1ms 镜像仅部分层完成、十余分钟不再推进后停止；GitHub 固定发布 zip 断点续传也在 180 秒只收到约 0.8 MiB 后超时。**没有启动成功真实 LLBot，没有生成 QQ 二维码**。已交付 `prepare-llbot.mjs` 和 `compose.llbot.example.yaml`，复用官方 8.3.2 镜像、独立资料和 loopback 管理服务，不需要重写 QQ 协议。恢复可用下载后，下一项最小检查是空白实例的 login-info / Auth Token 就绪 / 二维码；真实扫码和收发另行验收。

微信登录失败的有界诊断：复用同版本 `NativeClient::start_qr_login` 做一次独立空白预登录探测，仅输出阶段和 `std::io::ErrorKind`，没有输出 QR/随机密钥/认证材料。结果为 `stage=transport io_kind=WouldBlock`，即传输读取未在期限内取得响应，尚未到可证明成功的 QR 业务阶段。容器 DNS 返回 198.18.x.x 的代理映射地址；经 HTTPS DNS 解析得到公网 A 记录后，仅对第二个临时探测容器设置 `--add-host` 做一次有依据的修正重试，结果仍为 WouldBlock。保留正常主机名和协议认证，未绕过 TLS/MMTLS 校验。由此确认本环境有预登录传输阻塞证据；不能证明是官方资料缺失、QQ/微信账号拒绝或协议已不可用。下一步是在可达的独立部署网络完成同样空白预登录检查，再决定是否需要资料前置条件。没有继续无界重试。

只读预检的单项测试 `metadata_inspection_does_not_create_files` 通过：固定加密字节合成文件读取前后目录只有该文件，未创建 WAL/锁。未对真实源重复测试。

交接清理：本线程创建的微信 daemon、聚合链路探测容器、四个上游构建容器和空白账号测试卷均已清理；合成冒烟自行清理自己的容器/匿名卷。没有操作主线程 npm 预览。保留 `snsbox-cargo-cache`、`snsbox-build-target`、`snsbox-wx-target` 编译缓存卷及本地构建镜像，方便后续复用。临时目录 `%TEMP%/snsbox-wx-live-empty` 的递归清理被自动审批审查以 `blocked by policy` 拦截，因此仅该临时合成配置/随机测试 API 凭据目录尚未删除（无真实账号资料）；未继续绕过审查。上游源码缓存、未完成的 LLBot zip 和仅输出脱敏错误类别的诊断 example 也保留在 `%TEMP%`，不是 Git 或交付包的一部分。下载进程已停止。

后续最小清理：核对绝对路径及普通文件属性后，非递归删除本轮生成的 token 与 headers 两个随机测试凭据文件成功；没有重试递归删除。snsbox-wx-live-empty 目录仅保留 server.toml 和 accounts.json 合成配置（引用已删除的 token 路径），无凭据内容。公开源码、诊断 example、编译缓存及不完整下载仍保留。

## 第三轮：真实预登录恢复与固定源码 QQ 启动（2026-11-15）

本节更新上轮的传输/下载阻塞结论；用户当前明确暂不扫码，QQ 没有 Auth Token，先继续微信与只读历史。

- **微信预登录已恢复**。固定版本 `wechat-protocol/src/mmtls.rs:285` 的首段握手使用原始 TCP `long.weixin.qq.com:80`；短链使用 `http://short.weixin.qq.com/mmtls/...` 并显式 no_proxy。普通 HTTP/HTTPS 环境变量不会覆盖首段原始 TCP。本机现有代理为 loopback 7897，Docker 默认 HTTP 代理路径下直接 MMTLS 读取超时。仅对独立进程使用 HTTP CONNECT 后，同一编译产物成功取得 QR；随后换为成熟 `proxychains4 4.16` 的进程级 CONNECT，仍成功。未修改系统代理、VPN、全局 DNS，未关闭 TLS/MMTLS 校验，未改私有协议源码。
- **真实 SnSBox → daemon → 微信 QR 链路已通过**。独立 managed 账号返回 `pending/awaiting_scan`，SnSBox 受 Cookie 鉴权的 PNG 返回 HTTP 200、6384 字节；只记录状态和长度，没有打印/提交二维码。未扫码确认、未发消息、未注销现用客户端，也未挂载 X: 活跃资料。此证据说明空白 managed 资料可到扫码阶段，不能再把上轮失败归因为必需旧 profile。
- 现保留本机 `http://localhost:18080`，容器 `snsbox-mvp`、`snsbox-mvp-wechat`，命名卷 `snsbox-mvp-app-data`、`snsbox-mvp-wechat-data`。配置和管理员密码在 ignored `private/mvp-login/`；只供本机读取，不写入文档。用户要求暂不扫码，旧挑战已结束，没有循环刷新。更新后的服务当前显示微信 offline（尚未登录），以后可从页面手工发起。该现场使用缓存工具链镜像及原编译产物作为隔离 bootstrap，**不是精简生产发布镜像**。
- 修复主线程实测发现的状态抖动：未认证时不拉取会话。近期进行中的登录任务保持 connecting，无登录任务则 offline；上游不可访问/鉴权错误才是 error。不再让后台 sync 在 awaiting_scan 时覆盖成 error。
- **QQ 下载问题已通过源码构建绕过**。使用 `v8.3.2` 实际提交 `dc2b2b90092ef0f571b5546878288b83fff1e436`，Yarn 4.18.0 + immutable lock + 随仓库提供的 Linux 原生 sign-proxy，构建成功。上轮记录的 `7dec94b7...` 是 annotated tag 对象，实际提交应使用这里的 peeled commit。没有手工文件哈希校验。`deploy/llbot-source.Dockerfile` 实际构建 `snsbox-llbot:8.3.2-source`，Linux AMD64，约 348 MB；实际启动该镜像后 login-info HTTP 200、direct、online=false；auth-token/status HTTP 200、hasToken=false、validation=idle。该镜像仅打包 API 登录 bootstrap，不含上游 WebUI 静态构建和 FFmpeg，不能当作媒体功能交付。
- LLBot 缺少 Auth Token 时 SnSBox 直接返回 `blocked/auth_required`，不会发起 QR。用户明确无此 Token，本轮不申请外部服务、不等待、不从活跃 QQ 资料推断 UIN。QQ bootstrap 容器已停止，私密合成 bootstrap 目录和镜像保留，不影响微信现场。

必要验证：`snsbox:mvp-login` 构建成功；`node deploy/smoke.mjs snsbox:mvp-login --llbot` 通过，新增断言覆盖等待扫码时 sync 不读取 threads、不误报 error，以及缺少 LLBot Auth Token 不调用二维码接口。更新本地 SnSBox 镜像后通过真实 daemon 检查未登录显示 offline。`sh -n deploy/wechat-proxy/entrypoint.sh`、新 Compose 的 `config --quiet` 通过。代理扩展 Dockerfile 是基于官方 runtime 的部署配方，尚未在本机重建完整官方基础 runtime；已实测的是相同 proxychains4 工具和进程启动方式，不混淆两项证据。

部署参考：`deploy/wechat-proxy/`、`deploy/compose.wechat-proxy.example.yaml` 和 `deploy/llbot-source.Dockerfile`。临时 CONNECT 转发容器、源码构建容器和工具安装容器已清理。保留上轮编译 cache、代理工具链 bootstrap 镜像、QQ source 镜像，以及两个微信 MVP 现场容器。未操作主线程预览服务。下一项最大不确定性为用户实际扫码确认后的身份/会话恢复；另一个线程负责只读历史，当前不以 QR 成功承诺旧库解密或完整历史。
