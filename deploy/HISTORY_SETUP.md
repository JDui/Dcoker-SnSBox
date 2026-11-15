# 既有微信历史：独立只读来源

历史读取使用固定 `wechat-profile = 2.5.0`，复用其 SQLCipher 和官方 Linux schema 读取器。它不需要登录网络上游，不会注册或接管 profile。只有独立且经过一致性确认的资料才能建立索引；仅有活跃 WS 文件共享路径时，页面会显示缺少来源条件。当前不解密官方 QQNT 历史。

## 准备来源

可执行准备工具见 [副本准备](../docs/HISTORY_SNAPSHOT_PREPARATION.md) 和 [密钥转换](../docs/WECHAT_KEY_PREPARATION.md)。2026-11-16 收尾时副本专项检查已通过，但转换后接入主服务的 HTTP 集成仍返回 `keys_required`，尚未完成联合验收；不要将这些工具标为真实历史读取成功。

仅有 Windows SMB 映射时，可先枚举服务器已有的 Previous Versions，无需 SSH，也不会创建快照或打开数据库：

```powershell
.\deploy\probe-smb-snapshots.ps1 -Path 'X:\Docker\wechat\config'
```

`available` 会列出服务器返回的 `@GMT` 候选目录；仍需确认目录确属固定快照、覆盖完整 profile 和 WAL，并按下列步骤准备来源。`unsupported`、`none_advertised`、`access_denied` 或 `probe_failed` 都不会触发热复制、创建快照或自动放宽读取条件。当前用户共享实测为 `unsupported`；没有 SSH 也继续提供离线准备能力，但不能由文件共享推出可读取 NAS 进程内存。

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
