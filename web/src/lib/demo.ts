import type { Account, Capabilities, Conversation, Message, Segment } from './types'

const capabilities: Capabilities = Object.fromEntries(['login', 'logout', 'text', 'image', 'video', 'sticker', 'file', 'miniApp', 'history', 'realtime', 'mail'].map(key => [key, { status: 'supported', reason: '仅用于界面演示，不连接真实账号' }]))
export const demoAccounts: Account[] = [
  { id: 'demo-wechat', platform: 'wechat', displayName: '生活 · 示例账号', status: 'online', capabilities, historyScope: '仅本次界面演示的合成内容' },
  { id: 'demo-qq', platform: 'qq', displayName: '兴趣 · 示例账号', status: 'online', capabilities, historyScope: '仅本次界面演示的合成内容', mailUrl: 'https://mail.qq.com/' },
]
const now = new Date()
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString()
export const demoConversations: Conversation[] = [
  { id: 'demo-weekend', accountId: 'demo-wechat', platform: 'wechat', title: '周末出走计划', kind: 'group', unreadCount: 3, lastMessage: '林野：那就周六见，记得带相机 📷', lastMessageAt: at(2), memberCount: 6, pinned: true },
  { id: 'demo-linye-wx', accountId: 'demo-wechat', platform: 'wechat', title: '林野', kind: 'direct', unreadCount: 1, lastMessage: '发现一家很不错的咖啡店', lastMessageAt: at(16) },
  { id: 'demo-design', accountId: 'demo-qq', platform: 'qq', title: '小小灵感收集站', kind: 'group', unreadCount: 12, lastMessage: '阿澄：新整理的参考发在这里啦', lastMessageAt: at(37), muted: true, memberCount: 18 },
  { id: 'demo-linye-qq', accountId: 'demo-qq', platform: 'qq', title: '林野', kind: 'direct', unreadCount: 0, lastMessage: '文件已收到，谢谢！', lastMessageAt: at(90) },
  { id: 'demo-moments', accountId: 'demo-wechat', platform: 'wechat', title: '日常碎片', kind: 'group', unreadCount: 0, lastMessage: '[表情包] 慢慢来，也很好', lastMessageAt: at(155), memberCount: 4 },
]
function message(id: string, conversation: Conversation, senderName: string, minutesAgo: number, segments: Segment[], outgoing = false, status?: Message['status']): Message {
  return { id, conversationId: conversation.id, accountId: conversation.accountId, platform: conversation.platform, senderName, direction: outgoing ? 'outgoing' : 'incoming', timestamp: at(minutesAgo), segments, status: status || (outgoing ? 'demo' : 'received') }
}
const [weekend, linye, design, qqLinye, moments] = demoConversations
export const demoMessages: Message[] = [
  message('demo-1', weekend, '林野', 45, [{ type: 'text', text: '周末去山里走走吧！找到一条很轻松的路线，天气看起来也不错。' }]),
  message('demo-2', weekend, '阿澄', 42, [{ type: 'image', url: '/demo/landscape.svg', width: 800, height: 480, name: '山间晨光 · 合成示意图', state: 'available' }]),
  message('demo-3', weekend, '阿澄', 42, [{ type: 'text', text: '就是这里，沿着湖边散步，刚好能赶上傍晚的光 ☀️' }]),
  message('demo-4', weekend, '我', 38, [{ type: 'text', text: '好呀，我带相机。我们上午出发，路上再找一家咖啡店？' }], true),
  message('demo-5', weekend, '林野', 35, [{ type: 'miniApp', appName: '行程分享', title: '周末行程 · 示例', text: '小程序卡片样例 · 没有可打开的链接' }]),
  message('demo-6', weekend, '阿澄', 30, [{ type: 'sticker', url: '/demo/sticker.svg', name: '慢慢来，也很好', width: 180, height: 150, state: 'available' }]),
  message('demo-7', weekend, '我', 28, [{ type: 'text', text: '我整理了一个行程，先放这里。' }], true),
  message('demo-8', weekend, '我', 27, [{ type: 'file', name: '周末行程.pdf', size: 245760, unavailableReason: '演示附件，无实际文件' }], true),
  message('demo-9', weekend, '林野', 22, [{ type: 'video', name: '沿途风景.mp4', thumbnailUrl: '/demo/landscape.svg', duration: 18, unavailableReason: '演示视频，无实际视频文件' }]),
  message('demo-10', weekend, '我', 15, [{ type: 'text', text: '那我们就约 9:30，老地方见。' }], true, 'uncertain'),
  message('demo-11', weekend, '我', 12, [{ type: 'image', name: '集合位置.jpg', unavailableReason: '示例：附件已过期' }], true, 'failed'),
  message('demo-12', weekend, '林野', 2, [{ type: 'text', text: '那就周六见，记得带相机 📷' }]),
  message('demo-13', linye, '林野', 16, [{ type: 'text', text: '发现一家很不错的咖啡店，下次一起去吧。\n这是一条合成消息，用来检查中文长文本和原生选择。' }]),
  message('demo-14', design, '阿澄', 37, [{ type: 'link', title: '设计参考链接 · 示例', url: 'https://example.com/', text: '链接卡片样例 · 将在新标签页打开' }]),
  message('demo-15', design, '小禾', 36, [{ type: 'unknown', text: '暂不支持的消息：合并转发' }]),
  message('demo-16', qqLinye, '林野', 90, [{ type: 'text', text: '文件已收到，谢谢！\n此联系人属于 QQ 示例账号，与微信的同名联系人独立。' }]),
  message('demo-17', moments, '小禾', 155, [{ type: 'sticker', url: '/demo/sticker.svg', name: '慢慢来，也很好', state: 'available' }]),
]
