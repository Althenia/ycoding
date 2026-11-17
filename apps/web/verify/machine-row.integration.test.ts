import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser, decodeArray, decodeBoolean, decodeDictionary, decodeNullable, decodeNumber, decodeRecord, decodeString } from "./cdp"

const port = 4601
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(browserPath, 390, 844)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Vite did not start the machine row fixture")
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

const section = `[aria-labelledby="machine-settings"]`
const item = (name: string) => `[...document.querySelectorAll('${section} .machine-row__item')].find(node => node.querySelector('.machine-row__name')?.textContent === ${JSON.stringify(name)})`

async function until(page: Page, expression: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await page.evaluate(expression)) return
    await Bun.sleep(40)
  }
  throw new Error(`Machine row did not settle: ${expression}`)
}

async function open(width: number, query = "view=settings&machines=distinct", options: { readonly theme?: "light" | "dark"; readonly coarse?: boolean; readonly height?: number; readonly ready?: string } = {}) {
  if (!browser) throw new Error("Chrome was not initialized")
  const page = await browser.openPage()
  await page.setViewport(width, options.height ?? 900)
  if (options.coarse) await page.setCoarsePointer(true)
  const url = `http://127.0.0.1:${port}/verify/remote.html?${query}`
  await page.navigate(url)
  await page.evaluate(`localStorage.removeItem('ycoding.remote.device-aliases')`)
  await page.navigate(url)
  await until(page, `document.querySelector('${section} ${options.ready ?? ".machine-row__item"}') !== null`)
  if (options.theme) await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(options.theme)}`)
  return page
}

const names = (page: Page) => page.evaluate(`[...document.querySelectorAll('${section} .machine-row__name')].map(node => node.textContent)`, decodeArray(decodeString))
const aliases = (page: Page) => page.evaluate(`Object.fromEntries(window.remoteAliasReport().devices.filter(device => typeof device.alias === 'string').map(device => [device.id, device.alias]))`, decodeDictionary(decodeString))
const type = (page: Page, value: string) => page.evaluate(`(() => { const input = document.querySelector('${section} .machine-row__input'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
const doubleClickName = (page: Page, name: string) => page.evaluate(`${item(name)}.querySelector('.machine-row__name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`)
const laptopRequests = (page: Page) => page.evaluate(`window.remoteDeviceRequests.filter(request => request.deviceID === 'dev_laptop').length`, decodeNumber)

describe("machine row", () => {
  test("lists every owned machine as a vertical list of compact rows with its connection state and no dropdown", async () => {
    for (const width of [320, 390, 1440]) for (const theme of ["light", "dark"] as const) {
      const page = await open(width, "view=settings&machines=distinct", { theme })
      try {
        expect(await page.evaluate(`document.querySelector('${section} [aria-label="Machine"], ${section} [role="listbox"], ${section} .custom-select, #device-display-name') === null`)).toBe(true)
        expect(await names(page)).toEqual(["Studio Mac", "Laptop", "Sleeping Mac"])
        const layout = await page.evaluate(`(() => {
          const row = document.querySelector('${section} .machine-row'), items = [...row.querySelectorAll('.machine-row__item')], rects = items.map(node => node.getBoundingClientRect()), box = row.getBoundingClientRect()
          return { tops: rects.map(rect => Math.round(rect.top)), heights: rects.map(rect => Math.round(rect.height)), lefts: rects.map(rect => Math.round(rect.left)), widths: rects.map(rect => Math.round(rect.width)), sectionWidth: document.querySelector('${section}').getBoundingClientRect().width, rowWidth: box.width, rowScrolls: row.scrollWidth > row.clientWidth + 1, pageOverflow: document.documentElement.scrollWidth > innerWidth, listRole: row.getAttribute('role'), listLabel: row.getAttribute('aria-label'), hostnames: row.querySelectorAll('.machine-row__hostname').length, controls: items.flatMap(node => [...node.querySelectorAll('button')].map(button => Math.round(button.getBoundingClientRect().height))) }
        })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, tops: (decodeArray(decodeNumber))(record["tops"]), heights: (decodeArray(decodeNumber))(record["heights"]), lefts: (decodeArray(decodeNumber))(record["lefts"]), widths: (decodeArray(decodeNumber))(record["widths"]), sectionWidth: (decodeNumber)(record["sectionWidth"]), rowWidth: (decodeNumber)(record["rowWidth"]), rowScrolls: (decodeBoolean)(record["rowScrolls"]), pageOverflow: (decodeBoolean)(record["pageOverflow"]), listRole: (decodeNullable(decodeString))(record["listRole"]), listLabel: (decodeNullable(decodeString))(record["listLabel"]), hostnames: (decodeNumber)(record["hostnames"]), controls: (decodeArray(decodeNumber))(record["controls"]) } })
        const detail = JSON.stringify({ width, theme, layout })
        expect(layout.tops[0]! < layout.tops[1]! && layout.tops[1]! < layout.tops[2]!, detail).toBe(true)
        expect(new Set(layout.lefts).size, detail).toBe(1)
        expect(new Set(layout.widths).size, detail).toBe(1)
        expect(Math.max(...layout.heights), detail).toBeLessThanOrEqual(80)
        expect(layout.rowWidth, detail).toBeLessThanOrEqual(layout.sectionWidth + 1)
        expect(layout.rowScrolls, detail).toBe(false)
        expect(layout.pageOverflow, detail).toBe(false)
        expect(layout.hostnames, detail).toBe(0)
        expect(Math.min(...layout.controls), detail).toBeGreaterThanOrEqual(44)
        expect(layout.listRole).toBe("list")
        expect(layout.listLabel).toBe("Machines")
        const states = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('${section} .machine-row__item')].map(node => [node.querySelector('.machine-row__name').textContent, { state: node.querySelector('.machine-row__state').textContent.trim(), connect: node.querySelector('.machine-row__connect').textContent.trim(), disabled: node.querySelector('.machine-row__connect').disabled, current: node.getAttribute('aria-current') }]))`)
        expect(states).toEqual({
          "Studio Mac": { state: "Online", connect: "Connected", disabled: true, current: "true" },
          Laptop: { state: "Online", connect: "Connect", disabled: false, current: null },
          "Sleeping Mac": { state: "Offline", connect: "Offline", disabled: true, current: null },
        })
        expect(await page.evaluate(`document.querySelector('${section} .machine-row__scope').textContent`)).toMatch(/account.*browsers/i)
        expect(await page.evaluate(`document.querySelector('${section} .machine-row__note').textContent`)).toBe("1 revoked machine is managed in Settings → Devices.")
        const colors = await page.evaluate(`(() => ({ background: getComputedStyle(document.querySelector('${section} .machine-row__item')).backgroundColor, border: getComputedStyle(document.querySelector('${section} .machine-row__item:not([aria-current])')).borderTopColor, current: getComputedStyle(document.querySelector('${section} .machine-row__item[aria-current]')).borderTopColor }))()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, background: (decodeString)(record["background"]), border: (decodeString)(record["border"]), current: (decodeString)(record["current"]) } })
        expect(colors.background).not.toBe("rgba(0, 0, 0, 0)")
        expect(colors.current).not.toBe(colors.border)
        await Bun.sleep(600)
        await Bun.write(new URL(`../../../.cache/tmp/machine-row-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      } finally { await page.close() }
    }
  }, 120_000)

  test("shows the empty and offline-only account states without a selectable connect", async () => {
    for (const [mode, expected] of [["none", "No machine enrolled"], ["offline", "No machines online"]] as const) {
      const page = await open(390, `view=settings&devices=${mode}`, { height: 844, ready: mode === "none" ? ".machine-row__empty" : ".machine-row__item" })
      try {
        if (mode === "none") {
          expect(await page.evaluate(`document.querySelector('${section} .machine-row__empty').textContent.trim()`)).toBe(expected)
          expect(await page.evaluate(`document.querySelectorAll('${section} .machine-row__item').length`)).toBe(0)
        } else {
          expect(await page.evaluate(`[...document.querySelectorAll('${section} .machine-row__connect')].every(button => button.disabled)`)).toBe(true)
          expect(await page.evaluate(`document.querySelector('${section} .machine-row__note').textContent`)).toContain(expected)
        }
        expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      } finally { await page.close() }
    }
  }, 30_000)

  test("connects only an online machine that is not current", async () => {
    const page = await open(390)
    try {
      const before = await laptopRequests(page)
      await page.evaluate(`${item("Sleeping Mac")}.querySelector('.machine-row__connect').click()`)
      await Bun.sleep(150)
      expect(await laptopRequests(page)).toBe(before)
      await page.evaluate(`${item("Laptop")}.querySelector('.machine-row__connect').click()`)
      await until(page, `${item("Laptop")}?.getAttribute('aria-current') === 'true'`)
      expect(await page.evaluate(`${item("Laptop")}.querySelector('.machine-row__connect').textContent.trim()`)).toBe("Connected")
      expect(await page.evaluate(`${item("Studio Mac")}.querySelector('.machine-row__connect').textContent.trim()`)).toBe("Connect")
      expect(await page.evaluate(`${item("Sleeping Mac")}.querySelector('.machine-row__connect').disabled`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("double-clicking the displayed name edits in place and Enter saves without connecting", async () => {
    const page = await open(390)
    try {
      await page.evaluate(`window.rowNodes = [...document.querySelectorAll('${section} .machine-row__item')]; void 0`)
      const before = await laptopRequests(page)
      await doubleClickName(page, "Laptop")
      await until(page, `document.activeElement === document.querySelector('${section} .machine-row__input')`)
      expect(await page.evaluate(`(() => { const input = document.querySelector('${section} .machine-row__input'); return { value: input.value, max: input.maxLength, label: input.getAttribute('aria-label'), inputs: document.querySelectorAll('${section} .machine-row__input').length } })()`)).toEqual({ value: "Laptop", max: 48, label: "Name for Laptop", inputs: 1 })
      expect(await laptopRequests(page)).toBe(before)
      expect(await page.evaluate(`${item("Studio Mac")}.getAttribute('aria-current')`)).toBe("true")
      await type(page, "  Desk Linux  ")
      await page.pressKey("Enter", "Enter", 13, "\r")
      await until(page, `document.querySelector('${section} .machine-row__input') === null && ${item("Desk Linux")} !== undefined`)
      expect(await aliases(page)).toEqual({ dev_laptop: "Desk Linux" })
      const identity = await page.evaluate(`(() => { const node = ${item("Desk Linux")}; return { name: node.querySelector('.machine-row__name').textContent, hostname: node.querySelectorAll('.machine-row__hostname').length, title: node.querySelector('.machine-row__name').getAttribute('data-tooltip'), same: [...document.querySelectorAll('${section} .machine-row__item')].every((entry, index) => entry === window.rowNodes[index]), focus: document.activeElement?.getAttribute('aria-label') ?? null } })()`)
      expect(identity).toEqual({ name: "Desk Linux", hostname: 0, title: "Laptop", same: true, focus: "Edit name of Desk Linux" })
      expect(await laptopRequests(page)).toBe(before)
      expect(await page.evaluate(`${item("Studio Mac")}.getAttribute('aria-current')`)).toBe("true")
      expect(await page.evaluate(`document.querySelector('${section} .machine-row__scope').textContent`)).toMatch(/account.*browsers/i)
    } finally { await page.close() }
  }, 30_000)

  test("the edit icon opens editing for the keyboard and Escape cancels back to the icon", async () => {
    const page = await open(1440)
    try {
      await page.evaluate(`window.rowNodes = [...document.querySelectorAll('${section} .machine-row__item')]; ${item("Laptop")}.querySelector('.machine-row__edit').focus()`)
      expect(await page.evaluate(`document.activeElement.getAttribute('aria-label')`)).toBe("Edit name of Laptop")
      await page.pressKey("Enter", "Enter", 13, "\r")
      await until(page, `document.activeElement === document.querySelector('${section} .machine-row__input')`)
      expect(await page.evaluate(`document.querySelector('${section} .machine-row__input').value`)).toBe("Laptop")
      await type(page, "Discarded")
      await page.pressEscape()
      await until(page, `document.querySelector('${section} .machine-row__input') === null`)
      expect(await names(page)).toEqual(["Studio Mac", "Laptop", "Sleeping Mac"])
      expect(await aliases(page)).toEqual({})
      expect(await page.evaluate(`document.activeElement.getAttribute('aria-label')`)).toBe("Edit name of Laptop")
      expect(await page.evaluate(`[...document.querySelectorAll('${section} .machine-row__item')].every((node, index) => node === window.rowNodes[index])`)).toBe(true)
      expect(await page.evaluate(`document.querySelector('dialog[open]') === null`)).toBe(true)
      await page.evaluate(`${item("Laptop")}.querySelector('.machine-row__edit').focus()`)
      await page.pressKey(" ", "Space", 32, " ")
      await until(page, `document.querySelector('${section} .machine-row__input') !== null`)
    } finally { await page.close() }
  }, 30_000)

  test("touch Save, Cancel and an empty Save are visible, 44px targets that save, discard and clear", async () => {
    const page = await open(390, "view=settings&machines=distinct", { coarse: true, height: 844 })
    try {
      await page.evaluate(`${item("Laptop")}.querySelector('.machine-row__edit').click()`)
      await until(page, `document.querySelector('${section} .machine-row__input') !== null`)
      const targets = await page.evaluate(`[...document.querySelectorAll('${section} .machine-row__item')].flatMap(node => [...node.querySelectorAll('button')]).filter(button => button.getBoundingClientRect().width > 0).map(button => { const box = button.getBoundingClientRect(); return { label: button.getAttribute('aria-label') ?? button.textContent.trim(), width: box.width, height: box.height, visible: box.left >= 0 && box.right <= innerWidth + 400 } })`, decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, label: (decodeString)(record["label"]), width: (decodeNumber)(record["width"]), height: (decodeNumber)(record["height"]), visible: (decodeBoolean)(record["visible"]) } }))
      expect(targets.map((target) => target.label)).toEqual(expect.arrayContaining(["Save", "Cancel"]))
      expect(targets.filter((target) => target.label !== "Offline" && target.label !== "Connected").every((target) => target.width >= 44 && target.height >= 44), JSON.stringify(targets)).toBe(true)
      expect(await page.evaluate(`[...document.querySelectorAll('${section} .machine-row__connect')].every(button => button.disabled)`)).toBe(true)
      await type(page, "Scratch")
      await page.evaluate(`document.querySelector('${section} [data-device-id="dev_laptop"] .machine-row__cancel').click()`)
      await until(page, `document.querySelector('${section} .machine-row__input') === null`)
      expect(await names(page)).toEqual(["Studio Mac", "Laptop", "Sleeping Mac"])
      expect(await aliases(page)).toEqual({})

      await page.evaluate(`${item("Laptop")}.querySelector('.machine-row__edit').click()`)
      await until(page, `document.querySelector('${section} .machine-row__input') !== null`)
      await type(page, `  ${"x".repeat(48)}  `)
      await page.evaluate(`document.querySelector('${section} .machine-row__save').click()`)
      await until(page, `document.querySelector('${section} .machine-row__input') === null`)
      expect(await aliases(page)).toEqual({ dev_laptop: "x".repeat(48) })

      await page.evaluate(`${item("x".repeat(48))}.querySelector('.machine-row__edit').click()`)
      await until(page, `document.querySelector('${section} .machine-row__input') !== null`)
      await type(page, "   ")
      await page.evaluate(`document.querySelector('${section} .machine-row__save').click()`)
      await until(page, `document.querySelector('${section} .machine-row__input') === null`)
      expect(await aliases(page)).toEqual({})
      expect(await names(page)).toEqual(["Studio Mac", "Laptop", "Sleeping Mac"])
    } finally { await page.close() }
  }, 30_000)

  test("while one name is edited no machine can be connected and a second edit replaces the first without saving", async () => {
    const page = await open(1440)
    try {
      const before = await laptopRequests(page)
      await doubleClickName(page, "Studio Mac")
      await until(page, `document.querySelector('${section} .machine-row__input') !== null`)
      await type(page, "Draft Name")
      expect(await page.evaluate(`[...document.querySelectorAll('${section} .machine-row__connect')].every(button => button.disabled)`)).toBe(true)
      await page.evaluate(`${item("Laptop")}.querySelector('.machine-row__connect').click()`)
      await Bun.sleep(150)
      expect(await laptopRequests(page)).toBe(before)
      expect(await page.evaluate(`document.querySelector('${section} .machine-row__input').value`)).toBe("Draft Name")
      await doubleClickName(page, "Laptop")
      await until(page, `document.querySelectorAll('${section} .machine-row__input').length === 1 && document.querySelector('${section} .machine-row__input').getAttribute('aria-label') === 'Name for Laptop'`)
      expect(await aliases(page)).toEqual({})
      expect(await names(page)).toEqual(["Studio Mac", "Sleeping Mac"])
      await page.pressEscape()
      await until(page, `document.querySelector('${section} .machine-row__input') === null`)
      expect(await names(page)).toEqual(["Studio Mac", "Laptop", "Sleeping Mac"])
      expect(await page.evaluate(`[...document.querySelectorAll('${section} .machine-row__connect')].filter(button => !button.disabled).length === 1`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("names and hostnames containing markup render as literal text at every width", async () => {
    const hostile = "<img src=x onerror=window.pwned=1>"
    for (const width of [320, 390, 1440]) {
      const page = await open(width, `view=settings&machines=distinct&machineName=${encodeURIComponent("<b>Studio</b>")}`)
      try {
        expect(await names(page)).toEqual(["<b>Studio</b>", "Laptop", "Sleeping Mac"])
        await doubleClickName(page, "Laptop")
        await until(page, `document.querySelector('${section} .machine-row__input') !== null`)
        await type(page, hostile)
        await page.pressKey("Enter", "Enter", 13, "\r")
        await until(page, `document.querySelector('${section} .machine-row__input') === null`)
        expect(await names(page)).toEqual(["<b>Studio</b>", hostile, "Sleeping Mac"])
        const markup = await page.evaluate(`({ images: document.querySelectorAll('${section} img').length, bold: document.querySelectorAll('${section} b').length, pwned: window.pwned ?? null, title: ${item(hostile)}.querySelector('.machine-row__name').getAttribute('data-tooltip'), overflow: document.documentElement.scrollWidth > innerWidth })`)
        expect(markup).toEqual({ images: 0, bold: 0, pwned: null, title: "Laptop", overflow: false })
        expect(await aliases(page)).toEqual({ dev_laptop: hostile })
      } finally { await page.close() }
    }
  }, 60_000)

  test("keeps long names on one ellipsised line without widening the page", async () => {
    const longName = "build-agent-west-coast-production-07.example.internal"
    for (const width of [320, 390, 1440]) {
      const page = await open(width, `view=settings&machines=distinct&machineName=${encodeURIComponent(longName)}`)
      try {
        const state = await page.evaluate(`(() => { const name = document.querySelector('${section} .machine-row__name'), range = document.createRange(); range.selectNodeContents(name); return { text: name.textContent, whiteSpace: getComputedStyle(name).whiteSpace, textOverflow: getComputedStyle(name).textOverflow, truncated: name.scrollWidth > name.clientWidth, lines: new Set([...range.getClientRects()].map(rect => rect.top)).size, pageOverflow: document.documentElement.scrollWidth > innerWidth } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, text: (decodeString)(record["text"]), whiteSpace: (decodeString)(record["whiteSpace"]), textOverflow: (decodeString)(record["textOverflow"]), truncated: (decodeBoolean)(record["truncated"]), lines: (decodeNumber)(record["lines"]), pageOverflow: (decodeBoolean)(record["pageOverflow"]) } })
        expect(state.text).toBe(longName)
        expect(state.whiteSpace).toBe("nowrap")
        expect(state.textOverflow).toBe("ellipsis")
        expect(state.lines).toBe(1)
        expect(state.pageOverflow).toBe(false)
        if (width < 768) expect(state.truncated).toBe(true)
      } finally { await page.close() }
    }
  }, 60_000)

  test("saves canonical account aliases without sending a machine operation or overwriting the hostname", async () => {
    const page = await open(1440)
    try {
      await doubleClickName(page, "Studio Mac")
      await until(page, `document.querySelector('${section} .machine-row__input') !== null`)
      await type(page, "Studio Alias")
      await page.pressKey("Enter", "Enter", 13, "\r")
      await until(page, `${item("Studio Alias")} !== undefined`)
      expect(await aliases(page)).toEqual({ dev_studio: "Studio Alias" })
      expect(await page.evaluate(`window.requestLog.every(entry => !JSON.stringify(entry).includes('Studio Alias'))`)).toBe(true)
      expect(await page.evaluate(`window.remoteAliasReport().requests`)).toEqual([{ deviceID: "dev_studio", alias: "Studio Alias" }])
      expect(await page.evaluate(`document.querySelector('.device__name')?.textContent?.trim() ?? ''`)).toBe("Studio Alias")
      expect(await names(page)).toEqual(["Studio Alias", "Laptop", "Sleeping Mac"])
      expect(await page.evaluate(`${item("Studio Alias")}.querySelector('.machine-row__name').getAttribute('data-tooltip')`)).toBe("Studio Mac")
      expect(await page.evaluate(`document.querySelectorAll('.machine-row__hostname, .device__hostname').length`)).toBe(0)
      expect(await page.evaluate(`document.querySelector('${section} .machine-row__scope').textContent`)).toMatch(/account.*browsers/i)
    } finally { await page.close() }
  }, 30_000)

  test("fresh account metadata wins over existing browser-local names", async () => {
    const page = await open(390, "view=settings&machines=distinct&machineAlias=Account%20name")
    try {
      await page.evaluate(`localStorage.setItem('ycoding.remote.device-aliases', JSON.stringify({ dev_studio: 'Browser-only name' }))`)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=settings&machines=distinct&machineAlias=Account%20name`)
      await until(page, `${item("Account name")} !== undefined`)
      expect(await names(page)).toEqual(["Account name", "Laptop", "Sleeping Mac"])
      expect(await page.evaluate(`${item("Account name")}.querySelector('.machine-row__name').getAttribute('data-tooltip')`)).toBe("Studio Mac")
      expect(await page.evaluate(`JSON.parse(localStorage.getItem('ycoding.remote.device-aliases'))`)).toEqual({ dev_studio: "Browser-only name" })
    } finally { await page.close() }
  }, 30_000)

  test("keeps the draft and reported name on an alias failure without replaying the request", async () => {
    const page = await open(390, "view=settings&machines=distinct&aliasFailure=1")
    try {
      await doubleClickName(page, "Studio Mac")
      await until(page, `document.querySelector('${section} .machine-row__input') !== null`)
      await type(page, "Unsaved name")
      await page.pressKey("Enter", "Enter", 13, "\r")
      await until(page, `document.querySelector('${section} [role="alert"]') !== null`)
      expect(await page.evaluate(`document.querySelector('${section} .machine-row__input').value`)).toBe("Unsaved name")
      expect(await aliases(page)).toEqual({})
      expect(await page.evaluate(`window.remoteAliasReport().requests.length`)).toBe(1)
      await page.pressEscape()
      await until(page, `document.querySelector('${section} .machine-row__input') === null`)
      expect(await names(page)).toEqual(["Studio Mac", "Laptop", "Sleeping Mac"])
    } finally { await page.close() }
  }, 30_000)
})
