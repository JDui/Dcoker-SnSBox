import { expect, test } from '@playwright/test'

test('既有历史：阻塞条件、只读分页搜索、来源隔离和代次恢复', async ({ page }) => {
  // Every path and message below is synthetic. No existing client profile is opened.
  let prepared = false
  let stage = 'blocked'
  let generation = 'synthetic-generation-1'
  let refreshPolls = 0
  const calls = { refresh: 0, conversations: 0, messages: 0, search: 0 }
  const mutations: string[] = []
  const unexpected: string[] = []
  const source = () => ({ id: 'fixture-history-a', platform: 'wechat', displayName: '合成微信副本 A', kind: 'legacy-readonly', status: stage === 'ready' ? 'partial' : stage === 'refreshing' ? 'refreshing' : 'snapshot_required', reason: stage === 'ready' ? '合成夹具：文字可读，附件尚未展开。' : stage === 'refreshing' ? '正在读取合成一致性副本。' : '合成条件：未提供一致性副本及授权数据库密钥，尚未读取消息。', readOnly: true, sendAllowed: false, capturedAt: stage === 'blocked' ? null : '2026-11-14T12:00:00Z', indexedAt: stage === 'ready' ? '2026-11-15T01:00:00Z' : null, generation: stage === 'ready' ? generation : null, consistency: stage === 'blocked' ? 'unavailable' : 'operator-confirmed-copy', conversationCount: stage === 'ready' ? 1 : null, messageCount: stage === 'ready' ? 2 : null, partial: true })
  const secondSource = { ...source(), id: 'fixture-history-b', displayName: '合成微信副本 B', status: 'ready', reason: '独立合成来源，只显示本来源记录。', generation: 'synthetic-b-1', consistency: 'operator-confirmed-copy', conversationCount: 1, messageCount: 1, partial: false }
  const qqSource = { ...source(), id: 'fixture-history-qq', platform: 'qq', displayName: '合成 QQ 官方资料', status: 'unsupported', reason: 'QQ 官方既有资料解密尚未验证。' }
  const conversation = { id: 'fixture-conversation-a', sourceId: 'fixture-history-a', accountId: 'history:fixture-history-a', platform: 'wechat', title: '合成历史会话 A', kind: 'direct', lastMessage: '分页与搜索均为合成数据。', lastMessageAt: '2026-11-14T12:00:00Z', unreadCount: 0, readOnly: true }
  const secondConversation = { ...conversation, id: 'fixture-conversation-b', sourceId: secondSource.id, accountId: `history:${secondSource.id}`, title: '合成历史会话 B' }
  const current = { id: 'fixture-history-current', sourceId: conversation.sourceId, conversationId: conversation.id, accountId: conversation.accountId, platform: 'wechat', direction: 'incoming', senderName: '合成联系人', timestamp: '2026-11-14T12:00:00Z', segments: [{ type: 'text', text: '分页：合成较新消息。' }], status: 'received', readOnly: true }
  const older = { ...current, id: 'fixture-history-older', timestamp: '2026-11-14T11:59:00Z', segments: [{ type: 'text', text: '分页：合成更早消息。' }] }
  const secondMessage = { ...current, id: 'fixture-history-b-message', sourceId: secondSource.id, conversationId: secondConversation.id, accountId: secondConversation.accountId, segments: [{ type: 'text', text: '这是副本 B 的合成消息。' }] }
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (!['GET', 'HEAD'].includes(request.method())) mutations.push(`${request.method()} ${path}`)
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true, csrfToken: 'synthetic-history-csrf' } })
    if (path.endsWith('/accounts')) return route.fulfill({ json: { items: [] } })
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': synthetic history fixture\n\n' })
    if (path === '/api/v1/history/sources') {
      if (stage === 'refreshing' && ++refreshPolls > 1) stage = 'ready'
      return route.fulfill({ json: { items: [source(), secondSource, qqSource] } })
    }
    if (path.endsWith('/fixture-history-a/refresh')) {
      calls.refresh++
      expect(request.headers()['x-csrf-token']).toBe('synthetic-history-csrf')
      expect(request.postDataJSON()).toEqual({})
      if (prepared) stage = 'refreshing'
      return route.fulfill({ json: source() })
    }
    if (path.startsWith('/api/v1/history/sources/')) {
      const isA = path.includes('/fixture-history-a/')
      const selectedConversation = isA ? conversation : secondConversation
      const selectedMessage = isA ? current : secondMessage
      if (path.endsWith('/conversations')) {
        calls.conversations++
        // A foreign row is deliberately included to check the UI's source boundary.
        return route.fulfill({ json: { items: [selectedConversation, { ...selectedConversation, id: 'foreign-conversation', sourceId: 'foreign-source', title: '不应展示的外来源会话' }], nextCursor: null } })
      }
      if (path.includes('/conversations/') && path.endsWith('/messages')) {
        calls.messages++
        const cursor = url.searchParams.get('cursor')
        if (cursor === 'synthetic-stale') {
          generation = 'synthetic-generation-2'
          return route.fulfill({ status: 409, json: { error: { code: 'history_changed', message: '合成索引已刷新，请从第一页读取。' } } })
        }
        return route.fulfill({ json: { items: [cursor ? older : selectedMessage], nextCursor: isA ? cursor ? 'synthetic-stale' : 'synthetic-older' : null } })
      }
      if (path.endsWith('/messages')) {
        calls.search++
        expect(url.searchParams.get('query')).toBe('分页')
        return route.fulfill({ json: { items: [{ ...current, conversationTitle: conversation.title, conversationKind: conversation.kind }], nextCursor: null } })
      }
    }
    if (path === '/api/v1/conversations') return route.fulfill({ json: { items: [], nextCursor: null } })
    unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 404, json: { error: { code: 'synthetic_missing', message: '合成接口未配置' } } })
  })

  await page.goto('/')
  await page.getByRole('button', { name: '既有历史', exact: true }).click()
  await expect(page.getByRole('heading', { name: '缺少一致性副本', exact: true })).toBeVisible()
  await expect(page.getByRole('searchbox', { name: '搜索当前历史来源' })).toHaveCount(0)
  expect(calls.conversations + calls.messages + calls.search).toBe(0)
  await page.getByRole('button', { name: '重新检查条件', exact: true }).click()
  await expect.poll(() => calls.refresh).toBe(1)
  await expect(page.getByRole('heading', { name: '缺少一致性副本', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /合成 QQ 官方资料/ }).click()
  await expect(page.getByRole('heading', { name: '暂不支持', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '重新检查条件', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: /合成微信副本 A/ }).click()
  await page.screenshot({ path: 'test-results/history-blocked-desktop-synthetic.png', animations: 'disabled' })

  prepared = true
  await page.getByRole('button', { name: '重新检查条件', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在读取副本', exact: true })).toBeDisabled()
  await expect(page.locator('.history-conversation').filter({ hasText: conversation.title })).toBeVisible()
  expect(refreshPolls).toBeGreaterThan(1)
  await expect(page.getByText('不应展示的外来源会话', { exact: true })).toHaveCount(0)
  await page.locator('.history-conversation').filter({ hasText: conversation.title }).click()
  await expect(page.getByText('分页：合成较新消息。', { exact: true })).toBeVisible()
  await expect(page.locator('.readonly-history-footer')).toBeVisible()
  await expect(page.locator('.composer, textarea, input[type=file]')).toHaveCount(0)
  await expect(page.locator('.chat-header').getByRole('button', { name: /^会话操作/ })).toHaveCount(0)
  await page.getByRole('button', { name: '加载更早消息', exact: true }).click()
  await expect(page.getByText('分页：合成更早消息。', { exact: true })).toBeVisible()
  await page.getByRole('searchbox', { name: '搜索当前历史来源' }).fill('分页')
  await expect(page.locator('.search-result')).toHaveCount(1)
  await page.locator('.search-result').click()
  await expect(page.locator('.chat-heading h2')).toHaveText(conversation.title)
  await page.screenshot({ path: 'test-results/history-ready-desktop-synthetic.png', animations: 'disabled' })

  await page.getByRole('button', { name: '加载更早消息', exact: true }).click()
  await expect(page.getByRole('heading', { name: '选择历史会话', exact: true })).toBeVisible()
  await expect(page.getByRole('searchbox', { name: '搜索当前历史来源' })).toHaveValue('')
  await expect(page.locator('.history-conversation').filter({ hasText: conversation.title })).toBeVisible()
  await page.locator('.history-conversation').filter({ hasText: conversation.title }).click()
  await expect(page.getByText('分页：合成较新消息。', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '会话信息与能力', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('副本时间')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.navigation-rail')).toBeHidden()
  await expect(page.locator('.readonly-history-footer')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/history-ready-mobile-synthetic.png', animations: 'disabled' })
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
  await expect(page.locator('.navigation-rail')).toBeVisible()
  await page.getByRole('searchbox', { name: '搜索当前历史来源' }).fill('分页')
  await expect(page.locator('.search-result')).toHaveCount(1)
  await page.getByRole('button', { name: /合成微信副本 B/ }).click()
  await expect(page.getByRole('searchbox', { name: '搜索当前历史来源' })).toHaveValue('')
  await expect(page.locator('.history-conversation')).toHaveCount(1)
  await expect(page.locator('.history-conversation')).toContainText(secondConversation.title)
  await page.locator('.history-conversation').click()
  await expect(page.getByText('这是副本 B 的合成消息。', { exact: true })).toBeVisible()
  await expect(page.getByText('分页：合成较新消息。', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
  await page.getByRole('button', { name: '返回在线会话', exact: true }).click()
  await expect(page.getByRole('region', { name: '既有历史', exact: true })).toHaveCount(0)
  expect(mutations).toEqual(Array(2).fill('POST /api/v1/history/sources/fixture-history-a/refresh'))
  expect(unexpected).toEqual([])
})
