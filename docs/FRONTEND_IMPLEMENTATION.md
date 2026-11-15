# 前端实现记录

日期：2026-11-15。范围：`web/**`；本记录不代表真实微信或 QQ 账号验收。

## 实际实现

- React + TypeScript + Vite 静态前端；依赖精确固定并提交 npm 锁文件。Tailwind CSS 提供样式基础，按钮沿用 shadcn/ui 组合模式，Radix 负责弹窗焦点、退出与菜单键盘操作，Lucide 提供图标，TanStack Query / Virtual 处理服务端状态、分页和长列表。
- 桌面导航栏、会话列表、消息区；手机列表与会话分层返回。浅色、深色、跟随系统与 reduced-motion。主题和发送快捷键可保存，正文和草稿不写浏览器本地存储。
- 对齐 [HTTP API v1](API_CONTRACT.md)：管理员 Cookie 会话及内存 CSRF token；账号登录/退出/同步、会话分页、本地历史分页/搜索、清除本地未读、SSE 自动重连与查询刷新。管理员退出或失效时清理页面私有状态；前端不读取旧 config。
- 平台、账号、会话三重身份隔离；同名微信/QQ 联系人不会合并。草稿与附件只存在当前页面内存，切换会话后保留，切换演示/真实模式或管理会话退出后清除。异步上传和发送捕获原会话身份，并用工作区代次防止退出后提交新的动作或把结果写进新会话。
- 登录和发送按账号能力门控：unsupported / unavailable 禁用；unverified 明示“验证登录/验证发送”，发送前提示会实际提交。pending 登录请求不展示成登录完成。账号在线、事件连接、接口受理、对端送达不混用。
- 中文 composition、`isComposing` / 229 与组合结束后的 Enter 防误发；按 UTF-8 16 KiB 上限预先拦截超长文本；允许 Enter 发送或换行。附件按接口单独发送，保留文字草稿；上传前限制 32 MiB。
- 图片预览、视频和音频原生播放、文件下载、表情包、小程序/普通链接卡片与未知消息提示。媒体只读取同源授权 `/api/v1/media/`，外部链接只允许 http(s) 并使用新标签页隔离；不插入上游 HTML/XML。媒体失败显示可理解提示。QQ 邮箱固定跳转 `https://mail.qq.com/`，不读取邮箱内容。
- 每次用户发送生成独立幂等键。queued / submitting / accepted / failed / uncertain 均有独立展示；网络结果不确定时保留提示并阻止当前会话继续误发，先允许刷新核对，再由用户移除提示。没有自动重发。HTTP 202 不显示为送达。
- 显式“界面演示”使用合成账号与内容；有持续横幅，演示发送不访问发送接口、不冒充真实连接。演示配图为本仓库 SVG 示意图，不含私人附件。

## 运行

```powershell
cd web
npm ci
npm run dev
```

本地入口默认 `http://127.0.0.1:18731`。默认 Vite 5173 在当前 Windows 主机被拒绝绑定，因此改用此端口；可通过 `SNSBOX_WEB_PORT` 覆盖。开发代理默认访问 `http://127.0.0.1:8080`，通过 `SNSBOX_API_TARGET` 可指定其他后端地址。生产执行 `npm run build` 后由 Rust 同源托管 `web/dist`，不需要运行时 Node 服务。

`npm run check:interactions` 为两项聚焦 Playwright 检查，默认使用已安装的 Microsoft Edge，无额外浏览器下载；其它系统可在 `playwright.config.ts` 调整 channel。检查完全使用合成 API 响应，不读取或操作真实账号。

## 已有证据

- `npm run build`：通过，TypeScript 严格检查与 Vite 生产构建完成。
- 两项聚焦浏览器检查通过：composition Enter 与紧随 compositionend 的 Enter 不发送；正常 Enter 仅产生一次演示消息；微信/QQ 同名联系人草稿独立；退出演示清理消息与草稿；手机深色视图无横向溢出。
- 同一检查覆盖真实接口形状下的 unverified 提示、中文 UTF-8 字节超限拦截、CSRF 和幂等键附带、网络发送失败后 uncertain 状态及无自动重试；“核对历史”只读刷新。拒绝 javascript 卡片链接和外部媒体追踪地址。
- 已检查 1440×1000 桌面浅色与 390×844 手机深色截图。证据在忽略提交的 `web/test-results/`，不包含真实账号内容。
- 无手工 SHA 校验，无真实账户登录或消息发送。

## 尚未验证与下一项最大不确定性

- 浏览器检查使用合成 API；Docker 与 Rust 同源服务的最终联调、真实账号登录/退出、文本及媒体收发、上游历史完整性由集成阶段分别验收。
- iPad Safari/软键盘、真机中文输入、旋转、后台恢复未验收。桌面 Edge 与模拟手机布局结果不能代表 iPad 真机结果。
- 旧历史加载通过稳定消息键和滚动高度锚点保留阅读位置，但长历史混合媒体加载和多次分页尚待真实数据验证。
- 服务端没有按客户端幂等键查询回执的独立端点：请求连接丢失时，前端不能自动把无 ID 的本地待确认提示与某条历史绑定；明确要求核对，不推断成功。
- 下一项最大不确定性是固定版本上游的实际账号收发与媒体可用性；前端能力提示不会代替这些验收。

组件参考：[Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog)、[TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)、[Vite](https://vite.dev/guide/)。
