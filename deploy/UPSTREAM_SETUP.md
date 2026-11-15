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

启动尚无资料的微信守护进程，不代表已有微信账号。先参照固定版本的 `packages/native-client-rust/CLI.md` 注册**独立准备且源已停止的完整资料副本**，在上游执行登录，并使用其账号 ID 更新 `accounts.json`。SnSBox 不代为执行 `profile add`、`store import` 或任何原目录接管。当前微信策略需要支持的 Linux 微信资料布局，创建全新资料在上游仍属于实验范围；没有这项前置条件时应停留在未接通状态。

QQ 在独立 Lagrange 工作目录保存 `Uin.ks`，不是官方 `.config/QQ` 的可互换令牌。按上游交互完成扫码或设备确认后，`get_login_info` 才能返回有效账号。若需要交互显示二维码，可对明确准备的这个隔离侧车使用前台 `docker compose ... up qq-upstream`；二维码和日志含私人材料，不提交或截图上传。本步骤没有自动执行扫码、密码登录或发送消息。

上游升级时一次只升级一个组件，先重新核对 HTTP/事件结构。此示例未证明账号不会掉线、完整历史会迁移或官方客户端可无缝切回。
