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
