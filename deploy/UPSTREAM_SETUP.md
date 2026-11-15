# 固定上游版本与独立启动

这份步骤用于另行准备上游，**本次没有执行真实账号登录、复制真实资料、接管旧容器或验收第三方签名服务**。以下源码版本是接口核对基线，不代表已经通过 SnSBox 真实账号验收。部署聚合服务不要求先部署上游；缺少上游时显示未配置账号。

## 取得与构建

在 Linux AMD64 Docker 主机的独立工作目录执行，勿在旧 Wechat-C 内执行。版本标识用于 Git 定位，不增加文件摘要校验步骤。

```sh
git clone https://github.com/thisnick/agent-wechat.git agent-wechat-snsbox
git -C agent-wechat-snsbox checkout --detach ce5c0687c0e99e3f93fd85266baa3fad26d63a11
docker build --platform linux/amd64 -f agent-wechat-snsbox/deploy/native/Dockerfile -t snsbox-agent-wechat:ce5c0687 agent-wechat-snsbox

git clone https://github.com/LagrangeDev/Lagrange.Core.git lagrange-snsbox
git -C lagrange-snsbox checkout --detach fe789c4a23796fbc82fa09e70a9c44c8a5cf2948
docker build --platform linux/amd64 -f lagrange-snsbox/Lagrange.Milky/Resources/Dockerfile -t snsbox-lagrange:fe789c4a lagrange-snsbox
```

微信源码 Dockerfile 使用 Rust 1.93.1、cmake、FFmpeg、PulseAudio 运行库；QQ 使用 .NET 10 Native AOT。构建需要访问各自包仓库和基础镜像。这里复用上游 Dockerfile，不在 SnSBox 重新维护协议编译链。微信仓库 LICENSE 为 MIT，并有第三方组件告知；所核对 QQ 根目录没有找到 LICENSE 文件，因此本项目不分发/捆绑 QQ 上游代码或镜像，分发许可仍须另核对。

## 配置隔离侧车

使用 [compose.sidecars.example.yaml](compose.sidecars.example.yaml) 在 SnSBox 根目录复制为 `compose.upstreams.yaml`，然后准备已被 Git 忽略的 `private/`：

- `accounts.json`：按 [accounts.example.json](accounts.example.json) 填写，但微信 baseUrl 改为 `http://127.0.0.1:6174`，QQ 改为 `http://127.0.0.1:3000`。两个侧车与 SnSBox 共享网络命名空间；上游 API 不映射公开端口。
- `wechat-api-token` 与 `qq-api-token`：各自独立的随机 Bearer token，文件只允许部署管理员和相应容器 UID 读取。不要使用官方客户端会话令牌替代这两个 API 密钥。
- `wechat-server.toml`：使用下面配置。
- `qq-appsettings.json`：从已检出的 `Lagrange.Milky/Resources/appsettings.json` 复制，填 `Lagrange.Login.Uin`；设置 `Milky.AccessToken` 与 `qq-api-token` 完全相同；启用 `Milky.Api.Http.Enabled` 和 `Milky.Event.SSE.Enabled`。监听保持 `127.0.0.1:3000`。JSON 中 `Lagrange.Protocol.Signer` 的默认外部服务可用性、授权与信任由操作者确认，本次没有调用该服务。若不使用在线验证码服务，将 `UseOnlineCaptchResolver` 设为 false 并准备按上游提示手工处理。

```toml
schemaVersion = 1
listen = "127.0.0.1:6174"
dataDir = "/var/lib/agent-wechat"
tokenFile = "/run/secrets/wechat-api-token"
```

Agent WeChat 的普通 HTTP listener **只允许 loopback**，不能直接改成 `0.0.0.0`。上述共享网络空间确保聚合服务能访问它。若使用另一主机的独立上游，须改用其 `networkListen` + `tlsCertFile` + `tlsKeyFile` 的 HTTPS 模式，证书须被 SnSBox 的标准 CA 信任；不能关闭证书校验。`compose.upstreams.example.yaml` 的 host gateway 是通用已有服务示例，不足以穿透一个仅绑定 loopback 的微信守护进程。

配置齐备后，启动命令是：

```sh
docker compose -f compose.yaml -f compose.upstreams.yaml up -d
```

启动空白微信守护进程不代表已有登录账号。SnSBox 可创建独立 managed 账号并请求登录，但本轮空白预登录没有取得二维码。若另行验证已有资料路线，参照固定版本的 `packages/native-client-rust/CLI.md` 注册**独立准备、经过一致性确认且当前无其他写入者的完整资料副本**；活跃 WS 原目录保持只读。SnSBox 不代为执行 `profile add`、`store import` 或原目录接管。支持的 Linux 资料布局、密钥和保存信任均需独立验收，不能把本次传输失败推断为资料兼容结果。

QQ 在独立 Lagrange 工作目录保存 `Uin.ks`，不是官方 `.config/QQ` 的可互换令牌。按上游交互完成扫码或设备确认后，`get_login_info` 才能返回有效账号。若需要交互显示二维码，可对明确准备的这个隔离侧车使用前台 `docker compose ... up qq-upstream`；二维码和日志含私人材料，不提交或截图上传。本步骤没有自动执行扫码、密码登录或发送消息。

上游升级时一次只升级一个组件，先重新核对 HTTP/事件结构。此示例未证明账号不会掉线、完整历史会迁移或官方客户端可无缝切回。

## QQ 网页登录与注销：LLBot 8.3.2 可选路线

新部署优先使用受维护的 [LuckyLilliaBot v8.3.2](https://github.com/LuckyLilliaDev/LuckyLilliaBot/releases/tag/v8.3.2) direct 模式。它提供登录信息、扫码和注销 HTTP API；Milky 继续负责消息。SnSBox 不实现私有协议，不复用 `.config/QQ` 的官方令牌。此轮真实镜像下载未完成，实际启动未验证；具体错误见后端记录。

```sh
# 在 SnSBox 根目录，为目标 QQ 号创建全新 private/qq-llbot；存在时会拒绝覆盖。
node deploy/prepare-llbot.mjs YOUR_QQ_UIN
cp deploy/compose.llbot.example.yaml compose.llbot.yaml
# 将 private/qq-llbot/account-entry.json 合并到 private/accounts.json 数组。
# Linux 上确保聚合服务 UID 10001 能读取它的三个单文件 bind：
sudo chown 10001:10001 private/accounts.json private/qq-llbot/milky-token private/qq-llbot/management-token
docker compose -f compose.yaml -f compose.llbot.yaml up -d
```

已有微信 accounts 配置保留，只替换对应 QQ 条目；不要同时启动两个指向同一 QQ data 的实例。默认镜像是 `linyuchen/llbot:8.3.2`，可通过 `SNSBOX_LLBOT_IMAGE` 选择可信镜像站的同版镜像。Compose 只启动独立 direct 模式，无官方客户端、PMHQ 或旧 config 挂载。Milky 3010 和管理 3080 均为共享网络空间内的 loopback，不公开端口。

初始化脚本复用上游的 WebUI 密码认证格式：生成随机密码文件、对应 `X-Webui-Token` 值、独立 Milky token，均不打印内容。密码认证使用上游规定的 SHA-256，属于认证机制，并非手工文件哈希校验。Linux 文件权限与容器 UID 如上处理；Windows bind 权限由 Docker Desktop 映射。QQ Auth Token 另外依赖上游自己的授权服务；需要时将**专用于该独立 LLBot 实例**的有效 Auth Token 写入 `private/qq-llbot/data/auth_token.txt`，上游 watcher 读取。不要把官方 QQ 登录令牌、微信 key 或 SnSBox 管理员密码填进去。此轮没有获取或提交外部服务 Auth Token。

登录由 SnSBox 发起，PNG 在受鉴权的同源接口显示；QR 不写磁盘，过期/重启后需要用户重新发起。配置的预期 UIN 必须与管理接口、Milky 自身身份和事件 self_id 一致，否则拒绝同步/发送；扫码成另一个账号不能当作配置账号登录成功。LLBot 没有取消接口；关闭窗口不代表远端扫码任务取消。注销使用 direct 模式 logout，保留独立资料。QQ 日志可能包含二维码，示例禁用 Docker 日志持久化；不把扫码内容或认证文件提交 Git。

## 微信本轮实际结果与资料副本

固定源码已完成 AMD64 编译，空白独立 daemon 健康、managed 账号创建，以及 SnSBox 的登录失败/注销完成状态映射均已实测。空白登录返回 `login_failed`，没有二维码，不能用该结果承诺新账号登录可用。详细有界诊断见后端记录。

SnSBox 的“创建独立账号”只创建 managed 记录，不传 `--official`、不注册外部路径。现有活跃 WS 源只能只读预检；只有另行准备并确认一致性的完整副本才可进入上游的独占 profile 流程。普通文件复制正在写入的数据库不是一致性快照。副本必须有独立写入所有权，不能指向原目录；原客户端继续使用原源。导入可能改写副本，因此保留导入前副本；回滚不意味着让官方客户端直接读取 native 已改写的资料。目录识别、密钥兼容、历史可读、令牌复用仍是分别待验收的项目。
