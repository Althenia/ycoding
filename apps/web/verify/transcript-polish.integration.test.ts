import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4386
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

beforeAll(async () => {
  if (!await ready()) server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80 && !await ready(); attempt += 1) await Bun.sleep(100)
  if (!await ready()) throw new Error("Vite did not start the workspace fixture")
  browser = await launchBrowser(browserPath, 1440, 900)
}, 30_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

const chat = (theme: "light" | "dark", extra = "", preview = true) => `http://127.0.0.1:${port}/verify/remote.html?view=chat${preview ? "&acceptedPreview=1" : ""}&theme=${theme}${extra}`
const viewports = [{ name: "wide", width: 1440, height: 900, mobile: false }, { name: "phone", width: 390, height: 844, mobile: true }] as const

async function open(theme: "light" | "dark", extra: string, viewport: (typeof viewports)[number] = viewports[0], preview = true) {
  const page = await requireBrowser().openPage()
  if (viewport.mobile) await page.setMobileViewport(viewport.width, viewport.height)
  else await page.setViewport(viewport.width, viewport.height)
  await page.setColorScheme(theme)
  await page.navigate(chat(theme, extra, preview))
  await until(page, `document.querySelector('.transcript-navigation__item') !== null && document.querySelector('.composer .composer__row') !== null`)
  return page
}

describe("transcript activity and queued input", () => {
  test("shows activity in the transcript, never in the composer, and labels queued input once", async () => {
    const page = await open("light", "&requests=form&queued=1")
    try {
      await until(page, `document.querySelector('.transcript-activity__status') !== null && document.querySelector('.transcript-message:has([data-delivery-state="queued"])') !== null`)
      const state = await page.evaluate<{ slots: number; activityInScroll: boolean; activity: string; composerStatus: number; queued: number; queuedLabels: number }>(`(() => {
        const activity = document.querySelector('.transcript-activity')
        const queued = [...document.querySelectorAll('.transcript-message:has([data-delivery-state="queued"])')]
        return {
          slots: document.querySelectorAll('.session-status__slot').length,
          activityInScroll: !!activity?.closest('.workspace__scroll'),
          activity: activity?.textContent.trim() ?? '',
          composerStatus: document.querySelectorAll('.composer [role="status"]:not(.transcript-message__receipt):not(.session-status__announce)').length,
          queued: queued.length,
          queuedLabels: queued.reduce((count, row) => count + [...row.querySelectorAll('*')].filter((element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() === 'Queued')).length, 0),
        }
      })()`)
      expect(state).toEqual({ slots: 0, activityInScroll: true, activity: "Waiting for your decision", composerStatus: 0, queued: 1, queuedLabels: 1 })
    } finally { await page.close() }
  }, 30_000)
})

describe("inline images", () => {
  test("renders referenced images as thumbnails inside the bubble without their tokens and opens them in the lightbox", async () => {
    const page = await open("light", "&images=1")
    try {
      await page.evaluate(`document.querySelector('.transcript-message__images').scrollIntoView({ block: 'center' })`)
      await until(page, `document.querySelectorAll('.transcript-message__bubble .transcript-image img').length >= 3 && [...document.querySelectorAll('.transcript-message__bubble .transcript-image img')].every((image) => image.complete && image.naturalWidth > 0)`)
      const bubbles = await page.evaluate<{ text: string; images: number }[]>(`[...document.querySelectorAll('.transcript-message__bubble')].filter((bubble) => bubble.querySelector('.transcript-message__images')).map((bubble) => ({ text: bubble.querySelector('.transcript-message__bubble-text')?.textContent ?? '', images: bubble.querySelectorAll('.transcript-image').length }))`)
      expect(bubbles).toEqual([
        { text: "Compare with and keep the spacing from the second one.", images: 2 },
        { text: "", images: 1 },
      ])
      expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-image__unavailable').length`)).toBe(0)
      await page.evaluate(`document.querySelector('.transcript-message__bubble .transcript-image').click()`)
      await until(page, `document.querySelector('dialog.transcript-lightbox[open]') !== null`)
      expect(await page.evaluate<string>(`document.querySelector('dialog.transcript-lightbox').getAttribute('aria-label')`)).toBe("Image: layout-1.png")
    } finally { await page.close() }
  }, 30_000)
})

describe("disclosure motion", () => {
  test("opening a Thought row above the reading position keeps the reading row in place", async () => {
    const page = await open("light", "", viewports[0], false)
    try {
      await until(page, `document.querySelector('.transcript-reasoning__toggle') !== null`)
      const before = await page.evaluate<{ id: string; top: number }>(`(() => {
        const toggle = document.querySelector('.transcript-reasoning__toggle')
        const scroller = document.querySelector('.workspace__scroll')
        scroller.scrollTop += toggle.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + 40
        const anchor = [...document.querySelectorAll('.transcript-navigation__item, .transcript-row, article')].find((row) => row.getBoundingClientRect().top > scroller.getBoundingClientRect().top + 8)
        anchor.dataset.readingAnchor = '1'
        return { id: anchor.tagName, top: anchor.getBoundingClientRect().top }
      })()`)
      await page.evaluate(`document.querySelector('.transcript-reasoning__toggle').click()`)
      await Bun.sleep(500)
      const after = await page.evaluate<{ expanded: string | null; open: boolean; top: number }>(`(() => {
        const toggle = document.querySelector('.transcript-reasoning__toggle')
        const body = document.getElementById(toggle.getAttribute('aria-controls'))
        return { expanded: toggle.getAttribute('aria-expanded'), open: body.classList.contains('collapsible') && body.hasAttribute('data-open'), top: document.querySelector('[data-reading-anchor]').getBoundingClientRect().top }
      })()`)
      expect(after.expanded).toBe("true")
      expect(after.open).toBe(true)
      expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
    } finally { await page.close() }
  }, 30_000)
})

for (const theme of ["light", "dark"] as const) {
  for (const viewport of viewports) {
    describe(`floating composer in ${theme} at ${viewport.name} width`, () => {
      test("floats an inset rounded card over the scrolling transcript and keeps the last content above it", async () => {
        const page = await open(theme, "&requests=form&queued=1", viewport)
        try {
          await page.evaluate(`(() => { const scroller = document.querySelector('.workspace__scroll'); scroller.scrollTop = scroller.scrollHeight })()`)
          await Bun.sleep(600)
          const layout = await page.evaluate<{ placeholder: string; radius: number; shadow: string; fieldBorder: string; insetStart: number; insetEnd: number; scrollerBelowCard: boolean; clear: { name: string; bottom: number }[]; cardTop: number }>(`(() => {
            const card = document.querySelector('.composer .composer__row').getBoundingClientRect()
            const scroller = document.querySelector('.workspace__scroll')
            const box = scroller.getBoundingClientRect()
            const content = box.left + scroller.clientLeft
            const named = (name, element) => ({ name, bottom: element ? Math.round(element.getBoundingClientRect().bottom) : -1 })
            const button = (label) => [...document.querySelectorAll('#pending-requests button')].find((element) => element.textContent.trim() === label)
            return {
              placeholder: document.querySelector('.composer__input').getAttribute('placeholder'),
              radius: parseFloat(getComputedStyle(document.querySelector('.composer .composer__row')).borderTopLeftRadius),
              shadow: getComputedStyle(document.querySelector('.composer .composer__row')).boxShadow,
              fieldBorder: getComputedStyle(document.querySelector('.composer .mini-composer__input-wrap')).borderTopWidth,
              insetStart: Math.round(card.left - content),
              insetEnd: Math.round(content + scroller.clientWidth - card.right),
              scrollerBelowCard: box.bottom >= card.bottom - 1,
              clear: [named('Send answer', button('Send answer')), named('Cancel', button('Cancel')), named('queued bubble', document.querySelector('.transcript-message:has([data-delivery-state="queued"]) .transcript-message__bubble')), named('activity row', document.querySelector('.transcript-activity'))],
              cardTop: Math.round(card.top),
            }
          })()`)
          expect(layout.placeholder).toBe("Ask YCoding…")
          expect(layout.radius).toBe(20)
          expect(layout.shadow).toBe("none")
          expect(layout.fieldBorder).toBe("0px")
          expect(layout.insetStart).toBeGreaterThan(0)
          expect(layout.insetEnd).toBeGreaterThan(0)
          expect(layout.scrollerBelowCard).toBe(true)
          for (const item of layout.clear) expect({ name: item.name, clear: item.bottom !== -1 && item.bottom <= layout.cardTop }).toEqual({ name: item.name, clear: true })
        } finally { await page.close() }
      }, 30_000)

      test("keeps the last content above the card after the draft grows", async () => {
        const page = await open(theme, "&requests=form&queued=1", viewport)
        try {
          await page.evaluate(`(() => { const scroller = document.querySelector('.workspace__scroll'); scroller.scrollTop = scroller.scrollHeight })()`)
          await Bun.sleep(400)
          await page.evaluate(`(() => { const input = document.querySelector('.composer__input'); input.focus(); document.execCommand('insertText', false, ['one', 'two', 'three', 'four', 'five', 'six'].join('\\n')) })()`)
          await Bun.sleep(600)
          const layout = await page.evaluate<{ queued: number; cardTop: number; scrollerVisible: boolean }>(`(() => {
            const card = document.querySelector('.composer .composer__row').getBoundingClientRect()
            return { queued: Math.round(document.querySelector('.transcript-message:has([data-delivery-state="queued"]) .transcript-message__bubble').getBoundingClientRect().bottom), cardTop: Math.round(card.top), scrollerVisible: card.top > document.querySelector('.workspace__scroll').getBoundingClientRect().top }
          })()`)
          expect(layout.scrollerVisible).toBe(true)
          expect(layout.queued).toBeLessThanOrEqual(layout.cardTop)
        } finally { await page.close() }
      }, 30_000)
    })
  }
}

function requireBrowser() {
  if (!browser) throw new Error("Browser did not start")
  return browser
}

async function ready() {
  return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)
}

async function until(page: Page, expression: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}
