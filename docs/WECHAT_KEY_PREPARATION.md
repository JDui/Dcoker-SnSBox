# 微信历史密钥准备与转换

日期：2026-11-16。实现文件：[prepare.py](../tools/wechat-key-import/prepare.py)；固定来源及修改说明：[SOURCES.md](../tools/wechat-key-import/vendor/SOURCES.md)。这是独立 Linux 准备工具，不加入网页/API，不自动运行，不扫描共享盘或发现账号。主服务继续采用 Rust；准备工具复用现有 Python 标准库实现，不增加新的密码学实现或运行依赖。

## 本轮能交付什么

- `import-cache`：读取明确指定的 chatlog-keeper 64-hex 缓存文件，将它视为候选密钥；对独立资料副本的每个 `.db` 分别判断 raw-key 或 password-mode，输出 `wechat-profile = 2.5.0` 的 KeyFile。
- `scan`：在客户端所在 Linux 主机及可见的 PID namespace 中，对明确 PID、明确 executable 使用 `process_vm_readv` 读取候选。仅读取 `/proc/<pid>/maps`、进程身份和内存，不打开 `/proc/<pid>/mem`，不附加调试器、发信号、暂停、重启、注入、调用网络或自动提升权限。
- 两个入口均需要操作者确认的独立一致性副本。只以普通文件读取每个数据库的前 4096 字节；不打开 SQLite、不处理源 WAL/SHM、不解密导出消息。准备成功只说明候选认证了这些首屏，不等于整个数据库健康、历史完整或真实账号适配完成。
- 密钥只能写入已存在、当前 UID 所有的 `0700` 私有目录，新文件 `0600`，拒绝覆盖。输入缓存也要求当前 UID 所有、`0600` 及私有父目录。输出不包含原始内存、主密钥或消息；KeyFile 本身包含逐库 page key，仍必须作为密钥保护。

当前只有 `X:\Docker\wechat\config` 的 SMB 可达性，没有 NAS 进程内存或主机执行能力。**本轮没有读取真实进程、取得真实密钥，也没有触碰活跃 WS**。无需提供 SSH 信息即可完成离线转换工具及合成验证；实际被动扫描只能在将来具备已授权主机执行条件时进行。

## 现成方案审查结论

固定 chatlog-keeper 源码为 `d2feeec09a192af9a4738547b8543cf096386464`，MIT。

1. [wechat_db.py 的 `_scan_linux_memory_for_key`](https://github.com/labazhou2024/chatlog-keeper/blob/d2feeec09a192af9a4738547b8543cf096386464/chatlog_keeper/wechat_db.py) 调用 Python `iter_process_memory_chunks`；其 [内存模块](https://github.com/labazhou2024/chatlog-keeper/blob/d2feeec09a192af9a4738547b8543cf096386464/chatlog_keeper/core/_linux_process_memory.py) 在 `EPERM/EACCES` 时抛出拒绝错误，不调用 ptrace。只抽取该模块及 SQLCipher 首屏验证/派生函数，避免整个上游 CLI 的其他行为。
2. [C helper](https://github.com/labazhou2024/chatlog-keeper/blob/d2feeec09a192af9a4738547b8543cf096386464/chatlog_keeper/scripts/linux_memory_scan.c) 的 `read_remote` 确有 `PTRACE_ATTACH` → `waitpid` → `PTRACE_PEEKDATA` 回退，退出时 `PTRACE_DETACH`。`linux_key.py` 的 active 子进程路径会调用它；不能仅根据“只读/passive”字样承诺不暂停。本工具不分发、不编译、不加载该 helper，也无失败回退入口。
3. [`process_vm_readv` 手册](https://man7.org/linux/man-pages/man2/process_vm_readv.2.html) 明确它受 `PTRACE_MODE_ATTACH_REALCREDS` **权限检查**控制；这不等于执行 `PTRACE_ATTACH`。读取不是原子操作，可能短读。[Yama](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html) 限制、同 UID/dumpable、容器 PID/user namespace、seccomp/LSM 都可能阻止读取。本工具只报告拒绝，不更改 sysctl、capabilities、客户端状态或沙箱策略。不暂停也不代表零 CPU、内存或分页开销。
4. 支持的候选形态来自上游：`x'<64..192 hex>'` 的前 32 字节，以及 NUL 结尾的 64-hex 字符串。它不是全内存任意 32 字节穷举；跨块候选、不同分配位置、未驻留密钥、新版本的内部表示都可能漏掉。
5. [上游 Linux 说明](https://github.com/labazhou2024/chatlog-keeper/blob/d2feeec09a192af9a4738547b8543cf096386464/docs/linux.zh.md) 报告 4.1.13.9 x86_64 的 **active GDB KDF 捕获**成功，不能转述成被动扫描成功。主密钥 password-mode 与 raw-key 均通过 HMAC 判别，不以版本字符串猜测。任何真实 Linux 微信版本在本项目均尚未验收。
6. [wcdb-key-tool](https://github.com/TANGandXUE/wcdb-key-tool/tree/79f1b5b92e12c66aa281b4a60a3c478b5f547dfa) 固定参考 revision `79f1b5b92e12c66aa281b4a60a3c478b5f547dfa`；其面向新版本的 ELF/GDB 路线不符合本轮无调试附加、无重登录边界，不作为执行后备。

## 为什么不能直接把 64-hex 改成 Base64

chatlog-keeper 缓存是 32 字节候选的十六进制表示，不标明它一定是 page key。工具复用上游 `_effective_page_key`：先用 raw-key 检查 SQLCipher4 页一 HMAC；不匹配时，使用该库 16 字节盐值执行 PBKDF2-HMAC-SHA512、256000 轮、32 字节输出，再验证 HMAC。每库单独处理，password-mode 不同盐值会得到不同 page key。

输出包含 `schemaVersion:1`、`format:"official-linux"`、账号目录名 `accountBinding`、SQLCipher4 参数，以及每库相对路径、`saltHex`、`rawPageKeyBase64`；`imageDat:null`，不伪造图片密钥。所有发现的数据库均需匹配才生成文件，部分匹配返回 `incomplete_key_coverage`。目录名只是绑定提示，密钥有效性由逐库 HMAC 提供。

这些是必要密码学验证，不是额外文件 SHA 摘要验收。工具没有手工文件摘要比对步骤。

## 离线缓存转换

需要 Linux、Python 3.10+ 标准库、独立副本和已有合法获得的缓存。普通 Windows/SMB ACL 不能代替这里的 Linux 文件权限检查；可在隔离 Linux 容器内只读挂载副本并使用私有 Linux 卷。不要挂载正在使用的 WS 源。

```sh
python3 tools/wechat-key-import/prepare.py import-cache \
  --snapshot /snapshots/synthetic-or-authorized-account \
  --confirmed-snapshot \
  --key-file /private/input/account.key \
  --output /private/output/history-wechat-keys.json
```

`--key-file` 可重复，最多 16 个；不自动枚举其他账号缓存、不生成缓存文件名摘要。若当前主机可见活跃资料路径，增加 `--active-root /live-profile`，拒绝源或输出与之重叠。所有打开的路径组件均拒绝符号链接；数据库及缓存拒绝硬链接/特殊文件。边界仍依赖管理员不并发改变挂载及确认的副本，不将路径检查称为文件系统快照。

KeyFile 生成后交给 [既有历史配置](../deploy/HISTORY_SETUP.md)。服务 UID 默认 `10001`，密钥的 Linux 所有者也须匹配；不要降低读取器权限校验。工具不自动改所有者或现有文件权限。

## 被动扫描准备入口（未在真实客户端运行）

下面只说明已实现接口；不授权在现用客户端执行，也不是本轮要求用户补主机访问条件。必须在进程所在 Linux 环境执行，不能从 Windows 的 SMB 映射读取远端 `/proc`。

```sh
python3 tools/wechat-key-import/prepare.py scan \
  --pid 12345 --expected-exe /opt/wechat/wechat \
  --active-root /live-profile \
  --snapshot /snapshots/independent-account --confirmed-snapshot \
  --output /private/output/history-wechat-keys.json --timeout 30
```

显式 PID 和 executable 在扫描前后核对，包含 starttime；不自动选择进程。最多扫描 512 MiB、128 个去重候选、256 个 DB、10000 个目录项和 16 层目录；单次上限 120 秒，期限在读取/派生之间检查，不保证中断正在执行的系统调用或单次 KDF。失败不会自动增加权限、重试主动模式或生成不完整 KeyFile。禁用工具自身 core dump，但 Python 无法保证所有 secret 内存副本及时清零。

## 固定错误与验收

终端只输出一行 JSON 状态和计数，不输出密钥、PID、账号、路径、正文或底层异常。返回码成功 0、失败 1；参数用法错误由 argparse 返回 2。

| code | 含义 |
| --- | --- |
| `process_access_denied` | 内核拒绝内存读取；没有 attach/提权回退 |
| `process_identity_mismatch` / `process_changed` | executable/PID 身份不符或扫描期间改变 |
| `no_matching_key_or_unsupported_layout` | 扫描中没有通过验证的候选；不能区分密钥不在内存与版本/形态不支持 |
| `key_mismatch` / `incomplete_key_coverage` | 缓存不匹配，或只有部分 DB 匹配；不生成输出 |
| `snapshot_confirmation_required` / `active_source_overlap` | 缺少独立快照声明或路径触及已知活跃源 |
| `private_key_file_required` / `private_directory_required` | 私有权限/所有者不满足 |
| `unsafe_file` / `unsafe_path` / `output_exists` | 链接、特殊文件、路径异常或已有输出 |
| `scan_timeout` / `conversion_timeout` / `*_limit_exceeded` | 达到读取/候选/时间上限，不扩大扫描 |
| `source_changed` | 重读首屏/目录发现改变；不会称为一致性快照 |

合成验收入口 [fixture](../tools/wechat-key-import/fixture/Cargo.toml) 使用固定 `wechat-profile 2.5.0` 和真实 SQLCipher：生成 password/raw 两类库、合成联系人/会话/三条消息，再由转换器产生 KeyFile，最终用 `ProfileReader` 解密查询。仅合成资料可用此 fixture builder；`create` 拒绝已有目标目录，不复用真实资料。

```sh
cargo build --locked --manifest-path tools/wechat-key-import/fixture/Cargo.toml
python3 tools/wechat-key-import/test_prepare.py \
  --fixture-tool tools/wechat-key-import/fixture/target/debug/snsbox-key-fixture -v
```

组件检查与主线程 `history refresh` HTTP 验收分开记录；不运行全套应用测试。最大剩余不确定性仍是实际微信构建的内存表示、主机权限、可用缓存以及独立一致性来源，不是 JSON 格式。

## 本轮实际结果与关机交接

2026-11-16 收尾状态：

- Rust fixture 已编译成功。最终夹具只含合成 contact/session/message 三库。
- password-mode 与 raw-key-mode 均由 `prepare.py import-cache` 逐库验证并转换，随后实际 `wechat-profile 2.5.0` 的 `KeyFile::load` + `ProfileReader` 成功解密查询：各 1 个会话、3 条消息，联系人非空；不是仅验证 JSON 字段。
- 5 项定向组件检查全部通过（1.302 秒，不含已完成的编译）：两种模式真实读取器消费；错误缓存/不安全权限拒绝；源目录/链接/覆盖边界；模拟内核拒绝且无回退；仅对专门创建的合成 Python 子进程被动扫描，检查其无 tracer、未停驻并正常退出。未运行真实微信进程取钥。
- 首轮失败包括输出同级路径误拒、初始合成会话为空，以及排查时产生过无效字段命名的中间 KeyFile。均已修正；`round1` 不作为交付或验收依据。不要把主线程针对 `round1` 得到的 `keys_required` 当成最终 `round2` 结果。
- 截至 2026-11-16 收尾，主线程 HTTP/history refresh 集成验收尚未确认；2026-11-17 的续验结果见下文。真实资料、真实密钥、NAS 主机权限和实际微信版本仍未验收。
- 格式化工具 `cargo-fmt` 在当前构建镜像未安装，未为此下载组件；没有扩大全套测试，没有提交或推送。

保留的交接卷为 `snsbox-key-preparation-fixtures`。以卷根挂载 `/fixtures` 时，最终路径是：

| 内容 | 卷内路径 |
| --- | --- |
| password-mode 独立合成资料 | `/fixtures/round2/synthetic-password` |
| 转换所得 password-mode KeyFile | `/fixtures/round2/password.keys.json` |
| raw-key-mode 独立合成资料 | `/fixtures/round2/synthetic-raw` |
| 转换所得 raw-key-mode KeyFile | `/fixtures/round2/raw.keys.json` |

`round2` 已归属 `10001:10001`；私有父目录 `0700`，密钥 `0600`。卷内还保留合成输入缓存及不可用于验收的 `round1` 中间结果，未清理。**不要在主线程验收完成前删除该卷。**

本线程临时检查/构建容器均以 `--rm` 启动且已结束，没有需保活的临时容器。本线程新建的 `snsbox-key-tools-target` 是可再生 Rust 构建缓存卷，可由主线程决定后续清理；`snsbox-key-preparation-fixtures` 是交接资料卷，当前保留。共享的 `snsbox-cargo-cache` 不属于本轮清理范围。现用 WS、`snsbox-mvp`、`snsbox-mvp-wechat` 均未由本轮工具修改或重建。

### 2026-11-17 HTTP 续验

主线程执行 `node tools/history-smoke.mjs` 成功：使用 round2 合成资料及转换所得 KeyFile，经 HTTP history refresh 返回来源 `ready`，会话数 1、消息数 3、搜索结果数 3。这补齐了转换工具 → KeyFile → 主服务 HTTP 历史读取的集成证据；没有重跑旧 round1 失败夹具或重复组件测试。

本次通过仍仅针对合成资料，不表示已经取得真实密钥、读取现用 WS 历史，或支持用户实际微信构建。下一项最大不确定性仍是可用的真实密钥与独立一致性来源；不因此扩展现用进程操作，也不把 SMB 文件访问当作 NAS 内存读取能力。
