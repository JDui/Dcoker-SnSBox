# SnSBox

> **项目暂时搁置**：由于项目的特殊性质触发平台风控，测试账号已全部被封禁。项目暂时雪藏，等待未来合适的时机重启。

将 QQ 与微信聚合为一个美观、响应迅速、适合桌面和触屏的聊天面板。部署面向 Docker / NAS，浏览器通过结构化消息接口交互，日常聊天不依赖远程桌面串流。

仓库名称保留为 `Dcoker-SnSBox`。本项目是独立的新项目，不修改或迁移现有 Wechat-C / AXiVer 服务。

## 当前状态

2026-11-17：项目暂时搁置，暂无重启时间。MVP 尚未完成真实账号验收；WS 历史解密、登录令牌复用和无缝切换仍未验证。镜像未发布。已有实现和阶段证据见 [执行记录](docs/EXECUTION_STATUS.md)，上游能力声明不代表本项目验收通过。

## 技术方向

- 主体 Rust：聚合 API、账号与会话管理、适配器、同步、消息索引、媒体任务和鉴权。
- 前端采用 React + TypeScript + Vite，配合 Tailwind CSS、shadcn/ui 和 Lucide；形成自己的聊天产品视觉，不直接照搬组件演示页。
- 初期 SQLite 存储自身状态与索引；HTTP 承载查询和命令，SSE 承载可重放事件。
- QQ 与微信通过可替换适配器接入。优先复用成熟协议实现；允许非 Rust 上游作为隔离服务，不为了语言统一重写协议。

## 文档入口

| 文档 | 用途 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 仓库内 agent 的工作规则与阅读入口 |
| [agent.mg](agent.mg) | 用户目标、产品边界、阶段路线与验收门槛；按用户指定文件名保留 |
| [技术约束手册](docs/TECHNICAL_CONSTRAINTS.md) | 架构、数据、安全、同步、部署及验证约束 |
| [前端设计说明](docs/FRONTEND_DESIGN.md) | 视觉方向、响应式布局、输入与交互要求 |
| [接入方案研究](docs/INTEGRATION_RESEARCH.md) | 候选上游、公开证据、限制及待验证项 |
| [执行记录](docs/EXECUTION_STATUS.md) | MVP 能力、线程分工、阶段提交和验证证据 |
| [config 兼容](docs/CONFIG_COMPATIBILITY.md) | WS 目录保全、只读共享和单写入方边界 |
| [既有历史读取](deploy/HISTORY_SETUP.md) | 独立来源、数据库密钥、只读索引、分页与搜索 |
| [副本准备工具](docs/HISTORY_SNAPSHOT_PREPARATION.md) | 独立 DB/WAL 副本、只读 Compose 配置及来源限制 |
| [历史密钥准备](docs/WECHAT_KEY_PREPARATION.md) | 现成取钥模块审查、缓存转换及未完成验收 |
| [API 合约](docs/API_CONTRACT.md) | 前后端实现的统一接口 |
| [部署说明](deploy/README.md) | AMD64 容器、上游配置、只读资料挂载及数据卷 |
| [验收路线](docs/ACCEPTANCE.md) | 工程、真实账号与 WS 资料分别验收 |

先证明消息后端可靠，再扩大 UI 与功能范围。完整历史、复杂消息、通话和与官方客户端无缝切换均不作当前承诺。

## 本地 Docker 启动

```sh
docker compose up -d --build
docker compose exec snsbox cat /data/initial-admin-password
```

打开 `http://localhost:8080`，输入首次生成的管理员密码。默认只绑定本机；LAN 或 HTTPS 反向代理部署需按部署文档设置访问地址。密码不要提交到 Git 或粘贴进日志。

初始页面展示未配置账号，真实接入需另行运行并配置支持的上游。主动进入“界面演示”才能看到合成聊天内容。该镜像不包含已登录的微信/QQ，也不自动接管旧 config。

自有数据库和媒体位于独立 `snsbox-data` 数据卷。旧 WS config 通过可选 overlay 只读挂载；不会搬迁、删除或覆盖原目录。路径识别、历史解密、令牌恢复是三项独立能力，不能由只读挂载推断全部兼容。
