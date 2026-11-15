# 后端实现与验证记录

日期：2026-11-15。范围：Rust 聚合服务、SQLite、自有附件、安全鉴权和 Linux AMD64 构建。真实微信/QQ 账号未接通、旧 config 未导入、未发布镜像、未修改旧项目或现有容器。

## 固定上游源码依据

- Agent WeChat：`ce5c0687c0e99e3f93fd85266baa3fad26d63a11`（2026-11-15）。核对 [native-client.ts](https://github.com/thisnick/agent-wechat/blob/ce5c0687c0e99e3f93fd85266baa3fad26d63a11/packages/shared/src/native-client.ts)、[native.generated.ts](https://github.com/thisnick/agent-wechat/blob/ce5c0687c0e99e3f93fd85266baa3fad26d63a11/packages/shared/src/native.generated.ts)、[actions.rs](https://github.com/thisnick/agent-wechat/blob/ce5c0687c0e99e3f93fd85266baa3fad26d63a11/packages/native-client-rust/crates/wechat-api/src/actions.rs)、[runtime.rs](https://github.com/thisnick/agent-wechat/blob/ce5c0687c0e99e3f93fd85266baa3fad26d63a11/packages/native-client-rust/crates/wechat-core/src/runtime.rs)。使用 `/v1/accounts/{id}`、`threads`、`messages`、`events`、`sends`、`uploads`、`jobs`、`login-attempts`、`logout`。普通 HTTP listener 限 loopback；独立网络访问需要 HTTPS。
- Lagrange.Core V2 / Milky：`fe789c4a23796fbc82fa09e70a9c44c8a5cf2948`（2026-11-07）。核对 [HttpApiHandler.cs](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Milky/Api/HttpApiHandler.cs)、[SSEEventHandler.cs](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Milky/Events/SSEEventHandler.cs)、[MilkyConverter.Sequence.cs](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Milky/Converters/MilkyConverter.Sequence.cs)、Message/System handlers、Models/Segments。源码已有 `POST /api/{name}` 和 `GET /event` SSE，README 对 HTTP/SSE 的未勾选清单落后于源码。图片/语音/视频同时返回 `resource_id` 和 `temp_url`；market_face 返回 `url`。发送图片/视频使用源码 ResourceConverter 支持的 `base64://`，没有向上游传递本地路径或用户指定 URL。
- `C:\Users\Muxinzheng\Desktop\Wechat-C` 仅只读核对源码：`root/scripts/stable-desktop-environment.py` 识别 `/config/.xwechat`、`/config/xwechat_files` 并保存 `.system-identity`；README 附件表说明 `/config/.config/QQ/nt_qq_*/nt_data`。没有读取实际账号 config、消息数据库或令牌文件。

获取和独立启动命令见 [UPSTREAM_SETUP.md](../deploy/UPSTREAM_SETUP.md)。这些上游版本不意味着已通过 SnSBox 真实账号验收；QQ 上游签名服务与登录前置条件未验证。

## 本次实际实现

- 单 Rust crate，模块化 config / adapters / store / remote_media / HTTP；Axum + Tokio + SQLx SQLite WAL；显式 SQL 迁移和 Cargo.lock。
- 首次随机管理员凭据文件、Argon2 密码验证、12 小时内存 Cookie 会话、限速、Origin + CSRF、无跨域上游令牌暴露。日志不记录正文、二维码或 token。
- 账号状态和能力矩阵；初始两个 unconfigured 账号不生成假会话。微信要求 `authenticated=true` 且 `connection=online`；QQ 要求有效 `uin`。健康检查与账号在线分开。
- 账号/会话/上游 ID 隔离；最近历史分页、本地完整文本搜索、本地未读；微信事件游标先持久化消息再推进，重复事件按稳定上游 ID 去重；QQ SSE 支持 LF/CRLF，断线重连但不能保证补齐缺口。
- 发送请求持久化幂等键和原请求；同键变参 409；上游提交前已入库。accepted 仅指上游接受；未知/失败响应保守标记 uncertain。重启不重发未决请求；微信有任务 ID 时仅查询 sends/jobs。处理上游事件先于发送回执到达的竞态，保留本地 outbox 身份而合并远端投影。
- 单附件上传与安全回读，32 MiB 单文件和默认 2 GiB 总配额；UUID 文件名、账号归属、内容类型识别、Range、下载 disposition、nosniff。微信接收通过已配置上游鉴权 `/messages/{id}/media` + `/media/{assetId}/content` 读取 available 附件；未下载/过期明确失败。QQ 只用上游返回的地址，限定 `qq.com/qpic.cn/gtimg.cn/gtimg.com` 域及子域，解析后拒绝私网 IP，固定解析结果、禁止重定向和代理，不提供任意 URL 抓取。
- 图片/视频发送双方可配置；微信文件发送。接收媒体、表情、卡片按现有类型展示；微信表情发送、QQ 表情/文件发送、QQ 登录管理 API、可执行小程序未开放。QQ 邮箱是独立网页入口。
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

QQ 的 `get_login_info` 仅返回 UIN/昵称，没有独立网络在线字段；其账号可用状态来自有效 UIN 与 API 成功，应理解为适配器接口可用，不能独立证明 QQ 会话仍在网络侧在线。真实收发与掉线状态一致性属于后续账号验收；微信则检查源码提供的 authenticated/connection 字段。

静态加密、自动缓存清理、完整备份恢复验收、消息撤回控制、群管理、官方 token 互换、NAS 性能和长时间常驻均未完成。事件暂不清理以保留重放，数据库生命周期决定回放窗口；生产长时容量需后续测量。下一项最大不确定性：在单写者、完整独立资料副本与测试账号条件下，验证两侧登录、一次真实文本/媒体收发和冷启动恢复。
