import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { launchBrowser } from "./cdp"

const port = 4387
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
  await mkdir(new URL("../../../.cache/tmp/", import.meta.url), { recursive: true })
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("status stays inside a fixed-height composer and pending picks survive unrelated updates", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(390, 620)
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Agent"]') !== null`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Agent"]')?.click()`)
    await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
    await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.includes('architect'))?.click()`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    await wait(page, `document.querySelector('[role="slider"]') !== null`)
    await page.evaluate(`document.querySelector('[role="slider"]')?.focus()`)
    await page.pressKey("Home", "Home", 36)
    await page.evaluate(`document.querySelector('button[aria-label="Close model picker"]')?.click()`)
    const idle = await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect().height`)
    expect(idle).toBeLessThanOrEqual(160)
    for (const status of ["running", "waiting", "goal", "goal-yolo", "yolo", "idle"]) {
      await page.evaluate(`window.composerSetStatus(${JSON.stringify(status)})`)
      expect(await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect().height`)).toBe(idle)
      expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount button[aria-label="Agent"]')?.textContent`)).toContain("architect")
      expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.textContent`)).toContain("low")
      expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount button[aria-label="Agent"]')?.getAttribute('aria-description')`)).toBe("applies with your next send")
      expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.getAttribute('aria-description')`)).toBe("applies with your next send")
      expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount .session-status') !== null`)).toBe(true)
    }
    await page.evaluate(`window.composerSetStatus('goal')`)
    await page.evaluate(`document.querySelector('.mini-composer__mount .session-status__goal-trigger')?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .session-status__goal-popover')?.textContent`)).toContain("Finish task")
    await page.evaluate(`document.querySelector('.mini-composer__mount .session-status__goal-popover button')?.click()`)
    expect(await page.evaluate<string>(`window.composerRequests().at(-1)?.operation`)).toBe("session.goal.stop")
  } finally { await page.close() }
}, 30_000)

test("brand and repository actions replace the visible new-session heading", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.new-session-composer__brand') !== null`)
    expect(await page.evaluate<string>(`document.querySelector('.new-session-composer__brand')?.textContent`)).toContain("YCoding")
    expect(await page.evaluate<boolean>(`getComputedStyle(document.querySelector('.new-session-composer h2')).position === 'absolute'`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('.new-session-composer button[aria-label="Refresh repositories"] svg') !== null`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("full skill list scrolls to the last skill without unrelated updates snapping it back", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount textarea') !== null`)
    await type(page, ".mini-composer__mount textarea", "$")
    await wait(page, `document.querySelectorAll('.mini-composer__mount .mini-composer__autocomplete button').length === 65`)
    await page.evaluate(`(() => { const list = document.querySelector('.mini-composer__mount .mini-composer__autocomplete'); list.scrollTop = list.scrollHeight; })()`)
    const before = await page.evaluate<number>(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete').scrollTop`)
    expect(before).toBeGreaterThan(0)
    await page.evaluate(`window.composerSetStatus('running')`)
    expect(await page.evaluate<number>(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete').scrollTop`)).toBe(before)
    expect(await page.evaluate<boolean>(`(() => { const list = document.querySelector('.mini-composer__mount .mini-composer__autocomplete'); const last = [...list.querySelectorAll('button')].at(-1); return last?.textContent?.includes('skill-62') && last.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom })()`)).toBe(true)
    await page.evaluate(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete button:last-of-type')?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount textarea')?.value`)).toBe("$skill-62 ")
  } finally { await page.close() }
}, 30_000)

test("model effort supports keyboard and pointer changes and reset to the catalog default", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Model"]') !== null`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    await wait(page, `document.querySelector('[role="slider"]') !== null`)
    await page.evaluate(`document.querySelector('[role="slider"]')?.focus()`)
    await page.pressKey("Home", "Home", 36)
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("low")
    await page.evaluate(`(() => { const slider = document.querySelector('[role="slider"]'); const rect = slider.getBoundingClientRect(); slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: rect.right - 1, clientY: rect.top + 4 })); })()`)
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("high")
    await page.evaluate(`document.querySelector('button[aria-label="Reset reasoning effort"]')?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("high")
  } finally { await page.close() }
}, 30_000)

test("model search supports Enter, Escape back, and models without effort variants", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Model"]') !== null`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    await page.evaluate(`document.querySelector('.model-control__switch')?.click()`)
    await wait(page, `document.querySelector('input[aria-label="Search models"]') !== null`)
    await type(page, "input[aria-label='Search models']", "Claude")
    await page.pressKey("Enter", "Enter", 13)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.textContent`)).toContain("Claude Opus 5.5")
    await page.evaluate(`document.querySelector('.model-control__switch')?.click()`)
    await wait(page, `document.activeElement?.getAttribute('aria-label') === 'Search models'`)
    await page.pressEscape()
    expect(await page.evaluate<boolean>(`document.querySelector('[role="slider"]') !== null`)).toBe(true)
    await page.pressEscape()
    expect(await page.evaluate<boolean>(`document.querySelector('.model-control__surface') === null`)).toBe(true)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    await page.evaluate(`document.querySelector('.model-control__switch')?.click()`)
    await type(page, "input[aria-label='Search models']", "Lite")
    await page.pressKey("Enter", "Enter", 13)
    expect(await page.evaluate<boolean>(`document.querySelector('.model-control__surface') === null`)).toBe(true)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    expect(await page.evaluate<boolean>(`document.querySelector('[role="slider"]') === null && document.querySelector('input[aria-label="Search models"]') !== null`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("paste, picker and drop add removable file chips and send exact file inputs", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(390, 844)
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount textarea') !== null`)
    await page.evaluate(`(() => { const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlFiZkAAAAASUVORK5CYII='), value => value.charCodeAt(0)); const file = new File([bytes], 'capture.png', { type: 'image/png' }); const transfer = new DataTransfer(); transfer.items.add(file); document.querySelector('.mini-composer__mount textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); })()`)
    await wait(page, `document.querySelectorAll('.mini-composer__mount .composer__attachment').length === 1`)
    expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount .composer__attachment img') !== null`)).toBe(true)
    await wait(page, `document.querySelector('.mini-composer__mount .composer__attachment img')?.complete === true`)
    expect(await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__attachment img')?.naturalWidth`)).toBe(1)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__attachment')?.textContent`)).toContain("B")
    await page.evaluate(`(() => { const input = document.querySelector('.mini-composer__mount input[type=file]'); const click = input.click.bind(input); input.click = () => { window.pickerOpened = true }; document.querySelector('.mini-composer__mount button[aria-label="Attach files"]').click(); input.click = click; const transfer = new DataTransfer(); transfer.items.add(new File(['file content'], 'notes.txt', { type: 'text/plain' })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    expect(await page.evaluate<boolean>(`window.pickerOpened === true`)).toBe(true)
    await wait(page, `document.querySelectorAll('.mini-composer__mount .composer__attachment').length === 2`)
    await page.evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['drop content'], 'drop.txt', { type: 'text/plain' })); document.querySelector('.mini-composer__mount .composer__row').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); })()`)
    await wait(page, `document.querySelectorAll('.mini-composer__mount .composer__attachment').length === 3`)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__attachment')?.textContent`)).toContain("capture.png")
    expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
    await Bun.write(new URL(`../../../.cache/tmp/composer-attached-390-light.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Remove notes.txt"]')?.click()`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.mini-composer__mount .composer__attachment').length`)).toBe(2)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]')?.click()`)
    await wait(page, `window.composerRequests().some(item => item.operation === 'session.prompt')`)
    expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)?.input`)).toMatchObject({ text: "", files: [{ name: "capture.png", uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlFiZkAAAAASUVORK5CYII=" }, { name: "drop.txt" }] })
    expect(await page.evaluate<number>(`document.querySelectorAll('.mini-composer__mount .composer__attachment').length`)).toBe(0)
  } finally { await page.close() }
}, 30_000)

test("plain text paste remains native and oversized clipboard files fail visibly before submission", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount textarea') !== null`)
    expect(await page.evaluate<boolean>(`(() => { const transfer = new DataTransfer(); transfer.setData('text/plain', 'plain words'); const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }); document.querySelector('.mini-composer__mount textarea').dispatchEvent(event); return event.defaultPrevented })()`)).toBe(false)
    await page.evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'too-large.png', { type: 'image/png' })); document.querySelector('.mini-composer__mount textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); })()`)
    await wait(page, `document.querySelector('.mini-composer__mount .composer__attachment-error') !== null`)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__attachment-error')?.textContent`)).toContain("20 MiB")
    expect(await page.evaluate<number>(`document.querySelectorAll('.mini-composer__mount .composer__attachment').length`)).toBe(0)
    expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]')?.disabled`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("upload progress is visible and cancelling stops it without removing the attachment", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount textarea') !== null`)
    await page.evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['content'], 'capture.png', { type: 'image/png' })); document.querySelector('.mini-composer__mount textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); })()`)
    await wait(page, `document.querySelector('.mini-composer__mount .composer__attachment') !== null`)
    await page.evaluate(`window.composerSetUpload(37)`)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__upload')?.textContent`)).toContain("37%")
    await page.evaluate(`document.querySelector('.mini-composer__mount .composer__upload button')?.click()`)
    expect(await page.evaluate<string>(`window.composerRequests().at(-1)?.operation`)).toBe("upload.cancel")
    expect(await page.evaluate<number>(`document.querySelectorAll('.mini-composer__mount .composer__attachment').length`)).toBe(1)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__attachment-error')?.textContent`)).toContain("cancelled")
  } finally { await page.close() }
}, 30_000)

test("coarse pointer restores 44px composer and repository targets", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1024, 768)
    await page.setCoarsePointer(true)
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Agent"]') !== null`)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.composer__controls button, .new-session-composer__repository button')].every(button => button.getBoundingClientRect().height >= 44)`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("composer states and effort surface retain layout at four sizes in both themes", async () => {
  for (const [width, height] of [[390, 844], [820, 1180], [1024, 768], [1440, 900]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Model"]:not([disabled])') !== null`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await Bun.sleep(600)
      const idle = await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect().height`)
      for (const state of ["idle", "running", "waiting", "goal"]) {
      await page.evaluate(`window.composerSetStatus(${JSON.stringify(state)})`)
      if (state === "waiting") expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount .session-status__slot')?.classList.contains('session-status__slot--attention')`)).toBe(true)
      expect(await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect().height`)).toBe(idle)
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
      expect(await page.evaluate<boolean>(`(() => { const row = document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect(); return [...document.querySelectorAll('.mini-composer__mount .composer__controls button, .mini-composer__mount .session-status__slot')].filter(item => getComputedStyle(item).display !== 'none' && getComputedStyle(item).visibility !== 'hidden').every(item => { const rect = item.getBoundingClientRect(); return rect.left >= row.left - 1 && rect.right <= row.right + 1 }) })()`)).toBe(true)
      const overlaps = await page.evaluate<string[]>(`(() => { const controls = [...document.querySelectorAll('.mini-composer__mount .composer__controls button, .mini-composer__mount .session-status__slot')].filter(item => getComputedStyle(item).display !== 'none' && getComputedStyle(item).visibility !== 'hidden'); return controls.flatMap((a, index) => controls.slice(index + 1).flatMap(b => { const x = a.getBoundingClientRect(), y = b.getBoundingClientRect(); return x.right <= y.left || y.right <= x.left || x.bottom <= y.top || y.bottom <= x.top ? [] : [a.className + ' / ' + b.className] })) })()`)
      expect(overlaps).toEqual([])
      await Bun.sleep(240)
      await Bun.write(new URL(`../../../.cache/tmp/composer-${state}-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      }
      await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
      await wait(page, `document.querySelector('.model-control__surface') !== null`)
      await Bun.write(new URL(`../../../.cache/tmp/composer-effort-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    } finally { await page.close() }
  }
}, 90_000)

test("keyboard and mouse autocomplete, pending identity, and creation work across four sizes and themes", async () => {
  for (const [width, height] of [[390, 844], [820, 1180], [1024, 768], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
        await wait(page, `document.querySelectorAll('.composer textarea').length === 2`)
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
        const input = ".mini-composer__mount textarea"
        for (const [trigger, choice, expected] of [["/pla", "/plan", "/plan "], ["@rev", "@reviewer", "@reviewer "], ["$aud", "$audit", "$audit "], ["#rev", "Reviewer", "@reviewer "]] as const) {
          await type(page, input, trigger)
          await wait(page, `document.querySelector('.mini-composer__mount .mini-composer__autocomplete button')?.textContent?.includes(${JSON.stringify(choice)}) === true`)
          if (trigger === "/pla" || trigger === "$aud") await page.pressKey("Enter", "Enter", 13)
          else await page.evaluate(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete button')?.click()`)
          expect(await page.evaluate<string>(`document.querySelector(${JSON.stringify(input)})?.value`)).toBe(expected)
        }
        await type(page, input, "@apps/web")
        await wait(page, `document.querySelector('.mini-composer__mount .mini-composer__autocomplete')?.textContent?.includes('composer.tsx') === true`)
        await page.evaluate(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete button')?.click()`)
        expect(await page.evaluate<string>(`document.querySelector(${JSON.stringify(input)})?.value`)).toContain("composer.tsx")
        await type(page, input, "@")
        await wait(page, `document.querySelectorAll('.mini-composer__mount .mini-composer__autocomplete button small').length >= 2`)
        const suggestionLayout = await page.evaluate<{ starts: number[]; lines: number[] }>(`(() => { const items = [...document.querySelectorAll('.mini-composer__mount .mini-composer__autocomplete button small')].filter(item => item.textContent.trim()); return { starts: items.map(item => item.getBoundingClientRect().left), lines: items.map(item => Math.round(item.getBoundingClientRect().height / parseFloat(getComputedStyle(item).lineHeight))) } })()`)
        expect(new Set(suggestionLayout.starts).size).toBe(1)
        expect(suggestionLayout.lines.every((lines) => lines === 1)).toBe(true)
        if (width === 390 && theme === "light") {
          await type(page, input, "@slow")
          await Bun.sleep(250)
          await type(page, input, "@apps")
          await wait(page, `document.querySelector('.mini-composer__mount .mini-composer__autocomplete')?.textContent?.includes('composer.tsx') === true`)
          await Bun.sleep(420)
          expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete')?.textContent?.includes('slow.txt') ?? false`)).toBe(false)
        }
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Agent"]')?.click()`)
        await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].map(item => item.textContent.trim())`)).toEqual(["GSD", "architect"])
        expect(await page.evaluate<boolean>(`document.querySelector('.mini-picker__surface')?.classList.contains('mini-picker__surface--sheet')`)).toBe(width! < 768)
        await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.includes('architect'))?.click()`)
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
        await wait(page, `document.querySelector('.model-control__switch') !== null`)
        await page.evaluate(`document.querySelector('.model-control__switch')?.click()`)
        await wait(page, `document.querySelector('.mini-picker__search') !== null`)
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.mini-picker__group')].map(item => item.textContent.trim())`)).toEqual(["Anthropic", "OpenAI"])
        await page.evaluate(`(() => { const field = document.querySelector('.mini-picker__search'); field.value = 'Claude'; field.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
        await page.evaluate(`document.querySelector('.model-control__surface [role="option"]')?.click()`)
        await wait(page, `document.querySelector('[role="slider"][aria-label="Reasoning effort"]') !== null`)
        await page.evaluate(`document.querySelector('[role="slider"][aria-label="Reasoning effort"]')?.focus()`)
        await page.pressKey("End", "End", 35)
        expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("max")
        await page.evaluate(`document.querySelector('.model-control__heading-actions button[aria-label="Close model picker"]')?.click()`)
        await type(page, input, "Review $audit")
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]')?.click()`)
        expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)?.input`)).toMatchObject({ text: "Review $audit", skills: ["audit"], agent: "architect", model: { id: "claude-opus-5-5", variant: "max" } })
        await type(page, input, "/plan now")
        await page.evaluate(`document.querySelector('.mini-composer__mount .composer__delivery-toggle')?.click()`)
        await page.pressKey("Enter", "Enter", 13)
        expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)`)).toMatchObject({ operation: "session.command", input: { command: "plan", arguments: "now", delivery: "queue", agent: "architect", model: { variant: "max" } } })
        await page.evaluate(`document.querySelector('main > button')?.click()`)
        await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Interrupt the running step"]') !== null`)
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Interrupt the running step"]')?.click()`)
        expect(await page.evaluate<string>(`window.composerRequests().at(-1)?.operation`)).toBe("session.interrupt")
        await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Repository"]')?.click()`)
        await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
        await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.includes('Other repository'))?.click()`)
        await type(page, ".new-session-composer textarea", "Use @apps/web")
        await wait(page, `document.querySelector('.new-session-composer .mini-composer__autocomplete')?.textContent?.includes('composer.tsx') === true`)
        await page.evaluate(`document.querySelector('.new-session-composer .mini-composer__autocomplete button')?.click()`)
        await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]')?.click()`)
        await wait(page, `document.querySelector('output')?.textContent?.includes('ses_created') === true`)
        expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)?.input`)).toMatchObject({ workspaceID: "work_two", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "max" }, prompt: { text: "Use @apps/web/src/remote/ui/composer.tsx", files: [{ uri: "file:///workspace/ycoding/apps/web/src/remote/ui/composer.tsx", mention: { start: 4, text: "@apps/web/src/remote/ui/composer.tsx" } }] } })
        const layout = await page.evaluate<{ overflow: boolean; controlsInside: boolean; touchTargets: boolean }>(`(() => { const rows = [...document.querySelectorAll('.composer__row')]; const controls = [...document.querySelectorAll('.composer__controls button')]; return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, controlsInside: rows.every(row => [...row.querySelectorAll('.composer__controls button')].every(button => button.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1)), touchTargets: controls.every(button => button.getBoundingClientRect().width >= 44 && button.getBoundingClientRect().height >= 44) }; })()`)
        expect(layout.overflow).toBe(false)
        expect(layout.controlsInside).toBe(true)
        if (width! < 768) expect(layout.touchTargets).toBe(true)
        await Bun.write(new URL(`../../../.cache/tmp/composer-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      } finally { await page.close() }
    }
  }
}, 180_000)

async function type(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, selector: string, text: string) {
  await page.evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus(); field.value = ${JSON.stringify(text)}; field.setSelectionRange(field.value.length, field.value.length); field.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
}
async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}`)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/composer-fixture.html`).then((response) => response.ok, () => false) }
