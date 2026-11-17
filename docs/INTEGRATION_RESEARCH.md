# QQ / 微信接入研究

查阅日期：2026-11-15。以下保留首批研究背景；实施阶段已固定源码版本并实现 HTTP 适配器，具体来源、路由和验证见 [后端实施记录](BACKEND_IMPLEMENTATION.md)。真实账号未验收。搜索摘要可能过时，以当前仓库、选定版本源码与实际验证共同判断。

## 三条路线

| 路线 | 能力 | 边界 |
| --- | --- | --- |
| 本地资料只读 | 已有历史、联系人与缓存媒体 | 不提供消息发送；实时性取决于其他进程写入与读取方式 |
| 官方客户端 + 桥接 | 由客户端负责通信，接口供新前端使用 | 可取消串流，但保留客户端和版本耦合 |
| 独立协议后端 | 自行登录、同步和发送 | 维护协议、账号兼容及长期运行可靠性要求较高 |

SnSBox 应适配以上来源，不把“改写数据库”等同于发消息，不把“数据库可解密”等同于完整客户端。

## 微信候选：Agent WeChat

- [仓库](https://github.com/thisnick/agent-wechat)
- [HTTP API](https://thisnick.github.io/agent-wechat/use/api/)
- [底层实现与限制](https://github.com/thisnick/agent-wechat/blob/main/packages/native-client-rust/README.md)
- [平台验收说明](https://github.com/thisnick/agent-wechat/blob/main/PLATFORM-ACCEPTANCE.md)

项目声明提供 Rust 独立通信后端、HTTP API 与事件流，可读取受支持的 Linux 微信资料并处理收发；从架构看适合作为优先研究候选。

其说明同时限定特定资料布局与有限真实账号验证：不能直接推出任意账号或版本兼容。接管目录要求停止官方客户端，完整历史与无缝切回官方程序不能保证。首页和底层文档对部分能力存在不同描述，必须固定版本核对，不以 README 中功能最多的描述作为合同。

下一步先核对候选版本、API 类型、支持的数据布局和资料所有权；获得账号实验授权后再验证文本链路。未知布局应拒绝接入，不能自动修改原始数据库。

## QQ 候选：Lagrange.Core V2 / Milky

- [当前仓库](https://github.com/LagrangeDev/Lagrange.Core)
- [Milky 功能清单](https://github.com/LagrangeDev/Lagrange.Core/blob/master/Lagrange.Milky/README.md)

当前仓库说明主分支为 V2，实现 QQ 通信并提供 Milky 接口。清单包含私聊/群聊发送、历史查询和事件，但已读、部分文件与转发相关能力仍不完整；传输方式也需按具体实现核对。

实施更新：固定版本源码已经提供 HTTP 与 SSE，早期 README 的未勾选清单落后于实现。SnSBox 使用这两类接口；历史恢复和登录管理仍有独立限制，不由传输接口存在推断可用。具体版本与源码链接见后端实施记录。

它不是 Rust 项目，可作为隔离侧车由 Rust 适配器调用。研究其登录条件、接口可用性、历史限制、依赖和分发许可后再决定是否采用；不能仅凭功能清单勾选认定已可日常使用。

## 不直接确定为依赖的旧方案

| 项目 | 本次查阅结果 | 处理 |
| --- | --- | --- |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | 当前主页只保留结束说明，搜索缓存仍有旧发布与文档 | 保留桥接思路参考；重新确认可维护来源前不作为默认依赖 |
| [WeChatFerry](https://github.com/lich0821/WeChatFerry) | 仓库已归档 | 不作为当前 Linux 主路线 |
| [chatlog](https://github.com/sjzar/chatlog) | 仓库公告说明代码已移除 | 不按旧教程承诺可下载、可维护 |

候选可用性可能变化。选型时重新检查维护状态、具体许可证及外部组件授权，不把可浏览代码等同于允许再分发；本批不代替用户选择整个新项目的开源许可证。

## M1 最小证据记录模板

每个平台只记录与当前实验相关的内容：

1. 上游来源、固定版本、运行系统与架构、资料布局；不要记录个人账号秘密。
2. 验证模式：文档审阅、离线样本、测试账号或实际授权账号。
3. 会话读取、新文本接收、文本发送、冷启动恢复各自结果。
4. 历史范围、事件恢复、发送回执含义和不支持的能力。
5. 是否触及源目录、备份与退出方式；不公开真实消息或联系人。
6. 决策：继续接入、保持只读、替换候选或等待缺失证据。

优先解决微信接入和资料兼容；QQ 复用现成实现。未经验证，不以开发一个漂亮空壳作为接入可行性结论。

## 第三轮：现成历史读取与取钥方案核对

用户补充要求遇到阻碍时寻找合适的现存项目，包括微信数据逆向工具。本轮继续复用 Agent WeChat 读取器，同时核对以下替代入口；没有在活跃 WS 上执行取钥、调试器、锁定或导出程序。

| 候选 | 主线程核对结果 | 当前决策 |
| --- | --- | --- |
| [chatlog-keeper](https://github.com/labazhou2024/chatlog-keeper/tree/d2feeec09a192af9a4738547b8543cf096386464) | 固定源码有 Linux 微信/QQ 读取、密钥管理、SQLCipher 和已提交 WAL 恢复；MIT。Linux 文档的 4.1.13.9 成功案例属于上游证据，未在本项目复现 | 可作为独立导出/转换来源候选，优先于自行重写密码学与 WAL |
| [wcdb-key-tool](https://github.com/TANGandXUE/wcdb-key-tool) | 文档区分旧版 raw-key 扫描与新版 Linux GDB 捕获派生参数；新版本路径要求重新登录 | 研究参考；不对正在使用的 WS 执行主动调试或重登录 |
| [wx-cli](https://github.com/windjc06/wx-cli) | 文档描述 Linux `/proc/<pid>/mem` 读取及本地解密缓存；页面指向其他上游/发行命名，尚未固定完整可运行来源 | 备用候选，不直接按安装脚本执行，不认定适配当前微信版本 |

对 chatlog-keeper 的额外源码审查：

- [`core/_snapshot.py`](https://github.com/labazhou2024/chatlog-keeper/blob/d2feeec09a192af9a4738547b8543cf096386464/chatlog_keeper/core/_snapshot.py) 默认复制 DB/WAL/SHM，并比较前后大小、mtime 和首尾内容指纹；有界重试是乐观稳定性检查，不等同文件系统原子快照，尤其不能直接保证跨 SMB/NAS 缓存的一致性。
- 同文件的 Windows `allow_active_wal` 路径会以 `r+b` 打开源 SHM 并取得排他锁；本项目活跃源只读模式不能启用此回退。禁止把工具文档的“只读导出”视为所有参数均符合当前约束。
- [`core/_wal.py`](https://github.com/labazhou2024/chatlog-keeper/blob/d2feeec09a192af9a4738547b8543cf096386464/chatlog_keeper/core/_wal.py) 实际校验 WAL/SHM 结构、帧和提交边界，再在派生明文文件上重放；协议要求的校验不属于额外文件 SHA 验收。
- [Linux 取钥说明](https://github.com/labazhou2024/chatlog-keeper/blob/d2feeec09a192af9a4738547b8543cf096386464/docs/linux.zh.md) 的主动模式启动并退出官方客户端子进程；被动模式也要求在客户端运行主机上读取进程内存并满足操作系统权限。本机只有文件共享路径，无法据此取得 NAS 进程内存，不能把“找到工具”说成“已获得密钥”。

后续接入可以接受已验证读取器生成的独立导出，保留来源、时间和覆盖范围。真实旧记录读取仍需要可用密钥及满足一致性要求的来源；不因当前缺少这些条件而放弃实现分页、检索与只读界面，也不把演示内容当作用户历史。

## 第四轮：仅 SMB 条件下的现场发现（2026-11-16）

- 用户没有 SSH 或快照接口信息，要求在现有条件下继续。通过 Windows 既有 SMB 连接，以只读目录句柄调用标准 `FSCTL_SRV_ENUMERATE_SNAPSHOTS`，不创建快照、不打开数据库、不请求写入、不取得数据库锁。新工具为 `deploy/probe-smb-snapshots.ps1`。
- 对用户指定 config 目录的实际响应为 `unsupported` / Win32 error 1。该共享没有通过本次标准枚举提供 Previous Versions；这不证明 NAS 的底层文件系统不具备快照能力。没有因此扫描其他共享、复制整个活跃库或自动设置一致性确认。
- 协议依据：[Microsoft SMB2 Previous Versions](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-smb2/c631e497-9a47-4537-9817-8af2a4834d03)。只有服务器返回的既有版本才可列为候选；枚举本身不证明数据库完整、密钥可用或版本覆盖范围。
- 进一步审查固定 chatlog-keeper 源码发现 `scripts/linux_memory_scan.c` 有 `PTRACE_ATTACH` 回退，需要核实具体调用链。后端线程确认普通 Linux passive Python 路径不调用此 helper，active 子进程路径可以调用。SnSBox 只保留独立 `core/_linux_process_memory.py` 的 `process_vm_readv` 读取与密钥验证函数，不带入 C helper、CLI、主动捕获或进程自动发现。SMB 文件共享本身不提供远端进程内存。
- [SQLite WAL 文档](https://www.sqlite.org/wal.html) 说明 WAL 与共享内存的读写协作条件。`mode=ro` 不等于零锁影响，也不能将活跃数据库错误标记为 `immutable` 来获取一致性；本轮不在现用源上调用备份 API 或 checkpoint。

## 第五轮：QQ 真实导出格式接入（2026-11-17）

已核对缓存中的固定 chatlog-keeper `d2feeec09a192af9a4738547b8543cf096386464` 源码，MIT 许可证。采用其现有 JSON 导出格式，在 Rust 中实现有限字段适配，没有另做 QQ 私有协议或 SQLCipher 解密，也未复制/调用上游 CLI：

- [`export.py:export_json`](https://github.com/labazhou2024/chatlog-keeper/blob/d2feeec09a192af9a4738547b8543cf096386464/chatlog_keeper/export.py) 将消息列表原样写成 UTF-8 JSON 数组，不是 JSONL，也不是 SnSBox 自定义消息封装。
- [`qq_db.py:QQDBReader.read_recent_dicts`](https://github.com/labazhou2024/chatlog-keeper/blob/d2feeec09a192af9a4738547b8543cf096386464/chatlog_keeper/qq_db.py) 输出账号、会话、类型、发送人、`ts`、`content` 等字段。固定路径正文最多 1500 字符，`msg_id` 为 null，`source_offset` 以会话和秒数构造，可能重复；不可拿它作为唯一消息 ID。
- [`cli.py:_export_qq`](https://github.com/labazhou2024/chatlog-keeper/blob/d2feeec09a192af9a4738547b8543cf096386464/chatlog_keeper/cli.py) 最终写 `qq_messages.json`，补全 `account_id`、`conversation_id`、`conversation_type: direct/group` 和 `is_self`。账号标识不能归一为 QQ 号码时，`is_self` 仍可能为 false；SnSBox 不把这种 false 冒充确知的入站方向。群聊与好友同号、多个账号同会话号必须分开。

SnSBox 配置 `format: chatlog-keeper-qq-json` 直接读取已经完成的独立文件，限制 64 MiB / 10 万条；只写自有索引，原 JSON 不改写，附件元数据和未知字段不进入产品模型。账号、会话类型和会话 ID 共同作用域化，行号避免导出内部消息碰撞。分页、搜索、鉴权与代际游标复用原历史模块。成功为 `partial`，重启后仍说明上游时间窗口、正文截断和附件缺失。部署见 [HISTORY_SETUP](../deploy/HISTORY_SETUP.md)。

本轮针对性验证为合成的真实字段格式，不能证明现场 NTQQ 解密、密钥或完整历史可用。没有在活跃 NAS 上执行 chatlog-keeper 初始化/导出、进程读内存、注入或调试。主线程另行审查 WeQ 的本地凭据复用：其 pure-protocol quickLogin 需要网络认证/新会话，可能手机确认，并非离线读取数据库密钥；当前未执行。最大未决项仍是取得用户授权范围内、与现用客户端隔离的实际 QQ 导出或可解密一致性副本。

## 第六轮：优先完成解密后的加载（2026-11-17）

用户明确本轮不强求真实取钥，允许同格式合成已解密数据。已实现 [qq-decrypted](../tools/qq-decrypted/README.md)：标准库离线工具将独立明文 `nt_msg.db` 复制到私有临时目录，再只读连接自己的副本；从 `c2c_msg_table` / `group_msg_table` 数字列读取并生成 `snsbox-qq-decrypted-v1`，复用 Rust 历史索引。未访问活跃 X:，没有登录、进程访问、解密或网络调用。

本次进一步发现固定上游的实质限制：`_query_message_dict_page` 虽在记录层注释“不限制正文长度”，底层 `_extract_msg_text` 第 1859 行仍 `return " ".join(out)[:1000]`；因此上一节 1500 字符只是外层上限，不能视为实际保留长度。新工具只提取 MIT 许可的纯解析函数与字段常量，移除最终 1000 字符截断、保留前后空白，并禁用未知二进制的暴力 UTF-8 兜底。没有复制整个 `qq_db` 取钥/凭据/临时库模块，没有新增私有 protobuf 解析实现；测试 fixture 中的最小 protobuf 编码只用于构造合成库。完整来源、行范围、许可证与修改在 [vendor/SOURCES.md](../tools/qq-decrypted/vendor/SOURCES.md)。

普通字段 45101 的长文保留到明确的 64 KiB UTF-8 上限，超限整条保留 unknown 占位而非截断。引用、卡片、系统消息仍使用上游有限摘要；未知类型与附件未完整展开，成功仍标 `partial`。所有支持表行均读取，无最近几天窗口；上限为 2 GiB 输入、64 MiB / 10 万条输出、4 MiB 单条 BLOB，schema/总量失败不发布清单。

WeQ 的另一个候选也已排除为当前格式契约：主线程核查本地固定 `ec0f4f9` 的 `schemas/export/v1/README.md` 明确是“待实现设计，尚未接入业务导出器”，不能把规范草案当实际可导入产物；其当前代码许可为 CC BY-NC-SA 4.0，本工具未复制。仍以已实现的 chatlog-keeper MIT 解析器为基准。

证据：转换器 Windows/Linux 两项定向测试通过；账号 A 合成 SQLite 124 条 / 2 会话（122 可展示、2 未知占位），账号 B 2 条 / 2 会话，5029 字符长文未截断。主线程使用生成器 → 转换器实际产物完成 AMD64 容器 HTTP 检查，126 条索引、长文尾部搜索、未知占位、上下文分页和代际边界通过。以上不是实际用户明文库版本兼容或真实 QQ 解密验收；下一项最大不确定性是非合成已解密库的列布局、消息变体与完整附件覆盖，本轮不以取钥阻塞软件链路交付。
