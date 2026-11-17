# 已解密 QQNT SQLite 的离线转换

`convert.py` 将**已经解密、独立且停止变更**的 QQNT SQLite 转为 SnSBox 历史来源；Python 3.11+，仅标准库。消息解析复用固定 chatlog-keeper 的 MIT 代码，来源和局部修改见 [vendor/SOURCES.md](vendor/SOURCES.md)。工具不取钥、不登录、不联网、不发现进程，不操作现用 QQ。

## 实际支持范围

| 项目 | 支持 |
| --- | --- |
| 文件 | 从第 0 字节开始是 `SQLite format 3\0` 的普通 SQLite；不支持加密库或带 1024 字节 QQ 包装头的文件 |
| 表 | `c2c_msg_table`（私聊）、`group_msg_table`（群聊）；至少一个存在，存在的表都必须符合 schema |
| 必须列 | `40050` 秒级时间、`40033` 发送人 QQ、`40800` 消息 protobuf BLOB；私聊 `40030` 对端号 / 群聊 `40021` 群号 |
| 可选列 | `40001` 消息 ID、`40090` 发送人显示名；表必须有 SQLite rowid |
| 账号 | 显式 `--account-id` 绑定输入库；不从路径或登录凭据推断 |
| 文字 | 上游字段 40800 / 45101 的普通文字；已去掉最终 1000 字符截断，保留前后空白；不套用最近几天时间窗口 |
| 复杂内容 | 复用上游文字摘要、附件名称提示；引用仍最多 120 字符，部分卡片/系统标签更短，嵌套最多 3 层，相邻相同片段可能合并；不保证复杂消息无损 |
| 未知与超限 | 保留同一会话中的 `unknown` 占位，不盲扫二进制、不静默丢行；报告按原因计数 |
| 不支持 | 密钥、解密、checkpoint、WAL 重放、附件下载、完整表情/卡片、辅助联系人库；新版本不同列名不会猜测适配 |

只读取输入文件并先复制到私有临时目录，SQLite 只连接这份副本，使用 `mode=ro&immutable=1`、query-only 和禁用 trusted schema。输入旁有 `-wal` / `-shm` / `-journal` 即拒绝；工具不会在源上 checkpoint 或删除它们。必须由调用者确认输入已是完成且一致的明文导出；无 sidecar 和前后元数据稳定只是额外检查，不能证明任意热复制完整。

限制：输入 2 GiB、输出 64 MiB / 10 万条、单条 BLOB 4 MiB、解析文字 UTF-8 64 KiB。单条超限保留占位并报告；总量、无效时间/会话或 schema 错误整批失败，不发布可用清单。查询有 120 秒预算。输出状态仍 `partial`，表示附件、未知类型和复杂摘要范围有限，不表示普通长文本被截成 1000/1500 字符。

## 转换与挂载

`--output-dir` 必须不存在、父目录已存在；不得位于输入目录或任何保护目录内。多个账号分别转换、各用唯一 `--source-id`，再合并生成的配置数组。

```powershell
python -B tools/qq-decrypted/convert.py `
  --database C:/private/qq-independent/account-a/nt_msg.db `
  --account-id ACCOUNT_ID `
  --output-dir C:/private/qq-exports/account-a `
  --source-id qq-history-a `
  --active-root X:/Docker/selkies --active-root X:/Docker/wechat `
  --confirmed-independent-copy `
  --container-path /history-qq/qq_messages.json
```

产物 `qq_messages.json`、`history-sources.json`、`report.json` 均在新目录中。Linux 目录 0700 / 文件 0600；Windows 的 chmod 不代替 ACL，应使用已有私密目录。`history-sources.json` 最后发布，`format` 为 `snsbox-qq-decrypted-v1`，`capturedAt` 是本次转换时间。`report.json`/标准输出只有计数和限制，不输出账号、正文或密钥。

将产物目录以只读方式挂载到 `/history-qq`，配置文件也只读挂载，设置 `SNSBOX_HISTORY_SOURCES_FILE`。需让容器 UID 10001 可读，原客户端资料权限不变。可复用 [QQ Compose overlay](../../deploy/compose.history-qq-export.example.yaml)，调整到实际独立输出目录。原 `chatlog-keeper-qq-json` 格式继续可用，不能仅修改旧导出的格式标签来宣称恢复已截断正文。

新格式记录沿用账号/会话/时间/content 字段，增加 `decode_status: decoded/unreadable`、可选 `decode_error_code`。不可读记录 `content` 为空，Rust 显示固定提示，不把错误代码当正文。`msg_id` 是不透明字符串，`source_offset` 为表名与 rowid；索引仍以来源/账号/类型/会话/导出行号隔离，刷新后游标失效，不跨导出去重。

## 可重复合成库

```powershell
python -B tools/qq-decrypted/fixture.py --output-dir C:/private/new-qq-fixtures
```

输出 `account-a/nt_msg.db`（账号 10001、124 条、2 会话）、`account-b/nt_msg.db`（账号 20001、2 条、2 会话）及 `fixture-report.json`。账号 A 包含跨页记录、同秒不同消息、同号群/私聊、5029 字符长文、未知记录和图片文字提示；账号 B 用于账号隔离。尾部测试常量 `SNSBOX_QQ_LONG_TAIL_20261117` 仅属 fixture，不是数据协议。生成器只创建新目录，Windows 在探测路径前拒绝两个已知活跃根。

定向检查：`python -B -m unittest discover -s tools/qq-decrypted -p test_convert.py -v`。测试使用同一生成器和真实 SQLite/protobuf 结构；它不是用户真实账号兼容验收。HTTP 集成应使用生成器 → 转换器的实际产物，不以手写 JSON 代替转换。
