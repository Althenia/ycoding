import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { launchBrowser, decodeArray, decodeBoolean, decodeNumber, decodeRecord, decodeString, type Page } from "./cdp"

const port = 4593
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
const origin = `http://127.0.0.1:${port}`
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const longText = "The quick brown fox jumps over the lazy dog while the composer keeps its exact height. ".repeat(3)

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 100 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
}, 30_000)
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

async function ready() { return fetch(`${origin}/verify/remote.html`).then((response) => response.ok, () => false) }
async function wait(page: Page, expression: string) {
  for (let count = 0; count < 200; count++) {
    if (await page.evaluate(expression)) return
    await Bun.sleep(50)
  }
  throw new Error(`Condition did not settle: ${expression}`)
}
const point = async (page: Page, selector: string) => decodeRecord(await page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`))
async function click(page: Page, selector: string) {
  const at = await point(page, selector)
  const x = decodeNumber(at["x"])
  const y = decodeNumber(at["y"])
  await page.mouse("mouseMoved", x, y)
  await page.mouse("mousePressed", x, y)
  await page.mouse("mouseReleased", x, y)
}
async function type(page: Page, text: string) {
  for (const character of text) await page.pressKey(character, "Key", character.charCodeAt(0), character)
}
const greenDominant = (color: string) => {
  const [red, green, blue] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  return green! > red! && green! > blue!
}
const luminance = (color: string) => {
  const [red, green, blue] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((value) => Number(value) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
}
const contrast = (first: string, second: string) => {
  const [high, low] = [luminance(first), luminance(second)].sort((left, right) => right - left)
  return (high! + 0.05) / (low! + 0.05)
}
const composerFixture = (query = "") => `${origin}/verify/composer-fixture.html${query}`
const shell = (query = "") => `${origin}/verify/remote.html?view=chat&team=two&acceptedPreview=1${query}`
const captureActions = async (page: Page, name: string) => {
  const output = process.env.YCODING_MESSAGE_ACTION_CAPTURE_DIR
  if (output) await Bun.write(join(output, name + ".png"), Buffer.from(await page.screenshot(), "base64"))
}
const attachPng = (name: string, type: string, via: "paste" | "input") => `(() => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(png)}), (character) => character.charCodeAt(0))
  const data = new DataTransfer()
  data.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }))
  if (${JSON.stringify(via)} === "paste") document.querySelector('.mini-composer__mount .composer__input').dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
  else { const input = document.querySelector('.mini-composer__mount .composer__file-input'); input.files = data.files; input.dispatchEvent(new Event("change", { bubbles: true })) }
})()`

describe("composer", () => {
  test("composer toolbar fits one row and keeps its draft and keyboard actions when controls overflow", async () => {
    const page = await browser!.openPage()
    const scope = `.composer-resident:not([inert])`
    const field = `document.querySelector('${scope} textarea')`
    const toggle = `document.querySelector('${scope} button[aria-label="More composer controls"]')`
    const row = `(() => { const bar = document.querySelector('${scope} .composer__controls'), send = bar.querySelector('.mini-composer__send'), s = send.getBoundingClientRect(), b = bar.getBoundingClientRect(); const buttons = [...bar.querySelectorAll('button')].filter(e => e.checkVisibility() && !e.closest('[inert]')); return buttons.length >= 3 && buttons.every(e => { const r = e.getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - s.top - s.height / 2) < 1 && r.left >= b.left && r.right <= b.right + 1 }) && Math.abs(s.right - b.right) < 1 && document.elementFromPoint(s.x + s.width / 2, s.y + s.height / 2)?.closest('button') === send; })()`
    try {
      await page.setViewport(1440, 900)
      await page.navigate(shell())
      await wait(page, `${field} && !${field}.disabled`)
      await click(page, `${scope} textarea`)
      await type(page, "Synthetic toolbar draft")
      await page.evaluate(`${field}.setSelectionRange(2, 7); window.toolbarField = ${field}`)
      expect(await page.evaluate(row)).toBe(true)
      await page.setCoarsePointer(true)
      await page.setViewport(390, 844)
      await wait(page, `${toggle}?.checkVisibility()`)
      expect(await page.evaluate(row)).toBe(true)
      expect(await page.evaluate(`${field} === window.toolbarField && ${field}.selectionStart === 2 && ${field}.selectionEnd === 7 && document.activeElement === ${field}`)).toBe(true)
      await page.evaluate(`${toggle}.focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      await wait(page, `${toggle}.getAttribute('aria-expanded') === 'true'`)
      expect(await page.evaluate(`(() => { const t = ${toggle}, p = document.getElementById(t.getAttribute('aria-controls')), r = p.getBoundingClientRect(), b = t.getBoundingClientRect(); return t.getAttribute('aria-haspopup') === 'dialog' && p.contains(document.activeElement) && b.width >= 44 && b.height >= 44 && r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= b.top; })()`)).toBe(true)
      const first = await page.evaluate(`document.activeElement.textContent`)
      await page.pressKey("ArrowDown", "ArrowDown", 40)
      expect(await page.evaluate(`document.activeElement.textContent`)).not.toEqual(first)
      await page.pressKey("Tab", "Tab", 9)
      await page.pressEscape()
      expect(await page.evaluate(`document.activeElement === ${toggle} && ${toggle}.getAttribute('aria-expanded') === 'false'`)).toBe(true)
      await page.setCoarsePointer(false)
      await page.setViewport(1440, 900)
      await wait(page, `!${toggle}.checkVisibility()`)
      expect(await page.evaluate(row)).toBe(true)
      expect(await page.evaluate(`${field} === window.toolbarField && ${field}.value === 'Synthetic toolbar draft' && ${field}.selectionStart === 2 && ${field}.selectionEnd === 7`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("typing and pasting long text never changes the composer height, wraps or reflows the transcript", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(shell())
      await wait(page, `document.querySelector('.composer-resident .composer__input') !== null`)
      await click(page, ".composer-resident .composer__input")
      await page.evaluate(`(() => {
        const input = document.querySelector('.composer-resident .composer__input'), main = document.querySelector('.workspace__main'), row = document.querySelector('.composer-resident .composer')
        window.__frames = []; window.__reserveEvents = 0
        window.addEventListener('ycoding:composer-reserve', () => window.__reserveEvents++)
        const tick = () => { window.__frames.push([input.getBoundingClientRect().height, row.getBoundingClientRect().height, row.getBoundingClientRect().top, getComputedStyle(main).getPropertyValue('--yc-composer-reserve')]); requestAnimationFrame(tick) }
        tick()
      })()`)
      await type(page, longText)
      const typedGrowth = decodeNumber(await page.evaluate(`(() => { const input = document.querySelector('.composer-resident .composer__input'); return input.scrollHeight - input.clientHeight })()`))
      await page.evaluate(`document.execCommand('insertText', false, ${JSON.stringify("pasted line one\npasted line two\npasted line three\npasted line four")})`)
      await Bun.sleep(300)
      const state = decodeRecord(await page.evaluate(`(() => {
        const input = document.querySelector('.composer-resident .composer__input'), style = getComputedStyle(input)
        const distinct = (index) => [...new Set(window.__frames.map((frame) => frame[index]))]
        return { inputHeights: distinct(0), composerHeights: distinct(1), tops: distinct(2).map(Math.round), reserves: distinct(3), reserveEvents: window.__reserveEvents, length: input.value.length, whiteSpace: style.whiteSpace, fieldSizing: style.fieldSizing, resize: style.resize, scrollGrowth: input.scrollHeight - input.clientHeight, frames: window.__frames.length }
      })()`))
      expect(decodeNumber(state["length"])).toBeGreaterThan(200)
      expect(decodeArray(decodeNumber)(state["inputHeights"])).toHaveLength(1)
      expect(decodeArray(decodeNumber)(state["composerHeights"])).toHaveLength(1)
      expect(decodeArray(decodeNumber)(state["tops"])).toHaveLength(1)
      expect(decodeArray(decodeString)(state["reserves"])).toHaveLength(1)
      expect(decodeNumber(state["reserveEvents"])).toBe(0)
      expect(decodeString(state["whiteSpace"])).toBe("pre")
      expect(decodeString(state["fieldSizing"])).toBe("fixed")
      expect(decodeString(state["resize"])).toBe("none")
      expect(typedGrowth).toBeLessThanOrEqual(1)
      expect(decodeNumber(state["frames"])).toBeGreaterThan(10)
    } finally { await page.close() }
  }, 60_000)

  test("the composer sits at the viewport bottom inset with no status strip, no status text and no bottom status bar", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(shell())
      await wait(page, `document.querySelector('.composer-resident .composer__input') !== null`)
      const state = decodeRecord(await page.evaluate(`(() => {
        const composer = document.querySelector('.composer-resident .composer'), dock = composer.querySelector('.composer__dock'), app = document.querySelector('.app')
        return { gap: innerHeight - composer.querySelector('.composer__row').getBoundingClientRect().bottom, inset: parseFloat(getComputedStyle(composer).paddingBottom), dockHeight: dock ? dock.getBoundingClientRect().height : 0, statusBar: document.querySelector('.status-bar, [data-item="connection"], [data-item="running"]') !== null, bodyHasBar: /Shared backend|Hide list/.test(document.body.innerText), text: composer.innerText, appBottom: app.getBoundingClientRect().bottom, rows: getComputedStyle(app).gridTemplateRows.split(' ').length }
      })()`))
      expect(Math.abs(decodeNumber(state["gap"]) - decodeNumber(state["inset"]))).toBeLessThanOrEqual(1)
      expect(decodeNumber(state["dockHeight"])).toBe(0)
      expect(decodeBoolean(state["statusBar"])).toBe(false)
      expect(decodeBoolean(state["bodyHasBar"])).toBe(false)
      expect(decodeString(state["text"])).not.toMatch(/Sending…|Working/)
      expect(decodeNumber(state["appBottom"])).toBeLessThanOrEqual(900)
      expect(decodeNumber(state["rows"])).toBe(2)
    } finally { await page.close() }
  }, 30_000)

  test("a disabled sending composer keeps the same field styling and composer height", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(composerFixture())
      await wait(page, `document.querySelector('.mini-composer__mount .composer__input') !== null && typeof window.composerPredictionEnabled === 'function'`)
      const measure = `(() => { const input = document.querySelector('.mini-composer__mount .composer__input'), style = getComputedStyle(input), card = document.querySelector('.mini-composer__mount .composer'); return { disabled: input.disabled, background: style.backgroundColor, border: style.borderTopWidth + style.borderTopStyle, padding: style.padding, lineHeight: style.lineHeight, height: input.getBoundingClientRect().height, composer: card.getBoundingClientRect().height, color: style.color, shadow: style.boxShadow } })()`
      const enabled = decodeRecord(await page.evaluate(measure))
      await page.evaluate(`window.composerPredictionEnabled(false)`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer__input').disabled`)
      const disabled = decodeRecord(await page.evaluate(measure))
      for (const key of ["background", "border", "padding", "lineHeight", "height", "composer", "color", "shadow"]) expect(disabled[key], key).toEqual(enabled[key])
      expect(decodeString(disabled["background"])).toBe("rgba(0, 0, 0, 0)")
    } finally { await page.close() }
  }, 30_000)

  test("a pasted or attached screenshot renders a real thumbnail in the tray and in the sent timeline message", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(composerFixture("?echo=1"))
      await wait(page, `document.querySelector('.mini-composer__mount .composer__input') !== null`)
      await page.evaluate(attachPng("image.png", "image/png", "paste"))
      await wait(page, `document.querySelectorAll('.mini-composer__mount .composer__attachment img').length === 1`)
      await page.evaluate(attachPng("clip.png", "", "input"))
      await wait(page, `document.querySelectorAll('.mini-composer__mount .composer__attachment img').length === 2`)
      await page.evaluate(`(() => { const data = new DataTransfer(); data.items.add(new File(['text'], 'notes.txt', { type: 'text/plain' })); const input = document.querySelector('.mini-composer__mount .composer__file-input'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      await wait(page, `document.querySelectorAll('.mini-composer__mount .composer__attachment').length === 3`)
      expect(await page.evaluate(`getComputedStyle(document.querySelector('.mini-composer__mount .composer__attachments')).alignItems`)).toBe("center")
      expect(await page.evaluate(`(() => { const boxes = [...document.querySelectorAll('.mini-composer__mount .composer__attachment')].map((item) => item.getBoundingClientRect()); return boxes.every((box) => Math.abs(box.top + box.height / 2 - boxes[0].top - boxes[0].height / 2) < 1) })()`)).toBe(true)
      await click(page, '.mini-composer__mount .composer__attachment button[aria-label="Remove notes.txt"]')
      const tray = decodeRecord(await page.evaluate(`(() => { const images = [...document.querySelectorAll('.mini-composer__mount .composer__attachment img')]; return { complete: images.map((image) => image.complete), natural: images.map((image) => image.naturalWidth), alts: images.map((image) => image.alt), widths: images.map((image) => Math.round(image.getBoundingClientRect().width)), fit: getComputedStyle(images[0]).objectFit, remove: [...document.querySelectorAll('.mini-composer__mount .composer__attachment button')].map((button) => button.getAttribute('aria-label')), mimes: window.composerRequests().length } })()`))
      expect(decodeArray(decodeBoolean)(tray["complete"])).toEqual([true, true])
      expect(decodeArray(decodeNumber)(tray["natural"]).every((width) => width > 0)).toBe(true)
      expect(decodeArray(decodeString)(tray["alts"])).toEqual(["image.png preview", "clip.png preview"])
      expect(decodeArray(decodeNumber)(tray["widths"])).toEqual([40, 40])
      expect(decodeString(tray["fit"])).toBe("cover")
      expect(decodeArray(decodeString)(tray["remove"])).toEqual(["Remove image.png", "Remove clip.png"])
      await page.evaluate(`window.composerSetDraft('ses_fixture', 'Look at these')`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer__input').value === 'Look at these'`)
      await click(page, ".mini-composer__mount .mini-composer__send")
      await wait(page, `document.querySelectorAll('.transcript-message--user .transcript-message__images img').length === 2`)
      await wait(page, `[...document.querySelectorAll('.transcript-message--user .transcript-message__images img')].every((image) => image.complete && image.naturalWidth > 0)`)
      expect(decodeNumber(await page.evaluate(`document.querySelectorAll('.transcript-message--user .transcript-file').length`))).toBe(0)
      expect(decodeNumber(await page.evaluate(`document.querySelectorAll('.mini-composer__mount .composer__attachment').length`))).toBe(0)
    } finally { await page.close() }
  }, 30_000)

  test("send, composer focus, user bubble, working dots and active Chat pill use the green accent", async () => {
    const page = await browser!.openPage()
    try {
      for (const scheme of ["dark", "light"] as const) {
        await page.setColorScheme(scheme)
        await page.setViewport(1440, 900)
        await page.navigate(composerFixture())
        await wait(page, `document.querySelector('.mini-composer__mount .composer__input') !== null`)
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(scheme)}; window.composerSetStatus('running'); window.composerSetMessages([{ kind: "user", id: "msg_manual", text: "Manual question", state: "consumed", delivery: "steer", created: 1 }])`)
        await wait(page, `document.querySelector('.transcript-message__bubble') !== null`)
        await click(page, ".mini-composer__mount .composer__input")
        const colors = decodeRecord(await page.evaluate(`(() => { const style = (selector, property) => { const node = document.querySelector(selector); return node ? getComputedStyle(node)[property] : '' }; const typing = document.querySelector('.transcript-activity__typing span'); return { send: style('.mini-composer__send', 'backgroundColor'), bubble: style('.transcript-message__bubble', 'backgroundColor'), focus: style('.mini-composer__mount .composer__row', 'borderTopColor'), attach: style('.mini-composer__mount .composer__attach', 'color'), typing: typing ? getComputedStyle(typing).backgroundColor : '' } })()`))
        for (const key of ["send", "bubble", "focus", "attach"]) expect(greenDominant(decodeString(colors[key])), `${scheme} ${key} ${colors[key]}`).toBe(true)
        if (decodeString(colors["typing"]) !== "") expect(greenDominant(decodeString(colors["typing"])), `${scheme} working dots`).toBe(true)
        await page.navigate(shell(`&theme=${scheme}`))
        await wait(page, `document.querySelector('.activity-bar__item[aria-current="page"]') !== null`)
        const pill = decodeRecord(await page.evaluate(`(() => { const active = document.querySelector('.activity-bar__item[aria-current="page"]'); const style = getComputedStyle(active); const inset = getComputedStyle(active, '::before'); return { background: style.backgroundColor, color: style.color, insetWidth: inset.inlineSize, insetColor: inset.backgroundColor } })()`))
        expect(greenDominant(decodeString(pill["background"])), `${scheme} chat pill ${pill["background"]}`).toBe(true)
        expect(greenDominant(decodeString(pill["color"])), `${scheme} chat pill text ${pill["color"]}`).toBe(true)
        expect(pill["insetWidth"]).toBe("2px")
        expect(greenDominant(decodeString(pill["insetColor"])), `${scheme} leading current marker`).toBe(true)
      }
    } finally { await page.close() }
  }, 60_000)

  test("typing /ui: keeps the suggestions open and Enter inserts the namespaced command", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(composerFixture("?ns=1"))
      await wait(page, `document.querySelector('.mini-composer__mount .composer__input') !== null`)
      await click(page, ".mini-composer__mount .composer__input")
      await type(page, "/ui:")
      await wait(page, `document.querySelector('.mini-composer__mount .mini-composer__suggestions') !== null`)
      const labels = decodeArray(decodeString)(await page.evaluate(`[...document.querySelectorAll('.mini-composer__mount .mini-composer__autocomplete [role="option"] span')].map((node) => node.textContent)`))
      expect(labels).toContain("/ui:review")
      expect(labels).toContain("/ui-design")
      await type(page, "rev")
      await page.pressKey("Enter", "Enter", 13)
      await wait(page, `document.querySelector('.mini-composer__mount .composer__input').value === '/ui:review '`)
      await wait(page, `document.querySelector('.mini-composer__mount .mini-composer__suggestions') === null`)
    } finally { await page.close() }
  }, 30_000)

  test("the model picker opens with a tall scrollable list across providers and a green search focus ring", async () => {
    const page = await browser!.openPage()
    try {
      await page.setColorScheme("dark")
      await page.setViewport(1440, 900)
      await page.navigate(composerFixture("?model=many"))
      await wait(page, `document.querySelector('.mini-composer__mount .model-control__trigger') !== null`)
      await click(page, ".mini-composer__mount .model-control__trigger")
      await wait(page, `document.querySelector('.model-control__surface .mini-picker__search') !== null`)
      await page.evaluate(`document.querySelector('.model-control__surface .mini-picker__search').focus()`)
      const picker = decodeRecord(await page.evaluate(`(() => {
        const surface = document.querySelector('.model-control__surface'), list = surface.querySelector('.mini-picker__list'), box = list.getBoundingClientRect(), search = surface.querySelector('.mini-picker__search')
        const visible = (node) => { const rect = node.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom }
        return { listHeight: box.height, width: surface.getBoundingClientRect().width, rows: [...list.querySelectorAll('[role="option"]')].filter(visible).length, groups: [...list.querySelectorAll('.mini-picker__group')].filter(visible).length, ring: getComputedStyle(search).outlineColor, ringStyle: getComputedStyle(search).outlineStyle, overflow: getComputedStyle(list).overflowY, top: surface.getBoundingClientRect().top, bottom: surface.getBoundingClientRect().bottom }
      })()`))
      expect(decodeNumber(picker["listHeight"])).toBeGreaterThanOrEqual(260)
      expect(decodeNumber(picker["width"])).toBeGreaterThanOrEqual(340)
      expect(decodeNumber(picker["width"])).toBeLessThanOrEqual(400)
      expect(decodeNumber(picker["rows"])).toBeGreaterThanOrEqual(6)
      expect(decodeNumber(picker["groups"])).toBeGreaterThanOrEqual(2)
      expect(decodeString(picker["overflow"])).toBe("auto")
      expect(decodeString(picker["ringStyle"])).toBe("solid")
      expect(greenDominant(decodeString(picker["ring"])), decodeString(picker["ring"])).toBe(true)
      expect(decodeNumber(picker["top"])).toBeGreaterThanOrEqual(0)
      expect(decodeNumber(picker["bottom"])).toBeLessThanOrEqual(900)
    } finally { await page.close() }
  }, 30_000)
})

describe("transcript", () => {
  const dotSteer = { kind: "synthetic", id: "msg_dot", description: "Install and verify the pinned MCP", text: "Install and verify the pinned MCP by checking config first.", created: 3 }
  const user = (id: string, text: string, state: string) => ({ kind: "user", id, text, state, delivery: "steer", created: new Date("2026-11-20T10:42:00").getTime() })
  const assistant = { kind: "assistant", id: "msg_assistant", created: 4, completed: 5, parts: [{ kind: "reasoning", ordinal: 0, text: "hidden reasoning" }, { kind: "text", ordinal: 1, text: "First reply paragraph.\n\n**Bold** second paragraph." }] }

  test("Dot-steered bubbles carry the ChatGPT corner badge and no Dot text; manual bubbles carry no badge", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(composerFixture())
      await wait(page, `typeof window.composerSetMessages === 'function' && document.querySelector('.mini-composer__mount .composer__input') !== null`)
      await page.evaluate(`window.composerSetMessages([${JSON.stringify(user("msg_manual", "Manual question", "consumed"))}, ${JSON.stringify(dotSteer)}])`)
      await wait(page, `document.querySelectorAll('.transcript-message__bubble').length === 2`)
      const state = decodeRecord(await page.evaluate(`(() => {
        const bubbles = [...document.querySelectorAll('.transcript-message__bubble')]
        const geometry = (bubble) => { const badge = bubble.querySelector('.transcript-message__origin'); if (!badge) return null; const a = badge.getBoundingClientRect(), b = bubble.getBoundingClientRect(); return { dx: a.left + a.width / 2 - b.left, dy: a.top + a.height / 2 - b.top, label: badge.getAttribute('aria-label'), title: badge.getAttribute('title'), size: a.width, glyph: getComputedStyle(badge.querySelector('.provider-logo__glyph')).getPropertyValue('--provider-logo-mask').toLowerCase().includes('openai') } }
        return { manual: geometry(bubbles[0]), steer: geometry(bubbles[1]), text: document.body.innerText, background: getComputedStyle(document.querySelector('.transcript-message__origin')).backgroundColor }
      })()`))
      expect(state["manual"]).toBeNull()
      const steer = decodeRecord(state["steer"])
      expect(decodeString(steer["label"])).toBe("ChatGPT")
      expect(decodeString(steer["title"])).toBe("Sent via ChatGPT")
      expect(Math.abs(decodeNumber(steer["dx"]))).toBeLessThanOrEqual(8)
      expect(Math.abs(decodeNumber(steer["dy"]))).toBeLessThanOrEqual(8)
      expect(decodeBoolean(steer["glyph"])).toBe(true)
      expect(decodeString(state["text"])).not.toContain("Dot steer")
    } finally { await page.close() }
  }, 30_000)

  test("delivery icons replace the clock time: bouncing dots while sending, a check once sent, a green double check once read", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.setColorScheme("dark")
      await page.navigate(composerFixture())
      await wait(page, `typeof window.composerSetMessages === 'function'`)
      await page.evaluate(`document.documentElement.dataset.theme = 'dark'; window.composerSetMessages([{ kind: "user", id: "msg_fixture", text: "Sending text", state: "pending", delivery: "steer", created: new Date("2026-11-20T10:42:00").getTime() }]); window.composerSetMutation('sending')`)
      await wait(page, `document.querySelector('.delivery-status[data-state="sending"]') !== null`)
      const sending = decodeRecord(await page.evaluate(`(() => { const dots = [...document.querySelectorAll('.delivery-status[data-state="sending"] .delivery-status__dots i')]; const receipt = document.querySelector('.transcript-message__receipt'); return { count: dots.length, names: dots.map((dot) => getComputedStyle(dot).animationName), delays: dots.map((dot) => getComputedStyle(dot).animationDelay), running: dots.map((dot) => dot.getAnimations().some((animation) => animation.playState === 'running')), label: receipt.getAttribute('aria-label') } })()`))
      expect(decodeNumber(sending["count"])).toBe(3)
      expect(decodeArray(decodeString)(sending["names"])).toEqual(["delivery-dot", "delivery-dot", "delivery-dot"])
      expect(new Set(decodeArray(decodeString)(sending["delays"])).size).toBe(3)
      expect(decodeArray(decodeBoolean)(sending["running"])).toEqual([true, true, true])
      expect(decodeString(sending["label"])).toBe("Sending")
      const receipt = `document.querySelector('.transcript-message__receipt')`
      expect(await page.evaluate(`${receipt}.hasAttribute('title')`, decodeBoolean)).toBe(false)
      await page.evaluate(`${receipt}.focus()`)
      await wait(page, `document.activeElement === ${receipt} && document.getElementById(${receipt}.getAttribute('aria-describedby'))?.getAttribute('role') === 'tooltip'`)
      expect(decodeString(await page.evaluate(`document.querySelector('.owned-tooltip').textContent`))).toMatch(/Sending prompt · .*\d/)
      await page.pressEscape()
      await wait(page, `!document.querySelector('.owned-tooltip') && document.activeElement === ${receipt}`)
      await page.setReducedMotion(true)
      const reduced = decodeRecord(await page.evaluate(`(() => { const dots = [...document.querySelectorAll('.delivery-status__dots i')]; return { names: dots.map((dot) => getComputedStyle(dot).animationName), running: dots.some((dot) => dot.getAnimations().length > 0) } })()`))
      expect(decodeArray(decodeString)(reduced["names"])).toEqual(["none", "none", "none"])
      expect(decodeBoolean(reduced["running"])).toBe(false)
      await page.setReducedMotion(false)

      await page.evaluate(`window.composerSetMutation(null); window.composerSetMessages([${JSON.stringify(user("msg_sent", "Sent text", "promoted"))}, ${JSON.stringify(user("msg_read", "Read text", "consumed"))}])`)
      await wait(page, `document.querySelectorAll('.delivery-status').length === 2`)
      const done = decodeRecord(await page.evaluate(`(() => {
        const [sent, read] = [...document.querySelectorAll('.delivery-status')]
        return { sent: { state: sent.dataset.state, svgs: sent.querySelectorAll('svg').length, double: sent.querySelector('.delivery-status__double') !== null, label: sent.closest('.transcript-message__receipt').getAttribute('aria-label') },
          read: { state: read.dataset.state, double: read.querySelector('.delivery-status__double') !== null, label: read.closest('.transcript-message__receipt').getAttribute('aria-label'), color: getComputedStyle(read).color, hint: read.closest('.transcript-message__receipt').getAttribute('data-tooltip') },
          bubbleBackground: getComputedStyle(document.querySelector('.transcript-message__bubble')).backgroundColor, canvas: getComputedStyle(document.body).backgroundColor,
          visibleTime: [...document.querySelectorAll('.transcript-message--user')].some((message) => /\\b\\d{1,2}:\\d{2}\\b/.test(message.innerText)) }
      })()`))
      const sent = decodeRecord(done["sent"])
      const read = decodeRecord(done["read"])
      expect(sent).toEqual({ state: "sent", svgs: 1, double: false, label: "Sent" })
      expect(decodeString(read["state"])).toBe("read")
      expect(decodeBoolean(read["double"])).toBe(true)
      expect(decodeString(read["label"])).toBe("Read by YCoding")
      expect(greenDominant(decodeString(read["color"]))).toBe(true)
      expect(contrast(decodeString(read["color"]), decodeString(done["canvas"]))).toBeGreaterThanOrEqual(3)
      expect(decodeString(read["hint"])).toMatch(/Read by YCoding · .*\d/)
      expect(decodeBoolean(done["visibleTime"])).toBe(false)
    } finally { await page.close() }
  }, 30_000)

  test("the copy icon on user and assistant messages copies each message's exact text without shifting layout", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(composerFixture())
      await wait(page, `typeof window.composerSetMessages === 'function'`)
      await page.evaluate(`window.composerSetMessages([${JSON.stringify(user("msg_user", "Copy this exact\ntext with  spacing", "consumed"))}, ${JSON.stringify(assistant)}])`)
      await wait(page, `document.querySelectorAll('.transcript-message__copy').length === 2`)
      await page.evaluate(`window.__written = []; const original = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (text) => { window.__written.push(text); return original(text).catch(() => undefined) }`)
      const geometry = () => page.evaluate(`[...document.querySelectorAll('.transcript-message')].map((node) => Math.round(node.getBoundingClientRect().height * 10) / 10)`)
      const before = decodeArray(decodeNumber)(await geometry())
      const targets = [".transcript-message--user .transcript-message__copy", ".transcript-message--assistant .transcript-message__copy"]
      const expected = ["Copy this exact\ntext with  spacing", "First reply paragraph.\n\n**Bold** second paragraph."]
      for (const [index, selector] of targets.entries()) {
        const article = selector.split(" ")[0]!
        const at = await point(page, article)
        await page.mouse("mouseMoved", decodeNumber(at["x"]), decodeNumber(at["y"]))
        await click(page, selector)
        await wait(page, `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-label') === 'Copied'`)
        expect(decodeArray(decodeString)(await page.evaluate(`window.__written`))[index]).toBe(expected[index]!)
        expect(decodeString(await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).dataset.state`))).toBe("copied")
      }
      expect(decodeArray(decodeNumber)(await geometry())).toEqual(before)
      await wait(page, `document.querySelector('.transcript-message__copy').getAttribute('aria-label') === 'Copy message'`)
      expect(decodeString(await page.evaluate(`document.querySelector('.transcript-message--assistant').innerText`))).not.toContain("hidden reasoning")

      await page.evaluate(`navigator.clipboard.writeText = () => Promise.reject(new Error('blocked')); window.__selected = []; document.addEventListener('copy', () => window.__selected.push(document.getSelection().toString()))`)
      await click(page, targets[0]!)
      await wait(page, `document.querySelector(${JSON.stringify(targets[0])}).dataset.state === 'copied'`)
      expect(decodeArray(decodeString)(await page.evaluate(`window.__selected`))).toEqual([expected[0]!])
    } finally { await page.close() }
  }, 30_000)
})

describe("workspace shell", () => {
  test("the slash-command suggestions are not cramped above the composer", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(shell())
      await wait(page, `document.querySelector('.composer-resident .composer__input') !== null`)
      await click(page, ".composer-resident .composer__input")
      await type(page, "/")
      await wait(page, `document.querySelector('.composer-resident .mini-composer__suggestions') !== null`)
      const popover = decodeRecord(await page.evaluate(`(() => { const box = document.querySelector('.composer-resident .mini-composer__suggestions').getBoundingClientRect(), options = document.querySelectorAll('.composer-resident .mini-composer__autocomplete [role="option"]').length; return { height: box.height, options, top: box.top } })()`))
      expect(decodeNumber(popover["options"])).toBeGreaterThanOrEqual(5)
      expect(decodeNumber(popover["height"])).toBeGreaterThanOrEqual(Math.min(220, 36 * decodeNumber(popover["options"]) + 44))
      expect(decodeNumber(popover["top"])).toBeGreaterThanOrEqual(56)
    } finally { await page.close() }
  }, 30_000)

  test("rail items stay legible on hover in both themes", async () => {
    const page = await browser!.openPage()
    try {
      for (const scheme of ["dark", "light"] as const) {
        await page.setColorScheme(scheme)
        await page.setViewport(1440, 900)
        await page.navigate(shell(`&theme=${scheme}`))
        await wait(page, `document.querySelectorAll('.activity-bar__item').length >= 5`)
        const ids = decodeArray(decodeString)(await page.evaluate(`[...document.querySelectorAll('.activity-bar__item')].map((item) => item.dataset.destination)`))
        for (const id of ids) {
          const selector = `.activity-bar__item[data-destination="${id}"]`
          const at = await point(page, selector)
          await page.mouse("mouseMoved", decodeNumber(at["x"]), decodeNumber(at["y"]))
          await Bun.sleep(300)
          const measured = decodeRecord(await page.evaluate(`(() => {
            const item = document.querySelector(${JSON.stringify(selector)}), label = item.querySelector('.activity-bar__label'), badge = item.querySelector('.activity-bar__badge');
            const box = label.getBoundingClientRect(), icon = item.querySelector('.activity-bar__glyph svg').getBoundingClientRect(), outer = item.getBoundingClientRect();
            const center = rect => (rect.left + rect.right) / 2;
            return { hovered: item.matches(':hover'), background: getComputedStyle(item).backgroundColor, label: getComputedStyle(label).color, badge: badge ? [getComputedStyle(badge).color, getComputedStyle(badge).backgroundColor] : null, inside: box.left >= outer.left - 1 && box.right <= outer.right + 1 && box.top >= outer.top - 1 && box.bottom <= outer.bottom + 1, badgeInside: badge ? badge.getBoundingClientRect().right <= outer.right + 1 : true, aligned: Math.abs(center(box) - center(icon)) <= 0.5 && box.top >= icon.bottom };
          })()`))
          expect(decodeBoolean(measured["hovered"])).toBe(true)
          expect(contrast(decodeString(measured["label"]), decodeString(measured["background"])), `${scheme} ${id} label`).toBeGreaterThanOrEqual(4.5)
          expect(decodeBoolean(measured["inside"]), `${scheme} ${id} label inside`).toBe(true)
          expect(decodeBoolean(measured["badgeInside"]), `${scheme} ${id} badge inside`).toBe(true)
          expect(decodeBoolean(measured["aligned"]), `${scheme} ${id} icon and label share a column`).toBe(true)
          if (measured["badge"] !== null) {
            const [color, background] = decodeArray(decodeString)(measured["badge"])
            expect(contrast(color!, background!), `${scheme} ${id} badge`).toBeGreaterThanOrEqual(4.5)
          }
        }
      }
    } finally { await page.close() }
  }, 60_000)

  test("session rows and rail items activate on the first real click, even with the search field focused", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(shell())
      await wait(page, `document.querySelector('.workspace__rail [data-session-id="ses_running"]') !== null`)
      await click(page, '.workspace__rail input[aria-label="Search sessions"]')
      expect(decodeString(await page.evaluate(`document.activeElement.getAttribute('aria-label')`))).toBe("Search sessions")
      await click(page, '.workspace__rail [data-session-id="ses_running"]')
      await wait(page, `document.querySelector('.session-row--active')?.dataset.sessionId === 'ses_running'`)
      expect(decodeString(await page.evaluate(`location.search`))).toContain("ses_running")
      await click(page, '.activity-bar__item[data-destination="projects"]')
      await wait(page, `location.pathname === '/remote/projects'`)
      await click(page, '.activity-bar__item[data-destination="sessions"]')
      await wait(page, `location.pathname === '/remote/sessions'`)
    } finally { await page.close() }
  }, 30_000)

  test("the session-list toggle in the header collapses the list to full width, reopens it and persists across reloads", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(shell())
      await page.evaluate(`localStorage.removeItem('ycoding.remote.desktopRailCollapsed')`)
      await page.navigate(shell())
      await wait(page, `document.querySelector('.workspace__topbar .session-list-toggle') !== null`)
      const toggle = ".workspace__topbar .session-list-toggle"
      const read = async () => decodeRecord(await page.evaluate(`(() => { const button = document.querySelector(${JSON.stringify(toggle)}); return { label: button.getAttribute('aria-label'), expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls'), railWidth: document.querySelector('.workspace__rail').getBoundingClientRect().width, mainWidth: document.querySelector('.workspace__main').getBoundingClientRect().width, toggleVisible: button.getBoundingClientRect().width >= 44, controlled: document.getElementById(button.getAttribute('aria-controls')) !== null } })()`))
      const open = await read()
      expect(open).toMatchObject({ label: "Hide session list", expanded: "true", controls: "session-rail", toggleVisible: true, controlled: true })
      expect(decodeNumber(open["railWidth"])).toBeGreaterThan(200)
      await click(page, toggle)
      await wait(page, `document.querySelector('.app--rail-collapsed') !== null`)
      const closed = await read()
      expect(closed).toMatchObject({ label: "Show session list", expanded: "false", toggleVisible: true })
      expect(decodeNumber(closed["railWidth"])).toBe(0)
      expect(decodeNumber(closed["mainWidth"])).toBeGreaterThan(decodeNumber(open["mainWidth"]) + 200)
      await page.navigate(shell())
      await wait(page, `document.querySelector('.workspace__topbar .session-list-toggle') !== null`)
      expect(await read()).toMatchObject({ label: "Show session list", railWidth: 0 })
      await click(page, toggle)
      await wait(page, `document.querySelector('.app--rail-collapsed') === null`)
      const reopened = await read()
      expect(reopened).toMatchObject({ label: "Hide session list", expanded: "true" })
      expect(decodeNumber(reopened["railWidth"])).toBeGreaterThan(200)
    } finally { await page.close() }
  }, 30_000)
})

describe("pending tray", () => {
  test.each([390, 1440])("fits pending previews and both actions at %i pixels", async (width) => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.navigate(shell("&queued=0"))
      await wait(page, `typeof window.remoteSetPendingInputs === 'function' && document.querySelector('.composer-resident .composer__input') !== null`)
      await page.evaluate(`window.remoteSetPendingInputs(${JSON.stringify([
        row("msg_long", "Synthetic pending preview ".repeat(90).trim()), row("msg_short", "Short preview"),
      ])}); void 0`)
      await wait(page, `document.querySelector('.pending-tray__preview')?.textContent.endsWith('..')`)
      await click(page, ".pending-tray__toggle")
      const expanded = decodeRecord(await page.evaluate(`(() => {
        const toggle = document.querySelector('.pending-tray__toggle');
        const r = toggle.getBoundingClientRect();
        return { active: toggle.getAttribute('aria-expanded'), hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.outerHTML.slice(0, 140), rows: [...document.querySelectorAll('.pending-tray__text')].map(node => node.textContent.slice(0, 100)) };
      })()`))
      expect(expanded).toMatchObject({ active: "true" })
      await wait(page, `document.querySelectorAll('.pending-tray__item').length === 2 && document.querySelector('.pending-tray__text')?.textContent.endsWith('..')`)
      expect(decodeBoolean(await page.evaluate(`(() => {
        const [long, short] = document.querySelectorAll('.pending-tray__text');
        return long.textContent.endsWith('..') && !long.textContent.includes('…') && short.textContent === 'Short preview' && Array.from(document.querySelectorAll('.pending-tray__item')).every(row => {
          const bounds = row.getBoundingClientRect();
          return ['Steer now', 'Delete'].every(label => {
            const button = row.querySelector('[aria-label="' + label + '"]');
            const b = button?.getBoundingClientRect();
            return !!b && b.width > 0 && b.left >= bounds.left && b.right <= Math.min(innerWidth, bounds.right);
          });
        });
      })()`))).toBe(true)
      await captureActions(page, `web-pending-${width}`)
    } finally { await page.close() }
  }, 40_000)

  const row = (id: string, text: string, delivery: "queue" | "steer" = "queue") => ({ id, sessionID: "ses_fixture", admittedSeq: 2, timeCreated: 2, type: "user", delivery, data: { text } })
  const rows = [
    row("msg_q1", "First queued message that is long enough to be previewed on one line"),
    { id: "msg_json", sessionID: "ses_fixture", admittedSeq: 3, timeCreated: 3, type: "synthetic", delivery: "queue", data: { text: "{\"internal\":true}", description: "Internal", metadata: { contextSource: "session-state" } } },
    { id: "msg_compact", sessionID: "ses_fixture", admittedSeq: 4, timeCreated: 4, type: "compaction", delivery: "queue" },
    row("msg_q2", "Second queued message"),
    row("msg_q3", "Third queued message"),
    row("msg_steer", "Steer prompt about to be promoted", "steer"),
  ]
  test.each([390, 1440])("fits pending previews and both actions at %i pixels", async (width) => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.navigate(shell("&queued=0"))
      await wait(page, `typeof window.remoteSetPendingInputs === 'function' && document.querySelector('.composer-resident .composer__input')`)
      await page.evaluate(`window.remoteSetPendingInputs(${JSON.stringify([
        row("msg_long", "Synthetic pending preview ".repeat(90).trim()), row("msg_short", "Short preview"),
      ])}).then(() => true)`)
      await wait(page, `document.querySelector('.pending-tray__preview')?.textContent.endsWith('..')`)
      await click(page, ".pending-tray__toggle")
      await wait(page, `document.querySelectorAll('.pending-tray__item').length === 2 && document.querySelector('.pending-tray__text')?.textContent.endsWith('..')`)
      expect(await page.evaluate(`(() => {
        const [long, short] = document.querySelectorAll('.pending-tray__text');
        return long.textContent.endsWith('..') && !long.textContent.includes('…') && short.textContent === 'Short preview' && Array.from(document.querySelectorAll('.pending-tray__item')).every(row => {
          const bounds = row.getBoundingClientRect();
          return ['Steer now', 'Delete'].every(label => {
            const button = row.querySelector('[aria-label="' + label + '"]');
            const b = button?.getBoundingClientRect();
            return !!b && b.width > 0 && b.left >= bounds.left && b.right <= Math.min(innerWidth, bounds.right);
          });
        });
      })()`)).toBe(true)
    } finally { await page.close() }
  }, 40_000)
  const itemTexts = (page: Page) => page.evaluate(`[...document.querySelectorAll('.pending-tray__item .pending-tray__text')].map((node) => node.textContent)`)
  const operations = async (page: Page) => decodeArray(decodeRecord)(await page.evaluate(`window.remotePendingOperations.map((entry) => ({ operation: entry.operation, messageID: entry.input.messageID }))`))

  test("is hidden when nothing is pending and lists only user-authored messages above the composer field", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(shell("&queued=0"))
      await wait(page, `document.querySelector('.composer-resident .composer__input') !== null && typeof window.remoteSetPendingInputs === 'function'`)
      expect(decodeBoolean(await page.evaluate(`document.querySelector('.pending-tray') === null`))).toBe(true)
      await page.evaluate(`window.remoteSetPendingInputs(${JSON.stringify(rows)}); void 0`)
      await wait(page, `document.querySelector('.pending-tray__toggle') !== null`)
      const collapsed = decodeRecord(await page.evaluate(`(() => {
        const tray = document.querySelector('.pending-tray'), toggle = tray.querySelector('.pending-tray__toggle'), input = document.querySelector('.composer-resident .composer__input')
        const t = tray.getBoundingClientRect(), i = input.getBoundingClientRect()
        return { expanded: toggle.getAttribute('aria-expanded'), text: toggle.innerText, list: tray.querySelector('.pending-tray__list') !== null, gap: i.top - t.bottom, trayWidth: t.width, inputWidth: i.width, shadow: getComputedStyle(tray).boxShadow, preview: getComputedStyle(tray.querySelector('.pending-tray__preview')).textOverflow, label: tray.getAttribute('aria-label') }
      })()`))
      expect(collapsed).toMatchObject({ expanded: "false", list: false, preview: "clip", label: "Pending messages" })
      expect(decodeString(collapsed["text"])).toContain("3 pending")
      expect(decodeString(collapsed["text"])).toContain("First queued message that is long enough")
      expect(decodeString(collapsed["text"])).not.toContain("internal")
      expect(decodeString(collapsed["text"])).not.toContain("Steer prompt")
      expect(decodeString(collapsed["shadow"])).not.toBe("none")
      expect(decodeNumber(collapsed["gap"])).toBeGreaterThanOrEqual(0)
      expect(decodeNumber(collapsed["gap"])).toBeLessThanOrEqual(24)
      expect(Math.abs(decodeNumber(collapsed["trayWidth"]) - decodeNumber(collapsed["inputWidth"]))).toBeLessThanOrEqual(24)

      await click(page, ".pending-tray__toggle")
      await wait(page, `document.querySelector('.pending-tray__list') !== null`)
      expect(decodeArray(decodeString)(await itemTexts(page))).toEqual(["First queued message that is long enough to be previewed on one line", "Second queued message", "Third queued message"])
      const labels = decodeArray(decodeString)(await page.evaluate(`[...document.querySelectorAll('.pending-tray__item button')].map((button) => button.getAttribute('aria-label'))`))
      expect(labels).toEqual(Array.from({ length: 3 }, () => ["Steer now", "Delete"]).flat())
      expect(decodeNumber(await page.evaluate(`document.querySelector('.pending-tray__action').getBoundingClientRect().width`))).toBeGreaterThanOrEqual(32)
      await click(page, ".pending-tray__toggle")
      await wait(page, `document.querySelector('.pending-tray__list') === null`)
    } finally { await page.close() }
  }, 40_000)

  test("Remove and Steer now issue the relay operations, the row leaves or switches, and a stale input shows a short note", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(shell("&queued=0"))
      await wait(page, `typeof window.remoteSetPendingInputs === 'function' && document.querySelector('.composer-resident .composer__input') !== null`)
      await page.evaluate(`window.remoteSetPendingInputs(${JSON.stringify(rows)}); void 0`)
      await wait(page, `document.querySelector('.pending-tray__toggle') !== null`)
      await click(page, ".pending-tray__toggle")
      await wait(page, `document.querySelectorAll('.pending-tray__item').length === 3`)
      const action = (index: number, label: string) => `.pending-tray__item:nth-child(${index}) button[aria-label="${label}"]`

      await click(page, action(2, "Delete"))
      await wait(page, `document.querySelectorAll('.pending-tray__item').length === 2`)
      expect(decodeArray(decodeString)(await itemTexts(page))).toEqual(["First queued message that is long enough to be previewed on one line", "Third queued message"])
      expect(await operations(page)).toEqual([{ operation: "session.pending.remove", messageID: "msg_q2" }])

      await click(page, action(1, "Steer now"))
      await wait(page, `document.querySelectorAll('.pending-tray__item').length === 1`)
      expect(await operations(page)).toEqual([{ operation: "session.pending.remove", messageID: "msg_q2" }, { operation: "session.pending.steer", messageID: "msg_q1" }])
      expect(decodeArray(decodeString)(await itemTexts(page))).toEqual(["Third queued message"])

      await page.evaluate(`window.remoteStaleInput('msg_q3'); void 0`)
      await wait(page, `document.querySelector('.pending-tray__action') !== null && !document.querySelector('.pending-tray__action').disabled`)
      const target = await point(page, action(1, "Delete"))
      await page.mouse("mouseMoved", decodeNumber(target["x"]), decodeNumber(target["y"]))
      await wait(page, `document.querySelector('.owned-tooltip')?.textContent === 'Delete' && document.querySelector('.owned-tooltip').getBoundingClientRect().top > 0`)
      await click(page, action(1, "Delete"))
      await wait(page, `document.querySelector('.pending-tray__note') !== null`)
      expect(decodeString(await page.evaluate(`document.querySelector('.pending-tray__note').textContent`))).toBe("That input is no longer pending.")
      expect(decodeString(await page.evaluate(`document.querySelector('.pending-tray__note').getAttribute('role')`))).toBe("status")
      await wait(page, `document.querySelector('.pending-tray__toggle') === null`)
      expect((await operations(page)).at(-1)).toEqual({ operation: "session.pending.remove", messageID: "msg_q3" })
    } finally { await page.close() }
  }, 40_000)
})

test("sent message actions delete unread messages and retain a newly read message when its open menu submits", async () => {
  const page = await browser!.openPage()
  const user = (id: string, text: string, origin: string, consumed?: number) => ({ id, type: "user", text, metadata: { inputOrigin: origin }, time: { created: 3, consumed } })
  const fixture = [
    user("msg_action_read", "Synthetic already read", "direct", 4),
    user("msg_action_peer", "Synthetic non-owned", "plugin"),
    user("msg_action_unread", "Synthetic delete before read", "direct"),
    user("msg_action_race", "Synthetic read while menu is open", "direct"),
  ]
  try {
    await page.setViewport(1440, 900)
    await page.navigate(shell("&queued=0"))
    await wait(page, `typeof window.remoteSetSentMessages === 'function' && document.querySelector('.composer-resident .composer__input')`)
    await wait(page, `document.body.textContent.includes('Updated the session sync and verified the targeted tests.')`)
    await page.evaluate(`window.remoteSetSentMessages(${JSON.stringify(fixture)}).then(() => true)`)
    await wait(page, `document.body.textContent.includes('Synthetic delete before read')`)
    await wait(page, `document.querySelectorAll('.message-delete__menu-button').length === 2`)
    expect(await page.evaluate(`document.querySelectorAll('.transcript-message--user .delivery-status[data-state="read"]').length`)).toBe(1)
    await page.evaluate(`document.querySelectorAll('.message-delete__menu-button')[0].click()`)
    await wait(page, `document.querySelector('.message-delete__menu button')?.textContent === 'Delete'`)
    await captureActions(page, "web-sent-unread-menu")
    await page.evaluate(`document.querySelector('.message-delete__menu button').click()`)
    await wait(page, `!document.body.textContent.includes('Synthetic delete before read')`)
    await page.evaluate(`document.querySelector('.message-delete__menu-button').click(); window.remoteReadSentMessage('msg_action_race'); void 0`)
    await wait(page, `document.querySelectorAll('.transcript-message--user .delivery-status[data-state="read"]').length === 2`)
    await page.evaluate(`document.querySelector('.message-delete__menu button').click()`)
    await wait(page, `document.querySelector('.message-delete__error')?.textContent === 'YCoding has already read this message.'`)
    expect(await page.evaluate(`document.body.textContent.includes('Synthetic read while menu is open') && !document.querySelector('.message-delete__menu-button')`)).toBe(true)
    await captureActions(page, "web-sent-read-refusal")
  } finally { await page.close() }
}, 40_000)

describe("markdown", () => {
  const code = "const answer: Promise<number> = 42 // keep\n\tfunction run() {\n  return `x`\n}"
  const longLine = `const long = "${"wrap-me ".repeat(40)}"`
  const prose = ["# Plan", "", "1. First `npm test` step", "2. **Second** step", "", "- bullet item", "", "```ts", code, "```", "", "```ts", longLine, "```", "", "```", "plain text", "```"].join("\n")
  const assistant = { kind: "assistant", id: "msg_md", created: 4, completed: 5, parts: [{ kind: "text", ordinal: 0, text: prose }] }
  const userMessage = { kind: "user", id: "msg_user_md", text: "Please read `file.ts` and **fix** it\n\n- one\n- two", state: "consumed", delivery: "steer", created: 3 }

  test("renders user and assistant bodies as Markdown with a TypeScript code card", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(composerFixture())
      await wait(page, `typeof window.composerSetMessages === 'function'`)
      await page.evaluate(`window.composerSetMessages([${JSON.stringify(userMessage)}, ${JSON.stringify(assistant)}])`)
      await wait(page, `document.querySelectorAll('.transcript-md__code').length === 3`)
      const state = decodeRecord(await page.evaluate(`(() => {
        const assistantNode = document.querySelector('.transcript-message--assistant'), userNode = document.querySelector('.transcript-message--user')
        const card = document.querySelector('.transcript-md__code')
        const head = card.querySelector('.transcript-md__code-head')
        const buttons = [...head.querySelectorAll('button')]
        return {
          heading: assistantNode.querySelector('[role="heading"]')?.textContent, headingLevel: assistantNode.querySelector('[role="heading"]')?.getAttribute('aria-level'),
          ordered: assistantNode.querySelectorAll('ol > li').length, bullets: assistantNode.querySelectorAll('ul > li').length,
          inline: [...assistantNode.querySelectorAll('p code')].map((node) => node.textContent), strong: assistantNode.querySelector('strong')?.textContent,
          userInline: userNode.querySelector('code')?.textContent, userStrong: userNode.querySelector('strong')?.textContent, userBullets: userNode.querySelectorAll('li').length,
          labels: [...document.querySelectorAll('.transcript-md__code-lang')].map((node) => node.textContent.trim()),
          iconPath: head.querySelector('.transcript-md__code-lang svg path')?.getAttribute('d'),
          buttons: buttons.map((button) => ({ label: button.getAttribute('aria-label') ?? button.textContent.trim(), text: button.textContent.trim(), pressed: button.getAttribute('aria-pressed'), action: button.dataset.action })),
          radius: getComputedStyle(card).borderTopLeftRadius, overflow: getComputedStyle(card).overflow, headBackground: getComputedStyle(head).backgroundColor, cardBackground: getComputedStyle(card).backgroundColor,
          tokenKinds: [...new Set([...card.querySelectorAll('.code-token')].map((node) => node.className))].sort(), keyword: card.querySelector('.code-token--keyword')?.textContent, bodyText: card.querySelector('pre code').textContent,
          font: getComputedStyle(card.querySelector('pre code')).fontFamily, plainTokens: document.querySelectorAll('.transcript-md__code:last-of-type .code-token').length,
          headHeight: head.getBoundingClientRect().height,
        }
      })()`))
      expect(state).toMatchObject({ heading: "Plan", headingLevel: "1", ordered: 2, bullets: 1, strong: "Second", userInline: "file.ts", userStrong: "fix", userBullets: 2 })
      expect(decodeArray(decodeString)(state["inline"])).toContain("npm test")
      expect(decodeArray(decodeString)(state["labels"])).toEqual(["TypeScript", "TypeScript", "Code"])
      expect(decodeString(state["iconPath"])).toBe("M8 7l-5 5 5 5")
      expect(decodeArray(decodeRecord)(state["buttons"])).toEqual([
        { label: "Wrap lines", text: "Wrap lines", pressed: "false", action: "wrap" },
        { label: "Copy code", text: "Copy code", pressed: null, action: "copy" },
      ])
      expect(decodeString(state["radius"])).toBe("8px")
      expect(decodeString(state["font"])).toMatch(/JetBrains Mono|monospace/)
      expect(decodeString(state["bodyText"])).toBe(code)
      expect(decodeString(state["keyword"])).toBe("const")
      expect(decodeArray(decodeString)(state["tokenKinds"])).toEqual(expect.arrayContaining(["code-token code-token--keyword", "code-token code-token--comment", "code-token code-token--number", "code-token code-token--type", "code-token code-token--string", "code-token code-token--function"]))
      expect(decodeString(state["headBackground"])).not.toBe(decodeString(state["cardBackground"]))
      expect(decodeNumber(state["headHeight"])).toBeLessThanOrEqual(48)
    } finally { await page.close() }
  }, 40_000)

  test("Wrap lines flips aria-pressed and wraps the long line; Copy code writes the exact raw code and shows Copied", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(900, 900)
      await page.navigate(composerFixture())
      await wait(page, `typeof window.composerSetMessages === 'function'`)
      await page.evaluate(`window.composerSetMessages([${JSON.stringify(assistant)}])`)
      await wait(page, `document.querySelectorAll('.transcript-md__code').length === 3`)
      await page.evaluate(`document.querySelectorAll('.transcript-md__code').forEach((card, index) => { card.dataset.index = String(index) })`)
      const metrics = () => page.evaluate(`(() => { const card = document.querySelectorAll('.transcript-md__code')[1], pre = card.querySelector('pre'), button = card.querySelector('[data-action="wrap"]'); return { pressed: button.getAttribute('aria-pressed'), whiteSpace: getComputedStyle(pre).whiteSpace, overflows: pre.scrollWidth > pre.clientWidth + 1, headStill: card.querySelector('.transcript-md__code-head').getBoundingClientRect().width, cardWidth: card.getBoundingClientRect().width } })()`)
      const before = decodeRecord(await metrics())
      expect(before).toMatchObject({ pressed: "false", whiteSpace: "pre", overflows: true })
      await page.evaluate(`document.querySelectorAll('.transcript-md__code')[1].scrollIntoView()`)
      await click(page, '[data-index="1"] [data-action="wrap"]')
      await wait(page, `document.querySelectorAll('.transcript-md__code')[1].querySelector('[data-action="wrap"]').getAttribute('aria-pressed') === 'true'`)
      const after = decodeRecord(await metrics())
      expect(after).toMatchObject({ pressed: "true", whiteSpace: "pre-wrap", overflows: false })
      expect(decodeNumber(after["headStill"])).toBe(decodeNumber(before["headStill"]))
      await click(page, '[data-index="1"] [data-action="wrap"]')
      await wait(page, `document.querySelectorAll('.transcript-md__code')[1].querySelector('[data-action="wrap"]').getAttribute('aria-pressed') === 'false'`)

      await page.evaluate(`window.__written = []; const original = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (text) => { window.__written.push(text); return original(text).catch(() => undefined) }`)
      await page.evaluate(`document.querySelectorAll('.transcript-md__code')[0].scrollIntoView()`)
      await click(page, '[data-index="0"] [data-action="copy"]')
      await wait(page, `document.querySelector('.transcript-md__code [data-action="copy"]').getAttribute('aria-label') === 'Copied'`)
      expect(decodeArray(decodeString)(await page.evaluate(`window.__written`))).toEqual([code])
      expect(decodeBoolean(await page.evaluate(`document.querySelector('.transcript-md__code [data-action="copy"] svg path').getAttribute('d') === 'M5 12.5l4.5 4.5L19 7'`))).toBe(true)
      await wait(page, `document.querySelector('.transcript-md__code [data-action="copy"]').getAttribute('aria-label') === 'Copy code'`)
    } finally { await page.close() }
  }, 40_000)

  test("syntax colors and the card keep 4.5:1 in dark and light", async () => {
    const page = await browser!.openPage()
    try {
      for (const scheme of ["dark", "light"] as const) {
        await page.setColorScheme(scheme)
        await page.setViewport(1440, 900)
        await page.navigate(composerFixture())
        await wait(page, `typeof window.composerSetMessages === 'function'`)
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(scheme)}`)
        await page.evaluate(`window.composerSetMessages([${JSON.stringify(assistant)}])`)
        await wait(page, `document.querySelectorAll('.transcript-md__code').length === 3`)
        expect(decodeString(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--yc-plane-canvas').trim()`))).toBe(scheme === "dark" ? "#191f19" : "#fffaf0")
        const colors = decodeRecord(await page.evaluate(`(() => {
          const card = document.querySelector('.transcript-md__code'), head = card.querySelector('.transcript-md__code-head')
          const spans = {}
          for (const kind of ['keyword', 'string', 'number', 'comment', 'type']) { const node = card.querySelector('.code-token--' + kind) ?? document.querySelector('.code-token--' + kind); if (node) spans[kind] = getComputedStyle(node).color }
          return { card: getComputedStyle(card).backgroundColor, head: getComputedStyle(head).backgroundColor, code: getComputedStyle(card.querySelector('pre code')).color, headInk: getComputedStyle(head).color, copy: getComputedStyle(head.querySelector('[data-action="copy"]')).color, spans }
        })()`))
        const card = decodeString(colors["card"])
        const spans = decodeRecord(colors["spans"])
        expect(Object.keys(spans).sort(), scheme).toEqual(["comment", "keyword", "number", "string", "type"])
        for (const [kind, color] of Object.entries(spans)) expect(contrast(decodeString(color), card), `${scheme} ${kind} on card`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(decodeString(colors["code"]), card), `${scheme} code ink`).toBeGreaterThanOrEqual(4.5)
        for (const key of ["headInk", "copy"]) expect(contrast(decodeString(colors[key]), decodeString(colors["head"])), `${scheme} ${key}`).toBeGreaterThanOrEqual(4.5)
        expect(decodeString(colors["card"]), scheme).not.toBe(decodeString(colors["head"]))
        console.log(`code card ${scheme}: ${Object.entries(spans).map(([kind, color]) => `${kind} ${contrast(decodeString(color), card).toFixed(2)}`).join(", ")}, ink ${contrast(decodeString(colors["code"]), card).toFixed(2)}`)
      }
    } finally { await page.close() }
  }, 40_000)
})
