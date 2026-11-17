import { chromium, expect, test, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const syntheticSession = { status: 401, json: { error: { code: 'unauthorized', message: 'synthetic layout fixture' } } }
const areaHeight = (page: Page, selector: string) => page.locator(selector).evaluate(element => element.getBoundingClientRect().height)
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)

async function nativeZoomScreenshot(page: Page, file: string) {
  // With viewport:null, Playwright's ordinary screenshot clip can crop native zoom.
  const cdp = await page.context().newCDPSession(page)
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  const png = Buffer.from(data, 'base64')
  const physicalWidth = await page.evaluate(() => Math.round(innerWidth * devicePixelRatio))
  expect(png.readUInt32BE(16)).toBe(physicalWidth)
  await writeFile(file, png)
  await cdp.detach()
}

async function settings(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1)
  const body = dialog.locator('.modal-body')
  expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await body.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
}

test('低高度与窄屏保留消息、会话列表及可达的历史和设置', async ({ page }) => {
  await page.route('**/api/v1/**', route => route.fulfill(syntheticSession))
  await page.goto('/')
  await page.getByRole('button', { name: '打开界面演示', exact: true }).click()
  await page.setViewportSize({ width: 640, height: 360 })
  expect(await areaHeight(page, '.message-scroll')).toBeGreaterThanOrEqual(120)
  await expect(page.getByRole('textbox', { name: /发送消息/ })).toBeInViewport()
  await expect(page.getByRole('button', { name: '发送演示消息', exact: true })).toBeInViewport()
  await page.screenshot({ path: 'test-results/layout-fixed-chat-640x360.png', animations: 'disabled' })
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
  expect(await areaHeight(page, '.conversation-scroll')).toBeGreaterThanOrEqual(80)
  await settings(page)

  await page.setViewportSize({ width: 800, height: 400 })
  await page.locator('.conversation-item').first().click()
  expect(await areaHeight(page, '.message-scroll')).toBeGreaterThanOrEqual(150)
  expect(await areaHeight(page, '.conversation-scroll')).toBeGreaterThanOrEqual(150)
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeInViewport()
  await page.screenshot({ path: 'test-results/layout-fixed-chat-800x400.png', animations: 'disabled' })
  await settings(page)
  await page.setViewportSize({ width: 320, height: 568 })
  expect(await fitsWidth(page)).toBe(true)
  await expect(page.getByRole('button', { name: '会话信息与能力', exact: true })).toBeInViewport()
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
  await settings(page)
  await page.getByRole('button', { name: '既有历史', exact: true }).click()
  const history = page.locator('.history-workspace')
  await history.locator('.history-conversation').scrollIntoViewIfNeeded()
  await expect(history.locator('.history-conversation')).toBeInViewport()
  await history.locator('.history-conversation').click()
  await expect(history.locator('.readonly-history-footer')).toBeInViewport()
  expect(await areaHeight(page, '.message-scroll')).toBeGreaterThanOrEqual(150)
  expect(await fitsWidth(page)).toBe(true)
})

test('Edge 原生 200% 页面缩放下登录、聊天、设置与只读历史可用', async () => {
  const metrics: unknown[] = []
  let baseline: { width: number; height: number; dpr: number } | undefined
  for (const zoom of [1, 2]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'snsbox-reflow-zoom-'))
    await mkdir(path.join(directory, 'Default'))
    // Chromium HostZoomMap preferences, not CSS zoom or emulated device scaling.
    // x is the current default partition; 0 supports earlier Chromium/Edge builds.
    await writeFile(path.join(directory, 'Default', 'Preferences'), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(zoom) / Math.log(1.2), 0: Math.log(zoom) / Math.log(1.2) } } }))
    const context = await chromium.launchPersistentContext(directory, { channel: 'msedge', headless: true, viewport: null, args: ['--window-size=1440,900'] })
    try {
      await context.route('**/api/v1/**', route => route.fulfill(syntheticSession))
      const page = context.pages()[0]
      await page.goto('http://127.0.0.1:18731')
      const measured = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio, visualScale: visualViewport!.scale, cssZoom: getComputedStyle(document.documentElement).zoom, transform: getComputedStyle(document.documentElement).transform }))
      metrics.push({ requestedZoom: zoom, ...measured })
      if (zoom === 1) { baseline = measured; continue }
      expect(measured.dpr / baseline!.dpr).toBeCloseTo(2, 1)
      expect(Math.abs(measured.width * 2 - baseline!.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(measured.height * 2 - baseline!.height)).toBeLessThanOrEqual(1)
      expect(measured.visualScale).toBe(1)
      expect(measured.cssZoom).toBe('1')
      expect(measured.transform).toBe('none')
      const password = page.getByLabel('SnSBox 管理密码')
      await password.scrollIntoViewIfNeeded()
      await expect(password).toBeInViewport()
      const demo = page.getByRole('button', { name: '打开界面演示', exact: true })
      await demo.scrollIntoViewIfNeeded()
      await expect(demo).toBeInViewport()
      await demo.click()
      expect(await areaHeight(page, '.message-scroll')).toBeGreaterThanOrEqual(150)
      await expect(page.getByRole('button', { name: '发送演示消息', exact: true })).toBeInViewport()
      await nativeZoomScreenshot(page, 'test-results/layout-browser-200-chat.png')
      await page.getByRole('button', { name: '返回会话列表', exact: true }).click()
      await settings(page)
      await page.getByRole('button', { name: '既有历史', exact: true }).click()
      await page.locator('.history-conversation').scrollIntoViewIfNeeded()
      await page.locator('.history-conversation').click()
      expect(await areaHeight(page, '.message-scroll')).toBeGreaterThanOrEqual(150)
      await expect(page.locator('.readonly-history-footer')).toBeInViewport()
      await nativeZoomScreenshot(page, 'test-results/layout-browser-200-history.png')
      expect(await fitsWidth(page)).toBe(true)
    } finally {
      await context.close()
      const absolute = path.resolve(directory)
      if (!absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(absolute).startsWith('snsbox-reflow-zoom-')) throw new Error('Unexpected temporary profile path')
      await rm(absolute, { recursive: true, force: true })
    }
  }
  await writeFile('test-results/layout-browser-zoom-metrics.json', JSON.stringify(metrics, null, 2))
})

test('历史空状态与多来源长说明在矮窗口仍可滚动访问', async ({ page }) => {
  const blocked = { id: 'synthetic-blocked', platform: 'wechat', displayName: '合成阻塞来源', kind: 'legacy-readonly', status: 'keys_required', reason: '合成条件说明。'.repeat(70), readOnly: true, sendAllowed: false, partial: false, consistency: 'unavailable' }
  const ready = { ...blocked, id: 'synthetic-ready', displayName: '合成可读来源', status: 'ready', generation: 'synthetic-only', reason: '合成范围说明。'.repeat(70), messageCount: 0, conversationCount: 1 }
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true, csrfToken: 'synthetic-layout' } })
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': synthetic\n\n' })
    if (path.endsWith('/history/sources')) return route.fulfill({ json: { items: [blocked, ready, ...Array.from({ length: 4 }, (_, index) => ({ ...blocked, id: `synthetic-extra-${index}`, displayName: `合成来源 ${index + 1}` }))] } })
    if (path.includes('/history/') && path.endsWith('/conversations')) return route.fulfill({ json: { items: [{ id: 'synthetic-history-conversation', sourceId: ready.id, accountId: `history:${ready.id}`, platform: 'wechat', title: '合成会话', kind: 'direct', unreadCount: 0, readOnly: true }] } })
    return route.fulfill({ json: { items: [] } })
  })
  await page.setViewportSize({ width: 1000, height: 360 })
  await page.goto('/')
  await page.getByRole('button', { name: '既有历史', exact: true }).click()
  const empty = page.locator('.history-empty')
  expect(await empty.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  expect(await empty.evaluate(element => element.firstElementChild!.getBoundingClientRect().top >= element.getBoundingClientRect().top)).toBe(true)
  await empty.locator('.history-boundary').scrollIntoViewIfNeeded()
  await expect(empty.locator('.history-boundary')).toBeInViewport()
  await page.setViewportSize({ width: 800, height: 600 })
  await page.getByRole('button', { name: /合成可读来源/ }).click()
  expect(await areaHeight(page, '.history-conversations')).toBeGreaterThanOrEqual(150)
  await page.locator('.history-conversation').scrollIntoViewIfNeeded()
  await expect(page.locator('.history-conversation')).toBeInViewport()
  await expect(page.getByRole('button', { name: '返回在线会话', exact: true })).toBeInViewport()
  expect(await fitsWidth(page)).toBe(true)
})
