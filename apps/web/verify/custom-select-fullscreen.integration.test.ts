import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4207
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt += 1) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start the custom selector fixture server")
  browser = await launchBrowser(browserPath, 390, 844)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("shared selector mobile sheets", () => {
  test("places sparse machine, workspace and color scheme sheets directly below the grab handle", async () => {
    for (const [scenario, selector, title, count] of [
      ["autonomy-goal-notification-settings-390", '[aria-labelledby="machine-settings"] [aria-label="Machine"]', "Select Active Machine", 1],
      ["session-list-390", '.sessions-page [aria-label="Workspace"]', "Select workspace", 4],
      ["autonomy-goal-notification-settings-390", '[aria-label="Color scheme"]', "Select Color Scheme", 4],
    ] as const) {
      const page = await requireBrowser().openPage()
      try {
        await page.setMobileViewport(390, 844)
        await page.navigate(`${url()}/verify/remote.html?scenario=${scenario}`)
        await waitFor(page, `document.querySelector(${JSON.stringify(selector)}) !== null`)
        await page.evaluate<void>(`document.querySelector(${JSON.stringify(selector)}).click()`)
        await waitFor(page, `document.querySelector('.custom-select__dialog[open]') !== null`)
        await page.evaluate<void>(`Promise.all(document.querySelector('.custom-select__dialog .overlay__surface').getAnimations().map(animation => animation.finished))`)
        expect(await page.evaluate<string>(`document.querySelector('.custom-select__dialog .overlay__title').textContent`)).toBe(title)
        expect(await page.evaluate<number>(`document.querySelectorAll('.custom-select__dialog [role="option"]').length`)).toBe(count)
        const state = await geometry(page)
        expect(state.headingHeight, JSON.stringify({ title, state })).toBeLessThanOrEqual(64)
        expect(state.handleHeadGap).toBeCloseTo(state.handleBottomMargin, 0)
        expect(state.bodyHeadGap).toBeCloseTo(0, 0)
        expect(state.subtitleBodyGap).toBeCloseTo(state.bodyPaddingTop, 0)
        expect(state.listSubtitleGap).toBeCloseTo(state.subtitleListMargin, 0)
        expect(state.fullHeight).toBe(false)
        expect(state.contentSized).toBe(true)
        expect(state.bottomTracksVisualViewport).toBe(true)
        expect(state.tallestOption).toBeGreaterThanOrEqual(44)
        expect(state.tallestOption).toBeLessThanOrEqual(56)
        expect(state.confirmReachable).toBe(true)
        expect(state.bodyClipped).toBe(true)
        expect(state.pageOverflow).toBe(false)
      } finally {
        await page.close()
      }
    }
  }, 30_000)

  test("fills the visual viewport and keeps only the option list scrollable below 768px", async () => {
    for (const width of [390, 767] as const) {
      const page = await openMachinePicker(width, 844)
      try {
        await page.evaluate<void>(`(() => {
          const list = document.querySelector('.custom-select__list')
          const option = list?.querySelector('[role="option"]')
          if (!list || !option) throw new Error('Machine options are missing')
          list.append(...Array.from({ length: 24 }, () => option.cloneNode(true)))
        })()`)
        const initial = await geometry(page)
        expect(initial.fullHeight, JSON.stringify({ width, initial })).toBe(true)
        expect(initial.topTracksVisualViewport, JSON.stringify({ width, initial })).toBe(true)
        expect(initial.headingReachable).toBe(true)
        expect(initial.headingHeight).toBeLessThanOrEqual(64)
        expect(initial.handleHeadGap).toBeLessThanOrEqual(initial.handleBottomMargin + 1)
        expect(initial.handleHeadGap).toBeGreaterThanOrEqual(initial.handleBottomMargin - 1)
        expect(initial.listSubtitleGap).toBeLessThanOrEqual(initial.subtitleListMargin + 1)
        expect(initial.listSubtitleGap).toBeGreaterThanOrEqual(initial.subtitleListMargin - 1)
        expect(initial.confirmReachable).toBe(true)
        expect(initial.listScrollable).toBe(true)
        expect(initial.bodyClipped).toBe(true)
        expect(initial.pageOverflow).toBe(false)

        await page.evaluate<void>(`(() => { const list = document.querySelector('.custom-select__list'); list.scrollTop = list.scrollHeight })()`)
        const scrolled = await geometry(page)
        expect(scrolled.confirmTop).toBe(initial.confirmTop)
        expect(scrolled.headingTop).toBe(initial.headingTop)

        await page.setMobileViewport(width, 620)
        await waitFor(page, `Math.abs(document.querySelector('.custom-select__dialog .overlay__surface').getBoundingClientRect().height - window.visualViewport.height) <= 1`)
        const resized = await geometry(page)
        expect(resized.fullHeight, JSON.stringify({ width, resized })).toBe(true)
        expect(resized.topTracksVisualViewport, JSON.stringify({ width, resized })).toBe(true)
        expect(resized.confirmReachable).toBe(true)
        expect(resized.pageOverflow).toBe(false)

        const before = await page.evaluate<string>(`document.querySelector('[aria-label="Machine"] .custom-select__value')?.textContent?.trim() ?? ''`)
        const requestsBefore = await page.evaluate<number>(`window.remoteDeviceRequests.filter(request => request.deviceID === 'dev_laptop').length`)
        await page.evaluate<void>(`document.querySelector('.custom-select__option[aria-selected="false"]')?.click()`)
        expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"] .custom-select__value')?.textContent?.trim() ?? ''`)).toBe(before)
        expect(await page.evaluate<number>(`window.remoteDeviceRequests.filter(request => request.deviceID === 'dev_laptop').length`)).toBe(requestsBefore)
        await page.pressEscape()
        expect(await page.evaluate<boolean>(`document.querySelector('.custom-select__dialog')?.open === false && document.activeElement?.getAttribute('aria-label') === 'Machine'`)).toBe(true)
        expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"] .custom-select__value')?.textContent?.trim() ?? ''`)).toBe(before)
        expect(await page.evaluate<number>(`window.remoteDeviceRequests.filter(request => request.deviceID === 'dev_laptop').length`)).toBe(requestsBefore)
      } finally {
        await page.close()
      }
    }
  }, 40_000)

  test("retains the anchored popover at 768px", async () => {
    const page = await openMachinePicker(768, 900)
    try {
      const state = await page.evaluate<{ dialog: boolean; bounded: boolean; anchored: boolean; width: number; height: number }>(`(() => {
        const surface = document.querySelector('.custom-select__surface')
        const trigger = document.querySelector('[aria-label="Machine"]')
        const box = surface?.getBoundingClientRect()
        const anchor = trigger?.getBoundingClientRect()
        return {
          dialog: document.querySelector('.custom-select__dialog') !== null,
          bounded: !!box && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
          anchored: !!box && !!anchor && box.top >= anchor.bottom,
          width: box?.width ?? 0,
          height: box?.height ?? 0,
        }
      })()`)
      expect(state.dialog).toBe(false)
      expect(state.bounded).toBe(true)
      expect(state.anchored).toBe(true)
      expect(state.width).toBeLessThan(768)
      expect(state.height).toBeLessThan(900)
    } finally {
      await page.close()
    }
  }, 20_000)
})

async function openMachinePicker(width: number, height: number) {
  const page = await requireBrowser().openPage()
  if (width < 768) await page.setMobileViewport(width, height)
  else await page.setViewport(width, height)
  await page.navigate(`${url()}/verify/remote.html?scenario=conversation-workspace-390`)
  await waitFor(page, `document.querySelector('a[href="/remote/settings"]') !== null`)
  await page.evaluate<void>(`document.querySelector('a[href="/remote/settings"]')?.click()`)
  await waitFor(page, `document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]') !== null`)
  await page.evaluate<void>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.click()`)
  await waitFor(page, width < 768 ? `document.querySelector('.custom-select__dialog[open]') !== null` : `document.querySelector('.custom-select__surface [role="listbox"]') !== null`)
  await page.evaluate<void>(`Promise.all([...document.querySelector('.custom-select__dialog .overlay__surface, .custom-select__surface')?.getAnimations() ?? []].map(animation => animation.finished))`)
  return page
}

async function geometry(page: { evaluate<T>(expression: string): Promise<T> }) {
  return page.evaluate<{
    fullHeight: boolean
    contentSized: boolean
    bottomTracksVisualViewport: boolean
    tallestOption: number
    topTracksVisualViewport: boolean
    headingReachable: boolean
    confirmReachable: boolean
    listScrollable: boolean
    bodyClipped: boolean
    pageOverflow: boolean
    headingTop: number
    headingHeight: number
    handleHeadGap: number
    handleBottomMargin: number
    bodyHeadGap: number
    subtitleBodyGap: number
    bodyPaddingTop: number
    listSubtitleGap: number
    subtitleListMargin: number
    confirmTop: number
    surfaceTop: number
    surfaceBottom: number
    viewportTop: number
    viewportHeight: number
    confirmBottom: number
  }>(`(() => {
    const viewport = window.visualViewport
    const dialog = document.querySelector('.custom-select__dialog')
    const surface = dialog?.querySelector('.overlay__surface')
    const body = dialog?.querySelector('.overlay__body')
    const list = dialog?.querySelector('.custom-select__list')
    const heading = dialog?.querySelector('.overlay__head')
    const confirm = dialog?.querySelector('.custom-select__confirm')
    const subtitle = dialog?.querySelector('.custom-select__subtitle')
    if (!(surface instanceof HTMLElement) || !(body instanceof HTMLElement) || !(list instanceof HTMLElement) || !(heading instanceof HTMLElement) || !(confirm instanceof HTMLElement) || !(subtitle instanceof HTMLElement) || !viewport) throw new Error('Mobile selector sheet is incomplete')
    const surfaceBox = surface.getBoundingClientRect()
    const headingBox = heading.getBoundingClientRect()
    const confirmBox = confirm.getBoundingClientRect()
    const subtitleBox = subtitle.getBoundingClientRect()
    const listBox = list.getBoundingClientRect()
    const handleStyle = getComputedStyle(surface, '::before')
    const viewportTop = viewport.offsetTop
    const viewportBottom = viewportTop + viewport.height
    return {
      fullHeight: Math.abs(surfaceBox.height - viewport.height) <= 1,
      contentSized: surfaceBox.height < viewport.height - 8,
      bottomTracksVisualViewport: Math.abs(surfaceBox.bottom - viewportBottom) <= 2,
      tallestOption: Math.max(0, ...[...dialog.querySelectorAll('[role="option"]')].map((option) => option.getBoundingClientRect().height)),
      topTracksVisualViewport: Math.abs(surfaceBox.top - viewportTop) <= 1,
      headingReachable: headingBox.top >= viewportTop && headingBox.bottom <= viewportBottom,
      confirmReachable: confirmBox.top >= viewportTop && confirmBox.bottom <= viewportBottom,
      listScrollable: getComputedStyle(list).overflowY === 'auto' && list.scrollHeight > list.clientHeight,
      bodyClipped: getComputedStyle(body).overflow === 'hidden' && body.scrollHeight === body.clientHeight,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      headingTop: headingBox.top,
      headingHeight: headingBox.height,
      handleHeadGap: headingBox.top - surfaceBox.top - parseFloat(getComputedStyle(surface).paddingTop) - parseFloat(handleStyle.blockSize),
      handleBottomMargin: parseFloat(handleStyle.marginBottom),
      bodyHeadGap: body.getBoundingClientRect().top - headingBox.bottom,
      subtitleBodyGap: subtitleBox.top - body.getBoundingClientRect().top,
      bodyPaddingTop: parseFloat(getComputedStyle(body).paddingTop),
      listSubtitleGap: listBox.top - subtitleBox.bottom,
      subtitleListMargin: parseFloat(getComputedStyle(list).marginBlockStart),
      confirmTop: confirmBox.top,
      surfaceTop: surfaceBox.top,
      surfaceBottom: surfaceBox.bottom,
      viewportTop,
      viewportHeight: viewport.height,
      confirmBottom: confirmBox.bottom,
    }
  })()`)
}

async function waitFor(page: { evaluate<T>(expression: string): Promise<T> }, expression: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(50)
  }
  throw new Error(`Browser condition did not settle: ${expression}`)
}

async function ready(): Promise<boolean> {
  return fetch(`${url()}/verify/remote.html`).then((response) => response.ok, () => false)
}

function url(): string {
  return `http://127.0.0.1:${port}`
}

function requireBrowser() {
  if (!browser) throw new Error("Browser setup did not complete")
  return browser
}
