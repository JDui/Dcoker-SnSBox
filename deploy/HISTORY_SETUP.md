# 既有微信 / QQ 历史：独立只读来源

微信历史读取使用固定 `wechat-profile = 2.5.0`，复用其 SQLCipher 和官方 Linux schema 读取器。它不需要登录网络上游，不会注册或接管 profile。只有独立且经过一致性确认的资料才能建立索引；仅有活跃 WS 文件共享路径时，页面会显示缺少来源条件。QQ 支持下述已完成的 chatlog-keeper JSON 导出，不直接解密官方 QQNT 数据库。

## QQ：从已解密 SQLite 加载

已经有独立明文 `nt_msg.db` 时，使用 [qq-decrypted 转换工具](../tools/qq-decrypted/README.md) 生成 JSON 和来源配置，再按下节只读挂载。支持 QQNT 数字列 `c2c_msg_table` / `group_msg_table`，复制到私有临时目录后才打开 SQLite，原输入不连接数据库；拒绝活跃保护路径、未确认副本及任何旁路 WAL/SHM/journal。不会取钥、登录、解密或 checkpoint。

新格式为 `snsbox-qq-decrypted-v1`（[配置样例](history-qq-decrypted.example.json)），普通长文本不再受上游最终 1000 字符摘要截断；单条 UTF-8 64 KiB 上限，超限和不可解析记录保留占位，复杂引用/卡片仍有摘要限制，附件未导入。整个输入上限 2 GiB，输出 64 MiB / 10 万条。不要把原版 chatlog-keeper 已截断的导出直接改标为新格式。

2026-11-17 定向转换验证使用同 schema 合成 SQLite：账号 A 124 条 / 2 会话，含 5029 字符长文与 2 条不可读占位；账号 B 2 条 / 2 会话。Windows 与 Linux 转换测试通过；主线程已使用生成器→转换器实际产物通过 AMD64 容器 HTTP 的 126 条索引、长文尾部搜索、未知占位与上下文分页检查。真实用户明文库兼容尚未验收。

## QQ：导入现成 JSON 导出

使用固定 [chatlog-keeper d2feeec](https://github.com/labazhou2024/chatlog-keeper/tree/d2feeec09a192af9a4738547b8543cf096386464) 导出的 `qq_messages.json` 数组。SnSBox 只读取已经完成、独立保存的导出文件，不运行上游 CLI、不读取登录凭据、不发起 QQ 登录或密钥请求。不能将活跃 `nt_msg.db` 重命名为 JSON；当前没有替用户取得真实导出或密钥。

1. 将已有导出放在忽略的 `private/qq-history/qq_messages.json`，与整个活跃 `X:\Docker\selkies`、旧 `X:\Docker\wechat` 和 SnSBox data 隔离。只挂载这个私密导出目录，不挂载整个 NAS config。Linux 上让 UID 10001 可读，建议目录 0700、文件 0600；不改动原客户端资料权限。
2. 从 [QQ 配置示例](history-qq-export.example.json) 复制为 `private/history-sources.json`；确认导出完成且不会继续写入后，填写真实 `capturedAt`，将 `confirmedConsistentSnapshot` 改为 `true`。`format` 必须为 `chatlog-keeper-qq-json`，`profilePath` 是容器内 JSON 文件路径；不需要 `keysFile` 或 `allowPlaintext`。已有微信来源时向同一个配置数组追加 QQ 条目，保留微信原配置。
3. 复制 [QQ Compose overlay](compose.history-qq-export.example.yaml)，叠加到现有 Compose 后启动已包含该功能的镜像。微信与 QQ 共用同一个 `SNSBOX_HISTORY_SOURCES_FILE`；同时启用时合并只读挂载，不能用第二份配置覆盖第一份。现有 `history-snapshot/prepare.py` 和 `stage-compose.py` 面向微信数据库 bundle，不用于这个 JSON 文件。
4. 在“既有历史”选择 QQ 来源并读取。会话、消息分页、搜索和重新读取走现有历史 API，始终禁止发送。未确认来源仍被拒绝；读取错误不会替换已有索引。

上游实际字段：`account_id`、`conversation_id`（或 `chat_uid`）、`conversation_type: direct/group`（或 `chat_kind: friend/group`）、`ts`（秒级数字）、`content`、`sender_name`、`sender_qq`（整数）、可选 `is_self`。账号、会话类型、会话编号共同隔离；同秒重复 `source_offset` 不会丢记录。非数字账号标识时，上游 `is_self:false` 不足以确定方向，因此可能显示未知方向。

当前限制：单文件最多 64 MiB、10 万条，超限整批拒绝；只索引导出文字，忽略附件路径/URL，不下载媒体，不执行正文 HTML。固定上游 `read_recent_dicts()` 有时间窗口与 1500 字符外层限制，进一步核对发现底层 `_extract_msg_text()` 已先截到 1000 字符；缺少稳定消息 ID，故成功状态始终为 `partial`，重启也保留限制说明。本地 ID 用导出行号保持同秒多条记录；改写或重新导出后的 ID 不用于跨导出归并。导出原文和索引均含明文私人资料，不进入 Git。

## 准备来源

可执行准备工具见 [副本准备](../docs/HISTORY_SNAPSHOT_PREPARATION.md) 和 [密钥转换](../docs/WECHAT_KEY_PREPARATION.md)。2026-11-17 使用修正后的 round2 合成加密资料通过现有镜像的 HTTP 联合检查：一个会话、三条消息和三条搜索结果，来源状态 `ready`。这验证了副本与转换密钥的读取链路；不是用户真实历史验收，也不代表任意宿主的挂载权限均已正确设置。

如果准备 bundle 的用户不是服务 UID 10001，或使用 Windows Docker Desktop，不要直接放宽密钥权限。使用 `tools/history-snapshot/stage-compose.py` 将已准备的独立 bundle 复制到新建的本地 Linux 私有卷，生成可直接叠加的 Compose；详见副本准备文档。此工具不修改输入文件，不运行远端 Docker，不创建源端快照。2026-11-17 已通过生成 Compose 的实际 HTTP 检查，没有手工补 chown 或重写清单路径。

仅有 Windows SMB 映射时，可先枚举服务器已有的 Previous Versions，无需 SSH，也不会创建快照或打开数据库：

```powershell
.\deploy\probe-smb-snapshots.ps1 -Path 'X:\Docker\selkies\config'
```

`available` 会列出服务器返回的 `@GMT` 候选目录；仍需确认目录确属固定快照、覆盖完整 profile 和 WAL，并按下列步骤准备来源。`unsupported`、`none_advertised`、`access_denied` 或 `probe_failed` 都不会触发热复制、创建快照或自动放宽读取条件。2026-11-16 旧 NAS 的 `X:\Docker\wechat\config` 实测为 `unsupported`，该历史结果不能用于判断更换后的 NAS。当前路径为 `X:\Docker\selkies\config`；准备/staging 工具同时传入 `--active-root "X:\Docker\selkies" --active-root "X:\Docker\wechat"`，不把活跃目录本身当作历史来源。没有 SSH 也继续提供离线准备能力，但不能由文件共享推出可读取 NAS 进程内存。

2026-11-17 已在先前目录元数据检查之外，独立执行上述新 NAS 枚举命令：返回 `unsupported` / Win32 error `1`，无返回的快照条目，`confirmedConsistentSnapshot:false`。脚本仅以只读目录句柄查询已有版本，没有读取数据库、复制资料、创建快照或写源。此结果只说明该共享未通过本次标准 SMB 查询提供 Previous Versions，不能证明底层 NAS 没有快照能力；仍未获得可交给历史读取器的独立一致性来源。

1. 在 SnSBox 自有数据目录以外准备完整的独立微信账号资料，包括 `db_storage` 与快照中的 WAL 等状态。不要把运行中的 WS config 直接设为来源；普通热复制不等于一致性快照。原 WS 可以继续运行，独立快照的获得方式需由该部署环境保证。
2. 使用与该账号匹配、符合上游 `KeyFile` 格式的数据库密钥文件。Linux 上仅允许服务 UID 10001 读取，权限设为 0600，父目录保护为 0700。保存的登录令牌不是数据库密钥。密钥不要粘贴到浏览器或聊天，也不要提交 Git。Docker Desktop 的 bind 权限若被上游判为不安全，应使用独立 Linux 私密卷存放密钥；不要降低校验。
3. 从 [history-sources.example.json](history-sources.example.json) 复制到忽略的 `private/history-sources.json`，填写来源和实际捕获时间。只有已经确认来源一致性时才设置 `confirmedConsistentSnapshot: true`。`profilePath` 是账号资料根，不是外层 Compose 项目根；保留其原账号目录名，使其与密钥文件的账号绑定一致，示例 `wechat-account` 只是占位。明文兼容导出可显式设置 `allowPlaintext: true` 并删除 `keysFile`；这不是对加密库自动解密的开关。
4. 从 [compose.history.example.yaml](compose.history.example.yaml) 复制为 `compose.history.yaml`，按实际私密目录调整只读挂载。明文来源需移除密钥挂载。所有来源必须与活跃源及整个 SnSBox data 目录隔离；配置不会从网页接收任意服务器路径。

```sh
docker compose -f compose.yaml -f compose.history.yaml up -d --build
```

已有登录上游时可叠加其 Compose 文件；历史来源配置和网络账号配置各自独立。不要为了启用历史而替换或删除原来的 `accounts.json`。

历史 overlay 使用独立磁盘卷 `snsbox-history-scratch` 存放临时副本，避免把大型数据库复制进默认 64 MiB `/tmp` 内存盘。需要为所选资料及 WAL 留出磁盘空间；当前读取器上限为单库 2 GiB、数据库总量 8 GiB，索引另计。正常读取结束会删除临时副本；进程异常退出后的残留不当作历史备份。

## 页面与数据范围

打开“既有历史”，选择来源并发起读取。成功后提供会话、消息分页和本地文字搜索，没有发送框或平台账号操作。刷新来源只写 SnSBox 自有索引；上游读取器在私有临时目录处理副本。系统临时目录必须位于所有资料来源之外，程序会在创建索引前及刷新前检查，不要将 `TMPDIR` 设为源目录。索引位于 `/data/history/`，含明文私人资料，沿用 SnSBox 数据卷的权限和备份要求，不宣称静态加密。

页面显示来源状态、捕获/索引时间、数量与有限覆盖提示。未实现的附件、卡片等消息保留类型提示，不代表媒体已导入。缺少密钥、错误布局、读取期间源改变和索引失败均单独报告。刷新后旧分页游标失效并重新从第一页读取，来源之间不能互用游标。

当前用户活跃 WS 源没有提供一致性副本或数据库密钥，因此尚未读取其真实记录。合成加密/明文格式的验证不等于该用户资料兼容成功；真实账号版本、密钥、历史范围仍需在实际来源就绪后验证。

读取器来源：[Agent WeChat / wechat-profile](https://github.com/thisnick/agent-wechat/tree/ce5c0687c0e99e3f93fd85266baa3fad26d63a11/packages/native-client-rust/crates/wechat-profile)，MIT；依赖锁定于 Cargo.lock，遵循上游第三方声明。其他导出工具的核对和限制见 [接入研究](../docs/INTEGRATION_RESEARCH.md)。
