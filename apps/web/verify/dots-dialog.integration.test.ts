import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4794
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>
const modal = 'dialog[aria-label="Select Dots destination"]'
const input = '.workspace__main textarea.composer__input'

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 80; index++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) break
    await Bun.sleep(100)
  }
  browser = await launchBrowser(browserPath, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

async function wait(page: Page, condition: string) {
  for (let index = 0; index < 80; index++) { if (await page.evaluate<boolean>(condition)) return; await Bun.sleep(50) }
  throw new Error(`Dots state did not settle: ${condition}`)
}
async function load(page: Page, query: string) {
  await page.injectOnNewDocument(`localStorage.removeItem('ycoding.remote.composer-collapsed')`)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&${query}`)
  await wait(page, `document.querySelector('${input}') !== null`)
  await wait(page, `(window.remoteOperationReport().operations['session.dots.status'] ?? 0) >= 1`)
}
const type = (page: Page, value: string) => page.evaluate(`(() => { const field = document.querySelector('${input}'); field.focus(); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', {bubbles:true})); })()`)
const options = (page: Page) => page.evaluate<string[]>(`[...document.querySelectorAll('.workspace__main [role="option"]')].map(option => option.textContent)`)
async function open(page: Page, query = "dots=unpaused") {
  await load(page, query)
  await type(page, "/dots")
  await wait(page, `[...document.querySelectorAll('.workspace__main [role="option"]')].some(option => option.textContent.includes('/dots'))`)
  await page.evaluate(`document.querySelector('.workspace__main button[aria-label="Send prompt"]').click()`)
  await wait(page, `document.querySelector('${modal}')?.open === true`)
}
const click = (page: Page, label: string) => page.evaluate(`[...document.querySelectorAll('${modal} button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})?.click()`)
const text = (page: Page) => page.evaluate<string>(`document.querySelector('${modal}').textContent`)
const operations = (page: Page) => page.evaluate<{ operation: string; input: unknown }[]>(`window.remoteMutationReport().filter(entry => entry.operation.startsWith('session.dots.'))`)

test("Dots Pause and Resume use the displayed target and returned runtime state", async () => {
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.setCoarsePointer(width === 390)
      await open(page, "dots=unpaused&dotsOutcome=hold")
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await wait(page, `document.querySelector('${modal}')?.textContent.includes('Pause Dot')`)
      expect(await text(page)).toContain("Fixture Dot")
      expect(await text(page)).toContain("thread-1")
      expect(await text(page)).toContain("Not paused")
      expect(await text(page)).toContain("Pause stops the Dot's autonomous runtime until Resume; Resume may continue its work and goals.")
      expect(await text(page)).not.toContain("Stop active response")
      expect(await operations(page)).toEqual([])
      expect(await page.evaluate<number>(`window.remoteOperationReport().operations['session.dots.status']`)).toBe(2)
      await click(page, "Pause Dot")
      await wait(page, `window.remoteMutationReport().some(entry => entry.operation === 'session.dots.pause')`)
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('${modal} button')].filter(button => ['Refresh status','Change destination','Pause Dot','Resume Dot'].includes(button.textContent.trim())).every(button => button.disabled)`)).toBe(true)
      expect(await text(page)).not.toContain("Not paused")
      await page.evaluate(`window.dotsFixture.release()`)
      await wait(page, `document.querySelector('${modal}')?.textContent.includes('Resume Dot')`)
      expect(await text(page)).toContain("Paused")
      await click(page, "Resume Dot")
      await wait(page, `window.remoteMutationReport().filter(entry => entry.operation === 'session.dots.resume').length === 1`)
      await page.evaluate(`window.dotsFixture.release()`)
      await wait(page, `document.querySelector('${modal}')?.textContent.includes('Pause Dot')`)
      expect(await operations(page)).toEqual(["pause", "resume"].map((action) => ({ operation: `session.dots.${action}`, input: { expectedTarget: { profile: "fixture", dotID: "dot-1", threadID: "thread-1", generation: "generation-1", label: "Fixture Dot" } } })))
      expect(await page.evaluate<number>(`window.remoteOperationReport().operations['session.dots.status']`)).toBe(2)
      expect(await page.evaluate<string>(`document.querySelector('${input}').value`)).toBe("/dots")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      await page.pressEscape()
      await wait(page, `document.querySelector('${modal}') === null`)
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('${input}')`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

test.each(["failed", "unknown"])("Dots %s runtime action retains the dialog and requires Refresh without replay", async (outcome) => {
  const page = await browser!.openPage()
  try {
    await open(page, `dots=unpaused&dotsOutcome=${outcome}`)
    await wait(page, `document.querySelector('${modal}')?.textContent.includes('Pause Dot')`)
    await click(page, "Pause Dot")
    await wait(page, `document.querySelector('${modal} [role="alert"]') !== null`)
    expect(await text(page)).toContain("not confirmed")
    expect(await text(page)).not.toContain("Pause Dot")
    expect(await text(page)).not.toContain("Resume Dot")
    expect(await operations(page)).toHaveLength(1)
    await page.evaluate(`window.dotsFixture.runtime('paused')`)
    await click(page, "Refresh status")
    await wait(page, `document.querySelector('${modal}')?.textContent.includes(${JSON.stringify(outcome === "unknown" ? "Runtime state unavailable" : "Resume Dot")})`)
    expect(await operations(page)).toHaveLength(1)
    if (outcome === "unknown") {
      expect(await text(page)).not.toContain("Resume Dot")
      expect(await text(page)).not.toContain("Pause Dot")
    }
    await click(page, "Change destination")
    expect(await text(page)).not.toContain("Resume Dot")
    expect(await text(page)).not.toContain("Pause Dot")
    if (outcome === "unknown") {
      await page.evaluate(`(() => { const field = document.querySelector('${modal} input:not([type="radio"])'); field.value='fixture'; field.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await click(page, "Read destinations")
      await wait(page, `document.querySelector('${modal} input[type="radio"]') !== null`)
      await page.evaluate(`document.querySelector('${modal} input[type="radio"]').click()`)
      await click(page, "Confirm destination")
      await wait(page, `document.querySelector('${modal}') === null`)
      await page.evaluate(`document.querySelector('.workspace__main button[aria-label="Send prompt"]').click()`)
      await wait(page, `document.querySelector('${modal}')?.textContent.includes('Resume Dot')`)
      expect((await operations(page)).map((entry) => entry.operation)).toEqual(["session.dots.pause", "session.dots.bind"])
    }
    await page.pressEscape()
    expect(await operations(page)).toHaveLength(outcome === "unknown" ? 2 : 1)
  } finally { await page.close() }
}, 30_000)

test("Dots destination confirmation sends no draft and unreported runtime exposes no actions", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "dots=unbound")
    await wait(page, `document.querySelector('${modal} input:not([type="radio"])') !== null`)
    expect(await text(page)).not.toContain("Pause stops")
    await page.evaluate(`(() => { const field = document.querySelector('${modal} input:not([type="radio"])'); field.value='fixture'; field.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await click(page, "Read destinations")
    await wait(page, `document.querySelector('${modal} input[type="radio"]') !== null`)
    expect(await page.evaluate<boolean>(`document.querySelector('${modal} input[type="radio"]').checked`)).toBe(false)
    await page.evaluate(`document.querySelector('${modal} input[type="radio"]').click()`)
    await click(page, "Confirm destination")
    await wait(page, `document.querySelector('${modal}') === null`)
    expect((await operations(page)).map((entry) => entry.operation)).toEqual(["session.dots.bind"])
    expect(await page.evaluate<string>(`document.querySelector('${input}').value`)).toBe("/dots")
    await open(page, "dots=missing")
    await wait(page, `document.querySelector('${modal}')?.textContent.includes('Runtime state unavailable')`)
    expect(await text(page)).not.toContain("Pause Dot")
    expect(await text(page)).not.toContain("Resume Dot")
    await page.pressEscape()
    expect(await operations(page)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test.each(["disconnected", "unknown"])("%s Dots status offers no runtime mutation", async (state) => {
  const page = await browser!.openPage()
  try {
    await open(page, `dots=${state}`)
    await wait(page, `document.querySelector('${modal}')?.textContent.includes('Runtime state unavailable')`)
    expect(await text(page)).not.toContain("Pause Dot")
    expect(await text(page)).not.toContain("Resume Dot")
    expect(await text(page)).toContain("Refresh status")
    expect(await operations(page)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("closing Dots during Pause ignores late completion without replay", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "dots=unpaused&dotsOutcome=hold")
    await wait(page, `document.querySelector('${modal}')?.textContent.includes('Pause Dot')`)
    await click(page, "Pause Dot")
    await wait(page, `window.remoteMutationReport().some(entry => entry.operation === 'session.dots.pause')`)
    await page.pressEscape()
    await wait(page, `document.querySelector('${modal}') === null`)
    await page.evaluate(`window.dotsFixture.release()`)
    await page.evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`)
    expect(await operations(page)).toHaveLength(1)
    expect(await page.evaluate<boolean>(`document.querySelector('${modal}') === null`)).toBe(true)
    expect(await page.evaluate<string>(`document.querySelector('${input}').value`)).toBe("/dots")
  } finally { await page.close() }
}, 30_000)

test.each(["off", "omitted", "unavailable"])("Dots stays hidden and a typed /dots is refused without a model prompt when the capability is %s", async (capability) => {
  for (const [width, theme] of [[390, "light"], [1440, "dark"]] as const) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.setCoarsePointer(width === 390)
      await load(page, `dotsCapability=${capability}`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await type(page, "/dots")
      await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      expect((await options(page)).some((option) => option.includes("/dots"))).toBe(false)
      await page.evaluate(`document.querySelector('.workspace__main button[aria-label="Send prompt"]').click()`)
      await wait(page, `document.querySelector('.workspace__main [role="alert"]')?.textContent.includes('Dots is disabled')`)
      expect(await page.evaluate<string>(`document.querySelector('${input}').value`)).toBe("/dots")
      expect(await page.evaluate<boolean>(`document.querySelector('${modal}') === null`)).toBe(true)
      const report = await page.evaluate<Record<string, number>>(`window.remoteOperationReport().operations`)
      expect(Object.keys(report).filter((operation) => operation.startsWith("session.dots.") || operation === "session.prompt" || operation === "session.attachment.upload")).toEqual(["session.dots.status"])
      expect(report["session.dots.status"]).toBe(1)
      expect(await page.evaluate<unknown[]>(`window.remoteMutationReport()`)).toEqual([])
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)
