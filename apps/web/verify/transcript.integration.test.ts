import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser, decodeArray, decodeBoolean, decodeNullable, decodeNumber, decodeOptional, decodeRecord, decodeString } from "./cdp"

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
  test("Web renders Markdown in prompts and notices and copies fenced code verbatim", async () => {
    const page = await browser!.openPage()
    try {
      await page.injectOnNewDocument(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedMarkdown = text; } } })`)
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?markdown`)
      await page.evaluate(`new Promise((resolve, reject) => { const until = performance.now() + 5000; const ready = () => { if (document.querySelector('[data-message-id="msg_markdown_tool"]')) resolve(true); else if (performance.now() >= until) reject(new Error('Markdown turns did not render')); else requestAnimationFrame(ready); }; ready(); })`)
      await page.evaluate(`(() => { for (const selector of ['.transcript-notice__toggle', '.transcript-tool__toggle[aria-expanded="false"]']) document.querySelector(selector)?.click(); })()`)
      expect(await page.evaluate(`Object.fromEntries([...document.querySelectorAll('[data-message-id^="msg_markdown_"]')].map(row => [row.dataset.messageId, row.querySelector('.transcript-md strong')?.textContent ?? '']))`, decodeRecord)).toEqual({ msg_markdown_user: "User emphasis", msg_markdown_system: "System emphasis", msg_markdown_goal: "Goal emphasis", msg_markdown_member: "Member emphasis", msg_markdown_excerpt: "Child emphasis", msg_markdown_tool: "Tool emphasis" })
      const code = `  const line = '${"longCode".repeat(90)}'\n\n    return line`
      expect(await page.evaluate(`(() => { const block = document.querySelector('.transcript-md__code'), pre = block.querySelector('pre'), code = pre.querySelector('code'), head = block.querySelector('.transcript-md__code-head'), copy = head.querySelector('button'); return { language: head.firstElementChild.textContent, label: copy.textContent.trim(), icon: !!copy.querySelector('svg'), mono: getComputedStyle(code).fontFamily.includes('JetBrains Mono'), text: code.textContent, selectable: [block.closest('.transcript-md'), pre, code].every(el => getComputedStyle(el).userSelect === 'text'), outerFits: [document.documentElement, block, block.closest('.transcript-message__bubble')].every(el => el.scrollWidth <= el.clientWidth), scrollsInside: pre.scrollWidth > pre.clientWidth && getComputedStyle(pre).overflowX === 'auto' }; })()`, decodeRecord)).toEqual({ language: "ts", label: "Copy", icon: true, mono: true, text: code, selectable: true, outerFits: true, scrollsInside: true })
      await page.evaluate(`document.querySelector('.transcript-md__code-head button').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      expect(await page.evaluate(`window.copiedMarkdown`, decodeString)).toBe(code)
      expect(await page.evaluate(`document.querySelector('.transcript-md__code-head button').textContent.trim()`, decodeString)).toBe("Copied")
    } finally { await page.close() }
  }, 20_000)

  test("Markdown task checkboxes own their indicator and retain native checked, disabled and keyboard states", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"]) {
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?theme=${theme}`)
        for (let i = 0; i < 60 && !await page.evaluate(`document.querySelector('.transcript-md input[type=checkbox]') !== null`); i++) await Bun.sleep(50)
        const state = await page.evaluate(`(() => {
          const input = document.querySelector('.transcript-md input[type=checkbox]')
          const style = getComputedStyle(input)
          const mark = getComputedStyle(input, '::after')
          input.focus()
          return { type: input.type, checked: input.checked, disabled: input.disabled, focused: document.activeElement === input, appearance: style.appearance, width: input.getBoundingClientRect().width, border: style.borderTopStyle, mark: mark.content, markWidth: parseFloat(mark.width) || 0, sameInk: mark.borderTopColor === style.borderTopColor, label: input.closest('li').textContent.trim() }
        })()`, (value: unknown) => { const r = decodeRecord(value); return { type: decodeString(r.type), checked: decodeBoolean(r.checked), disabled: decodeBoolean(r.disabled), focused: decodeBoolean(r.focused), appearance: decodeString(r.appearance), width: decodeNumber(r.width), border: decodeString(r.border), mark: decodeString(r.mark), markWidth: decodeNumber(r.markWidth), sameInk: decodeBoolean(r.sameInk), label: decodeString(r.label) } })
        expect(state).toMatchObject({ type: "checkbox", checked: true, disabled: true, focused: false, appearance: "none", width: 16, border: "solid", mark: '""', markWidth: 8, sameInk: true, label: "Verified task" })
        await page.pressKey("Tab", "Tab", 9)
        await page.evaluate(`(() => { const input = document.querySelector('.transcript-md input[type=checkbox]'); input.disabled = false; input.focus() })()`)
        const focus = await page.evaluate(`(() => { const input = document.querySelector('.transcript-md input[type=checkbox]'); const style = getComputedStyle(input); return { focused: document.activeElement === input, visible: input.matches(':focus-visible'), outline: style.outlineStyle, width: parseFloat(style.outlineWidth) } })()`, (value: unknown) => { const r = decodeRecord(value); return { focused: decodeBoolean(r.focused), visible: decodeBoolean(r.visible), outline: decodeString(r.outline), width: decodeNumber(r.width) } })
        expect(focus).toEqual({ focused: true, visible: true, outline: "solid", width: 2 })
        await page.pressKey(" ", "Space", 32, " ")
        expect(await page.evaluate(`(() => { const input = document.querySelector('.transcript-md input[type=checkbox]'); return !input.checked && getComputedStyle(input, '::after').content === 'none' })()`)).toBe(true)
        await page.pressKey(" ", "Space", 32, " ")
        expect(await page.evaluate(`document.querySelector('.transcript-md input[type=checkbox]').checked`)).toBe(true)
        await page.evaluate(`document.querySelector('.transcript-md input[type=checkbox]').disabled = true`)
        await page.pressKey(" ", "Space", 32, " ")
        expect(await page.evaluate(`document.querySelector('.transcript-md input[type=checkbox]').checked`)).toBe(true)
      }
      await page.setForcedColors(true)
      expect(await page.evaluate(`(() => { const input = document.querySelector('.transcript-md input[type=checkbox]'); const mark = getComputedStyle(input, '::after'); return input.checked && input.disabled && mark.content === '""' && mark.borderTopStyle === 'solid' && parseFloat(mark.borderTopWidth) > 0 && mark.borderTopColor !== getComputedStyle(input).backgroundColor })()`)).toBe(true)
    } finally { await page.close() }
  }, 20_000)

  test("user messages retain receipts without prompt-cost summaries or breakdowns", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]]) {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?costs&theme=${theme}`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_cost_known"] .transcript-message__receipt')`); i++) await Bun.sleep(50)
        for (const id of ["msg_cost_known", "msg_cost_partial", "msg_cost_unreported", "msg_cost_pending"]) {
          const row = await page.evaluate(`(() => { const row = document.querySelector('[data-message-id="${id}"]'); const article = row.querySelector('article'); const receipt = article.querySelector('.transcript-message__receipt'); return { costBlocks: row.querySelectorAll('.usage-unit-cost, [aria-label="Prompt cost"]').length, text: row.textContent, headCount: article.querySelectorAll(".transcript-message__head").length, receiptParent: receipt.parentElement.className, receiptAfterBubble: !article.querySelector(".transcript-message__bubble") || !!(article.querySelector(".transcript-message__bubble").compareDocumentPosition(receipt) & Node.DOCUMENT_POSITION_FOLLOWING), receiptRole: receipt.getAttribute('role'), receiptLabel: receipt.getAttribute('aria-label') ?? '' } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, costBlocks: (decodeNumber)(record["costBlocks"]), text: (decodeString)(record["text"]), headCount: (decodeNumber)(record["headCount"]), receiptParent: (decodeString)(record["receiptParent"]), receiptAfterBubble: (decodeBoolean)(record["receiptAfterBubble"]), receiptRole: (decodeNullable(decodeString))(record["receiptRole"]), receiptLabel: (decodeString)(record["receiptLabel"]) } })
          expect(row.costBlocks).toBe(0)
          expect(row.text).not.toContain("Prompt cost")
          expect(row.text).not.toContain("Cost breakdown")
          expect(row.headCount).toBe(0)
          expect(row.receiptParent).toBe("transcript-message transcript-message--user")
          expect(row.receiptAfterBubble).toBe(true)
          expect(row.receiptRole).toBe("status")
          expect(row.receiptLabel).not.toBe("")
          expect(row.text).toContain(id === "msg_cost_pending" ? "Queued" : id === "msg_cost_unreported" ? "Sent" : "Read")
        }
        expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      }
    } finally { await page.close() }
  }, 20_000)

  test("keeps a compaction divider stationary and preserves neighbours across completion at phone and desktop sizes in both themes", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]]) {
        await page.setViewport(width!, height!)
        await page.setReducedMotion(theme === "dark")
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?compaction=history&theme=${theme}`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-compaction__label')`); i++) await Bun.sleep(50)
        expect(await page.evaluate(`document.querySelector('.transcript-compaction__label')?.textContent ?? ''`)).toBe("~ compacting · manual")
        const before = await page.evaluate(`(() => { window.neighbour = document.querySelector('[data-message-id="msg_after"]'); window.divider = document.querySelector('[data-message-id="cmp_live"]'); return { top: window.neighbour.getBoundingClientRect().top, height: window.divider.getBoundingClientRect().height } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), height: (decodeNumber)(record["height"]) } })
        await page.evaluate(`window.compactionUpdate()`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-compaction__label')?.textContent?.includes('compacted')`); i++) await Bun.sleep(25)
        const after = await page.evaluate(`(() => { const row = document.querySelector('[data-message-id="cmp_live"]') ?? document.querySelector('[data-message-id="msg_compact"]'); return { top: document.querySelector('[data-message-id="msg_after"]').getBoundingClientRect().top, height: row.getBoundingClientRect().height, same: window.neighbour === document.querySelector('[data-message-id="msg_after"]'), sameDivider: window.divider === row, text: row.textContent, overflow: document.documentElement.scrollWidth > innerWidth } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), height: (decodeNumber)(record["height"]), same: (decodeBoolean)(record["same"]), sameDivider: (decodeBoolean)(record["sameDivider"]), text: (decodeString)(record["text"]), overflow: (decodeBoolean)(record["overflow"]) } })
        expect(after.same).toBe(true)
        expect(after.sameDivider).toBe(true)
        expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2)
        expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(2)
        expect(after.text).toContain("~ compacted · 11 items excluded · 1k → 400 tokens")
        expect(after.text).toContain("~900 tokens saved total")
        expect(after.text).toContain("Compression #2 (~600 tokens removed, 60% reduction)")
        expect(after.overflow).toBe(false)
        if (theme === "dark") expect(await page.evaluate(`getComputedStyle(document.querySelector('.transcript-compaction__details')).transitionDuration`)).toBe("0s")
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
        const text = await page.evaluate(`document.querySelector('[data-message-id="cmp_live"]')?.textContent ?? document.querySelector('[data-message-id="msg_compact"]')?.textContent ?? ''`)
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
      const text = await page.evaluate(`document.querySelector('[data-message-id="cmp_live"]')?.textContent ?? ''`)
      expect(text).toContain("Compression #4 (~600 tokens removed, 60% reduction)")
      expect(text).toContain("~2k tokens saved total")
      await page.evaluate(`window.compactionFail()`)
      expect(await page.evaluate(`document.querySelector('.transcript-compaction__label')?.textContent ?? ''`)).toBe("~ compaction cancelled")
      expect(await page.evaluate(`document.querySelector('[data-message-id="cmp_live"]')?.textContent ?? ''`)).not.toContain("tokens saved total")
    } finally { await page.close() }
  })

  test("keeps an oversized message in place while loading and offers retry after failure", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?oversized=1`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_big"]')`); i++) await Bun.sleep(50)
      expect(await page.evaluate(`document.querySelector('[data-message-id="msg_big"]')?.textContent ?? ''`)).toContain("Loading content")
      await page.evaluate(`document.querySelector('#fail-oversized').click()`)
      expect(await page.evaluate(`document.querySelector('[data-message-id="msg_big"]')?.textContent ?? ''`)).toContain("Content too large or unavailable")
      await page.evaluate(`document.querySelector('[data-message-id="msg_big"] button').click()`)
      expect(await page.evaluate(`document.querySelector('[data-message-id="msg_big"]')?.textContent ?? ''`)).toContain("Recovered full content")
    } finally { await page.close() }
  })
  test("shows an admitted oversized input as pending without a misleading retry", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?oversized=pending`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_big"]')`); i++) await Bun.sleep(50)
      const pending = await page.evaluate(`(() => { const row = document.querySelector('[data-message-id="msg_big"]'); return { text: row?.textContent ?? '', retry: Boolean(row?.querySelector('button')) } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, text: (decodeString)(record["text"]), retry: (decodeBoolean)(record["retry"]) } })
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
        const before = await page.evaluate(`document.querySelector('[data-message-id="prompt_6"]').getBoundingClientRect().top`, decodeNumber)
        for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.transcript-navigation__beginning')`); i++) await Bun.sleep(25)
        const after = await page.evaluate(`(() => ({ top: document.querySelector('[data-message-id="prompt_6"]').getBoundingClientRect().top, marker: Boolean(document.querySelector('.transcript-navigation__beginning')) }))()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), marker: (decodeBoolean)(record["marker"]) } })
        expect(Math.abs(after.top - before)).toBeLessThanOrEqual(2)
        expect(after.marker).toBe(true)
        await page.evaluate(`document.querySelector('[aria-label="Jump to top"]').click()`)
        for (let i = 0; i < 60 && await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop`, decodeNumber) > 8; i++) await Bun.sleep(20)
        expect(await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop`)).toBeLessThanOrEqual(8)
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
        for (let i = 0; i < 40 && !await page.evaluate(`Boolean(document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img')?.complete)`); i++) await Bun.sleep(25)
        const images = await page.evaluate(`(() => { const img = document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img'); const user = document.querySelector('[data-message-id="msg_image"] .transcript-image img'); const box = img?.getBoundingClientRect(); return { lazy: img?.loading === 'lazy', alt: img?.alt ?? '', bounded: Boolean(box && box.width <= innerWidth && box.height <= 400), chip: Boolean(document.querySelector('.transcript-file')), loaded: Boolean(img?.complete && img.naturalWidth > 0), userLoaded: Boolean(user?.complete && user.naturalWidth > 0) } })()`)
        expect(images).toEqual({ lazy: true, alt: "plot.png", bounded: true, chip: true, loaded: true, userLoaded: true })
        await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image').click()`)
        for (let i = 0; i < 30 && !await page.evaluate(`document.querySelector('.transcript-lightbox[open]')`); i++) await Bun.sleep(20)
        await page.evaluate(`Promise.all([...document.querySelector('.transcript-lightbox .overlay__surface').getAnimations()].map(animation => animation.finished))`)
        const dialog = await page.evaluate(`(() => { const d = document.querySelector('.transcript-lightbox'); const box = d.querySelector('.overlay__surface').getBoundingClientRect(); return { open: Boolean(d?.open), focused: Boolean(d?.contains(document.activeElement)), contained: box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1, sticky: getComputedStyle(d.querySelector('.overlay__head')).position === 'sticky', reduced: getComputedStyle(d.querySelector('.overlay__surface')).animationName === 'none' } })()`)
        expect(dialog).toEqual({ open: true, focused: true, contained: true, sticky: false, reduced: theme === "dark" })
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate(`document.querySelector('.transcript-lightbox')?.contains(document.activeElement) ?? false`)).toBe(true)
        await Bun.write(new URL(`../../../.cache/tmp/transcript-images-${theme}-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.evaluate(`document.querySelector('.transcript-lightbox').click()`)
        for (let i = 0; i < 20 && await page.evaluate(`Boolean(document.querySelector('.transcript-lightbox[open]'))`, decodeBoolean); i++) await Bun.sleep(20)
        expect(await page.evaluate(`document.querySelector('.transcript-lightbox[open]') === null`)).toBe(true)
        await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image').click()`)
        for (let i = 0; i < 20 && !await page.evaluate(`Boolean(document.querySelector('.transcript-lightbox[open]'))`); i++) await Bun.sleep(20)
        await page.pressEscape()
        for (let i = 0; i < 20 && await page.evaluate(`document.querySelector('.transcript-lightbox[open]')`); i++) await Bun.sleep(20)
        expect(await page.evaluate(`document.querySelector('.transcript-lightbox[open]') === null`)).toBe(true)
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
        for (let i = 0; i < 40 && !await page.evaluate(`Boolean(document.querySelector('[data-message-id="msg_tool_image"] .transcript-image[aria-label="Open image tall.png"] img')?.complete)`); i++) await Bun.sleep(25)
        await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image[aria-label="Open image tall.png"]').click()`)
        for (let i = 0; i < 30 && !await page.evaluate(`Boolean(document.querySelector('.transcript-lightbox[open] .overlay__body img')?.complete)`); i++) await Bun.sleep(20)
        await page.evaluate(`Promise.all([...document.querySelector('.transcript-lightbox .overlay__surface').getAnimations()].map(animation => animation.finished))`)
        const layout = await page.evaluate(`(() => {
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
        for (let i = 0; i < 60 && !await page.evaluate(`['msg_image', 'msg_image_only'].every((id) => document.querySelector('[data-message-id="' + id + '"] .transcript-image img')?.complete) && Boolean(document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable'))`); i++) await Bun.sleep(25)
        const layout = await page.evaluate(`(() => {
          const thumbnails = ['msg_image', 'msg_image_only'].map((id) => {
            const message = document.querySelector('[data-message-id="' + id + '"]').getBoundingClientRect()
            const frame = document.querySelector('[data-message-id="' + id + '"] .transcript-attachment .transcript-image').getBoundingClientRect()
            const image = document.querySelector('[data-message-id="' + id + '"] .transcript-image img').getBoundingClientRect()
            const bubble = document.querySelector('[data-message-id="' + id + '"] .transcript-message__bubble').getBoundingClientRect()
            return { width: Math.round(frame.width), ratio: Math.round(frame.width / frame.height * 100) / 100, painted: image.width >= 80 && image.height >= 50, insideBubble: frame.left >= bubble.left - 1 && frame.right <= bubble.right + 1,
              inside: frame.left >= message.left - 1 && frame.right <= message.right + 1 && frame.right <= innerWidth }
          })
          return { thumbnails, unavailableWidth: Math.round(document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable').getBoundingClientRect().width),
            imageOnlyTexts: document.querySelectorAll('[data-message-id="msg_image_only"] .transcript-message__bubble-text').length,
            imageOnlyBubbles: document.querySelectorAll('[data-message-id="msg_image_only"] .transcript-message__bubble').length,
            textBubbles: document.querySelectorAll('[data-message-id="msg_image"] .transcript-message__bubble').length }
        })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, thumbnails: (decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, width: (decodeNumber)(record["width"]), ratio: (decodeNumber)(record["ratio"]), painted: (decodeBoolean)(record["painted"]), inside: (decodeBoolean)(record["inside"]), insideBubble: (decodeBoolean)(record["insideBubble"]) } }))(record["thumbnails"]), unavailableWidth: (decodeNumber)(record["unavailableWidth"]), imageOnlyTexts: (decodeNumber)(record["imageOnlyTexts"]), imageOnlyBubbles: (decodeNumber)(record["imageOnlyBubbles"]), textBubbles: (decodeNumber)(record["textBubbles"]) } })
        for (const thumbnail of layout.thumbnails) {
          expect(thumbnail.width).toBe(80)
          expect(thumbnail.ratio).toBeCloseTo(10 / 7, 1)
          expect(thumbnail).toMatchObject({ painted: true, inside: true, insideBubble: true })
        }
        expect(layout.unavailableWidth).toBeGreaterThanOrEqual(160)
        expect({ imageOnlyTexts: layout.imageOnlyTexts, imageOnlyBubbles: layout.imageOnlyBubbles, textBubbles: layout.textBubbles }).toEqual({ imageOnlyTexts: 0, imageOnlyBubbles: 1, textBubbles: 1 })
      }
    } finally { await page.close() }
  })

  test("keeps loaded user and tool images mounted through streaming, reconciliation, older history, and reconnect", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]] as const) {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?images=1&theme=${theme}`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-tool__toggle') !== null`); i++) await Bun.sleep(50)
        await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-tool__toggle').click()`)
        for (let i = 0; i < 60 && !await page.evaluate(`[...document.querySelectorAll('[data-message-id="msg_image"] .transcript-image img, [data-message-id="msg_tool_image"] .transcript-image img')].length === 2 && [...document.querySelectorAll('[data-message-id="msg_image"] .transcript-image img, [data-message-id="msg_tool_image"] .transcript-image img')].every((img) => img.complete && img.naturalWidth > 0)`); i++) await Bun.sleep(50)
        expect(await page.evaluate(`window.imageFetchCount()`)).toBe(1)
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
        expect(await page.evaluate(`window.imageProbe()`)).toEqual({ sameUser: true, sameTool: true, sameUserRow: true, sameUserContainer: true, sameToolRow: true, sameSources: true, removed: 0, srcChanges: 0, loading: 0, heightChanges: 0, fetches: 1 })
      }
    } finally { await page.close() }
  }, 30_000)

  test("recovers a changed tool image source after an invalid image without resetting unchanged images", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?images=1`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-tool__toggle') !== null`); i++) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-tool__toggle').click()`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img')?.naturalWidth > 0`); i++) await Bun.sleep(50)
      await page.evaluate(`window.imageUpdate('corrupt-tool')`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image__unavailable') !== null`); i++) await Bun.sleep(50)
      expect(await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image__unavailable') !== null`)).toBe(true)
      await page.evaluate(`window.imageUpdate('repair-tool')`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img')?.naturalWidth > 0`); i++) await Bun.sleep(50)
      expect(await page.evaluate(`document.querySelector('[data-message-id="msg_tool_image"] .transcript-image img')?.naturalWidth > 0`)).toBe(true)
    } finally { await page.close() }
  })

  test("offers retry when a managed user image cannot load", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?images=1`)
      for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable')`); i++) await Bun.sleep(25)
      expect(await page.evaluate(`document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable')?.textContent ?? ''`)).toContain("Image unavailable")
      await page.evaluate(`document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable button').click()`)
      for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable')`); i++) await Bun.sleep(25)
      expect(await page.evaluate(`Boolean(document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable button'))`)).toBe(true)
    } finally { await page.close() }
  })
  test("omits internal observations and Project lifecycle cards while keeping visible cards and prompt ticks in order", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?visibility=1`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('[data-message-id="msg_follow_up"]')`); i++) await Bun.sleep(50)
      const state = await page.evaluate(`(() => ({
        ids: [...document.querySelectorAll('.transcript-navigation__item')].map(row => row.dataset.messageId),
        cards: [...document.querySelectorAll('.project-event')].map(card => [card.dataset.event, card.querySelector('strong').textContent]),
        ticks: [...document.querySelectorAll('.transcript-navigation__tick')].filter(tick => tick.getBoundingClientRect().width > 0).map(tick => tick.getAttribute('aria-label')),
        raw: document.body.innerText.includes('TeamView ·') || document.body.innerText.includes('Session state ·'),
      }))()`)
      expect(state).toEqual({
        ids: ["msg_ordinary", "msg_notification", "msg_project_1", "msg_project_4", "msg_follow_up"],
        cards: [["completed", "Fixture worker"], ["failed", "Fixture worker"]],
        ticks: ["Go to prompt: Check the repair", "Go to prompt: Review the result"],
        raw: false,
      })
    } finally { await page.close() }
  }, 20_000)

  test("keeps five labeled accessible destinations in one phone navigation row", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const width of [320, 360, 390, 430]) {
        await page.setViewport(width, 844)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=${theme}`)
        for (let i = 0; i < 300 && await page.evaluate(`document.querySelectorAll('.bottom-nav__item').length`, decodeNumber) < 5; i++) await Bun.sleep(50)
        const nav = await page.evaluate(`(() => { const items = [...document.querySelectorAll('.bottom-nav__item')]; return { tops: items.map(item => item.getBoundingClientRect().top), minHeight: Math.min(...items.map(item => item.getBoundingClientRect().height)), names: items.map(item => item.getAttribute('aria-label')), labelsHidden: items.every(item => { const label = item.querySelector('.bottom-nav__label'); return label instanceof HTMLElement && getComputedStyle(label).display === 'none' }), overflow: document.documentElement.scrollWidth > innerWidth } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, tops: (decodeArray(decodeNumber))(record["tops"]), minHeight: (decodeNumber)(record["minHeight"]), names: (decodeArray(decodeString))(record["names"]), labelsHidden: (decodeBoolean)(record["labelsHidden"]), overflow: (decodeBoolean)(record["overflow"]) } })
        expect(new Set(nav.tops).size).toBe(1)
        expect(nav.minHeight).toBeGreaterThanOrEqual(44)
        expect(nav.names.map((name) => name.replace(", waiting for your decision", ""))).toEqual(["Projects", "Sessions", "Workspaces", "Usage", "Settings"])
        expect(nav.labelsHidden).toBe(false)
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
          const geometry = await page.evaluate(`(() => { const dialog = document.querySelector('.overlay[open]'); const surface = dialog.querySelector('.overlay__surface'); const rect = surface.getBoundingClientRect(); return { top: rect.top, headerBottom: document.querySelector('.app-header').getBoundingClientRect().bottom, bottom: rect.bottom, width: rect.width, animation: getComputedStyle(surface).animationName, focused: dialog.contains(document.activeElement) } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), headerBottom: (decodeNumber)(record["headerBottom"]), bottom: (decodeNumber)(record["bottom"]), width: (decodeNumber)(record["width"]), animation: (decodeString)(record["animation"]), focused: (decodeBoolean)(record["focused"]) } })
          expect(geometry.top).toBeGreaterThan(geometry.headerBottom)
          expect(geometry.bottom).toBeCloseTo(height!, 0)
          expect(geometry.width).toBeCloseTo(width!, 0)
          expect(geometry.animation).toBe("yc-sheet-in")
          expect(geometry.focused).toBe(true)
          await Bun.write(new URL(`../../../.cache/tmp/sessions-sheet-${theme}-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
          await page.pressEscape()
          for (let i = 0; i < 20 && await page.evaluate(`document.querySelector('.overlay[open]') !== null`, decodeBoolean); i++) await Bun.sleep(20)
          expect(await page.evaluate(`document.querySelector('.overlay[open]') === null`)).toBe(true)
        }
      }
      await page.setReducedMotion(true)
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=dark`)
      for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.app-header__menu')`); i++) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.app-header__menu').click()`)
      for (let i = 0; i < 30 && !await page.evaluate(`document.querySelector('.overlay[open]')`); i++) await Bun.sleep(20)
      expect(await page.evaluate(`getComputedStyle(document.querySelector('.overlay__surface')).animationName`)).toBe("none")
    } finally { await page.close() }
  }, 45_000)

  test("places active Sessions at full page width above the workspace heading", async () => {
    const page = await browser!.openPage()
    try {
      for (const width of [390, 1440]) {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&theme=light`)
        for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.sessions-page__toolbar')`); i++) await Bun.sleep(50)
        const result = await page.evaluate(`(() => { const section = document.querySelector('.running-sessions'); const card = section?.querySelector('.running-sessions__item'); const page = document.querySelector('.sessions-page').getBoundingClientRect(); return { cards: section?.querySelectorAll('.running-sessions__item').length ?? 0, left: section?.getBoundingClientRect().left ?? 0, right: section?.getBoundingClientRect().right ?? 0, pageLeft: page.left, pageRight: page.right, top: card?.getBoundingClientRect().top ?? 0, headingTop: document.querySelector('.sessions-page__title').getBoundingClientRect().top, toolbarTop: document.querySelector('.sessions-page__content .sessions-page__toolbar').getBoundingClientRect().top, filterTop: document.querySelector('.filter-bar').getBoundingClientRect().top } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, cards: (decodeNumber)(record["cards"]), left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]), pageLeft: (decodeNumber)(record["pageLeft"]), pageRight: (decodeNumber)(record["pageRight"]), top: (decodeNumber)(record["top"]), headingTop: (decodeNumber)(record["headingTop"]), toolbarTop: (decodeNumber)(record["toolbarTop"]), filterTop: (decodeNumber)(record["filterTop"]) } })
        expect(result.cards).toBeGreaterThan(0)
        expect(Math.abs(result.left - result.pageLeft)).toBeLessThanOrEqual(1)
        expect(Math.abs(result.right - result.pageRight)).toBeLessThanOrEqual(1)
        expect(result.top).toBeLessThan(result.headingTop)
        expect(result.top).toBeLessThan(result.toolbarTop)
        expect(result.top).toBeLessThan(result.filterTop)
      }
    } finally { await page.close() }
  })



  test("centers Web Conversation prose, composer and jump controls on a 64rem track", async () => {
    const page = await browser!.openPage()
    try {
      for (const width of [1440, 1920]) {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&acceptedPreview=1&theme=light`)
        await page.evaluate(`new Promise((resolve, reject) => { const end = performance.now() + 5000; const frame = () => { if (document.querySelector('.transcript-message__text .transcript-md > p') && document.querySelector('.composer__row')) resolve(true); else if (performance.now() > end) reject(new Error('Conversation prose or composer not mounted')); else requestAnimationFrame(frame); }; frame(); })`)
        const geometry = await page.evaluate(`(() => { const nav = document.querySelector('.transcript-navigation'), root = nav.closest('.workspace__scroll'), box = nav.getBoundingClientRect(), parent = root.getBoundingClientRect(); const left = box.left - parent.left, right = parent.left + root.clientWidth - box.right; const differences = Object.fromEntries(['.composer__row', '.conversation-jump-slot', '.transcript-message__text .transcript-md > p'].map(selector => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return [selector, rect ? [Math.round(rect.left - box.left), Math.round(rect.right - box.right)] : null]; })); const rail = nav.querySelector('.transcript-navigation__rail'); return { width: Math.round(box.width), balanced: Math.abs(left - right) <= 1 && Math.min(left, right) >= 36, differences, railFits: !rail || rail.getBoundingClientRect().right <= parent.left + root.clientWidth, overflow: root.scrollWidth > root.clientWidth }; })()`, decodeRecord)
        expect(geometry).toEqual({ width: 1024, balanced: true, differences: { ".composer__row": [0, 0], ".conversation-jump-slot": [0, 0], ".transcript-message__text .transcript-md > p": [0, 0] }, railFits: true, overflow: false })
      }
    } finally { await page.close() }
  }, 20_000)

  test("places a compact prompt rail to the right with an inward preview", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?navigation=1`)
      for (let i = 0; i < 40 && await page.evaluate(`document.querySelectorAll('.transcript-navigation__tick').length`, decodeNumber) < 12; i++) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.transcript-navigation__tick').focus()`)
      const geometry = await page.evaluate(`(() => { const rail = document.querySelector('.transcript-navigation__rail').getBoundingClientRect(); const tick = document.querySelector('.transcript-navigation__tick').getBoundingClientRect(); const transcript = document.querySelector('.transcript-navigation').getBoundingClientRect(); const preview = document.querySelector('.transcript-navigation__tooltip').getBoundingClientRect(); return { railLeft: rail.left, railWidth: rail.width, tickWidth: tick.width, transcriptRight: transcript.right, previewRight: preview.right, viewport: innerWidth } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, railLeft: (decodeNumber)(record["railLeft"]), railWidth: (decodeNumber)(record["railWidth"]), tickWidth: (decodeNumber)(record["tickWidth"]), transcriptRight: (decodeNumber)(record["transcriptRight"]), previewRight: (decodeNumber)(record["previewRight"]), viewport: (decodeNumber)(record["viewport"]) } })
      expect(geometry.railLeft).toBeGreaterThanOrEqual(geometry.transcriptRight)
      expect(geometry.railWidth).toBeLessThanOrEqual(30)
      expect(geometry.tickWidth).toBe(24)
      expect(geometry.previewRight).toBeLessThanOrEqual(geometry.viewport)
      expect(geometry.previewRight).toBeLessThanOrEqual(geometry.transcriptRight)
      expect(await page.evaluate(`document.querySelector('.transcript-navigation__controls [aria-label="Jump to top"]') !== null && document.querySelector('.transcript-navigation__rail [aria-label^="Jump to"]') === null`)).toBe(true)
      await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 })); root.scrollTop = 0 })()`)
      for (let i = 0; i < 20 && !await page.evaluate(`document.querySelector('.transcript-navigation__controls [aria-label="Jump to latest"]')`); i++) await Bun.sleep(20)
      expect(await page.evaluate(`document.querySelector('.transcript-navigation__controls [aria-label="Jump to latest"]') !== null`)).toBe(true)
    } finally { await page.close() }
  })

  test("keeps user prompt bubbles on the right on phone and tablet", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?navigation=1`)
      for (const [width, height] of [[390, 844], [820, 1180]]) {
        await page.setViewport(width!, height!)
        await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop = 0`)
        const geometry = await page.evaluate(`(() => ({ bubbleRights: [...document.querySelectorAll('.transcript-message--user')].map(row => row.getBoundingClientRect().right), columnRight: document.querySelector('.transcript-navigation').getBoundingClientRect().right }))()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, bubbleRights: (decodeArray(decodeNumber))(record["bubbleRights"]), columnRight: (decodeNumber)(record["columnRight"]) } })
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
        const geometry = await page.evaluate(`(() => ({ bubbleRight: document.querySelector('.transcript-message--user').getBoundingClientRect().right, columnRight: document.querySelector('.transcript-navigation').getBoundingClientRect().right }))()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, bubbleRight: (decodeNumber)(record["bubbleRight"]), columnRight: (decodeNumber)(record["columnRight"]) } })
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
        const geometry = await page.evaluate(`(() => { const row = document.querySelector('.transcript-message--user:has(.transcript-message__receipt[aria-label="Processing prompt"])'); return { processing: document.querySelectorAll('.transcript-message__receipt[aria-label="Processing prompt"]').length, right: row?.getBoundingClientRect().right ?? 0, columnRight: document.querySelector('.transcript-navigation').getBoundingClientRect().right } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, processing: (decodeNumber)(record["processing"]), right: (decodeNumber)(record["right"]), columnRight: (decodeNumber)(record["columnRight"]) } })
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
      const visibility = () => page.evaluate(`(() => { const top = document.querySelector('.transcript-navigation__controls [aria-label="Jump to top"]'); const bottom = document.querySelector('.transcript-navigation__controls [aria-label="Jump to latest"]'); const controls = document.querySelector('.transcript-navigation__controls')?.getBoundingClientRect(); const slot = document.querySelector('.conversation-jump-slot')?.getBoundingClientRect(); const root = document.querySelector('.workspace__scroll')?.getBoundingClientRect(); const todo = document.querySelector('.todo-panel__inner')?.getBoundingClientRect(); const composer = document.querySelector('.composer')?.getBoundingClientRect(); return { top: Boolean(top && getComputedStyle(top).visibility === 'visible'), bottom: Boolean(bottom && getComputedStyle(bottom).visibility === 'visible'), clear: Boolean(controls && slot && root && todo && composer && slot.height === 0 && Math.abs(root.bottom - todo.top) <= 1 && controls.top >= root.top && controls.bottom <= root.bottom && controls.bottom <= todo.top - 6 && controls.bottom <= composer.top - 6) } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeBoolean)(record["top"]), bottom: (decodeBoolean)(record["bottom"]), clear: (decodeBoolean)(record["clear"]) } })
      expect(await visibility()).toEqual({ top: true, bottom: false, clear: true })
      await page.evaluate(`const root = document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 })); root.scrollTop = root.scrollHeight / 2`)
      for (let i = 0; i < 20 && !(await visibility()).bottom; i++) await Bun.sleep(20)
      expect(await visibility()).toEqual({ top: true, bottom: true, clear: true })
      await page.evaluate(`document.querySelector('.transcript-navigation__controls [aria-label="Jump to top"]').click()`)
      for (let i = 0; i < 80 && await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop`, decodeNumber) > 8; i++) await Bun.sleep(20)
      for (let i = 0; i < 20 && (await visibility()).top; i++) await Bun.sleep(20)
      expect(await visibility()).toEqual({ top: false, bottom: true, clear: true })
      await page.evaluate(`document.querySelector('.transcript-navigation__controls [aria-label="Jump to latest"]').click()`)
      for (let i = 0; i < 80 && await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); return root.scrollHeight - root.clientHeight - root.scrollTop })()`, decodeNumber) > 2; i++) await Bun.sleep(20)
      expect(await visibility()).toEqual({ top: true, bottom: false, clear: true })
    } finally { await page.close() }
  })

  test("keeps the jump control above the full composer mount and selector row", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=light`)
      for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.mini-composer__mount .composer__mobile-trigger') && document.querySelector('.transcript-navigation__controls')`); i++) await Bun.sleep(50)
      await page.evaluate(`(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture = document.querySelector('.fixture'); fixture.style.height = '100dvh'; fixture.style.minHeight = '0'; fixture.style.overflow = 'hidden' })()`)
      await page.evaluate(`(() => { document.querySelector('.conversation-pane').style.minHeight = '2600px'; const root = document.querySelector('.workspace__scroll'); root.scrollTop = 900; root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 })); root.scrollTop = 300 })()`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-navigation__controls--visible') !== null`); i++) await Bun.sleep(25)
      expect(await page.evaluate(`document.querySelector('.transcript-navigation__controls--visible') !== null`)).toBe(true)
      await page.evaluate(`new Promise(resolve => setTimeout(resolve, 0)).then(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))))`)
      const geometry = await page.evaluate(`(() => { const controls = document.querySelector('.transcript-navigation__controls').getBoundingClientRect(); const mount = document.querySelector('.mini-composer__mount').getBoundingClientRect(); const selector = document.querySelector('.composer__mobile-trigger').getBoundingClientRect(); const todo = document.querySelector('.todo-panel__inner')?.getBoundingClientRect(); return { controlBottom: controls.bottom, mountTop: mount.top, selectorTop: selector.top, selectorBottom: selector.bottom, todoTop: todo?.top } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, controlBottom: (decodeNumber)(record["controlBottom"]), mountTop: (decodeNumber)(record["mountTop"]), selectorTop: (decodeNumber)(record["selectorTop"]), selectorBottom: (decodeNumber)(record["selectorBottom"]), ...("todoTop" in record ? { todoTop: (decodeOptional(decodeNumber))(record["todoTop"]) } : {}) } })
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
      const summary = await page.evaluate(`(() => ({ text: document.querySelector('[data-message-id="msg_notification"]')?.textContent ?? '', bubbles: document.querySelectorAll('.transcript-message--user .transcript-message__bubble').length, raw: document.body.innerText.includes('{"source":"subagent_notification"') }))()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, text: (decodeString)(record["text"]), bubbles: (decodeNumber)(record["bubbles"]), raw: (decodeBoolean)(record["raw"]) } })
      expect(summary.text).toContain("ses_child")
      expect(summary.text).toContain("completed")
      expect(summary.raw).toBe(false)
      expect(summary.bubbles).toBe(1)
      const toggle = `document.querySelector('[data-message-id="msg_notification"] button[aria-expanded="false"][aria-controls]')`
      expect(await page.evaluate(`!!${toggle}?.querySelector('svg')`, decodeBoolean)).toBe(true)
      await page.evaluate(`${toggle}.focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      expect(await page.evaluate(`document.querySelector('[data-message-id="msg_notification"]')?.textContent ?? ''`)).toContain("Tests pass and the repair is verified.")
      if (process.env.YCODING_WEB_CAPTURE_DIR) await Bun.write(`${process.env.YCODING_WEB_CAPTURE_DIR}/transcript-notification-light-390x844.png`, Buffer.from(await page.screenshot(), "base64"))
    } finally { await page.close() }
  })

  test("mounts navigation in the real Conversation shell scroll column", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=light`)
      for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('.app--conversation.app--selected .transcript-navigation')`); i++) await Bun.sleep(50)
      await Bun.sleep(250)
      const result = await page.evaluate(`(() => { const nav = document.querySelector('.app--conversation.app--selected .transcript-navigation'); const root = nav?.closest('.workspace__scroll'); const main = nav?.closest('.workspace__main'); const slot = main?.querySelector('.conversation-jump-slot'); return { scroll: Boolean(root), railControls: Boolean(nav?.querySelector('.transcript-navigation__rail [aria-label^="Jump to"]')), controlsInSlot: Boolean(slot?.querySelector('.transcript-navigation__controls')), slotHeight: slot?.getBoundingClientRect().height, slotAligned: Math.abs((slot?.getBoundingClientRect().left ?? -99) - document.querySelector('.composer__row').getBoundingClientRect().left) <= 1 && Math.abs((slot?.getBoundingClientRect().right ?? -99) - document.querySelector('.composer__row').getBoundingClientRect().right) <= 1, overflow: document.documentElement.scrollWidth > innerWidth } })()`)
      expect(result).toEqual({ scroll: true, railControls: false, controlsInSlot: true, slotHeight: 0, slotAligned: true, overflow: false })
    } finally { await page.close() }
  })

  test("shows one activity indicator on the active row and none on the assistant header", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?running=1`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-tool')`); i++) await Bun.sleep(50)
      expect(await page.evaluate(`document.querySelectorAll('.transcript-tool .transcript-dot-trail').length`)).toBe(1)
      expect(await page.evaluate(`document.querySelectorAll('.transcript-message__agent .transcript-dot-trail').length`)).toBe(0)
    } finally { await page.close() }
  })

  test("animates a tool disclosure closed without losing its accessible state", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-tool__toggle')`); i++) await Bun.sleep(50)
      const states = await page.evaluate(`(async () => {
        const toggle = document.querySelector('.transcript-tool__toggle');
        const panel = document.querySelector('.transcript-tool__body');
        const id = toggle.getAttribute('aria-controls');
        const label = toggle.textContent;
        const state = () => ({
          expanded: toggle.getAttribute('aria-expanded'),
          inert: panel.inert,
          ariaHidden: panel.getAttribute('aria-hidden'),
          height: panel.getBoundingClientRect().height,
        });
        toggle.focus({ preventScroll: true });
        toggle.click();
        await Promise.all(panel.getAnimations().map(animation => animation.finished));
        const opened = state();
        toggle.click();
        const closing = state();
        const animations = panel.getAnimations();
        const transitions = animations.map(animation => animation.transitionProperty).sort();
        await Promise.all(animations.map(animation => animation.finished));
        return {
          opened: { ...opened, height: opened.height > 0 },
          closing: { ...closing, height: closing.height > 0 },
          transitions,
          closed: state(),
          controlRetained: document.querySelector('.transcript-tool__toggle') === toggle &&
            document.activeElement === toggle && !toggle.disabled && label.trim() !== '' && toggle.textContent === label,
          relationshipRetained: Boolean(id) && toggle.getAttribute('aria-controls') === id && document.getElementById(id) === panel,
        };
      })()`)
      expect(states).toEqual({
        opened: { expanded: "true", inert: false, ariaHidden: null, height: true },
        closing: { expanded: "false", inert: true, ariaHidden: "true", height: true },
        transitions: ["grid-template-rows", "opacity"],
        closed: { expanded: "false", inert: true, ariaHidden: "true", height: 0 },
        controlRetained: true,
        relationshipRetained: true,
      })
    } finally { await page.close() }
  })

  test("follows a streaming tail until the reader scrolls away, then offers jump and prompt ticks", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?navigation=1`)
      expect(await page.evaluate(`document.querySelector('.transcript-navigation') !== null`)).toBe(true)
      const atEnd = () => page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); return root.scrollHeight - root.clientHeight - root.scrollTop })()`, decodeNumber)
      const controls = () => page.evaluate(`(() => ({ top: Boolean(document.querySelector('.transcript-navigation__controls [aria-label="Jump to top"]')), bottom: Boolean(document.querySelector('.transcript-navigation__controls [aria-label="Jump to latest"]')) }))()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeBoolean)(record["top"]), bottom: (decodeBoolean)(record["bottom"]) } })
      expect(await atEnd()).toBeLessThanOrEqual(2)
      expect(await controls()).toEqual({ top: true, bottom: false })
      await page.evaluate(`document.querySelector('#append').click()`)
      for (let i = 0; i < 10 && await atEnd() > 2; i++) await Bun.sleep(20)
      expect(await atEnd()).toBeLessThanOrEqual(2)
      await page.evaluate(`document.querySelector('.workspace__scroll').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 })); document.querySelector('.workspace__scroll').scrollTop = 0`)
      expect(await atEnd()).toBeGreaterThan(48)
      for (let i = 0; i < 100; i++) {
        const state = await controls()
        if (!state.top && state.bottom) break
        await Bun.sleep(20)
      }
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
      expect(await page.evaluate(`document.querySelectorAll('.transcript-navigation__tick').length`)).toBe(12)
      await page.evaluate(`document.querySelector('.transcript-navigation__tick').focus()`)
      expect(await page.evaluate(`document.querySelector('.transcript-navigation__tooltip')?.textContent ?? ''`)).toContain("Prompt 1")
      await page.evaluate(`document.querySelector('.transcript-navigation__tick').click()`)
      expect(await page.evaluate(`document.activeElement?.dataset.messageId === 'prompt_0'`)).toBe(true)
      for (let i = 0; i < 30 && await atEnd() <= 48; i++) await Bun.sleep(20)
      expect(await atEnd()).toBeGreaterThan(48)
    } finally { await page.close() }
  })

  test("keeps a followed tail after retention pruning and starts a newly opened transcript at the end", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?navigation=1`)
      for (let i = 0; i < 40 && await page.evaluate(`document.querySelectorAll('.transcript-navigation__tick').length`, decodeNumber) < 12; i++) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('#prune').click()`)
      for (let i = 0; i < 20 && await page.evaluate(`document.querySelectorAll('.transcript-navigation__tick').length`) !== 6; i++) await Bun.sleep(20)
      expect(await page.evaluate(`document.querySelectorAll('.transcript-navigation__tick').length`)).toBe(6)
      expect(await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); return root.scrollHeight - root.clientHeight - root.scrollTop })()`)).toBeLessThanOrEqual(2)
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?navigation=1`)
      for (let i = 0; i < 40 && await page.evaluate(`document.querySelectorAll('.transcript-navigation__tick').length`, decodeNumber) < 12; i++) await Bun.sleep(50)
      expect(await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); return root.scrollHeight - root.clientHeight - root.scrollTop })()`)).toBeLessThanOrEqual(2)
    } finally { await page.close() }
  })

  test("large synthetic transcripts mount a bounded window and a completed boundary keeps its divider reachable", async () => {
    if (!browser) throw new Error("Browser not started")
    const counts: { readonly messages: number; readonly nodes: number; readonly reasoningBodies: number; readonly compactions: number; readonly height: number }[] = []
    for (const synthetic of ["full", "compacted"]) {
      const page = await browser.openPage()
      try {
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?synthetic=${synthetic}`)
        for (let i = 0; i < 80 && await page.evaluate(`document.querySelectorAll('.transcript-message').length`) === 0; i++) await Bun.sleep(50)
        for (let i = 0; i < 80 && !await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); return root.scrollHeight - root.clientHeight - root.scrollTop <= 2 })()`); i++) await Bun.sleep(50)
        const mounted = await page.evaluate(`({ messages: document.querySelectorAll('.transcript-message').length, nodes: document.querySelectorAll('*').length, reasoningBodies: document.querySelectorAll('.transcript-reasoning__body').length, height: document.querySelector('.transcript').getBoundingClientRect().height })`, (value: unknown) => { const record = decodeRecord(value); return { ...record, messages: (decodeNumber)(record["messages"]), nodes: (decodeNumber)(record["nodes"]), reasoningBodies: (decodeNumber)(record["reasoningBodies"]), height: (decodeNumber)(record["height"]) } })
        await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -300 })); root.scrollTop = 0 })()`)
        for (let i = 0; i < 80 && !await page.evaluate(`document.querySelector('[data-message-id="msg_0"], .transcript-compaction') !== null`); i++) await Bun.sleep(25)
        counts.push({ ...mounted, compactions: await page.evaluate(`document.querySelectorAll('.transcript-compaction').length`, decodeNumber) })
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
      expect(await page.evaluate(`document.querySelectorAll('.transcript-reasoning').length`)).toBe(1)
      expect(await page.evaluate(`document.querySelector('.transcript-reasoning summary').textContent`)).toContain("Thought · 2s")
      expect(await page.evaluate(`document.querySelectorAll('.transcript-reasoning__body').length`)).toBe(0)
      await page.evaluate(`document.querySelector('.transcript-reasoning summary').focus()`)
      expect(await page.evaluate(`document.activeElement === document.querySelector('.transcript-reasoning summary')`)).toBe(true)
      await page.pressKey(" ", "Space", 32)
      expect(await page.evaluate(`document.querySelector('.transcript-reasoning').open`)).toBe(true)
      for (let i = 0; i < 20 && !await page.evaluate(`document.querySelector('.transcript-reasoning strong') !== null`); i++) await Bun.sleep(20)
      const result = await page.evaluate(`({ bold: document.querySelector('.transcript-reasoning strong')?.textContent ?? '', code: document.querySelector('.transcript-reasoning code')?.textContent ?? '', literal: document.querySelector('.transcript-reasoning').textContent.includes('**'), unsafe: document.querySelectorAll('.transcript-reasoning img').length, answer: document.querySelector('.transcript-message--assistant .transcript-message__text')?.textContent ?? '' })`, (value: unknown) => { const record = decodeRecord(value); return { ...record, bold: (decodeString)(record["bold"]), code: (decodeString)(record["code"]), literal: (decodeBoolean)(record["literal"]), unsafe: (decodeNumber)(record["unsafe"]), answer: (decodeString)(record["answer"]) } })
      expect(result).toMatchObject({ bold: "Important", code: "code", literal: false, unsafe: 0 })
      expect(result.answer).toContain("Final answer")
      await page.evaluate(`document.querySelector('.transcript-reasoning').dataset.identity = 'retained'; document.querySelector('#stream').click()`)
      expect(await page.evaluate(`({ open: document.querySelector('.transcript-reasoning').open, retained: document.querySelector('.transcript-reasoning').dataset.identity === 'retained', streamed: document.querySelector('.transcript-reasoning__body')?.textContent.includes('Streamed detail') ?? false })`)).toEqual({ open: true, retained: true, streamed: true })
      await page.pressKey(" ", "Space", 32)
      expect(await page.evaluate(`document.querySelector('.transcript-reasoning summary').getAttribute('aria-expanded') === 'false' && document.querySelector('.transcript-reasoning__body') !== null`)).toBe(true)
      for (let i = 0; i < 20 && await page.evaluate(`document.querySelector('.transcript-reasoning__body') !== null`, decodeBoolean); i++) await Bun.sleep(20)
      expect(await page.evaluate(`document.querySelectorAll('.transcript-reasoning__body').length`)).toBe(0)
    } finally { await page.close() }
  })

  test("assistant prose fills the column and a pending prompt keeps a static receipt while the session runs", async () => {
    const page = await browser!.openPage()
    try {
      for (const [width, height] of [[390, 844], [1440, 900]] as const) {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?status=running`)
        for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-message--assistant .transcript-md p')`); i++) await Bun.sleep(50)
        const geometry = await page.evaluate(`(() => { const md = document.querySelector('.transcript-message--assistant .transcript-md').getBoundingClientRect(); const receipt = document.querySelector('.transcript-message--user .transcript-message__receipt'); return { paragraph: document.querySelector('.transcript-message--assistant .transcript-md p').getBoundingClientRect().width, list: document.querySelector('.transcript-message--assistant .transcript-md ul').getBoundingClientRect().width, quote: document.querySelector('.transcript-message--assistant .transcript-md blockquote').getBoundingClientRect().width, heading: document.querySelector('.transcript-message--assistant .transcript-md__heading').getBoundingClientRect().width, column: md.width, user: document.querySelector('.transcript-message--user').getBoundingClientRect().width, receipt: receipt?.getAttribute('aria-label') ?? '', role: receipt?.getAttribute('role') ?? '', animation: receipt ? getComputedStyle(receipt).animationName : '' } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, paragraph: (decodeNumber)(record["paragraph"]), list: (decodeNumber)(record["list"]), quote: (decodeNumber)(record["quote"]), heading: (decodeNumber)(record["heading"]), column: (decodeNumber)(record["column"]), user: (decodeNumber)(record["user"]), receipt: (decodeString)(record["receipt"]), role: (decodeString)(record["role"]), animation: (decodeString)(record["animation"]) } })
        expect(Math.abs(geometry.paragraph - geometry.column)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.list - geometry.column)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.quote - geometry.column)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.heading - geometry.column)).toBeLessThanOrEqual(1)
        expect(geometry.user).toBeLessThan(geometry.column)
        expect(geometry.receipt).toBe("Queued for processing")
        expect(geometry.role).toBe("status")
        expect(geometry.animation).toBe("none")
      }
      await page.setReducedMotion(true)
      await page.evaluate(`document.querySelector('#admit').click()`)
      expect(await page.evaluate(`document.querySelector('.transcript-message__receipt')?.getAttribute('aria-label') ?? ''`)).toBe("Processing prompt")
      expect(await page.evaluate(`document.querySelector('.transcript-message__receipt')?.textContent ?? ''`)).toContain("Processing")
      expect(await page.evaluate(`getComputedStyle(document.querySelector('.transcript-message__receipt')).animationName`)).toBe("none")
      await page.evaluate(`document.querySelector('#consume').click()`)
      expect(await page.evaluate(`document.querySelector('.transcript-message__receipt')?.getAttribute('aria-label') ?? ''`)).toBe("Processing prompt")
    } finally { await page.close() }
  })

  test("places user on the right, YCoding on the left with bounded mobile bubbles and actual read state", async () => {
    if (!browser) throw new Error("Browser not started")
    const page = await browser.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-message--user') !== null`); i++) await Bun.sleep(50)
      const inspect = () => page.evaluate(`(() => { const user = document.querySelector('.transcript-message--user'); const assistant = document.querySelector('.transcript-message--assistant'); const u = user.getBoundingClientRect(); const a = assistant.getBoundingClientRect(); const p = document.querySelector('.transcript').getBoundingClientRect(); return { user: u.right, assistant: a.left, parentLeft: p.left, parentRight: p.right, width: u.width, overflow: document.documentElement.scrollWidth > innerWidth, receipt: user.querySelector('.transcript-message__receipt')?.textContent?.trim() ?? '', identity: assistant.querySelector('.transcript-message__agent')?.textContent?.trim() ?? '', bubble: user.querySelector('.transcript-message__bubble')?.textContent ?? '', outside: user.querySelector('.transcript-message__receipt').getBoundingClientRect().top >= user.querySelector('.transcript-message__bubble').getBoundingClientRect().bottom, inHead: user.querySelector('.transcript-message__head') !== null } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, user: (decodeNumber)(record["user"]), assistant: (decodeNumber)(record["assistant"]), parentLeft: (decodeNumber)(record["parentLeft"]), parentRight: (decodeNumber)(record["parentRight"]), width: (decodeNumber)(record["width"]), overflow: (decodeBoolean)(record["overflow"]), receipt: (decodeString)(record["receipt"]), identity: (decodeString)(record["identity"]), bubble: (decodeString)(record["bubble"]), outside: (decodeBoolean)(record["outside"]), inHead: (decodeBoolean)(record["inHead"]) } })
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
      expect(pending.inHead).toBe(false)
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
      const result = await page.evaluate(`(() => ({ unsafe: document.querySelectorAll('.transcript-md script, .transcript-md img, .transcript-md a[href^="javascript:"], .transcript-md a[href^="data:"]').length, table: document.querySelectorAll('.transcript-md table').length, code: document.querySelectorAll('.transcript-md__code').length, imageLinks: [...document.querySelectorAll('.transcript-md a')].filter(a => a.textContent === 'No image').length, rawHTML: document.querySelector('.transcript-md').textContent.includes('<script>alert(1)</script>'), structures: ['ol','ul ul','input[type=checkbox]','blockquote','hr','del'].every(selector => document.querySelector('.transcript-md ' + selector)), taskLabel: document.querySelector('.transcript-md li:has(input[type=checkbox])')?.textContent ?? '', observation: document.querySelector('.transcript-message__observation summary')?.textContent ?? '', error: document.querySelector('.transcript-tool__error')?.textContent ?? '', footer: document.querySelector('.transcript-message__footer')?.textContent ?? '' }))()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, unsafe: (decodeNumber)(record["unsafe"]), table: (decodeNumber)(record["table"]), code: (decodeNumber)(record["code"]), imageLinks: (decodeNumber)(record["imageLinks"]), rawHTML: (decodeBoolean)(record["rawHTML"]), structures: (decodeBoolean)(record["structures"]), taskLabel: (decodeString)(record["taskLabel"]), observation: (decodeString)(record["observation"]), error: (decodeString)(record["error"]), footer: (decodeString)(record["footer"]) } })
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
          const metrics = await page.evaluate(`(() => { const controls = document.querySelector('.transcript-navigation__controls').getBoundingClientRect(); const slot = document.querySelector('.conversation-jump-slot').getBoundingClientRect(); const todo = document.querySelector('.todo-panel__inner').getBoundingClientRect(); const composer = document.querySelector('.transcript-fixture__composer').getBoundingClientRect(); const rail = document.querySelector('.transcript-navigation__rail'); const tick = rail.querySelector('.transcript-navigation__tick').getBoundingClientRect(); const root = document.querySelector('.workspace__scroll').getBoundingClientRect(); const transcript = document.querySelector('.transcript-navigation').getBoundingClientRect(); return { overflow: document.documentElement.scrollWidth > innerWidth, controlHeight: controls.height, controlClear: slot.height === 0 && controls.bottom <= todo.top - 6 && controls.bottom <= composer.top - 6 && controls.right <= transcript.right + 1 && controls.left >= transcript.left, railVisible: getComputedStyle(rail).display !== 'none', tickClear: tick.width > 0 && tick.left >= transcript.right && tick.right <= root.right, aligned: Math.abs(todo.left - transcript.left) <= 1 && Math.abs(todo.right - transcript.right) <= 1 && Math.abs(composer.left - transcript.left) <= 1 && Math.abs(composer.right - transcript.right) <= 1 } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, overflow: (decodeBoolean)(record["overflow"]), controlHeight: (decodeNumber)(record["controlHeight"]), controlClear: (decodeBoolean)(record["controlClear"]), railVisible: (decodeBoolean)(record["railVisible"]), tickClear: (decodeBoolean)(record["tickClear"]), aligned: (decodeBoolean)(record["aligned"]) } })
          expect(metrics.overflow).toBe(false)
          expect(metrics.aligned).toBe(true)
          expect(metrics.controlClear).toBe(true)
          expect(metrics.railVisible).toBe(width! >= 1024)
          if (width! >= 1024) expect(metrics.tickClear).toBe(true)
          expect(metrics.controlHeight).toBeGreaterThanOrEqual(36)
          await Bun.write(new URL(`../../../.cache/tmp/transcript-navigation-${theme}-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
          await page.evaluate(`document.querySelector('.workspace__scroll').scrollTop = document.querySelector('.workspace__scroll').scrollHeight`)
          await Bun.sleep(100)
          expect(await page.evaluate(`(() => { const controls = document.querySelector('.transcript-navigation__controls').getBoundingClientRect(); const last = [...document.querySelectorAll('.transcript-navigation__item')].at(-1).getBoundingClientRect(); return controls.width > 0 && last.bottom <= controls.top })()`), `${width}x${height} last content stays above the jump control`).toBe(true)
          await Bun.write(new URL(`../../../.cache/tmp/transcript-navigation-${theme}-${width}x${height}-bottom.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        }
      }
      await page.setViewport(1024, 768)
      await page.setCoarsePointer(true)
      const coarse = await page.evaluate(`({ height: document.querySelector('.transcript-navigation__controls button').getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth })`, (value: unknown) => { const record = decodeRecord(value); return { ...record, height: (decodeNumber)(record["height"]), overflow: (decodeBoolean)(record["overflow"]) } })
      expect(coarse.height).toBeGreaterThanOrEqual(44)
      expect(coarse.overflow).toBe(false)
    } finally { await page.close() }
  }, 60_000)
})
