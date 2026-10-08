import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4747
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

const shortcut = (key: string, modifiers: { ctrl?: boolean; meta?: boolean }) =>
  `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: ${modifiers.ctrl === true}, metaKey: ${modifiers.meta === true}, bubbles: true, cancelable: true }))`
const paletteOpen = `document.querySelector('dialog.overlay--command-palette[open]') !== null`
const paletteClosed = `document.querySelector('dialog.overlay--command-palette') === null`
const rows = `[...document.querySelectorAll('dialog.overlay--command-palette [role=option]')].map((row) => row.querySelector('.command-palette__title').textContent)`

async function openChat(viewport: "desktop" | "phone") {
  const page = await browser!.openPage()
  if (viewport === "phone") {
    await page.setViewport(390, 844)
    await page.setCoarsePointer(true)
  }
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
  await wait(page, `document.querySelector('.composer-resident:not([inert]) .composer__input') !== null`)
  return page
}

async function search(page: Page, query: string) {
  await page.evaluate(`(() => { const field = document.getElementById('command-palette-input'); field.value = ${JSON.stringify(query)}; field.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
  await Bun.sleep(50)
}

test("the header button opens a labelled combobox over grouped actions and Escape returns focus to it", async () => {
  const page = await openChat("desktop")
  try {
    const trigger = await page.evaluate<{ label: string | null; width: number; height: number }>(`(() => { const button = document.querySelector('.app-header__palette'); const box = button.getBoundingClientRect(); return { label: button.getAttribute('aria-label'), width: box.width, height: box.height } })()`)
    expect(trigger.label).toBe("Open command palette")
    expect(trigger.width).toBeGreaterThanOrEqual(44)
    expect(trigger.height).toBeGreaterThanOrEqual(44)
    await page.evaluate(`document.querySelector('.app-header__palette').click()`)
    await wait(page, paletteOpen)
    expect(await page.evaluate<unknown>(`(() => { const input = document.getElementById('command-palette-input'); const list = document.getElementById('command-palette-list'); return { focused: document.activeElement === input, role: input.getAttribute('role'), expanded: input.getAttribute('aria-expanded'), controls: input.getAttribute('aria-controls'), listRole: list.getAttribute('role'), described: document.getElementById(input.getAttribute('aria-activedescendant'))?.getAttribute('role') } })()`)).toEqual({ focused: true, role: "combobox", expanded: "true", controls: "command-palette-list", listRole: "listbox", described: "option" })
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.command-palette__heading')].map((heading) => heading.textContent)`)).toEqual(["Session", "Commands", "Skills", "Navigation", "Settings", "Account"])
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.command-palette__group')].every((group) => group.getAttribute('role') === 'group' && group.getAttribute('aria-labelledby'))`)).toBe(true)
    await page.pressEscape()
    await wait(page, paletteClosed)
    expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.app-header__palette')`)).toBe(true)
  } finally { await page.close() }
}, 60_000)

test("Ctrl+K opens from the composer and Escape returns focus to the composer; Ctrl+P defers to text fields", async () => {
  const page = await openChat("desktop")
  try {
    await page.evaluate(`document.querySelector('.composer-resident:not([inert]) .composer__input').focus()`)
    await page.evaluate(shortcut("p", { ctrl: true }))
    await Bun.sleep(150)
    expect(await page.evaluate<boolean>(paletteClosed)).toBe(true)
    await page.evaluate(shortcut("k", { ctrl: true }))
    await wait(page, paletteOpen)
    await page.evaluate(shortcut("k", { ctrl: true }))
    await wait(page, paletteClosed)
    expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.composer-resident:not([inert]) .composer__input')`)).toBe(true)
    await page.evaluate(`document.activeElement.blur()`)
    await page.evaluate(shortcut("p", { ctrl: true }))
    await wait(page, paletteOpen)
    await page.pressEscape()
    await wait(page, paletteClosed)
    await page.evaluate(`document.body.focus()`)
    await page.evaluate(shortcut("k", { meta: true }))
    await wait(page, paletteOpen)
  } finally { await page.close() }
}, 60_000)

test("searching a slash name ranks its action first and Enter runs it with the keyboard", async () => {
  const page = await openChat("desktop")
  try {
    await page.evaluate(shortcut("k", { ctrl: true }))
    await wait(page, paletteOpen)
    await search(page, "/compact")
    expect((await page.evaluate<string[]>(rows))[0]).toBe("Compact session")
    expect(await page.evaluate<number>(`document.querySelectorAll('.command-palette__heading').length`)).toBe(0)
    await page.pressKey("Enter", "Enter", 13)
    await wait(page, `window.requestLog.some((item) => item.operation === 'session.compact')`)
    await wait(page, paletteClosed)
    await page.evaluate(shortcut("k", { ctrl: true }))
    await wait(page, paletteOpen)
    await search(page, "yolo")
    expect(await page.evaluate<string[]>(rows)).toEqual(["YOLO off", "YOLO level 1", "YOLO level 3"])
    await page.pressKey("ArrowDown", "ArrowDown", 40)
    await page.pressKey("ArrowDown", "ArrowDown", 40)
    await page.pressKey("ArrowUp", "ArrowUp", 38)
    expect(await page.evaluate<string>(`document.querySelector('[role=option][aria-selected=true] .command-palette__title').textContent`)).toBe("YOLO level 1")
    await page.pressKey("Enter", "Enter", 13)
    await wait(page, `window.remoteMutationReport().some((item) => item.operation === 'session.autonomy.set' && item.input?.yolo === 1)`)
    await page.evaluate(shortcut("k", { ctrl: true }))
    await wait(page, paletteOpen)
    await search(page, "zzzzqq")
    expect(await page.evaluate<string>(`document.querySelector('.command-palette__empty').textContent`)).toBe("No matching action.")
    expect(await page.evaluate<string>(`document.querySelector('dialog.overlay--command-palette [role=status]').textContent`)).toBe("No matching action")
  } finally { await page.close() }
}, 60_000)

test("an action that needs text fills the composer draft and focuses it; a click selects navigation and theme", async () => {
  const page = await openChat("desktop")
  try {
    await page.evaluate(shortcut("k", { ctrl: true }))
    await wait(page, paletteOpen)
    await search(page, "Set goal")
    await page.pressKey("Enter", "Enter", 13)
    await wait(page, paletteClosed)
    await wait(page, `document.activeElement === document.querySelector('.composer-resident:not([inert]) .composer__input') && document.activeElement.value === '/goal '`)
    await page.evaluate(`document.querySelector('.app-header__palette').click()`)
    await wait(page, paletteOpen)
    await search(page, "/review")
    await page.evaluate(`document.querySelector('dialog.overlay--command-palette [role=option]').click()`)
    await wait(page, `document.querySelector('.composer-resident:not([inert]) .composer__input').value === '/review /goal '`)
    await page.evaluate(`document.querySelector('.app-header__palette').focus()`)
    await page.evaluate(`document.querySelector('.app-header__palette').click()`)
    await wait(page, paletteOpen)
    await search(page, "Go to Usage")
    await page.evaluate(`document.querySelector('dialog.overlay--command-palette [role=option]').click()`)
    await wait(page, `new URL(location.href).pathname === '/remote/usage'`)
    expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.app-header__palette')`)).toBe(true)
    await page.evaluate(`document.querySelector('.app-header__palette').click()`)
    await wait(page, paletteOpen)
    expect(await page.evaluate<string>(`document.querySelector('.command-palette__heading').textContent`)).toBe("Navigation")
    await search(page, "Theme: Dark")
    await page.pressKey("Enter", "Enter", 13)
    await wait(page, `document.documentElement.dataset.theme === 'dark'`)
    await page.evaluate(`document.querySelector('.app-header__palette').click()`)
    await wait(page, paletteOpen)
    await search(page, "One Dark Pro")
    await page.pressKey("Enter", "Enter", 13)
    await wait(page, `document.documentElement.dataset.scheme === 'onedark-pro'`)
  } finally { await page.close() }
}, 90_000)

test("on a phone the palette is a full-viewport sheet with touch-sized rows and its trigger stays in the narrow header", async () => {
  const page = await openChat("phone")
  try {
    const header = await page.evaluate<{ width: number; height: number; overflow: boolean }>(`(() => { const box = document.querySelector('.app-header__palette').getBoundingClientRect(); return { width: box.width, height: box.height, overflow: document.documentElement.scrollWidth > innerWidth } })()`)
    expect(header.width).toBeGreaterThanOrEqual(44)
    expect(header.height).toBeGreaterThanOrEqual(44)
    expect(header.overflow).toBe(false)
    await page.evaluate(`document.querySelector('.app-header__palette').click()`)
    await wait(page, paletteOpen)
    await Bun.sleep(400)
    const sheet = await page.evaluate<{ left: number; top: number; width: number; height: number; radius: string; rows: number; shortest: number; input: boolean }>(`(() => { const surface = document.querySelector('dialog.overlay--command-palette .overlay__surface'); const box = surface.getBoundingClientRect(); const options = [...document.querySelectorAll('dialog.overlay--command-palette [role=option]')]; return { left: box.left, top: box.top, width: box.width, height: box.height, radius: getComputedStyle(surface).borderTopLeftRadius, rows: options.length, shortest: Math.min(...options.map((option) => option.getBoundingClientRect().height)), input: document.activeElement === document.getElementById('command-palette-input') } })()`)
    expect(sheet).toMatchObject({ left: 0, top: 0, width: 390, height: 844, radius: "0px", input: true })
    expect(sheet.rows).toBeGreaterThan(5)
    expect(sheet.shortest).toBeGreaterThanOrEqual(44)
    await search(page, "settings")
    const close = await page.evaluate<{ width: number; height: number }>(`(() => { const box = document.querySelector('dialog.overlay--command-palette .overlay__close').getBoundingClientRect(); return { width: box.width, height: box.height } })()`)
    expect(close.width).toBeGreaterThanOrEqual(44)
    expect(close.height).toBeGreaterThanOrEqual(44)
    await page.evaluate(`[...document.querySelectorAll('dialog.overlay--command-palette [role=option]')].find((row) => row.querySelector('.command-palette__title').textContent === 'Go to Settings').click()`)
    await wait(page, `new URL(location.href).pathname === '/remote/settings'`)
    await wait(page, paletteClosed)
  } finally { await page.close() }
}, 60_000)

async function wait(page: Page, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}; ${await page.evaluate<string>(`JSON.stringify({ url: location.href, dialog: document.querySelector('dialog')?.outerHTML?.slice(0, 600), active: document.activeElement?.outerHTML?.slice(0, 200) })`)}`)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false) }
