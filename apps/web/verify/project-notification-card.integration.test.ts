import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4767
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: process.env.YCODING_CARD_CAPTURE_DIR ? Bun.file(`${process.env.YCODING_CARD_CAPTURE_DIR}/vite.log`) : "ignore",
    stderr: process.env.YCODING_CARD_CAPTURE_DIR ? Bun.file(`${process.env.YCODING_CARD_CAPTURE_DIR}/vite-error.log`) : "ignore",
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((result) => result.ok, () => false)) break
    await Bun.sleep(100)
  }
  browser = await launchBrowser(executable, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

async function wait(page: Page, expression: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(40)
  }
  throw new Error(`Project cards did not settle: ${expression}`)
}

async function openCards(page: Page, theme: "light" | "dark") {
  await page.setColorScheme(theme)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=coordination-projects-1440&projectCards=1&theme=${theme}`)
  await wait(page, `!!document.querySelector('.project-card')`)
  await page.evaluate(`document.querySelectorAll('.fixture__banner,.fixture__controls').forEach(element => element.remove())`)
  expect(await page.evaluate<string>(`document.documentElement.dataset.theme`)).toBe(theme)
  await page.evaluate(`[...document.querySelectorAll('button')].find(e => e.getAttribute('aria-label') === 'Open project Release train').click()`)
  await wait(page, `document.querySelectorAll('.project-event').length === 5`)
  await page.evaluate(`document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`)
  await page.evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect && Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => undefined)))`)
}

const cases = (["light", "dark"] as const).flatMap((theme) => [1440, 1024, 1023, 640, 639, 390, 359].map((width) => ({ theme, width })))

test.each(cases)("Project cards use bounded full-width previews at $width in $theme", async ({ theme, width }) => {
  const page = await browser!.openPage()
  try {
    if (width < 640) await page.setMobileViewport(width, 900)
    if (width >= 640) await page.setViewport(width, 900)
    await openCards(page, theme)
    expect(await page.evaluate<number>(`innerWidth`)).toBe(width)
    if (process.env.YCODING_CARD_CAPTURE_DIR) await Bun.write(`${process.env.YCODING_CARD_CAPTURE_DIR}/${theme}-${width}.png`, Buffer.from(await page.screenshot(), "base64"))
    const measured = await page.evaluate<{ overflow: number; cards: { event: string; preview: boolean; contained: boolean; width: number; available: number; height: number; line: number; below: boolean; action: boolean; compact: boolean }[] }>(`(() => {
      const rect = e => e.getBoundingClientRect()
      return { overflow: document.documentElement.scrollWidth - innerWidth, cards: [...document.querySelectorAll('.project-event')].map(card => {
        const title = rect(card.querySelector('strong'))
        const status = rect(card.querySelector('.project-event__status') || card.querySelectorAll(':scope > span')[1])
        const action = rect(card.querySelector('a'))
        const preview = card.querySelector('.project-event__excerpt')
        const style = getComputedStyle(card)
        const box = rect(card)
        const excerpt = preview && rect(preview)
        const header = Math.max(title.bottom, status.bottom, action.bottom)
        return { event: card.dataset.event, preview: !!preview && !!preview.textContent, contained: card.scrollWidth <= card.clientWidth,
          width: excerpt?.width || 0, available: card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          height: excerpt?.height || 0, line: preview ? parseFloat(getComputedStyle(preview).lineHeight) : 0,
          below: !preview || !preview.textContent || excerpt.top >= header - 1,
          action: action.left >= title.right && action.left >= status.right && action.right <= box.right,
          compact: box.height <= header - box.top + (excerpt?.height || 0) + parseFloat(style.paddingBottom) + 8 }
      }) }
    })()`)
    expect(measured.overflow).toBeLessThanOrEqual(0)
    expect(measured.cards.map(card => card.event)).toEqual(["completed", "failed", "interrupted", "question", "escalated"])
    for (const card of measured.cards) {
      expect(card.contained).toBe(true)
      expect(card.action).toBe(true)
      expect(card.below).toBe(true)
      expect(card.compact).toBe(true)
      if (card.event === "interrupted") expect(card.preview).toBe(false)
      if (!card.preview) continue
      expect(card.width).toBeGreaterThanOrEqual(card.available * 0.95)
      expect(card.height).toBeLessThanOrEqual(card.line * 3 + 1)
    }
    const link = `.project-event a`
    await page.evaluate(`document.querySelector('${link}').scrollIntoView({block:'center',behavior:'instant'})`)
    if (await page.evaluate<boolean>(`matchMedia('(hover:hover)').matches`)) {
      const target = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('${link}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      await page.mouse("mouseMoved", target.x, target.y)
      expect(await page.evaluate<boolean>(`document.querySelector('${link}').matches(':hover')`)).toBe(true)
      if (process.env.YCODING_CARD_CAPTURE_DIR) await Bun.write(`${process.env.YCODING_CARD_CAPTURE_DIR}/${theme}-${width}-hover.png`, Buffer.from(await page.screenshot(), "base64"))
    }
    await page.pressKey("Tab", "Tab", 9)
    await page.evaluate(`document.querySelector('${link}').focus()`)
    expect(await page.evaluate<boolean>(`document.activeElement.matches('${link}')`)).toBe(true)
    expect(await page.evaluate<string>(`document.activeElement.getAttribute('aria-label')`)).toBe("Open session Coordinate-the-release-train-checkout-api-migration-and-rollout-notes-for-every-region")
    expect(await page.evaluate<boolean>(`(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' || s.boxShadow !== 'none' })()`)).toBe(true)
    if (process.env.YCODING_CARD_CAPTURE_DIR) await Bun.write(`${process.env.YCODING_CARD_CAPTURE_DIR}/${theme}-${width}-focus.png`, Buffer.from(await page.screenshot(), "base64"))
    await page.pressKey("Enter", "Enter", 13)
    await wait(page, `new URL(location.href).searchParams.get('session_id') === 'ses_card_0'`)
  } finally { await page.close() }
}, 90_000)
