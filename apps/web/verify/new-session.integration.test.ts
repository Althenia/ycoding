import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4326
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("new session opens in the main area with repository names, selected model and prompt", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions`)
    await wait(page, `document.querySelector('.sessions-page__toolbar .new-session__trigger:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.sessions-page__toolbar .new-session__trigger')?.click()`)
    await wait(page, `document.querySelector('.workspace__main .new-session-composer textarea') !== null`)
    expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"]') === null`)).toBe(true)
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Repository"]')?.click()`)
    await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].map(item => item.textContent.trim())`)).toEqual(["YCoding", "Other repository"])
    await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.trim() === 'Other repository')?.click()`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Model"]:not([disabled])') !== null`)
    await type(page, ".new-session-composer textarea", "Start a new task")
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]')?.click()`)
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.create')`)
    expect(await page.evaluate<unknown>(`window.remoteMutationReport().find(item => item.operation === 'session.create')?.input`)).toMatchObject({ workspace: "workspace_other", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" } })
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.prompt' && item.input?.text === 'Start a new task')`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() === 'New session'`)
  } finally { await page.close() }
}, 30_000)

test("unknown creation retries the same admission without a second create", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&creation=unknown`)
    await wait(page, `document.querySelector('.sessions-page__toolbar .new-session__trigger:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.sessions-page__toolbar .new-session__trigger')?.click()`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Create session"]:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]')?.click()`)
    await wait(page, `document.querySelector('.new-session__outcome--unknown') !== null`)
    expect(await page.evaluate<string>(`document.querySelector('.new-session__outcome--unknown')?.textContent`)).toContain("Check Sessions before dismissing")
    await page.evaluate(`document.querySelector('.new-session__outcome--unknown button')?.click()`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() === 'New session'`)
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(item => item.operation === 'session.create').length`)).toBe(1)
  } finally { await page.close() }
}, 30_000)

async function type(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, selector: string, text: string) {
  await page.evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus(); field.value = ${JSON.stringify(text)}; field.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
}
async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}; ${await page.evaluate<string>(`JSON.stringify({ url: location.href, breadcrumb: document.querySelector('.conversation-breadcrumb')?.textContent, composer: document.querySelector('.new-session-composer')?.outerHTML?.slice(0, 800), body: document.body.innerText.slice(-500), requests: window.remoteMutationReport().slice(-3) })`)} `)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false) }
