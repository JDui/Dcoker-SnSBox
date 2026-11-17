# 既有历史的独立副本准备

日期：2026-11-17。实现文件：[prepare.py](../tools/history-snapshot/prepare.py) 与 [stage-compose.py](../tools/history-snapshot/stage-compose.py)，Python 3.10+ 标准库；不改变 Rust 主服务、不引入新运行时依赖。工具不会创建 NAS 快照、停止微信、提取密钥或连接输入端 SQLite。

当前只有 SMB，没有 SSH 或快照接口信息。2026-11-17 用户更换 NAS，当前活跃 config 为 `X:\Docker\selkies\config`；路径迁移时先仅确认目录元数据可达，随后已对新路径独立执行只读 SMB Previous Versions 枚举，实际结果见下文。旧 `X:\Docker\wechat\config` 的探测证据保留原日期，不代替新 NAS 检查。本工具已完成可执行准备链路，但不会因此把活跃目录热复制并标为一致。真实源仍缺独立一致来源和匹配密钥，尚未读取其记录。

### 新 NAS 只读枚举结果（2026-11-17）

审阅并执行 `deploy/probe-smb-snapshots.ps1 -Path 'X:\Docker\selkies\config'`：使用既有 SMB 连接，以 `GENERIC_READ`、共享 READ/WRITE/DELETE、`OPEN_EXISTING` 打开目录句柄，仅调用 `FSCTL_SRV_ENUMERATE_SNAPSHOTS` 查询已有版本。没有遍历资料、读取数据库、复制文件、创建快照或请求源写权限。

本次返回 `status: unsupported`、`nativeError: 1`、`snapshots: []`、`readOnly: true`、`createsSnapshot: false`、`confirmedConsistentSnapshot: false`。这表示新共享未通过本次标准 SMB 枚举提供 Previous Versions，**不证明 NAS 底层没有快照功能，也不等于成功枚举后确认快照总数为零**。没有据此启用热复制或自动确认一致性。该结果与 2026-11-16 旧 NAS 的同类返回是两次独立证据。

## 路线判断

| 路线 | 现成能力与本项目边界 |
| --- | --- |
| SQLite Online Backup | 能产生数据库级一致备份，但读取期间会取得源读锁。当前活跃 WS 不允许加锁或触碰 SHM，因此不对它运行 `.backup`、VACUUM INTO 或数据库连接；只在本工具新建的私有明文副本上复用 backup。 |
| NAS 文件系统快照 | 已有只读快照可保存同一捕获点的 DB/WAL。应在独立路径挂载后使用；存储层时间点一致不等于应用层跨多个库的事务一致，也不等于完整历史。 |
| Btrfs / ZFS | 复用 NAS 已有快照机制，不实现另一套快照算法。Btrfs 嵌套子卷不随父卷递归快照；ZFS 递归快照有自己的范围条件。缺少主机信息时不猜测文件系统或执行管理命令。 |
| SMB Previous Versions | 可先用主线程提供的 [只读枚举工具](../deploy/probe-smb-snapshots.ps1) 检查服务器暴露的已有历史版本。它不创建快照；unsupported/空列表不证明 NAS 从来没有内部快照，也不提供当前可读的快照路径。 |
| DB/WAL 普通热拷贝 | 前后大小、mtime、文件列表相同仍不能证明原子一致，尤其涉及 SMB 缓存。默认保持 `confirmedConsistentSnapshot: false`，不自动升级。 |

依据：[SQLite Backup API](https://www.sqlite.org/c3ref/backup_finish.html)、[SQLite WAL](https://www.sqlite.org/wal.html)、[Btrfs subvolume](https://btrfs.readthedocs.io/en/latest/btrfs-subvolume.html)、[ZFS snapshot](https://openzfs.github.io/openzfs-docs/man/master/8/zfs-snapshot.8.html)。SQLite 将 WAL 视为持久状态的一部分；本工具保留 DB+WAL，在私有副本中重建 SHM，绝不靠移除源 WAL/SHM 来“修复”。

## 工具实际完成什么

- 接受账号根、`db_storage` 或只含一个账号的上层目录；有界发现单个资料，多账号时要求选择具体账号，不自行合并。
- 只检查支持的 session/contact/message 布局、文件类型、容量、文件列表/大小/mtime，以及 DB 的 16 字节格式头。分类 `encrypted_or_unknown` 不是已识别 SQLCipher 或已解密；密钥文件仅检查路径存在，不读取或验证密钥内容。
- `copy` 默认只复制 `db_storage` 中的 DB+WAL，保留原账号目录名以供上游账号绑定；不复制登录材料、附件、SHM。SHM 只观察目录项元数据，不打开、不加锁、不复制。
- `mount` 生成指向已有独立快照的只读 bind，不复制数据。不会把一个活跃目录经 `:ro` 挂载后说成快照；只读挂载本身不能冻结另一个写入方。
- 自动生成 `history-sources.json`、`compose.history.yaml`、`preparation-report.json`，使用绝对路径、长语法只读 bind 和 `create_host_path:false`；JSON 为有效 YAML。路径中 `$` 转为 Compose 的 `$$`，防止账号名或目录中的 `${...}` 被解释为环境变量。历史清单保留实际原始目录名。
- 输入与已知活跃根、自有 `data`、输出互相隔离；拒绝符号链接、Windows junction/reparse point、特殊文件、非空 rollback journal、过大或变化的输入。输出必须是新目录，不覆盖；仓库内输出必须在忽略的 `private/` 下。失败保留 `INCOMPLETE.json`，不得消费该目录，应另选新输出路径。
- 私有目录/文件在 POSIX 分别以 0700/0600 创建。Windows 模式位不能替代 Linux 密钥权限；部署 UID、ACL 与密钥安全检查仍按 [历史部署说明](../deploy/HISTORY_SETUP.md) 执行。程序不修改输入权限。

工具未扫描 SMB 别名对应关系。必须对所有已知映射盘和 UNC 活跃别名重复传入 `--active-root`；路径护栏不能证明未知网络别名、远程后端对象或恶意并发替换完全相同。把快照挂载在活跃根之外；不会为了接受快照而放宽活跃根重叠检查。

## 未确认副本：检查并生成阻塞配置

仅对已经独立的副本执行；下例路径都是占位，不是让工具复制当前运行中的 WS。

```powershell
python tools/history-snapshot/prepare.py inspect "D:\IndependentCopy\account" --active-root "X:\Docker\selkies" --active-root "X:\Docker\wechat"
python tools/history-snapshot/prepare.py prepare "D:\IndependentCopy\account" --active-root "X:\Docker\selkies" --active-root "X:\Docker\wechat" --output "private/history-unconfirmed"
```

默认 `source-kind=unverified-copy`。即使元数据稳定，也生成 `confirmedConsistentSnapshot:false`；缺密钥同时报告 `keys_required`。不能加确认开关将该类型绕过为一致来源。

退出码：0 为已生成/检查完且具备尝试读取的前置条件；3 为检查/准备完成但仍有条件缺口；2 为输入、隔离或复制失败。标准输出只含状态、数量和静态错误，不打印路径、账号目录、快照引用、正文或密钥。

## 已有真实 NAS 只读快照

操作者需要知道该路径确实属于 NAS 生成的独立只读快照，并提供真实捕获时间/引用。工具不会仅凭 `@GMT` 文件夹名或用户输入的字符串证明快照存在。

```powershell
python tools/history-snapshot/prepare.py prepare "Y:\KnownReadOnlySnapshot\config" --active-root "X:\Docker\selkies" --active-root "X:\Docker\wechat" --source-kind nas-snapshot --snapshot-reference "actual-snapshot-reference" --captured-at "2026-11-16T08:00:00+08:00" --confirm-consistent-source --keys-file "private/history-wechat-keys.json" --output "private/history-prepared"
```

`copy` 将账号目录中的 DB+WAL 复制到新 bundle；如果 Docker 运行主机本身能访问快照路径，可加 `--mode mount`，省去重复复制。Windows/SMB 路径必须可供当前 Docker daemon 挂载；在 NAS/Linux 生成的宿主路径不能直接拿到 Windows daemon 使用，反之亦然。

确认来源类型包括 `nas-snapshot`、已由兼容导出工具完成的 `offline-export`、仅供测试的 `synthetic-fixture`，均要求显式确认、引用和带时区捕获时间；它们是来源生产方/操作者声明。报告中 `verifiedByTool:false` 明确表示工具没有证明 NAS 管理状态。元数据检查只检测部分变动，不是原子快照证明。

`readyForReader:true` 只表示来源声明和必要文件条件足够发起读取，**不代表密钥正确、数据库可解密、schema 兼容或真实历史验收成功**。加密库的验证留给固定的 `wechat-profile` 读取器。不要在工具参数、源码或文档里写数据库密码/密钥。

## 交给 UID 10001 服务运行

准备完成、没有 `INCOMPLETE.json` 后，Windows bind 或 root 生成的 `0700/0600` bundle 推荐先暂存到自有 Linux 卷。需要已有本地 `snsbox:0.1.0` 镜像；工具不拉镜像、不启动主服务：

```powershell
python tools/history-snapshot/stage-compose.py private/history-prepared --active-root "X:\Docker\selkies" --active-root "X:\Docker\wechat" --output private/history-deployment
docker compose -f compose.yaml -f private/history-deployment/compose.history.yaml config --quiet
docker compose -f compose.yaml -f private/history-deployment/compose.history.yaml up -d
```

把保护路径占位改为所有已知活跃根，可重复 `--active-root`。已有网络登录 overlay 时继续叠加该文件，不叠加旧的 history overlay，不删除账号配置。网页“既有历史”点击读取后才执行实际解密/索引验证。

暂存只读读取完成 bundle 引用的 profile 和明确 key 文件，通过本地 Docker stdin 复制 DB/WAL、来源清单和密钥到两个全新卷；不复制 SHM，不修改输入权限。一次性 root 容器仅初始化新卷，保留账号目录名及原一致性声明；复制后目录 `0700`、文件 `0600`、所有者 `10001:10001`。主服务仍为 UID 10001，输入卷只读，scratch 独立可写；所有挂载禁用 Docker 空卷复制，避免初始化权限被镜像目录权限覆盖。没有降低 KeyFile 保护或宣称已验证密钥。

工具拒绝远程 Docker context、已有输出/目标卷、链接及特殊文件；复制或权限检查失败不发布最终 Compose，保留 `INCOMPLETE.json`。生成的 `deployment.json` 记录两个卷名，卷为 external，不会被普通 Compose down 删除；更换来源要生成新部署目录。卷内含私有资料，保留与清理应按实际部署处理。直接 bind 的原 overlay 仍保留，但仅适用于宿主已保证 UID 10001 可读、密钥权限符合要求的环境。

## 明文兼容导出：只在新副本恢复 WAL

可信且已经完成一致性导出的明文资料可显式 `--allow-plaintext`。可选 `--normalize-plaintext` 将新复制的 DB+WAL 交给 Python 标准库 SQLite backup，并在新输出库执行一次 `quick_check(1)`；成功后输出自包含 DB。此选项只支持 `copy`，不会将 SQLite 连接指向输入；它不能补救本来不一致的热拷贝，不能解密 SQLCipher。

```sh
python tools/history-snapshot/prepare.py prepare /mnt/independent-export/account \
  --active-root /mnt/active-ws --source-kind offline-export \
  --snapshot-reference actual-export-reference --captured-at 2026-11-16T00:00:00Z \
  --confirm-consistent-source --allow-plaintext --normalize-plaintext \
  --output private/history-plaintext
```

## 本轮专项证据与剩余不确定性

执行 `python tools/history-snapshot/test_prepare.py`：两项检查通过，0.371 秒，全为临时合成资料，没有访问 X:。

1. 明文 WAL 中已提交记录通过私有副本 backup 保留；源所有文件字节保持不变，SQLite 连接被约束在新副本；不读 SHM、不复制登录材料，生成只读配置且拒绝覆盖输出。
2. 不透明“加密样式”字节原样复制，保持缺密钥/未确认；活跃根、输入/输出重叠、虚假热拷贝确认、复制期间变化及 rollback journal 被拒绝；特殊字符路径保留并转义 Compose 插值。该夹具只验证复制，不声称验证了密码学。

补充定向检查已完成：生成的 Compose 经 `create` 后，容器挂载目标保留原始 `${…}` 与中文目录名、bind 为只读；检查容器没有启动。独立复制脚本运行的 CLI 也通过，未确认副本返回退出码 3，生成的来源仍未确认一致性，标准输出不含源路径。此后按关机要求停止新增测试/构建。

主线程另负责真正兼容 SQLCipher 的合成 profile、密钥格式转换和现有镜像 HTTP 集成检查，结果见 [执行记录](EXECUTION_STATUS.md)，本文件不提前宣称其结果。没有运行无关全套应用测试，没有增加手工 SHA 验收。

2026-11-17：`python tools/history-snapshot/test_stage_compose.py` 聚焦检查 1 项通过（5.391 秒），覆盖宽权限合成 key 输入不变、Linux 卷内 `10001:10001/0600`、真实 UID 10001 读取和 scratch 写入、历史卷拒写、远程 Docker 拒绝、已有输出/链接/途中失败不发布。该检查只使用本地临时合成资料，不访问 X:，不重复运行 history-smoke。

主线程随后实际运行 `tools/history-compose-smoke.mjs` 通过（约 7 秒）：直接使用生成 Compose、未由测试手工 chown 或改写清单、源 key 不变；合成来源 ready，1 个会话、3 条消息、搜索 3 条。该结果证明本轮合成部署链路，不代表用户真实历史可读；完整记录由主线程维护在执行记录中。

下一项最大不确定性仍是得到当前部署可访问的真实一致性来源及授权密钥。SMB 不提供已有历史版本且没有其他接口时，当前工具无法凭空生成该来源；保持阻塞状态，同时交付可在来源就绪后直接执行的准备和导入链路。
