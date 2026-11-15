import { expect, test } from '@playwright/test'

test('登录任务按账号隔离、二维码到期、未知结果和终态停止轮询', async ({ page }) => {
  const accounts = ['a', 'b'].map(id => ({ id: `fixture-${id}`, platform: 'wechat', displayName: `合成账号 ${id.toUpperCase()}`, status: 'offline', upstreamConfigured: true, capabilities: { login: { status: 'unverified' }, logout: { status: 'unverified' }, history: { status: 'supported' } } }))
  const calls: Record<string, number> = { a: 0, b: 0, login: 0, provision: 0 }
  const phases = { a: 'awaiting_scan', b: 'succeeded' }
  // Agent WeChat's actual attempt.expires_at() is a u32 Unix timestamp in seconds.
  let expiresAt = Math.floor(Date.now() / 1000) + 60
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true, csrfToken: 'synthetic-task-test' } })
    if (path.endsWith('/accounts')) return route.fulfill({ json: { items: accounts } })
    if (path.endsWith('/conversations')) return route.fulfill({ json: { items: [] } })
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': synthetic\n\n' })
    if (path.endsWith('/compatibility')) return route.fulfill({ json: { configured: true, mode: 'live-source-readonly', nextStep: 'exclusive-copy-required', message: '合成资料元数据预检，未打开真实文件', wechat: { profileRoots: 2, sessionDatabases: 2, contactDatabases: 2, messageDatabases: 3 }, qq: { profileRoots: 1 } } })
    if (path.endsWith('/provision')) { calls.provision++; expect(route.request().postDataJSON()).toEqual({ confirmIsolated: true }); return route.fulfill({ json: { created: false, accountId: 'fixture-a', message: '合成：独立账号已存在，未覆盖' } }) }
    const id = path.includes('/fixture-a/') ? 'a' : 'b'
    if (path.endsWith('/login')) { calls.login++; expect(route.request().headers()['idempotency-key']).toBeTruthy(); return route.fulfill({ json: { state: id === 'b' ? 'uncertain' : 'pending', operationId: `task-${id}`, message: '合成登录请求，仅用于检查任务界面' } }) }
    if (path.endsWith('/qr')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') })
    if (path.includes('/operations/')) { calls[id]++; return route.fulfill({ json: { id: `task-${id}`, accountId: `fixture-${id}`, kind: 'login', state: id === 'b' ? 'uncertain' : phases.a === 'expired' ? 'blocked' : 'pending', phase: phases[id], qrCode: `/api/v1/accounts/fixture-${id}/operations/task-${id}/qr`, expiresAt, qrGeneration: 1, createdAt: String(Math.floor(Date.now() / 1000)), message: id === 'b' ? '合成：任务结束但在线状态未确认' : '合成二维码图片，非有效登录码，不连接真实账号' } }) }
    return route.fulfill({ status: 404, json: { error: { code: 'fixture_missing', message: 'fixture' } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '管理账号', exact: true }).first().click()
  const a = page.getByRole('region', { name: '微信 · 合成账号 A' })
  const b = page.getByRole('region', { name: '微信 · 合成账号 B' })
  await a.locator('summary').filter({ hasText: '首次接入' }).click()
  await a.getByRole('button', { name: '初始化独立账号' }).click()
  await expect(page.getByRole('button', { name: '准备独立账号', exact: true })).toBeDisabled()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: '准备独立账号', exact: true }).click()
  await expect(a.getByText('合成：独立账号已存在，未覆盖')).toBeVisible()
  expect(calls.provision).toBe(1)
  await a.getByRole('button', { name: '验证登录', exact: true }).click()
  await expect(a.getByRole('img', { name: '微信登录二维码（仅当前任务）' })).toBeVisible()
  await expect(a.getByText('登录账号 · 等待手机扫码', { exact: true })).toBeVisible()
  await expect(a.locator('.account-state')).toHaveText('离线')
  await b.getByRole('button', { name: '验证登录', exact: true }).click()
  await expect(b.getByText('登录账号 · 需要核对结果', { exact: true })).toBeVisible()
  await expect(b.getByText('任务已完成', { exact: false })).toHaveCount(0)
  await expect(b.getByRole('img', { name: '微信登录二维码（仅当前任务）' })).toHaveCount(0)
  await expect(b.getByRole('button', { name: '验证登录', exact: true })).toBeDisabled()
  await expect(b.locator('.account-state')).toHaveText('离线')
  await page.screenshot({ path: 'test-results/account-tasks-desktop-synthetic.png' })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  const beforeClose = { a: calls.a, b: calls.b }
  await page.waitForTimeout(2200)
  expect({ a: calls.a, b: calls.b }).toEqual(beforeClose)
  const references = await page.evaluate(() => JSON.parse(sessionStorage.getItem('snsbox.operationReferences') || '[]'))
  expect(references).toHaveLength(2)
  expect(references[0]).toEqual({ accountId: 'fixture-a', platform: 'wechat', operationId: 'task-a' })
  await page.reload()
  await page.getByRole('button', { name: '管理账号', exact: true }).first().click()
  await expect(a.getByRole('img', { name: '微信登录二维码（仅当前任务）' })).toBeVisible()
  await expect(b.getByText('登录账号 · 需要核对结果', { exact: true })).toBeVisible()
  expect(calls.login).toBe(2)
  expiresAt = Math.floor(Date.now() / 1000) - 1
  await a.getByRole('button', { name: '刷新任务', exact: true }).click()
  await expect(a.getByText('登录账号 · 二维码已过期', { exact: true })).toBeVisible()
  await expect(a.getByRole('img', { name: '微信登录二维码（仅当前任务）' })).toHaveCount(0)
  phases.a = 'expired'
  await a.getByRole('button', { name: '刷新任务', exact: true }).click()
  await expect(a.getByRole('button', { name: '验证登录', exact: true })).toBeEnabled()
  const beforeTerminal = { a: calls.a, b: calls.b }
  await page.waitForTimeout(2200)
  expect({ a: calls.a, b: calls.b }).toEqual(beforeTerminal)
  expect(calls.login).toBe(2)
  await page.getByRole('button', { name: '只读预检', exact: true }).click()
  await expect(page.getByText('资料目录 2 · 会话库文件 2 · 消息库文件 3')).toBeVisible()
  await expect(page.getByText('识别到目录或数据库特征，不代表已解密、已登录或可收发消息。')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.account-modal .modal-body').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: 'test-results/account-tasks-mobile-synthetic.png' })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '退出 SnSBox', exact: true }).click()
  await expect(page.getByLabel('SnSBox 管理密码')).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('snsbox.operationReferences'))).toBeNull()
})
