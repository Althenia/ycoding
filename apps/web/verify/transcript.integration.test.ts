import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4397
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore" })
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/transcript.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 390, 844)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Transcript fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

describe("transcript rendering", () => {
  test("keeps a compaction divider stationary and preserves neighbours across completion at phone and desktop sizes in both themes", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]]) {
        await page.setViewport(width!, height!)
        await page.setReducedMotion(theme === "dark")
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?compaction=history&theme=${theme}`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-compaction__label')`); i++) await Bun.sleep(50)
        expect(await page.evaluate<string>(`document.querySelector('.transcript-compaction__label')?.textContent ?? ''`)).toBe("~ compacting · manual")
        const before = await page.evaluate<{ top: number; height: number }>(`(() => { window.neighbour = document.querySelector('[data-message-id="msg_after"]'); window.divider = document.querySelector('[data-message-id="cmp_live"]'); return { top: window.neighbour.getBoundingClientRect().top, height: window.divider.getBoundingClientRect().height } })()`)
        await page.evaluate(`window.compactionUpdate()`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-compaction__label')?.textContent?.includes('compacted')`); i++) await Bun.sleep(25)
        const after = await page.evaluate<{ top: number; height: number; same: boolean; sameDivider: boolean; text: string; overflow: boolean }>(`(() => { const row = document.querySelector('[data-message-id="cmp_live"]') ?? document.querySelector('[data-message-id="msg_compact"]'); return { top: document.querySelector('[data-message-id="msg_after"]').getBoundingClientRect().top, height: row.getBoundingClientRect().height, same: window.neighbour === document.querySelector('[data-message-id="msg_after"]'), sameDivider: window.divider === row, text: row.textContent, overflow: document.documentElement.scrollWidth > innerWidth } })()`)
        expect(after.same).toBe(true)
        expect(after.sameDivider).toBe(true)
        expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2)
        expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(2)
        expect(after.text).toContain("~ compacted · 11 items excluded · 1k → 400 tokens")
        expect(after.text).toContain("~900 tokens saved total")
        expect(after.text).toContain("Compression #2 (~600 tokens removed, 60% reduction)")
        expect(after.overflow).toBe(false)
        if (theme === "dark") expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.transcript-compaction__details')).transitionDuration`)).toBe("0s")
      }
    } finally { await page.close() }
  }, 20_000)

  test("shows per-compaction numbers without total or numbering on an older connector", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]]) {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?compaction=old&theme=${theme}`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-compaction__label')`); i++) await Bun.sleep(50)
        await page.evaluate(`window.compactionUpdate()`)
        const text = await page.evaluate<string>(`document.querySelector('[data-message-id="cmp_live"]')?.textContent ?? document.querySelector('[data-message-id="msg_compact"]')?.textContent ?? ''`)
        expect(text).toContain("~ compacted · 11 items excluded · 1k → 400 tokens")
        expect(text).toContain("~600 tokens removed, 60% reduction")
        expect(text).not.toContain("tokens saved total")
        expect(text).not.toContain("Compression #")
      }
    } finally { await page.close() }
  }, 20_000)

  test("keeps exact numbering after a truncated history and shows a cancelled job without a completed summary", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?compaction=truncated`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-compaction__label')`); i++) await Bun.sleep(50)
      await page.evaluate(`window.compactionUpdate()`)
      const text = await page.evaluate<string>(`document.querySelector('[data-message-id="cmp_live"]')?.textContent ?? ''`)
      expect(text).toContain("Compression #4 (~600 tokens removed, 60% reduction)")
      expect(text).toContain("~2k tokens saved total")
      await page.evaluate(`window.compactionFail()`)
      expect(await page.evaluate<string>(`document.querySelector('.transcript-compaction__label')?.textContent ?? ''`)).toBe("~ compaction cancelled")
      expect(await page.evaluate<string>(`document.querySelector('[data-message-id="cmp_live"]')?.textContent ?? ''`)).not.toContain("tokens saved total")
    } finally { await page.close() }
  })

  test("keeps an oversized message in place while loading and offers retry after failure", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?oversized=1`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_big"]')`); i++) await Bun.sleep(50)
      expect(await page.evaluate<string>(`document.querySelector('[data-message-id="msg_big"]')?.textContent ?? ''`)).toContain("Loading content")
      await page.evaluate(`document.querySelector('#fail-oversized').click()`)
      expect(await page.evaluate<string>(`document.querySelector('[data-message-id="msg_big"]')?.textContent ?? ''`)).toContain("Content too large or unavailable")
      await page.evaluate(`document.querySelector('[data-message-id="msg_big"] button').click()`)
      expect(await page.evaluate<string>(`document.querySelector('[data-message-id="msg_big"]')?.textContent ?? ''`)).toContain("Recovered full content")
    } finally { await page.close() }
  })
  test("shows an admitted oversized input as pending without a misleading retry", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?oversized=pending`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_big"]')`); i++) await Bun.sleep(50)
      const pending = await page.evaluate<{ readonly text: string; readonly retry: boolean }>(`(() => { const row = document.querySelector('[data-message-id="msg_big"]'); return { text: row?.textContent ?? '', retry: Boolean(row?.querySelector('button')) } })()`)
      expect(pending.text).toContain("Waiting for content")
      expect(pending.retry).toBe(false)
    } finally { await page.close() }
  })
  test("prepends older history near the top without moving the first visible row", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]]) {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?history=1&theme=${theme}`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="prompt_6"]')`); i++) await Bun.sleep(50)
        await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel', { bubbles:true, deltaY:-300 })); root.scrollTop = 45 })()`)
        const before = await page.evaluate<number>(`document.querySelector('[data-message-id="prompt_6"]').getBoundingClientRect().top`)
        for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.transcript-navigation__beginning')`); i++) await Bun.sleep(25)
        const after = await page.evaluate<{ readonly top: number; readonly marker: boolean }>(`(() => ({ top: document.querySelector('[data-message-id="prompt_6"]').getBoundingClientRect().top, marker: Boolean(document.querySelector('.transcript-navigation__beginning')) }))()`)
        expect(Math.abs(after.top - before)).toBeLessThanOrEqual(2)
        expect(after.marker).toBe(true)
        await page.evaluate(`document.querySelector('[aria-label="Jump to top"]').click()`)
        for (let i = 0; i < 60 && await page.evaluate<number>(`document.querySelector('.workspace__scroll').scrollTop`) > 8; i++) await Bun.sleep(20)
        expect(await page.evaluate<number>(`document.querySelector('.workspace__scroll').scrollTop`)).toBeLessThanOrEqual(8)
        await Bun.write(new URL(`../../../.cache/tmp/transcript-history-${theme}-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      }
    } finally { await page.close() }
  }, 15_000)

  test("renders image previews and an accessible lightbox in both themes at phone and desktop widths", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]]) {
        await page.setViewport(width!, height!)
        await page.setReducedMotion(theme === "dark")
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?images=1&theme=${theme}`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-tool__toggle')`); i++) await Bun.sleep(50)
        await page.evaluate(`document.querySelector('.transcript-tool__toggle').click()`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img') && document.querySelector('[data-message-id="msg_image"] .transcript-image img')`); i++) await Bun.sleep(50)
        for (let i = 0; i < 40 && !await page.evaluate<boolean>(`Boolean(document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img')?.complete)`); i++) await Bun.sleep(25)
        const images = await page.evaluate<{ readonly lazy: boolean; readonly alt: string; readonly bounded: boolean; readonly chip: boolean; readonly loaded: boolean; readonly userLoaded: boolean }>(`(() => { const img = document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img'); const user = document.querySelector('[data-message-id="msg_image"] .transcript-image img'); const box = img?.getBoundingClientRect(); return { lazy: img?.loading === 'lazy', alt: img?.alt ?? '', bounded: Boolean(box && box.width <= innerWidth && box.height <= 400), chip: Boolean(document.querySelector('.transcript-file')), loaded: Boolean(img?.complete && img.naturalWidth > 0), userLoaded: Boolean(user?.complete && user.naturalWidth > 0) } })()`)
        expect(images).toEqual({ lazy: true, alt: "plot.png", bounded: true, chip: true, loaded: true, userLoaded: true })
        await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image').click()`)
        for (let i = 0; i < 30 && !await page.evaluate(`document.querySelector('.transcript-lightbox[open]')`); i++) await Bun.sleep(20)
        await page.evaluate(`Promise.all([...document.querySelector('.transcript-lightbox .overlay__surface').getAnimations()].map(animation => animation.finished))`)
        const dialog = await page.evaluate<{ readonly open: boolean; readonly focused: boolean; readonly contained: boolean; readonly sticky: boolean; readonly reduced: boolean }>(`(() => { const d = document.querySelector('.transcript-lightbox'); const box = d.querySelector('.overlay__surface').getBoundingClientRect(); return { open: Boolean(d?.open), focused: Boolean(d?.contains(document.activeElement)), contained: box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1, sticky: getComputedStyle(d.querySelector('.overlay__head')).position === 'sticky', reduced: getComputedStyle(d.querySelector('.overlay__surface')).animationName === 'none' } })()`)
        expect(dialog).toEqual({ open: true, focused: true, contained: true, sticky: false, reduced: theme === "dark" })
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate<boolean>(`document.querySelector('.transcript-lightbox')?.contains(document.activeElement) ?? false`)).toBe(true)
        await Bun.write(new URL(`../../../.cache/tmp/transcript-images-${theme}-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.evaluate(`document.querySelector('.transcript-lightbox').click()`)
        for (let i = 0; i < 20 && await page.evaluate<boolean>(`Boolean(document.querySelector('.transcript-lightbox[open]'))`); i++) await Bun.sleep(20)
        expect(await page.evaluate<boolean>(`document.querySelector('.transcript-lightbox[open]') === null`)).toBe(true)
        await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image').click()`)
        for (let i = 0; i < 20 && !await page.evaluate<boolean>(`Boolean(document.querySelector('.transcript-lightbox[open]'))`); i++) await Bun.sleep(20)
        await page.pressEscape()
        for (let i = 0; i < 20 && await page.evaluate(`document.querySelector('.transcript-lightbox[open]')`); i++) await Bun.sleep(20)
        expect(await page.evaluate<boolean>(`document.querySelector('.transcript-lightbox[open]') === null`)).toBe(true)
      }
    } finally { await page.close() }
  })

  test("keeps a tall image below the lightbox header and inside the viewport on a phone", async () => {
    const page = await browser!.openPage()
    try {
      for (const [width, height] of [[390, 844], [1440, 900]]) {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?images=1&theme=dark`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-tool__toggle')`); i++) await Bun.sleep(50)
        await page.evaluate(`document.querySelector('.transcript-tool__toggle').click()`)
        for (let i = 0; i < 40 && !await page.evaluate<boolean>(`Boolean(document.querySelector('[data-message-id="msg_tool_image"] .transcript-image[aria-label="Open image tall.png"] img')?.complete)`); i++) await Bun.sleep(25)
        await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image[aria-label="Open image tall.png"]').click()`)
        for (let i = 0; i < 30 && !await page.evaluate<boolean>(`Boolean(document.querySelector('.transcript-lightbox[open] .overlay__body img')?.complete)`); i++) await Bun.sleep(20)
        await page.evaluate(`Promise.all([...document.querySelector('.transcript-lightbox .overlay__surface').getAnimations()].map(animation => animation.finished))`)
        const layout = await page.evaluate<{ readonly headAboveImage: boolean; readonly imageInsideSurface: boolean; readonly surfaceInsideViewport: boolean; readonly imageInsideViewport: boolean; readonly bodyScrolls: boolean }>(`(() => {
          const d = document.querySelector('.transcript-lightbox')
          const surface = d.querySelector('.overlay__surface').getBoundingClientRect()
          const head = d.querySelector('.overlay__head').getBoundingClientRect()
          const body = d.querySelector('.overlay__body')
          const image = d.querySelector('.overlay__body img').getBoundingClientRect()
          return { headAboveImage: head.bottom <= image.top + 1 && head.top >= surface.top - 1,
            imageInsideSurface: image.top >= surface.top - 1 && image.bottom <= surface.bottom + 1 && image.left >= surface.left - 1 && image.right <= surface.right + 1,
            surfaceInsideViewport: surface.top >= -1 && surface.bottom <= innerHeight + 1 && surface.left >= -1 && surface.right <= innerWidth + 1,
            imageInsideViewport: image.top >= -1 && image.bottom <= innerHeight + 1,
            bodyScrolls: body.scrollHeight > body.clientHeight + 1 }
        })()`)
        expect(layout).toEqual({ headAboveImage: true, imageInsideSurface: true, surfaceInsideViewport: true, imageInsideViewport: true, bodyScrolls: false })
        await Bun.write(new URL(`../../../.cache/tmp/transcript-lightbox-tall-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.pressEscape()
        for (let i = 0; i < 20 && await page.evaluate(`document.querySelector('.transcript-lightbox[open]')`); i++) await Bun.sleep(20)
      }
    } finally { await page.close() }
  })

  test("sizes user image thumbnails within the message column and omits an empty text bubble", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]]) {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?images=1&theme=${theme}`)
        for (let i = 0; i < 60 && !await page.evaluate<boolean>(`['msg_image', 'msg_image_only'].every((id) => document.querySelector('[data-message-id="' + id + '"] .transcript-image img')?.complete) && Boolean(document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable'))`); i++) await Bun.sleep(25)
        const layout = await page.evaluate<{ readonly thumbnails: readonly { readonly width: number; readonly ratio: number; readonly painted: boolean; readonly inside: boolean }[]; readonly unavailableWidth: number; readonly emptyBubbles: number; readonly textBubbles: number }>(`(() => {
          const thumbnails = ['msg_image', 'msg_image_only'].map((id) => {
            const message = document.querySelector('[data-message-id="' + id + '"]').getBoundingClientRect()
            const frame = document.querySelector('[data-message-id="' + id + '"] .transcript-attachment .transcript-image').getBoundingClientRect()
            const image = document.querySelector('[data-message-id="' + id + '"] .transcript-image img').getBoundingClientRect()
            return { width: Math.round(frame.width), ratio: Math.round(frame.width / frame.height * 100) / 100, painted: image.width > 100 && image.height > 50,
              inside: frame.left >= message.left - 1 && frame.right <= message.right + 1 && frame.right <= innerWidth }
          })
          return { thumbnails, unavailableWidth: Math.round(document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable').getBoundingClientRect().width),
            emptyBubbles: document.querySelectorAll('[data-message-id="msg_image_only"] .transcript-message__bubble').length,
            textBubbles: document.querySelectorAll('[data-message-id="msg_image"] .transcript-message__bubble').length }
        })()`)
        for (const thumbnail of layout.thumbnails) {
          expect(thumbnail.width).toBeGreaterThanOrEqual(240)
          expect(thumbnail.width).toBeLessThanOrEqual(480)
          expect(thumbnail.ratio).toBeCloseTo(16 / 9, 1)
          expect(thumbnail).toMatchObject({ painted: true, inside: true })
        }
        expect(layout.unavailableWidth).toBeGreaterThanOrEqual(160)
        expect({ emptyBubbles: layout.emptyBubbles, textBubbles: layout.textBubbles }).toEqual({ emptyBubbles: 0, textBubbles: 1 })
      }
    } finally { await page.close() }
  })

  test("keeps loaded user and tool images mounted through streaming, reconciliation, older history, and reconnect", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]] as const) {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?images=1&theme=${theme}`)
        for (let i = 0; i < 40 && !await page.evaluate<boolean>(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-tool__toggle') !== null`); i++) await Bun.sleep(50)
        await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-tool__toggle').click()`)
        for (let i = 0; i < 60 && !await page.evaluate<boolean>(`[...document.querySelectorAll('[data-message-id="msg_image"] .transcript-image img, [data-message-id="msg_tool_image"] .transcript-image img')].length === 2 && [...document.querySelectorAll('[data-message-id="msg_image"] .transcript-image img, [data-message-id="msg_tool_image"] .transcript-image img')].every((img) => img.complete && img.naturalWidth > 0)`); i++) await Bun.sleep(50)
        expect(await page.evaluate<number>(`window.imageFetchCount()`)).toBe(1)
        await page.evaluate(`(() => {
          const user = document.querySelector('[data-message-id="msg_image"] .transcript-image img');
          const tool = document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img');
          const userRow = document.querySelector('[data-message-id="msg_image"]');
          const userHeight = userRow.getBoundingClientRect().height;
          const probe = { user, tool, userRow, userContainer: user.closest('.transcript-attachment'), toolRow: tool.closest('[data-message-id]'), userSrc: user.src, toolSrc: tool.src, removed: 0, srcChanges: 0, loading: 0, heights: [userHeight] };
          const resize = new ResizeObserver(() => probe.heights.push(userRow.getBoundingClientRect().height));
          resize.observe(userRow);
          const observer = new MutationObserver((records) => {
            for (const record of records) {
              if (record.type === 'attributes' && record.attributeName === 'src') probe.srcChanges++;
              for (const node of record.removedNodes) if (node === user || node === tool || node instanceof Element && (node.contains(user) || node.contains(tool))) probe.removed++;
              for (const node of record.addedNodes) if (node instanceof Element && (node.matches('.transcript-image__loading') || node.querySelector('.transcript-image__loading'))) probe.loading++;
            }
          });
          observer.observe(document.querySelector('.transcript'), { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
          window.imageProbe = () => ({ sameUser: probe.user === document.querySelector('[data-message-id="msg_image"] .transcript-image img'), sameTool: probe.tool === document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img'), sameUserRow: probe.userRow === document.querySelector('[data-message-id="msg_image"]'), sameUserContainer: probe.userContainer === document.querySelector('[data-message-id="msg_image"] .transcript-attachment'), sameToolRow: probe.toolRow === document.querySelector('[data-message-id="msg_tool_image"]'), sameSources: probe.userSrc === document.querySelector('[data-message-id="msg_image"] .transcript-image img')?.src && probe.toolSrc === document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img')?.src, removed: probe.removed, srcChanges: probe.srcChanges, loading: probe.loading, heightChanges: probe.heights.filter((value) => Math.abs(value - userHeight) > 1).length, fetches: window.imageFetchCount() });
        })()`)
        for (let i = 0; i < 10; i++) await page.evaluate(`window.imageUpdate('stream')`)
        for (const operation of ["live", "reconcile", "prepend", "reconnect"]) await page.evaluate(`window.imageUpdate('${operation}')`)
        await Bun.sleep(120)
        expect(await page.evaluate<{ readonly sameUser: boolean; readonly sameTool: boolean; readonly sameUserRow: boolean; readonly sameUserContainer: boolean; readonly sameToolRow: boolean; readonly sameSources: boolean; readonly removed: number; readonly srcChanges: number; readonly loading: number; readonly heightChanges: number; readonly fetches: number }>(`window.imageProbe()`)).toEqual({ sameUser: true, sameTool: true, sameUserRow: true, sameUserContainer: true, sameToolRow: true, sameSources: true, removed: 0, srcChanges: 0, loading: 0, heightChanges: 0, fetches: 1 })
      }
    } finally { await page.close() }
  }, 30_000)

  test("recovers a changed tool image source after an invalid image without resetting unchanged images", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?images=1`)
      for (let i = 0; i < 40 && !await page.evaluate<boolean>(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-tool__toggle') !== null`); i++) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-tool__toggle').click()`)
      for (let i = 0; i < 40 && !await page.evaluate<boolean>(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img')?.naturalWidth > 0`); i++) await Bun.sleep(50)
      await page.evaluate(`window.imageUpdate('corrupt-tool')`)
      for (let i = 0; i < 40 && !await page.evaluate<boolean>(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image__unavailable') !== null`); i++) await Bun.sleep(50)
      expect(await page.evaluate<boolean>(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image__unavailable') !== null`)).toBe(true)
      await page.evaluate(`window.imageUpdate('repair-tool')`)
      for (let i = 0; i < 40 && !await page.evaluate<boolean>(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img')?.naturalWidth > 0`); i++) await Bun.sleep(50)
      expect(await page.evaluate<boolean>(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img')?.naturalWidth > 0`)).toBe(true)
    } finally { await page.close() }
  })

  test("offers retry when a managed user image cannot load", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?images=1`)
      for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable')`); i++) await Bun.sleep(25)
      expect(await page.evaluate<string>(`document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable')?.textContent ?? ''`)).toContain("Image unavailable")
      await page.evaluate(`document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable button').click()`)
      for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable')`); i++) await Bun.sleep(25)
      expect(await page.evaluate<boolean>(`Boolean(document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable button'))`)).toBe(true)
    } finally { await page.close() }
  })
  test("omits internal TeamView and Session state rows without leaving blank transcript slots", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?visibility=1`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_notification"]')`); i++) await Bun.sleep(50)
      const state = await page.evaluate<{ readonly ids: readonly string[]; readonly ticks: number; readonly raw: boolean }>(`(() => ({ ids: [...document.querySelectorAll('.transcript-navigation__item')].map(row => row.dataset.messageId), ticks: document.querySelectorAll('.transcript-navigation__tick').length, raw: document.body.innerText.includes('TeamView ·') || document.body.innerText.includes('Session state ·') }))()`)
      expect(state.ids).toEqual(["msg_ordinary", "msg_notification"])
      expect(state.ticks).toBe(1)
      expect(state.raw).toBe(false)
    } finally { await page.close() }
  })

  test("keeps five icon-only accessible destinations in one phone navigation row", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const width of [320, 360, 390, 430]) {
        await page.setViewport(width, 844)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=${theme}`)
        for (let i = 0; i < 80 && await page.evaluate<number>(`document.querySelectorAll('.bottom-nav__item').length`) < 4; i++) await Bun.sleep(50)
        const nav = await page.evaluate<{ readonly tops: readonly number[]; readonly minHeight: number; readonly names: readonly string[]; readonly labelsHidden: boolean; readonly overflow: boolean }>(`(() => { const items = [...document.querySelectorAll('.bottom-nav__item')]; return { tops: items.map(item => item.getBoundingClientRect().top), minHeight: Math.min(...items.map(item => item.getBoundingClientRect().height)), names: items.map(item => item.getAttribute('aria-label')), labelsHidden: items.every(item => { const label = item.querySelector('.bottom-nav__label'); return label instanceof HTMLElement && getComputedStyle(label).display === 'none' }), overflow: document.documentElement.scrollWidth > innerWidth } })()`)
        expect(new Set(nav.tops).size).toBe(1)
        expect(nav.minHeight).toBeGreaterThanOrEqual(44)
        expect(nav.names.map((name) => name.replace(", waiting for your decision", ""))).toEqual(["Sessions", "Conversation", "Usage", "Settings"])
        expect(nav.labelsHidden).toBe(true)
        expect(nav.overflow).toBe(false)
        await page.evaluate(`(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture = document.querySelector('.fixture'); if (fixture) { fixture.style.height = '100dvh'; fixture.style.minHeight = '0'; fixture.style.overflow = 'hidden' } })()`)
        await Bun.write(new URL(`../../../.cache/tmp/bottom-nav-${theme}-${width}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      }
    } finally { await page.close() }
  })

  test("opens the phone sessions drawer upward below the header in both themes", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) {
        for (const [width, height] of [[390, 844], [430, 932]]) {
          await page.setViewport(width!, height!)
          await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=${theme}`)
          for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.app-header__menu')`); i++) await Bun.sleep(50)
          await page.evaluate(`document.querySelector('.app-header__menu').click()`)
          for (let i = 0; i < 30 && !await page.evaluate(`document.querySelector('.overlay[open]')`); i++) await Bun.sleep(20)
          await page.evaluate(`Promise.all([...document.querySelector('.overlay__surface').getAnimations()].map(animation => animation.finished))`)
          const geometry = await page.evaluate<{ readonly top: number; readonly headerBottom: number; readonly bottom: number; readonly width: number; readonly animation: string; readonly focused: boolean }>(`(() => { const dialog = document.querySelector('.overlay[open]'); const surface = dialog.querySelector('.overlay__surface'); const rect = surface.getBoundingClientRect(); return { top: rect.top, headerBottom: document.querySelector('.app-header').getBoundingClientRect().bottom, bottom: rect.bottom, width: rect.width, animation: getComputedStyle(surface).animationName, focused: dialog.contains(document.activeElement) } })()`)
          expect(geometry.top).toBeGreaterThan(geometry.headerBottom)
          expect(geometry.bottom).toBeCloseTo(height!, 0)
          expect(geometry.width).toBeCloseTo(width!, 0)
          expect(geometry.animation).toBe("yc-sheet-in")
          expect(geometry.focused).toBe(true)
          await Bun.write(new URL(`../../../.cache/tmp/sessions-sheet-${theme}-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
          await page.pressEscape()
          for (let i = 0; i < 20 && await page.evaluate<boolean>(`document.querySelector('.overlay[open]') !== null`); i++) await Bun.sleep(20)
          expect(await page.evaluate<boolean>(`document.querySelector('.overlay[open]') === null`)).toBe(true)
        }
      }
      await page.setReducedMotion(true)
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=dark`)
      for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.app-header__menu')`); i++) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.app-header__menu').click()`)
      for (let i = 0; i < 30 && !await page.evaluate(`document.querySelector('.overlay[open]')`); i++) await Bun.sleep(20)
      expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.overlay__surface')).animationName`)).toBe("none")
    } finally { await page.close() }
  }, 45_000)

  test("places active Sessions at full page width above the workspace heading", async () => {
    const page = await browser!.openPage()
    try {
      for (const width of [390, 1440]) {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&theme=light`)
        for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.sessions-page__toolbar')`); i++) await Bun.sleep(50)
        const result = await page.evaluate<{ readonly cards: number; readonly left: number; readonly right: number; readonly pageLeft: number; readonly pageRight: number; readonly top: number; readonly headingTop: number; readonly toolbarTop: number; readonly filterTop: number }>(`(() => { const section = document.querySelector('.running-sessions'); const card = section?.querySelector('.running-sessions__item'); const page = document.querySelector('.sessions-page').getBoundingClientRect(); return { cards: section?.querySelectorAll('.running-sessions__item').length ?? 0, left: section?.getBoundingClientRect().left ?? 0, right: section?.getBoundingClientRect().right ?? 0, pageLeft: page.left, pageRight: page.right, top: card?.getBoundingClientRect().top ?? 0, headingTop: document.querySelector('.sessions-page__title').getBoundingClientRect().top, toolbarTop: document.querySelector('.sessions-page__content .sessions-page__toolbar').getBoundingClientRect().top, filterTop: document.querySelector('.filter-bar').getBoundingClientRect().top } })()`)
        expect(result.cards).toBeGreaterThan(0)
        expect(Math.abs(result.left - result.pageLeft)).toBeLessThanOrEqual(1)
        expect(Math.abs(result.right - result.pageRight)).toBeLessThanOrEqual(1)
        expect(result.top).toBeLessThan(result.headingTop)
        expect(result.top).toBeLessThan(result.toolbarTop)
        expect(result.top).toBeLessThan(result.filterTop)
      }
    } finally { await page.close() }
  })



  test("uses most of the real desktop main area and aligns transcript with composer", async () => {
    const page = await browser!.openPage()
    try {
      for (const [width, ratio] of [[1440, 0.87], [1920, 0.8]] as const) {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=light`)
        for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.app--conversation.app--selected .transcript-navigation')`); i++) await Bun.sleep(50)
        const geometry = await page.evaluate<{ readonly ratio: number; readonly left: number; readonly right: number; readonly composerLeft: number; readonly composerRight: number }>(`(() => { const main = document.querySelector('.workspace__main').getBoundingClientRect(); const transcript = document.querySelector('.transcript-navigation').getBoundingClientRect(); const composer = document.querySelector('.composer__row').getBoundingClientRect(); return { ratio: transcript.width / main.width, left: transcript.left, right: transcript.right, composerLeft: composer.left, composerRight: composer.right } })()`)
        expect(geometry.ratio).toBeGreaterThan(ratio)
        expect(Math.abs(geometry.left - geometry.composerLeft)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.right - geometry.composerRight)).toBeLessThanOrEqual(1)
      }
    } finally { await page.close() }
  })

  test("places a compact prompt rail to the right with an inward preview", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?navigation=1`)
      for (let i = 0; i < 40 && await page.evaluate<number>(`document.querySelectorAll('.transcript-navigation__tick').length`) < 12; i++) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.transcript-navigation__tick').focus()`)
      const geometry = await page.evaluate<{ readonly railLeft: number; readonly railWidth: number; readonly tickWidth: number; readonly transcriptRight: number; readonly previewRight: number; readonly viewport: number }>(`(() => { const rail = document.querySelector('.transcript-navigation__rail').getBoundingClientRect(); const tick = document.querySelector('.transcript-navigation__tick').getBoundingClientRect(); const transcript = document.querySelector('.transcript-navigation').getBoundingClientRect(); const preview = document.querySelector('.transcript-navigation__tooltip').getBoundingClientRect(); return { railLeft: rail.left, railWidth: rail.width, tickWidth: tick.width, transcriptRight: transcript.right, previewRight: preview.right, viewport: innerWidth } })()`)
      expect(geometry.railLeft).toBeGreaterThanOrEqual(geometry.transcriptRight)
      expect(geometry.railWidth).toBeLessThanOrEqual(30)
      expect(geometry.tickWidth).toBeLessThanOrEqual(22)
      expect(geometry.previewRight).toBeLessThanOrEqual(geometry.viewport)
      expect(geometry.previewRight).toBeLessThanOrEqual(geometry.transcriptRight)
      expect(await page.evaluate<boolean>(`document.querySelector('.transcript-navigation__controls [aria-label="Jump to top"]') !== null && document.querySelector('.transcript-navigation__rail [aria-label^="Jump to"]') === null`)).toBe(true)
      await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 })); root.scrollTop = 0 })()`)
      for (let i = 0; i < 20 && !await page.evaluate(`document.querySelector('.transcript-navigation__controls [aria-label="Jump to latest"]')`); i++) await Bun.sleep(20)
      expect(await page.evaluate<boolean>(`document.querySelector('.transcript-navigation__controls [aria-label="Jump to latest"]') !== null`)).toBe(true)
    } finally { await page.close() }
  })

  test("keeps user prompt bubbles on the right on phone and tablet", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?navigation=1`)
      for (const [width, height] of [[390, 844], [820, 1180]]) {
        await page.setViewport(width!, height!)
        await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop = 0`)
        const geometry = await page.evaluate<{ readonly bubbleRights: readonly number[]; readonly columnRight: number }>(`(() => ({ bubbleRights: [...document.querySelectorAll('.transcript-message--user')].map(row => row.getBoundingClientRect().right), columnRight: document.querySelector('.transcript-navigation').getBoundingClientRect().right }))()`)
        expect(geometry.bubbleRights.length).toBeGreaterThan(0)
        expect(geometry.bubbleRights.every((right) => Math.abs(right - geometry.columnRight) <= 1)).toBe(true)
      }
    } finally { await page.close() }
  })

  test("right-aligns user bubbles in the real Conversation shell on phone and tablet", async () => {
    const page = await browser!.openPage()
    try {
      for (const [width, height] of [[390, 844], [820, 1180]]) {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=light`)
        for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.app--conversation.app--selected .transcript-navigation__item')`); i++) await Bun.sleep(50)
        await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -300 })); root.scrollTop = 0 })()`)
        for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.app--conversation.app--selected .transcript-message--user')`); i++) await Bun.sleep(50)
        const geometry = await page.evaluate<{ readonly bubbleRight: number; readonly columnRight: number }>(`(() => ({ bubbleRight: document.querySelector('.transcript-message--user').getBoundingClientRect().right, columnRight: document.querySelector('.transcript-navigation').getBoundingClientRect().right }))()`)
        expect(Math.abs(geometry.bubbleRight - geometry.columnRight)).toBeLessThanOrEqual(1)
      }
    } finally { await page.close() }
  })

  test("right-aligns a newly admitted pending prompt while execution is active", async () => {
    const page = await browser!.openPage()
    try {
      for (const [width, height] of [[390, 844], [820, 1180]]) {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=light`)
        for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.composer__input') && document.querySelector('.mini-composer__send')`); i++) await Bun.sleep(50)
        await page.evaluate(`(() => { const input = document.querySelector('.composer__input'); input.value = 'Inspect the running Session and keep this prompt pending while I review the transcript.'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); document.querySelector('.mini-composer__send').click() })()`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-message--user .transcript-message__receipt[aria-label="Processing prompt"]')`); i++) await Bun.sleep(50)
        const geometry = await page.evaluate<{ readonly processing: number; readonly right: number; readonly columnRight: number }>(`(() => { const row = document.querySelector('.transcript-message--user:has(.transcript-message__receipt[aria-label="Processing prompt"])'); return { processing: document.querySelectorAll('.transcript-message__receipt[aria-label="Processing prompt"]').length, right: row?.getBoundingClientRect().right ?? 0, columnRight: document.querySelector('.transcript-navigation').getBoundingClientRect().right } })()`)
        expect(geometry.processing).toBeGreaterThan(0)
        expect(Math.abs(geometry.right - geometry.columnRight)).toBeLessThanOrEqual(1)
        await page.evaluate(`(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture = document.querySelector('.fixture'); if (fixture) { fixture.style.height = '100dvh'; fixture.style.minHeight = '0'; fixture.style.overflow = 'hidden' } const root = document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 })); root.scrollTop = 0 })()`)
        await Bun.sleep(60)
        await page.evaluate(`document.querySelector('.transcript-message--user:has(.transcript-message__receipt[aria-label="Processing prompt"])')?.scrollIntoView({ block: 'center' })`)
        await Bun.sleep(120)
        await Bun.write(new URL(`../../../.cache/tmp/pending-prompt-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      }
    } finally { await page.close() }
  })


  test("offers top and bottom navigation without covering the todo panel or composer", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?navigation=1`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-navigation')`); i++) await Bun.sleep(50)
      const visibility = () => page.evaluate<{ readonly top: boolean; readonly bottom: boolean; readonly clear: boolean }>(`(() => { const top = document.querySelector('.transcript-navigation__controls [aria-label="Jump to top"]'); const bottom = document.querySelector('.transcript-navigation__controls [aria-label="Jump to latest"]'); const controls = document.querySelector('.transcript-navigation__controls')?.getBoundingClientRect(); const slot = document.querySelector('.conversation-jump-slot')?.getBoundingClientRect(); const root = document.querySelector('.workspace__scroll')?.getBoundingClientRect(); const todo = document.querySelector('.todo-panel__inner')?.getBoundingClientRect(); const composer = document.querySelector('.composer')?.getBoundingClientRect(); return { top: Boolean(top && getComputedStyle(top).visibility === 'visible'), bottom: Boolean(bottom && getComputedStyle(bottom).visibility === 'visible'), clear: Boolean(controls && slot && root && todo && composer && slot.height === 0 && Math.abs(root.bottom - todo.top) <= 1 && controls.top >= root.top && controls.bottom <= root.bottom && controls.bottom <= todo.top - 6 && controls.bottom <= composer.top - 6) } })()`)
      expect(await visibility()).toEqual({ top: true, bottom: false, clear: true })
      await page.evaluate(`const root = document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 })); root.scrollTop = root.scrollHeight / 2`)
      for (let i = 0; i < 20 && !(await visibility()).bottom; i++) await Bun.sleep(20)
      expect(await visibility()).toEqual({ top: true, bottom: true, clear: true })
      await page.evaluate(`document.querySelector('.transcript-navigation__controls [aria-label="Jump to top"]').click()`)
      for (let i = 0; i < 80 && await page.evaluate<number>(`document.querySelector('.workspace__scroll').scrollTop`) > 8; i++) await Bun.sleep(20)
      for (let i = 0; i < 20 && (await visibility()).top; i++) await Bun.sleep(20)
      expect(await visibility()).toEqual({ top: false, bottom: true, clear: true })
      await page.evaluate(`document.querySelector('.transcript-navigation__controls [aria-label="Jump to latest"]').click()`)
      for (let i = 0; i < 80 && await page.evaluate<number>(`(() => { const root = document.querySelector('.workspace__scroll'); return root.scrollHeight - root.clientHeight - root.scrollTop })()`) > 2; i++) await Bun.sleep(20)
      expect(await visibility()).toEqual({ top: true, bottom: false, clear: true })
    } finally { await page.close() }
  })

  test("floats the jump control above the full composer mount and selector row without a layout row", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=light`)
      for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.mini-composer__mount .composer__mobile-trigger') && document.querySelector('.transcript-navigation__controls')`); i++) await Bun.sleep(50)
      await page.evaluate(`(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture = document.querySelector('.fixture'); fixture.style.height = '100dvh'; fixture.style.minHeight = '0'; fixture.style.overflow = 'hidden' })()`)
      await page.evaluate(`(() => { document.querySelector('.conversation-pane').style.minHeight = '2600px'; const root = document.querySelector('.workspace__scroll'); root.scrollTop = 900; root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 })); root.scrollTop = 300 })()`)
      for (let i = 0; i < 40 && !await page.evaluate<boolean>(`document.querySelector('.transcript-navigation__controls--visible') !== null`); i++) await Bun.sleep(25)
      expect(await page.evaluate<boolean>(`document.querySelector('.transcript-navigation__controls--visible') !== null`)).toBe(true)
      await page.evaluate(`new Promise(resolve => setTimeout(resolve, 0)).then(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))))`)
      const geometry = await page.evaluate<{ readonly controlBottom: number; readonly mountTop: number; readonly selectorTop: number; readonly selectorBottom: number; readonly todoTop?: number }>(`(() => { const controls = document.querySelector('.transcript-navigation__controls').getBoundingClientRect(); const mount = document.querySelector('.mini-composer__mount').getBoundingClientRect(); const selector = document.querySelector('.composer__mobile-trigger').getBoundingClientRect(); const todo = document.querySelector('.todo-panel__inner')?.getBoundingClientRect(); return { controlBottom: controls.bottom, mountTop: mount.top, selectorTop: selector.top, selectorBottom: selector.bottom, todoTop: todo?.top } })()`)
      expect(geometry.controlBottom).toBeLessThanOrEqual(geometry.mountTop - 6)
      expect(geometry.controlBottom).toBeLessThanOrEqual(geometry.selectorTop - 6)
      if (geometry.todoTop !== undefined) expect(geometry.controlBottom).toBeLessThanOrEqual(geometry.todoTop - 6)
    } finally { await page.close() }
  })



  test("shows subagent notification status and excerpt without raw JSON or a user bubble", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?notification=1`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_notification"]')`); i++) await Bun.sleep(50)
      const summary = await page.evaluate<{ readonly text: string; readonly bubbles: number; readonly raw: boolean }>(`(() => ({ text: document.querySelector('[data-message-id="msg_notification"]')?.textContent ?? '', bubbles: document.querySelectorAll('.transcript-message--user .transcript-message__bubble').length, raw: document.body.innerText.includes('{"source":"subagent_notification"') }))()`)
      expect(summary.text).toContain("ses_child")
      expect(summary.text).toContain("completed")
      expect(summary.raw).toBe(false)
      expect(summary.bubbles).toBe(1)
      expect(await page.evaluate<boolean>(`document.querySelector('[data-message-id="msg_notification"] summary svg') !== null`)).toBe(true)
      await page.evaluate(`document.querySelector('[data-message-id="msg_notification"] summary').click()`)
      expect(await page.evaluate<string>(`document.querySelector('[data-message-id="msg_notification"]')?.textContent ?? ''`)).toContain("Tests pass and the repair is verified.")
      await Bun.write(new URL("../../../.cache/tmp/transcript-notification-light-390x844.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    } finally { await page.close() }
  })

  test("mounts navigation in the real Conversation shell scroll column", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=light`)
      for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.app--conversation.app--selected .transcript-navigation')`); i++) await Bun.sleep(50)
      await Bun.sleep(250)
      const result = await page.evaluate<{ readonly scroll: boolean; readonly railControls: boolean; readonly controlsInSlot: boolean; readonly slotHeight: number | undefined; readonly slotAligned: boolean; readonly overflow: boolean }>(`(() => { const nav = document.querySelector('.app--conversation.app--selected .transcript-navigation'); const root = nav?.closest('.workspace__scroll'); const main = nav?.closest('.workspace__main'); const slot = main?.querySelector('.conversation-jump-slot'); return { scroll: Boolean(root), railControls: Boolean(nav?.querySelector('.transcript-navigation__rail [aria-label^="Jump to"]')), controlsInSlot: Boolean(slot?.querySelector('.transcript-navigation__controls')), slotHeight: slot?.getBoundingClientRect().height, slotAligned: Math.abs((slot?.getBoundingClientRect().left ?? -99) - document.querySelector('.composer__row').getBoundingClientRect().left) <= 1 && Math.abs((slot?.getBoundingClientRect().right ?? -99) - document.querySelector('.composer__row').getBoundingClientRect().right) <= 1, overflow: document.documentElement.scrollWidth > innerWidth } })()`)
      expect(result).toEqual({ scroll: true, railControls: false, controlsInSlot: true, slotHeight: 0, slotAligned: true, overflow: false })
    } finally { await page.close() }
  })

  test("shows one activity indicator on the active row and none on the assistant header", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?running=1`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-tool')`); i++) await Bun.sleep(50)
      expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-tool .transcript-dot-trail').length`)).toBe(1)
      expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-message__agent .transcript-dot-trail').length`)).toBe(0)
    } finally { await page.close() }
  })

  test("animates a tool disclosure closed without losing its accessible state", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-tool__toggle')`); i++) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.transcript-tool__toggle').click()`)
      expect(await page.evaluate<boolean>(`document.querySelector('.transcript-tool__toggle').getAttribute('aria-expanded') === 'true'`)).toBe(true)
      await page.evaluate(`document.querySelector('.transcript-tool__toggle').click()`)
      expect(await page.evaluate<boolean>(`document.querySelector('.transcript-tool__toggle').getAttribute('aria-expanded') === 'false' && document.querySelector('.transcript-tool__body') !== null`)).toBe(true)
      await Bun.sleep(260)
      expect(await page.evaluate<boolean>(`document.querySelector('.transcript-tool__body') === null`)).toBe(true)
    } finally { await page.close() }
  })

  test("follows a streaming tail until the reader scrolls away, then offers jump and prompt ticks", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?navigation=1`)
      expect(await page.evaluate<boolean>(`document.querySelector('.transcript-navigation') !== null`)).toBe(true)
      const atEnd = () => page.evaluate<number>(`(() => { const root = document.querySelector('.workspace__scroll'); return root.scrollHeight - root.clientHeight - root.scrollTop })()`)
      const controls = () => page.evaluate<{ readonly top: boolean; readonly bottom: boolean }>(`(() => ({ top: Boolean(document.querySelector('.transcript-navigation__controls [aria-label="Jump to top"]')), bottom: Boolean(document.querySelector('.transcript-navigation__controls [aria-label="Jump to latest"]')) }))()`)
      expect(await atEnd()).toBeLessThanOrEqual(2)
      expect(await controls()).toEqual({ top: true, bottom: false })
      await page.evaluate(`document.querySelector('#append').click()`)
      for (let i = 0; i < 10 && await atEnd() > 2; i++) await Bun.sleep(20)
      expect(await atEnd()).toBeLessThanOrEqual(2)
      await page.evaluate(`document.querySelector('.workspace__scroll').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 })); document.querySelector('.workspace__scroll').scrollTop = 0`)
      expect(await atEnd()).toBeGreaterThan(48)
      for (let i = 0; i < 20 && !(await controls()).bottom; i++) await Bun.sleep(20)
      expect(await controls()).toEqual({ top: false, bottom: true })
      await page.evaluate(`document.querySelector('#append').click()`)
      expect(await atEnd()).toBeGreaterThan(48)
      await page.evaluate(`document.querySelector('.transcript-navigation__controls [aria-label="Jump to latest"]').click()`)
      for (let i = 0; i < 80 && await atEnd() > 2; i++) await Bun.sleep(20)
      expect(await atEnd()).toBeLessThanOrEqual(2)
      for (let i = 0; i < 20 && (await controls()).bottom; i++) await Bun.sleep(20)
      expect(await controls()).toEqual({ top: true, bottom: false })
      await page.evaluate(`document.querySelector('#append').click()`)
      for (let i = 0; i < 10 && await atEnd() > 2; i++) await Bun.sleep(20)
      expect(await atEnd()).toBeLessThanOrEqual(2)
      await page.setViewport(1440, 900)
      await Bun.sleep(300)
      expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-navigation__tick').length`)).toBe(12)
      await page.evaluate(`document.querySelector('.transcript-navigation__tick').focus()`)
      expect(await page.evaluate<string>(`document.querySelector('.transcript-navigation__tooltip')?.textContent ?? ''`)).toContain("Prompt 1")
      await page.evaluate(`document.querySelector('.transcript-navigation__tick').click()`)
      expect(await page.evaluate<boolean>(`document.activeElement?.dataset.messageId === 'prompt_0'`)).toBe(true)
      for (let i = 0; i < 30 && await atEnd() <= 48; i++) await Bun.sleep(20)
      expect(await atEnd()).toBeGreaterThan(48)
    } finally { await page.close() }
  })

  test("keeps a followed tail after retention pruning and starts a newly opened transcript at the end", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?navigation=1`)
      for (let i = 0; i < 40 && await page.evaluate<number>(`document.querySelectorAll('.transcript-navigation__tick').length`) < 12; i++) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('#prune').click()`)
      for (let i = 0; i < 20 && await page.evaluate<number>(`document.querySelectorAll('.transcript-navigation__tick').length`) !== 6; i++) await Bun.sleep(20)
      expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-navigation__tick').length`)).toBe(6)
      expect(await page.evaluate<number>(`(() => { const root = document.querySelector('.workspace__scroll'); return root.scrollHeight - root.clientHeight - root.scrollTop })()`)).toBeLessThanOrEqual(2)
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?navigation=1`)
      for (let i = 0; i < 40 && await page.evaluate<number>(`document.querySelectorAll('.transcript-navigation__tick').length`) < 12; i++) await Bun.sleep(50)
      expect(await page.evaluate<number>(`(() => { const root = document.querySelector('.workspace__scroll'); return root.scrollHeight - root.clientHeight - root.scrollTop })()`)).toBeLessThanOrEqual(2)
    } finally { await page.close() }
  })

  test("large synthetic transcripts mount a bounded window and a completed boundary keeps its divider reachable", async () => {
    if (!browser) throw new Error("Browser not started")
    const counts: { readonly messages: number; readonly nodes: number; readonly reasoningBodies: number; readonly compactions: number; readonly height: number }[] = []
    for (const synthetic of ["full", "compacted"]) {
      const page = await browser.openPage()
      try {
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?synthetic=${synthetic}`)
        for (let i = 0; i < 80 && await page.evaluate<number>(`document.querySelectorAll('.transcript-message').length`) === 0; i++) await Bun.sleep(50)
        for (let i = 0; i < 80 && !await page.evaluate<boolean>(`(() => { const root = document.querySelector('.workspace__scroll'); return root.scrollHeight - root.clientHeight - root.scrollTop <= 2 })()`); i++) await Bun.sleep(50)
        const mounted = await page.evaluate<{ readonly messages: number; readonly nodes: number; readonly reasoningBodies: number; readonly height: number }>(`({ messages: document.querySelectorAll('.transcript-message').length, nodes: document.querySelectorAll('*').length, reasoningBodies: document.querySelectorAll('.transcript-reasoning__body').length, height: document.querySelector('.transcript').getBoundingClientRect().height })`)
        await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -300 })); root.scrollTop = 0 })()`)
        for (let i = 0; i < 80 && !await page.evaluate<boolean>(`document.querySelector('[data-message-id="msg_0"], .transcript-compaction') !== null`); i++) await Bun.sleep(25)
        counts.push({ ...mounted, compactions: await page.evaluate<number>(`document.querySelectorAll('.transcript-compaction').length`) })
      } finally { await page.close() }
    }
    for (const count of counts) {
      expect(count.messages).toBeGreaterThan(0)
      expect(count.messages).toBeLessThanOrEqual(60)
      expect(count.nodes).toBeLessThan(6_000)
    }
    expect(counts[0]!.height).toBeGreaterThan(counts[1]!.height)
    expect(counts.map((count) => count.compactions)).toEqual([0, 1])
    console.log(`Synthetic transcript DOM: full ${counts[0]!.nodes} nodes, compacted ${counts[1]!.nodes} nodes`)
    expect(counts.map((count) => count.reasoningBodies)).toEqual([0, 0])
  })
  test("groups safe reasoning and preserves keyboard disclosure and streamed identity", async () => {
    if (!browser) throw new Error("Browser not started")
    const page = await browser.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-reasoning') !== null`); i++) await Bun.sleep(50)
      expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-reasoning').length`)).toBe(1)
      expect(await page.evaluate<string>(`document.querySelector('.transcript-reasoning summary').textContent`)).toContain("Thought · 2s")
      expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-reasoning__body').length`)).toBe(0)
      await page.evaluate(`document.querySelector('.transcript-reasoning summary').focus()`)
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.transcript-reasoning summary')`)).toBe(true)
      await page.pressKey(" ", "Space", 32)
      expect(await page.evaluate<boolean>(`document.querySelector('.transcript-reasoning').open`)).toBe(true)
      for (let i = 0; i < 20 && !await page.evaluate<boolean>(`document.querySelector('.transcript-reasoning strong') !== null`); i++) await Bun.sleep(20)
      const result = await page.evaluate<{ bold: string; code: string; literal: boolean; unsafe: number; answer: string }>(`({ bold: document.querySelector('.transcript-reasoning strong')?.textContent ?? '', code: document.querySelector('.transcript-reasoning code')?.textContent ?? '', literal: document.querySelector('.transcript-reasoning').textContent.includes('**'), unsafe: document.querySelectorAll('.transcript-reasoning img').length, answer: document.querySelector('.transcript-message--assistant .transcript-message__text')?.textContent ?? '' })`)
      expect(result).toMatchObject({ bold: "Important", code: "code", literal: false, unsafe: 0 })
      expect(result.answer).toContain("Final answer")
      await page.evaluate(`document.querySelector('.transcript-reasoning').dataset.identity = 'retained'; document.querySelector('#stream').click()`)
      expect(await page.evaluate<{ open: boolean; retained: boolean; streamed: boolean }>(`({ open: document.querySelector('.transcript-reasoning').open, retained: document.querySelector('.transcript-reasoning').dataset.identity === 'retained', streamed: document.querySelector('.transcript-reasoning__body')?.textContent.includes('Streamed detail') ?? false })`)).toEqual({ open: true, retained: true, streamed: true })
      await page.pressKey(" ", "Space", 32)
      expect(await page.evaluate<boolean>(`document.querySelector('.transcript-reasoning summary').getAttribute('aria-expanded') === 'false' && document.querySelector('.transcript-reasoning__body') !== null`)).toBe(true)
      for (let i = 0; i < 20 && await page.evaluate<boolean>(`document.querySelector('.transcript-reasoning__body') !== null`); i++) await Bun.sleep(20)
      expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-reasoning__body').length`)).toBe(0)
    } finally { await page.close() }
  })

  test("places user on the right, YCoding on the left with bounded mobile bubbles and actual read state", async () => {
    if (!browser) throw new Error("Browser not started")
    const page = await browser.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-message--user') !== null`); i++) await Bun.sleep(50)
      const inspect = () => page.evaluate<{ user: number; assistant: number; parentLeft: number; parentRight: number; width: number; overflow: boolean; receipt: string; identity: string; bubble: string; outside: boolean }>(`(() => { const user = document.querySelector('.transcript-message--user'); const assistant = document.querySelector('.transcript-message--assistant'); const u = user.getBoundingClientRect(); const a = assistant.getBoundingClientRect(); const p = document.querySelector('.transcript').getBoundingClientRect(); return { user: u.right, assistant: a.left, parentLeft: p.left, parentRight: p.right, width: u.width, overflow: document.documentElement.scrollWidth > innerWidth, receipt: user.querySelector('.transcript-message__receipt')?.textContent?.trim() ?? '', identity: assistant.querySelector('.transcript-message__agent')?.textContent?.trim() ?? '', bubble: user.querySelector('.transcript-message__bubble')?.textContent ?? '', outside: user.querySelector('.transcript-message__receipt').getBoundingClientRect().top >= user.querySelector('.transcript-message__bubble').getBoundingClientRect().bottom } })()`)
      const pending = await inspect()
      expect(pending.user).toBeGreaterThan(pending.assistant)
      expect(pending.user).toBeCloseTo(pending.parentRight, 0)
      expect(pending.assistant).toBeCloseTo(pending.parentLeft, 0)
      expect(pending.width).toBeLessThan(350)
      expect(pending.overflow).toBe(false)
      expect(pending.receipt).toContain("Queued")
      expect(pending.identity).toContain("God")
      expect(pending.bubble).not.toContain("You")
      expect(pending.outside).toBe(true)
      await page.evaluate(`document.querySelector('#admit').click()`)
      expect((await inspect()).receipt).toContain("Sent")
      await page.evaluate(`document.querySelector('#consume').click()`)
      expect((await inspect()).receipt).toContain("Read")
      await page.setViewport(320, 740)
      expect((await inspect()).overflow).toBe(false)
    } finally { await page.close() }
  })

  test("renders safe Markdown and error lines without internal observations", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-navigation')`); i++) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.transcript-tool--error .transcript-tool__toggle').click()`)
      const result = await page.evaluate<{ readonly unsafe: number; readonly table: number; readonly code: number; readonly imageLinks: number; readonly rawHTML: boolean; readonly structures: boolean; readonly taskLabel: string; readonly observation: string; readonly error: string; readonly footer: string }>(`(() => ({ unsafe: document.querySelectorAll('.transcript-md script, .transcript-md img, .transcript-md a[href^="javascript:"], .transcript-md a[href^="data:"]').length, table: document.querySelectorAll('.transcript-md table').length, code: document.querySelectorAll('.transcript-md__code').length, imageLinks: [...document.querySelectorAll('.transcript-md a')].filter(a => a.textContent === 'No image').length, rawHTML: document.querySelector('.transcript-md').textContent.includes('<script>alert(1)</script>'), structures: ['ol','ul ul','input[type=checkbox]','blockquote','hr','del'].every(selector => document.querySelector('.transcript-md ' + selector)), taskLabel: document.querySelector('.transcript-md li:has(input[type=checkbox])')?.textContent ?? '', observation: document.querySelector('.transcript-message__observation summary')?.textContent ?? '', error: document.querySelector('.transcript-tool__error')?.textContent ?? '', footer: document.querySelector('.transcript-message__footer')?.textContent ?? '' }))()`)
      expect(result.unsafe).toBe(0)
      expect(result.table).toBe(1)
      expect(result.code).toBe(1)
      expect(result.imageLinks).toBe(1)
      expect(result.rawHTML).toBe(true)
      expect(result.structures).toBe(true)
      expect(result.taskLabel.trim()).toBe("Verified task")
      expect(result.observation).toBe("")
      expect(result.error).toContain("↳ A very long JSON error")
      expect(result.footer).toContain("anthropic/Claude Opus 5 5 · high")
    } finally { await page.close() }
  })

  test("keeps transcript navigation clear of content and composer in both themes", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?navigation=1`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-navigation')`); i++) await Bun.sleep(50)
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(`document.documentElement.dataset.theme = '${theme}'`)
        for (const [width, height] of [[390, 844], [820, 1180], [1024, 768], [1440, 900], [1920, 1080]]) {
          await page.setViewport(width!, height!)
          await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop = 0`)
          await Bun.sleep(600)
          const metrics = await page.evaluate<{ readonly overflow: boolean; readonly controlHeight: number; readonly controlClear: boolean; readonly railVisible: boolean; readonly tickClear: boolean; readonly aligned: boolean }>(`(() => { const controls = document.querySelector('.transcript-navigation__controls').getBoundingClientRect(); const slot = document.querySelector('.conversation-jump-slot').getBoundingClientRect(); const todo = document.querySelector('.todo-panel__inner').getBoundingClientRect(); const composer = document.querySelector('.transcript-fixture__composer').getBoundingClientRect(); const rail = document.querySelector('.transcript-navigation__rail'); const tick = rail.querySelector('.transcript-navigation__tick').getBoundingClientRect(); const root = document.querySelector('.workspace__scroll').getBoundingClientRect(); const transcript = document.querySelector('.transcript-navigation').getBoundingClientRect(); return { overflow: document.documentElement.scrollWidth > innerWidth, controlHeight: controls.height, controlClear: slot.height === 0 && controls.bottom <= todo.top - 6 && controls.bottom <= composer.top - 6 && controls.right <= transcript.right + 1 && controls.left >= transcript.left, railVisible: getComputedStyle(rail).display !== 'none', tickClear: tick.width > 0 && tick.left >= transcript.right && tick.right <= root.right, aligned: Math.abs(todo.left - transcript.left) <= 1 && Math.abs(todo.right - transcript.right) <= 1 && Math.abs(composer.left - transcript.left) <= 1 && Math.abs(composer.right - transcript.right) <= 1 } })()`)
          expect(metrics.overflow).toBe(false)
          expect(metrics.aligned).toBe(true)
          expect(metrics.controlClear).toBe(true)
          expect(metrics.railVisible).toBe(width! >= 1024)
          if (width! >= 1024) expect(metrics.tickClear).toBe(true)
          expect(metrics.controlHeight).toBeGreaterThanOrEqual(36)
          await Bun.write(new URL(`../../../.cache/tmp/transcript-navigation-${theme}-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
          await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop = document.querySelector('.workspace__scroll').scrollHeight`)
          await Bun.sleep(100)
          expect(await page.evaluate<boolean>(`(() => { const controls = document.querySelector('.transcript-navigation__controls').getBoundingClientRect(); const last = [...document.querySelectorAll('.transcript-navigation__item')].at(-1).getBoundingClientRect(); return controls.width > 0 && last.bottom <= controls.top })()`), `${width}x${height} last content stays above the jump control`).toBe(true)
          await Bun.write(new URL(`../../../.cache/tmp/transcript-navigation-${theme}-${width}x${height}-bottom.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        }
      }
      await page.setViewport(1024, 768)
      await page.setCoarsePointer(true)
      const coarse = await page.evaluate<{ readonly height: number; readonly overflow: boolean }>(`({ height: document.querySelector('.transcript-navigation__controls button').getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth })`)
      expect(coarse.height).toBeGreaterThanOrEqual(44)
      expect(coarse.overflow).toBe(false)
    } finally { await page.close() }
  }, 60_000)
})
