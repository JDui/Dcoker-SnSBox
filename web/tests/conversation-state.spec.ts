import { expect, test } from '@playwright/test'

test('平台角标、会话持久状态回执与置顶分页恢复', async ({ page }) => {
  const accounts = [
    { id: 'fixture-wx', platform: 'wechat', displayName: '合成微信账号', status: 'offline', capabilities: {} },
    { id: 'fixture-qq', platform: 'qq', displayName: '合成 QQ 账号', status: 'offline', capabilities: {} },
  ]
  const conversations = [
    { id: 'fixture-old', accountId: 'fixture-wx', platform: 'wechat', title: '同名联系人', kind: 'direct', lastMessageAt: '2026-11-15T01:00:00Z', unreadCount: 0, unread: false, pinned: false, muted: false },
    { id: 'fixture-new', accountId: 'fixture-qq', platform: 'qq', title: '同名联系人', kind: 'direct', lastMessageAt: '2026-11-15T02:00:00Z', unreadCount: 0, unread: false, pinned: false, muted: false },
  ]
  let firstPages = 0
  let staleCursor = true
  let patches = 0
  let rejectMute = true
  let reads = 0
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true, csrfToken: 'synthetic-test-csrf' } })
    if (path.endsWith('/accounts')) return route.fulfill({ json: { items: accounts } })
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': synthetic\n\n' })
    if (path.endsWith('/conversations')) {
      if (url.searchParams.has('cursor') && staleCursor) { staleCursor = false; return route.fulfill({ status: 409, json: { error: { code: 'pagination_changed', message: '排序已改变' } } }) }
      firstPages++
      return route.fulfill({ json: { items: [...conversations].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastMessageAt.localeCompare(a.lastMessageAt)), nextCursor: staleCursor ? 'synthetic-stale-cursor' : null } })
    }
    const target = conversations.find(item => path.includes(item.id))
    if (target && route.request().method() === 'PATCH') {
      expect(route.request().headers()['x-csrf-token']).toBe('synthetic-test-csrf')
      const body = route.request().postDataJSON()
      patches++
      if (body.muted && rejectMute) { rejectMute = false; return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '合成状态保存失败' } } }) }
      if (body.pinned !== undefined) target.pinned = body.pinned
      if (body.muted !== undefined) target.muted = body.muted
      if (body.unread !== undefined) { target.unread = body.unread; target.unreadCount = body.unread ? 1 : 0 }
      return route.fulfill({ json: target })
    }
    if (target && path.endsWith('/read')) { reads++; target.unread = false; target.unreadCount = 0; return route.fulfill({ status: 204 }) }
    if (path.endsWith('/messages')) return route.fulfill({ json: { items: [], nextCursor: null } })
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'fixture' } } })
  })
  await page.goto('/')
  const wxRow = page.locator('.conversation-row').filter({ hasText: '合成微信账号' })
  await expect(wxRow.getByRole('img', { name: '微信平台' })).toBeVisible()
  await expect(page.locator('.conversation-row').filter({ hasText: '合成 QQ 账号' }).getByRole('img', { name: 'QQ平台' })).toBeVisible()
  expect(await page.locator('.conversation-item').first().textContent()).toContain('合成 QQ 账号')
  await wxRow.getByRole('button', { name: '会话操作：微信 · 同名联系人' }).click()
  await expect(page.getByText('SnSBox 本地状态，不同步平台', { exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: '置顶会话' }).click()
  await expect(wxRow.getByRole('img', { name: '已在 SnSBox 置顶' })).toBeVisible()
  expect(await page.locator('.conversation-item').first().textContent()).toContain('合成微信账号')
  await page.reload()
  await expect(page.locator('.conversation-item').first()).toContainText('合成微信账号')
  await wxRow.getByRole('button', { name: '会话操作：微信 · 同名联系人' }).click()
  await page.getByRole('menuitem', { name: '本地免打扰' }).click()
  await expect(page.getByText('合成状态保存失败', { exact: true })).toBeVisible()
  await expect(wxRow.getByRole('img', { name: 'SnSBox 本地免打扰' })).toHaveCount(0)
  await wxRow.getByRole('button', { name: '会话操作：微信 · 同名联系人' }).click()
  await page.getByRole('menuitem', { name: '本地免打扰' }).click()
  await expect(wxRow.getByRole('img', { name: 'SnSBox 本地免打扰' })).toBeVisible()
  await wxRow.locator('.conversation-item').click()
  await expect(page.locator('.chat-header').getByRole('img', { name: '微信平台' })).toHaveCount(2)
  const initialReads = reads
  await page.locator('.chat-header').getByRole('button', { name: '会话操作：微信 · 同名联系人' }).click()
  await page.getByRole('menuitem', { name: '标为未读' }).click()
  await expect(wxRow.locator('.unread-badge')).toHaveText('1')
  await page.waitForTimeout(150)
  expect(reads).toBe(initialReads)
  const countBeforeRecovery = firstPages
  await page.getByRole('button', { name: '加载更多会话', exact: true }).click()
  await expect.poll(() => firstPages).toBeGreaterThan(countBeforeRecovery)
  await expect(page.locator('.conversation-item')).toHaveCount(2)
  expect(patches).toBe(4)
  await page.locator('.chat-header').getByRole('button', { name: '会话操作：微信 · 同名联系人' }).click()
  await page.screenshot({ path: 'test-results/conversation-local-state-desktop.png' })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.chat-header').getByRole('button', { name: '会话操作：微信 · 同名联系人' }).click()
  await page.screenshot({ path: 'test-results/conversation-local-state-mobile.png' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
