import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { launchBrowser } from "./cdp"

const port = 4398
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60; index++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/transcript.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 1440, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("File-change transcript fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("shows cumulative file counts after the last assistant and expands latest patches in split or unified layout", async () => {
  const page = await browser!.openPage()
  try {
    await mkdir(new URL("../../../.cache/tmp/", import.meta.url), { recursive: true })
    for (const theme of ["light", "dark"] as const) for (const width of [1440, 820, 390]) {
      await page.setViewport(width, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?file-changes=captured&theme=${theme}`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('.file-change-card')`); attempt++) await Bun.sleep(50)
      const collapsed = await page.evaluate<{ cards: number; attached: boolean; title: string; counts: string; rows: number; more: string; expanded: string }>(`(() => {
        const card = document.querySelector('.file-change-card');
        return { cards: document.querySelectorAll('.file-change-card').length,
          attached: !!document.querySelector('[data-message-id="msg_latest"] .file-change-card') && !document.querySelector('[data-message-id="msg_earlier"] .file-change-card'),
          title: card?.querySelector('.file-change-card__title')?.textContent ?? '',
          counts: card?.querySelector('.file-change-card__totals')?.textContent ?? '',
          rows: card?.querySelectorAll('.file-change-card__file-toggle').length ?? 0,
          more: card?.querySelector('.file-change-card__more')?.textContent?.trim() ?? '',
          expanded: card?.querySelector('.file-change-card__file-toggle')?.getAttribute('aria-expanded') ?? '' }
      })()`)
      expect(collapsed).toEqual({ cards: 1, attached: true, title: "Edited 4 files", counts: "+5 −3", rows: 3, more: "Show 1 more file", expanded: "false" })
      const geometry = await page.evaluate<{ left: number; right: number; columnLeft: number; columnRight: number }>(`(() => { const card = document.querySelector('.file-change-card').getBoundingClientRect(); const column = document.querySelector('.transcript-navigation .transcript').getBoundingClientRect(); return { left: card.left, right: card.right, columnLeft: column.left, columnRight: column.right } })()`)
      expect(Math.abs(geometry.left - geometry.columnLeft)).toBeLessThanOrEqual(1)
      expect(Math.abs(geometry.right - geometry.columnRight)).toBeLessThanOrEqual(1)
      expect(await page.evaluate<boolean>(`(() => { const button = document.querySelector('.file-change-card__more'); return document.getElementById(button.getAttribute('aria-controls')) === document.querySelector('.file-change-card__files') })()`)).toBe(true)

      await page.evaluate(`document.querySelector('.file-change-card__more').click()`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.file-change-card__file-toggle').length`)).toBe(4)
      expect(await page.evaluate<string>(`document.querySelector('.file-change-card__more').getAttribute('aria-expanded')`)).toBe("true")
      await page.evaluate(`document.querySelector('.file-change-card__file-toggle').click()`)
      const opened = await page.evaluate<{ label: string; expanded: string; split: boolean; unified: boolean; oldLine: string; newLine: string; tinted: boolean; noPageOverflow: boolean }>(`(() => {
        const card = document.querySelector('.file-change-card');
        const region = card.querySelector('.file-change-card__diff');
        const removed = region.querySelector('.file-change-card__line--removed');
        const added = region.querySelector('.file-change-card__line--added');
        return { label: region.textContent.includes('Latest change') ? 'Latest change' : '',
          expanded: card.querySelector('.file-change-card__file-toggle').getAttribute('aria-expanded'),
          split: getComputedStyle(region.querySelector('.file-change-card__split')).display !== 'none',
          unified: getComputedStyle(region.querySelector('.file-change-card__unified')).display !== 'none',
          oldLine: region.querySelector('.file-change-card__line--removed .file-change-card__number')?.textContent?.trim() ?? '',
          newLine: region.querySelector('.file-change-card__line--added .file-change-card__number')?.textContent?.trim() ?? '',
          tinted: !!removed && !!added && getComputedStyle(removed).backgroundColor !== getComputedStyle(added).backgroundColor,
          noPageOverflow: document.documentElement.scrollWidth <= innerWidth }
      })()`)
      expect(opened).toMatchObject({ label: "Latest change", expanded: "true", split: width >= 768, unified: width < 768, oldLine: "1", newLine: "1", tinted: true, noPageOverflow: true })
      expect(await page.evaluate<boolean>(`(() => { const card = document.querySelector('.file-change-card'); const button = card.querySelector('.file-change-card__file-toggle'); return document.getElementById(button.getAttribute('aria-controls'))?.getAttribute('aria-label')?.includes('Latest change') === true && getComputedStyle(card.querySelector('.file-change-card__directory')).color !== getComputedStyle(card.querySelector('.file-change-card__basename')).color })()`)).toBe(true)

      await page.evaluate(`document.querySelectorAll('.file-change-card__file-toggle')[1].click()`)
      const long = await page.evaluate<{ scrolls: boolean; newVisible: boolean; pageOverflow: boolean }>(`(() => { const diff = document.querySelectorAll('.file-change-card__diff')[1], box = diff.getBoundingClientRect(), shown = (element) => !!element && element.getClientRects().length > 0 && element.getBoundingClientRect().left < box.right && element.getBoundingClientRect().right <= box.right + 1, heading = [...diff.querySelectorAll('.file-change-card__pane-heading')].find(item => item.textContent.trim() === 'New'); return { scrolls: diff.scrollWidth > diff.clientWidth, newVisible: shown(heading) && shown(diff.querySelector('.file-change-card__split .file-change-card__line--added')), pageOverflow: document.documentElement.scrollWidth > innerWidth } })()`)
      if (width >= 768) expect(long).toEqual({ scrolls: false, newVisible: true, pageOverflow: false })
      else expect(long).toMatchObject({ scrolls: true, pageOverflow: false })
      await page.evaluate(`document.querySelector('.file-change-card').scrollIntoView({ block: 'start' })`)
      await Bun.write(new URL(`../../../.cache/tmp/file-changes-${theme}-${width}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))

      await page.evaluate(`document.querySelector('.file-change-card__file-toggle').focus()`)
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.file-change-card__file-toggle')`)).toBe(true)
      await page.pressKey(" ", "Space", 32)
      expect(await page.evaluate<string>(`document.querySelector('.file-change-card__file-toggle').getAttribute('aria-expanded')`)).toBe("false")
    }
  } finally { await page.close() }
}, 60_000)

test("holds captured changes until the selected Session stops running", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?file-changes=captured&status=running`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.file-change-card').length`)).toBe(0)
    await page.evaluate(`window.setFileChangeStatus("idle")`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_latest"] .file-change-card')`); attempt++) await Bun.sleep(50)
    expect(await page.evaluate<boolean>(`!!document.querySelector('[data-message-id="msg_latest"] .file-change-card')`)).toBe(true)

    await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?file-changes=captured&status=interrupted`)
    expect(await page.evaluate<boolean>(`!!document.querySelector('[data-message-id="msg_latest"] .file-change-card')`)).toBe(true)

    await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?file-changes=checkpoint&status=running`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.file-change-card').length`)).toBe(0)
    await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?file-changes=checkpoint&status=idle`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.file-change-card').length`)).toBe(1)
  } finally { await page.close() }
}, 20_000)

test("uses the completed compaction row when no assistant has completed", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?file-changes=checkpoint`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('.file-change-card')`); attempt++) await Bun.sleep(50)
    expect(await page.evaluate<number>(`document.querySelectorAll('[data-message-id="cmp_file"] .file-change-card').length`)).toBe(1)
    expect(await page.evaluate<number>(`document.querySelectorAll('.file-change-card').length`)).toBe(1)
    expect(await page.evaluate<string>(`document.querySelector('.file-change-card__totals')?.textContent ?? ''`)).toBe("+5 −3")
    expect(await page.evaluate<string>(`document.querySelector('.file-change-card__file-counts')?.textContent ?? ''`)).toBe("+2−1")
    await page.evaluate(`document.querySelector('.file-change-card__file-toggle').click()`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.file-change-card__diff .file-change-card__unified .file-change-card__line--added').length`)).toBe(2)
  } finally { await page.close() }
}, 20_000)

test("retains the cumulative summary and explains when a recorded patch cannot be rendered", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?file-changes=unavailable`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('.file-change-card')`); attempt++) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.file-change-card__file-toggle').click()`)
    expect(await page.evaluate<string>(`document.querySelector('.file-change-card__totals')?.textContent?.trim() ?? ''`)).toBe("+3 −2")
    expect(await page.evaluate<string>(`document.querySelector('.file-change-card__diff')?.textContent?.trim() ?? ''`)).toBe("Latest changeDiff unavailable for this file.")
  } finally { await page.close() }
}, 20_000)

test("does not attribute pre-compaction ledger edits to a later reply and shows child-only captures", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?file-changes=no-edits`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.file-change-card').length`)).toBe(0)
    await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?file-changes=child-only`)
    expect(await page.evaluate<string>(`document.querySelector('.file-change-card__title')?.textContent ?? ''`)).toBe("Edited 1 file")
    expect(await page.evaluate<string>(`document.querySelector('.file-change-card__totals')?.textContent ?? ''`)).toBe("+2 −1")
  } finally { await page.close() }
}, 20_000)

test("expands every grouped patch behind one path and sums only those displayed changes", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?file-changes=repeated`)
    expect(await page.evaluate<string>(`document.querySelector('.file-change-card__totals')?.textContent ?? ''`)).toBe("+3 −2")
    await page.evaluate(`document.querySelector('.file-change-card__file-toggle').click()`)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.file-change-card__diff-label')].map(item => item.textContent)`)).toEqual(["Change 1", "Change 2"])
    expect(await page.evaluate<string>(`document.querySelector('.file-change-card__diff')?.textContent ?? ''`)).toContain("after second")
  } finally { await page.close() }
}, 20_000)
