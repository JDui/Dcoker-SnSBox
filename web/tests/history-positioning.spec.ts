import { expect, test } from '@playwright/test'

test('搜索跨页命中定位、长消息测量、更早分页与返回最新记录', async ({ page }) => {
  const sourceId = 'synthetic-position-source'
  const accountId = `history:${sourceId}`
  const conversationId = 'synthetic-position-conversation'
  const source = { id: sourceId, platform: 'qq', displayName: '合成已解密资料', kind: 'legacy-readonly', format: 'snsbox-qq-decrypted-v1', status: 'partial', reason: '合成记录，仅验证加载；附件未展开。', readOnly: true, sendAllowed: false, canRefresh: true, generation: 'synthetic-generation-1', partial: true, consistency: 'operator-confirmed-export' }
  const conversation = { id: conversationId, sourceId, accountId, platform: 'qq', title: '合成跨页会话', kind: 'group', unreadCount: 0, readOnly: true }
  const ascending = Array.from({ length: 220 }, (_, index) => ({ id: `synthetic-message-${index}`, sourceId, accountId, conversationId, platform: 'qq', direction: 'incoming', senderName: '合成发送者', timestamp: new Date(Date.UTC(2026, 10, 17, 0, index)).toISOString(), status: 'received', readOnly: true, conversationTitle: conversation.title, conversationKind: 'group', segments: [{ type: index === 61 ? 'unknown' : 'text', text: index === 59 ? '合成长正文，保持完整可读。'.repeat(160) : index === 60 ? '合成定位命中 60' : index === 61 ? '合成未知附件：未展开' : `合成记录 ${index}` }] }))
  const descending = [...ascending].reverse()
  const calls = { context: 0, latest: 0, older: 0 }
  const mutations: string[] = []
  await page.route('**/api/v1/**', route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (request.method() !== 'GET') mutations.push(path)
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true, csrfToken: 'synthetic-position-csrf' } })
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': synthetic\n\n' })
    if (path.endsWith('/history/sources')) return route.fulfill({ json: { items: [source] } })
    if (path.includes('/history/') && path.endsWith('/conversations')) return route.fulfill({ json: { items: [conversation], nextCursor: null } })
    if (path.endsWith('/context')) {
      calls.context++
      expect(url.searchParams.get('generation')).toBe(source.generation)
      expect(path).toContain('/messages/synthetic-message-60/context')
      const start = descending.findIndex(message => message.id === 'synthetic-message-60') - 25
      return route.fulfill({ json: { items: descending.slice(start, start + 50), nextCursor: `synthetic-offset-${start + 50}`, generation: source.generation, partial: true, anchorMessageId: 'synthetic-message-60', hasNewer: true } })
    }
    if (path.includes('/conversations/') && path.endsWith('/messages')) {
      const cursor = url.searchParams.get('cursor')
      if (cursor) calls.older++; else calls.latest++
      const offset = cursor ? Number(cursor.replace('synthetic-offset-', '')) : 0
      return route.fulfill({ json: { items: descending.slice(offset, offset + 50), nextCursor: offset + 50 < descending.length ? `synthetic-offset-${offset + 50}` : null, generation: source.generation, partial: true } })
    }
    if (path.includes('/history/') && path.endsWith('/messages')) return route.fulfill({ json: { items: [ascending[60]], nextCursor: null } })
    return route.fulfill({ json: { items: [] } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '既有历史', exact: true }).click()
  await page.getByRole('searchbox', { name: '搜索当前历史来源' }).fill('定位')
  await page.locator('.search-result').click()
  await expect.poll(() => calls.context).toBe(1)
  const target = page.locator('[data-position-id="synthetic-message-60"]')
  await expect(target).toBeInViewport()
  await expect(target).toHaveClass(/is-search-hit/)
  await expect(page.locator('.message-position-bar')).toContainText('已定位搜索结果')
  await expect(page.locator('.history-source-summary')).toContainText('普通长文本按转换结果保留')
  await expect(page.getByRole('log').locator('[data-message-id="synthetic-message-59"] .message-text')).toHaveText('合成长正文，保持完整可读。'.repeat(160))
  await expect(page.getByRole('log').getByText('合成未知附件：未展开', { exact: true })).toHaveCount(1)
  expect(calls.latest).toBe(0)
  expect(calls.older).toBe(0)
  await page.screenshot({ path: 'test-results/history-positioned-desktop-synthetic.png', animations: 'disabled' })
  const topBefore = (await target.boundingBox())!.y
  await page.getByRole('button', { name: '加载更早消息', exact: true }).click()
  await expect.poll(() => calls.older).toBe(1)
  await expect(target).toBeInViewport()
  expect(Math.abs((await target.boundingBox())!.y - topBefore)).toBeLessThan(8)
  await page.setViewportSize({ width: 640, height: 360 })
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
  await page.locator('.search-result').click()
  await expect(target).toBeInViewport()
  await expect(page.locator('.readonly-history-footer')).toBeInViewport()
  await expect(page.locator('.composer, textarea')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/history-positioned-640x360-synthetic.png', animations: 'disabled' })
  await page.locator('.message-position-bar').getByRole('button', { name: '查看最新记录', exact: true }).click()
  await expect.poll(() => calls.latest).toBe(1)
  await expect(page.getByRole('log').getByText('合成记录 219', { exact: true })).toBeVisible()
  await expect(page.locator('.message-position-bar')).toHaveCount(0)
  expect(calls.context).toBe(1)
  expect(mutations).toEqual([])
})
