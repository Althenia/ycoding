import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4395
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 390, 844)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Running Sessions fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

describe("running Sessions across workspaces", () => {
  test("renders only populated roots with workspace labels and usable focus and selection", async () => {
    if (!browser) throw new Error("Browser not started")
    for (const width of [320, 390, 1440]) for (const theme of ["light", "dark"] as const) {
      const page = await browser.openPage()
      try {
        await page.setViewport(width, 844)
        await page.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?theme=${theme}`)
        for (let attempt = 0; attempt < 40 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 2; attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<{ heading: string; labels: readonly string[]; overflow: boolean; targets: boolean }>(`({ heading: document.querySelector('.running-sessions h2')?.textContent.trim(),
          labels: [...document.querySelectorAll('.running-sessions__item')].map((button) => button.getAttribute('aria-label')),
          overflow: document.documentElement.scrollWidth > innerWidth,
          targets: [...document.querySelectorAll('.running-sessions__item')].every((button) => button.getBoundingClientRect().height >= 44) })`))
          .toEqual({ heading: "Running and recent", labels: ["Open Review test coverage in Alpha", "Open Debug remote response in Beta"], overflow: false, targets: true })
        await page.evaluate(`document.querySelector('.running-sessions__item').focus()`)
        expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.running-sessions__item') && getComputedStyle(document.activeElement).outlineStyle !== 'none'`)).toBe(true)
        await page.pressKey(" ", "Space", 32)
        expect(await page.evaluate<string[]>(`window.runningSelected()`)).toEqual(["ses_alpha"])
      } finally { await page.close() }
    }
    const empty = await browser.openPage()
    try {
      await empty.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?count=0`)
      for (let attempt = 0; attempt < 40 && !(await empty.evaluate<boolean>(`document.querySelector('[data-running-fixture]') !== null`)); attempt += 1) await Bun.sleep(50)
      expect(await empty.evaluate<boolean>(`document.querySelector('[data-running-fixture]') !== null`)).toBe(true)
      expect(await empty.evaluate<boolean>(`document.querySelector('.running-sessions') === null`)).toBe(true)
    } finally { await empty.close() }
  }, 20_000)

  test("labels running roots and recent activity separately without changing card selection", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?mixed=1`)
      for (let attempt = 0; attempt < 40 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 2; attempt += 1) await Bun.sleep(50)
      const cards = await page.evaluate<readonly { readonly status: string; readonly dot: boolean; readonly time: string | null }[]>(`[...document.querySelectorAll('.running-sessions__item')].map(card => ({ status: card.querySelector('.running-sessions__status')?.textContent?.trim() ?? '', dot: card.querySelector('.running-sessions__dot') !== null, time: card.querySelector('time')?.getAttribute('datetime') ?? null }))`)
      expect(cards[0]).toMatchObject({ status: "Running", dot: true, time: null })
      expect(cards[1]?.status.startsWith("Last active ")).toBe(true)
      expect(cards[1]?.dot).toBe(false)
      expect(cards[1]?.time).toMatch(/^20\d\d-/)
      await page.evaluate(`document.querySelectorAll('.running-sessions__item')[1]?.click()`)
      expect(await page.evaluate<string[]>(`window.runningSelected()`)).toEqual(["ses_beta"])
    } finally { await page.close() }
  })

  test("renders missing activity without falling back to update time, then shows a terminal run time", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?mixed=1&missing=1`)
      for (let attempt = 0; attempt < 40 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 2; attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<string>(`document.querySelectorAll('.running-sessions__status')[1]?.textContent?.trim()`)).toBe("Last active not reported")
      const finished = 1_700_000_000_000
      await page.evaluate(`window.runningFinish(${finished})`)
      expect(await page.evaluate<string>(`document.querySelectorAll('.running-sessions__status')[0]?.querySelector('time')?.getAttribute('datetime')`)).toBe(new Date(finished).toISOString())
      expect(await page.evaluate<string>(`document.querySelectorAll('.running-sessions__status')[1]?.textContent?.trim()`)).toBe("Last active not reported")
    } finally { await page.close() }
  })

  test("snaps fixed cards with visible pagination only when the row overflows", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const width of [320, 390, 820, 1024, 1440]) for (const count of [0, 1, 2, 7]) {
        await page.setViewport(width, 844)
        await page.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?theme=${theme}&count=${count}`)
        for (let attempt = 0; attempt < 40 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== count; attempt += 1) await Bun.sleep(50)
        const result = await page.evaluate<{ readonly cards: number; readonly dots: number; readonly overflow: boolean; readonly pageOverflow: boolean; readonly snap: string; readonly cardWidth: number; readonly peek: boolean; readonly labels: readonly string[] }>(`(() => { const track = document.querySelector('.running-sessions__list'); const cards = [...document.querySelectorAll('.running-sessions__list li')]; const dots = [...document.querySelectorAll('.running-sessions__pagination button')]; const box = track?.getBoundingClientRect(); return { cards: cards.length, dots: dots.length, overflow: Boolean(track && track.scrollWidth > track.clientWidth + 1), pageOverflow: document.documentElement.scrollWidth > innerWidth, snap: track ? getComputedStyle(track).scrollSnapType : '', cardWidth: cards[0]?.getBoundingClientRect().width ?? 0, peek: Boolean(box && cards[1] && cards[1].getBoundingClientRect().left < box.right), labels: cards.map(card => card.getAttribute('aria-label')) } })()`)
        expect(result.cards).toBe(count)
        expect(result.pageOverflow).toBe(false)
        if (count === 0) { expect(result.dots).toBe(0); continue }
        expect(result.snap).toContain("mandatory")
        expect(result.labels).toEqual(Array.from({ length: count }, (_, index) => `${index + 1} of ${count}`))
        expect(result.dots).toBe(result.overflow ? count : 0)
        if (result.overflow) expect(await page.evaluate<readonly { readonly name: string; readonly current: string | null }[]>(`[...document.querySelectorAll('.running-sessions__pagination button')].map(button => ({ name: button.getAttribute('aria-label'), current: button.getAttribute('aria-current') }))`)).toEqual(Array.from({ length: count }, (_, index) => ({ name: `Show Session ${index + 1} of ${count}`, current: index === 0 ? "true" : null })))
        if (width < 768) { expect(result.cardWidth).toBeGreaterThan(width * 0.7); if (count > 1) expect(result.peek).toBe(true) }
        else expect(result.cardWidth).toBeGreaterThanOrEqual(280)
        if (count !== 7) continue
        expect(await page.evaluate<boolean>(`(() => { const title = document.querySelector('.running-sessions__list li:last-child .running-sessions__title'); return title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === 'ellipsis' })()`)).toBe(true)
        expect(await page.evaluate<boolean>(`(() => { const track = document.querySelector('.running-sessions__list').getBoundingClientRect(); const first = document.querySelector('.running-sessions__list li').getBoundingClientRect(); return Math.abs(first.left - track.left) <= 1 })()`)).toBe(true)
        if (width === 390 || width === 1440) await Bun.write(new URL(`../../../.cache/tmp/running-carousel-${theme}-${width}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.evaluate(`document.querySelector('.running-sessions__pagination button:last-child').click()`)
        for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('.running-sessions__pagination button:last-child')?.getAttribute('aria-current') === 'true'`); attempt += 1) await Bun.sleep(20)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`(() => { const track = document.querySelector('.running-sessions__list'); const card = track.querySelector('li:last-child').getBoundingClientRect(); const box = track.getBoundingClientRect(); return track.scrollLeft > 0 && card.left < box.right && card.right > box.left })()`); attempt += 1) await Bun.sleep(20)
        const last = await page.evaluate<{ readonly active: boolean; readonly visible: boolean; readonly scrolled: boolean }>(`(() => { const track = document.querySelector('.running-sessions__list'); const card = track.querySelector('li:last-child'); const box = track.getBoundingClientRect(); const end = card.getBoundingClientRect(); return { active: document.querySelector('.running-sessions__pagination button:last-child')?.getAttribute('aria-current') === 'true', visible: end.left < box.right && end.right > box.left, scrolled: track.scrollLeft > 0 } })()`)
        expect(last).toEqual({ active: true, visible: true, scrolled: true })
        await page.evaluate(`const track = document.querySelector('.running-sessions__list'); track.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: -400 })); track.scrollLeft = 0; track.dispatchEvent(new Event('scroll'))`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.running-sessions__pagination button:first-child')?.getAttribute('aria-current') === 'true'`); attempt += 1) await Bun.sleep(20)
        expect(await page.evaluate<boolean>(`document.querySelector('.running-sessions__pagination button:first-child')?.getAttribute('aria-current') === 'true'`)).toBe(true)
      }
      await page.setViewport(390, 844)
      await page.setReducedMotion(true)
      await page.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?count=7`)
      await page.evaluate(`(() => { const track = document.querySelector('.running-sessions__list'); const scroll = track.scrollTo.bind(track); track.scrollTo = options => { window.carouselMotion = options.behavior; scroll(options) }; document.querySelector('.running-sessions__pagination button:last-child').click() })()`)
      expect(await page.evaluate<string>(`window.carouselMotion`)).toBe("instant")
    } finally { await page.close() }
  }, 60_000)

  test("drags the overflowing rail with the mouse, keeps a click on a card from leaving a ring, and keeps keyboard focus visible", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1024, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?count=7`)
      for (let attempt = 0; attempt < 40 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 7; attempt += 1) await Bun.sleep(50)
      const start = await page.evaluate<{ readonly x: number; readonly y: number; readonly cursor: string }>(`(() => { const track = document.querySelector('.running-sessions__list'); const box = track.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), cursor: getComputedStyle(track).cursor } })()`)
      expect(start.cursor).toBe("grab")
      await page.mouse("mouseMoved", start.x, start.y)
      await page.mouse("mousePressed", start.x, start.y)
      await page.mouse("mouseMoved", start.x - 40, start.y, true)
      expect(await page.evaluate<{ readonly dragging: boolean; readonly cursor: string }>(`(() => { const track = document.querySelector('.running-sessions__list'); return { dragging: track.dataset.cursor === 'panning', cursor: getComputedStyle(track).cursor } })()`)).toEqual({ dragging: true, cursor: "grabbing" })
      await page.mouse("mouseMoved", start.x - 260, start.y, true)
      await page.mouse("mouseReleased", start.x - 260, start.y)
      for (let attempt = 0; attempt < 40 && await page.evaluate<number>(`document.querySelector('.running-sessions__list').scrollLeft`) < 200; attempt += 1) await Bun.sleep(20)
      expect(await page.evaluate<{ readonly scrolled: number; readonly dragging: boolean; readonly selected: readonly string[] }>(`(() => { const track = document.querySelector('.running-sessions__list'); return { scrolled: Math.round(track.scrollLeft), dragging: track.dataset.cursor === 'panning', selected: window.runningSelected() } })()`)).toMatchObject({ dragging: false, selected: [] })
      expect(await page.evaluate<number>(`document.querySelector('.running-sessions__list').scrollLeft`)).toBeGreaterThanOrEqual(200)

      // A plain click on whichever card now sits under the pointer opens it and leaves no focus ring.
      const card = await page.evaluate<{ readonly x: number; readonly y: number; readonly index: number }>(`(() => { const items = [...document.querySelectorAll('.running-sessions__item')]; const track = document.querySelector('.running-sessions__list').getBoundingClientRect(); const index = items.findIndex((item) => item.getBoundingClientRect().left >= track.left - 1); const box = items[index].getBoundingClientRect(); return { x: Math.round(box.left + 20), y: Math.round(box.top + 20), index } })()`)
      await page.mouse("mouseMoved", card.x, card.y)
      await page.mouse("mousePressed", card.x, card.y)
      await page.mouse("mouseReleased", card.x, card.y)
      for (let attempt = 0; attempt < 40 && (await page.evaluate<string[]>(`window.runningSelected()`)).length === 0; attempt += 1) await Bun.sleep(20)
      expect(await page.evaluate<{ readonly selected: number; readonly outline: string; readonly focused: boolean }>(`(() => { const item = document.querySelectorAll('.running-sessions__item')[${card.index}]; return { selected: window.runningSelected().length, outline: getComputedStyle(item).outlineStyle, focused: document.activeElement === item } })()`)).toEqual({ selected: 1, outline: "none", focused: true })

      // Tab from the clicked card lands on the next card as keyboard navigation, which must show the ring.
      await page.pressKey("Tab", "Tab", 9)
      expect(await page.evaluate<{ readonly next: boolean; readonly outline: string }>(`(() => { const item = document.activeElement; return { next: item === document.querySelectorAll('.running-sessions__item')[${card.index + 1}], outline: getComputedStyle(item).outlineStyle } })()`)).toEqual({ next: true, outline: "solid" })
    } finally { await page.close() }
  }, 30_000)

  test("keeps overflowing page dots 24 px apart while each stays a 24 px target", async () => {
    const page = await browser!.openPage()
    try {
      for (const width of [390, 1440]) {
        await page.setViewport(width, 844)
        await page.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?theme=dark&count=7`)
        for (let attempt = 0; attempt < 40 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__pagination button').length`) !== 7; attempt += 1) await Bun.sleep(50)
        const dots = await page.evaluate<readonly { readonly center: number; readonly width: number; readonly height: number }[]>(`[...document.querySelectorAll('.running-sessions__pagination button')].map(button => { const box = button.getBoundingClientRect(); return { center: box.left + box.width / 2, width: box.width, height: box.height } })`)
        expect(dots).toHaveLength(7)
        for (const dot of dots) {
          expect(dot.width).toBeGreaterThanOrEqual(24)
          expect(dot.height).toBeGreaterThanOrEqual(24)
        }
        expect(dots.slice(1).map((dot, index) => dot.center - dots[index]!.center)).toEqual(Array.from({ length: 6 }, () => 24))
      }
    } finally { await page.close() }
  })

  test("rehydrates a later running list and recalculates overflow when the viewport grows", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?dynamic=1&count=2`)
      expect(await page.evaluate<boolean>(`document.querySelector('.running-sessions')?.getAttribute('aria-busy') === 'true'`)).toBe(true)
      await page.evaluate(`window.runningSetCount(2)`)
      for (let attempt = 0; attempt < 30 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__pagination button').length`) !== 2; attempt += 1) await Bun.sleep(20)
      expect(await page.evaluate<number>(`document.querySelectorAll('.running-sessions__pagination button').length`)).toBe(2)
      await page.setViewport(1440, 900)
      for (let attempt = 0; attempt < 30 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__pagination button').length`) !== 0; attempt += 1) await Bun.sleep(20)
      expect(await page.evaluate<number>(`document.querySelectorAll('.running-sessions__pagination button').length`)).toBe(0)
    } finally { await page.close() }
  })

  test("reserves the first unresolved carousel and reveals or releases it without shifting following content", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]]) for (const reduced of [false, true]) {
        await page.setViewport(width!, height!)
        await page.setColorScheme(theme)
        await page.setReducedMotion(reduced)
        await page.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?dynamic=1&count=2&theme=${theme}`)
        const pending = await page.evaluate<{ busy: boolean; cards: number; height: number; headingTop: number }>(`(() => { const parent = document.querySelector('[data-running-fixture]'); const following = document.createElement('h3'); following.textContent = 'Following heading'; parent.appendChild(following); window.following = following; const section = document.querySelector('.running-sessions'); return { busy: section?.getAttribute('aria-busy') === 'true', cards: section?.querySelectorAll('.running-sessions__item').length ?? 0, height: section?.getBoundingClientRect().height ?? 0, headingTop: following.getBoundingClientRect().top }; })()`)
        expect(pending.busy).toBe(true)
        expect(pending.cards).toBe(0)
        expect(pending.height).toBeGreaterThanOrEqual(150)
        await page.evaluate(`window.runningSetCount(2)`)
        for (let attempt = 0; attempt < 40 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 2; attempt++) await Bun.sleep(20)
        await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
        const revealed = await page.evaluate<{ headingTop: number; height: number; busy: boolean; name: string; duration: string }>(`(() => { const section = document.querySelector('.running-sessions'); const list = section.querySelector('.running-sessions__list'); return { headingTop: window.following.getBoundingClientRect().top, height: section.getBoundingClientRect().height, busy: section.getAttribute('aria-busy') === 'true', name: getComputedStyle(list).animationName, duration: getComputedStyle(list).animationDuration }; })()`)
        expect(revealed.busy).toBe(false)
        expect(Math.abs(revealed.headingTop - pending.headingTop)).toBeLessThanOrEqual(2)
        expect(Math.abs(revealed.height - pending.height)).toBeLessThanOrEqual(2)
        if (theme === "light" && width === 390 && !reduced) console.info("carousel reveal geometry", JSON.stringify({ pending, revealed }))
        expect(reduced ? revealed.name === 'none' : revealed.name !== 'none').toBe(true)
        if (!reduced) expect(revealed.duration).toBe("0.22s")
        await page.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?dynamic=1&count=0&theme=${theme}`)
        const beforeEmpty = await page.evaluate<number>(`(() => { const section = document.querySelector('.running-sessions'); return section?.getBoundingClientRect().height ?? 0 })()`)
        expect(beforeEmpty).toBeGreaterThanOrEqual(150)
        await page.evaluate(`window.runningSetCount(0)`)
        expect(await page.evaluate<boolean>(`document.querySelector('.running-sessions') === null`)).toBe(true)
        expect(await page.evaluate<number>(`document.querySelector('[data-running-fixture]').getBoundingClientRect().height`)).toBeLessThan(beforeEmpty)
      }
    } finally { await page.close() }
  }, 30_000)

  test("matches loading skeleton geometry and card styling across themes and viewport sizes", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [820, 900], [1440, 900]]) for (const reduced of [false, true]) {
        await page.setViewport(width!, height!)
        await page.setColorScheme(theme)
        await page.setReducedMotion(reduced)
        await page.navigate(`http://127.0.0.1:${port}/verify/running-sessions-fixture.html?dynamic=1&count=2&theme=${theme}`)
        const revealed = `(() => { const placeholders = [...document.querySelectorAll('.running-sessions--loading .loading-placeholder')]; return placeholders.length === 3 && placeholders.every(item => getComputedStyle(item).visibility === 'visible'); })()`
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(revealed); attempt++) await Bun.sleep(20)
        expect(await page.evaluate<boolean>(revealed)).toBe(true)
        const pending = await page.evaluate<readonly { readonly width: number; readonly height: number; readonly radius: string; readonly padding: string; readonly border: string; readonly background: string }[]>(`[...document.querySelectorAll('.running-sessions__list li')].map(item => { const skeleton = item.querySelector('.loading-placeholder__shape'); const box = skeleton.getBoundingClientRect(); const style = getComputedStyle(skeleton); return { width: box.width, height: box.height, radius: style.borderRadius, padding: style.padding, border: style.border, background: style.backgroundColor } })`)
        await page.evaluate(`window.runningSetCount(2)`)
        for (let attempt = 0; attempt < 40 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 2; attempt++) await Bun.sleep(20)
        const cards = await page.evaluate<readonly { readonly width: number; readonly height: number; readonly radius: string; readonly padding: string; readonly border: string; readonly background: string }[]>(`[...document.querySelectorAll('.running-sessions__item')].map(card => { const box = card.getBoundingClientRect(); const style = getComputedStyle(card); return { width: box.width, height: box.height, radius: style.borderRadius, padding: style.padding, border: style.border, background: style.backgroundColor } })`)
        expect(pending).toHaveLength(3)
        expect(cards).toHaveLength(2)
        expect(pending[0]).toEqual(cards[0])
        expect(pending[1]).toEqual(cards[1])
        if (theme === "light" && width === 390 && !reduced) console.info("carousel card geometry", JSON.stringify({ skeleton: pending[0], card: cards[0] }))
      }
    } finally { await page.close() }
  }, 30_000)
})
