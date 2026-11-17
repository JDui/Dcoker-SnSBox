# QQ 既有历史现场检查

## 2026-11-17：新 NAS，只读检查

用户授权尝试读取 QQ 历史；活跃 config 为 `X:\Docker\selkies\config`，仍不修改源、不暂停 WS、不扫码。当前只具备 SMB 文件访问，没有 NAS 进程内存或一致快照接口。

执行可重复的有界探测：

```powershell
.\deploy\probe-qq-history.ps1 -ConfigPath 'X:\Docker\selkies\config'
```

探测仅枚举 `.config/QQ/nt_qq_*/nt_db` 的指定文件元数据，每库最多以共享只读 FileStream 读取前 1040 字节；没有 SQLite 连接、数据库锁、复制、checkpoint、凭据解密或网络登录。输出不含账号目录名、原始文件头或 key_meta。

- 发现 1 个 QQ profile，消息库 `nt_msg.db` 约 1.57 GB，群聊检索库约 400 MB，资料库约 10.6 MB。
- 三个文件均符合 QQNT 扩展头形态，内容页不是明文 SQLite，均有 WAL。消息库大小在两次检查之间增长，属于现用活跃资料。
- 实际读取消息数 **0**；没有把文件可达或扩展头中的 key_meta 当成数据库密钥，没有把文件时间稳定当作一致性证明。

## 现成取钥路线核对

已审阅 [WeQ ec0f4f9 的 KeyService](https://github.com/weq-devs/WeQ/blob/ec0f4f9/packages/service/src/bootstrap/key.ts) 和 [login_db helpers](https://github.com/weq-devs/WeQ/blob/ec0f4f9/packages/service/src/bootstrap/login_db.ts)。该方案可从已有登录资料准备协议登录，不要求运行原 QQ 进程；但 `quickLogin` 会发起新协议登录，可能要求手机确认，还默认请求 VIP / QZone 凭据并启用调试日志。它不是只凭消息库离线求出密钥，本轮没有对真实资料执行该流程，也没有复用或发送用户的登录材料。

WeQ 采用 CC BY-NC-SA 4.0，本轮仅审阅，没有把其实现复制进 SnSBox。QQDecrypt 的 [Linux 研究说明](https://qqbackup.github.io/QQDecrypt/research/NTQQ-Linux-DB-Key-Research.html) 自称 AI 生成且有版本限制，因此只作为线索，决策以固定源码和实际证据为准。

现阶段可以继续实现独立导出的只读接入；真实库读取仍需匹配密钥与独立一致来源。不能把导入合成记录、QQ 平台图标显示或协议登录入口就绪说成已读取 NAS 上的真实 QQ 历史。
