import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4794
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to the pinned Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

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
  throw new Error(`Dots state did not settle: ${condition}\n${await page.evaluate<string>(`document.querySelector('dialog[aria-label="Command palette"]')?.textContent`)}`)
}
async function open(page: Page, query = "") {
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&${query}`)
  await wait(page, `document.querySelector('button[aria-label="Open command palette"]') !== null`)
  await page.evaluate(`document.querySelector('button[aria-label="Open command palette"]').click()`)
  await wait(page, `document.querySelector('dialog[aria-label="Command palette"]')?.open === true`)
}

test("Dots access changes only after the machine confirms it", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "dotsOutcome=hold")
    await wait(page, `document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Enable Dots access')`)
    await page.evaluate(`document.getElementById('command-palette-option-session.dots.access').click()`)
    await wait(page, `document.querySelector('dialog[aria-label="Command palette"]')?.textContent.includes('Changing Dots access')`)
    await page.evaluate(`window.dotsFixture.release()`)
    await wait(page, `document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Disable Dots access')`)
    expect(await page.evaluate<{ enabled: boolean; expectedRevision: number }[]>(`window.remoteMutationReport().filter(entry => entry.operation === 'session.dots.access.set').map(entry => entry.input)`)).toEqual([{ enabled: true, expectedRevision: 1 }])
  } finally { await page.close() }
}, 60_000)

test.each(["off", "unavailable"])("Dots access %s offers no action", async (state) => {
  const page = await browser!.openPage()
  try {
    await open(page, `dotsCapability=${state}`)
    await wait(page, `document.querySelector('dialog[aria-label="Command palette"]')?.textContent.includes(${JSON.stringify(state === "off" ? "Dots is not configured" : "Dots access is unavailable")})`)
    expect(await page.evaluate(`document.getElementById('command-palette-option-session.dots.access')`)).toBeNull()
  } finally { await page.close() }
}, 60_000)

test.each(["failed", "unknown"])("Dots access %s is not replayed or presented as enabled", async (outcome) => {
  const page = await browser!.openPage()
  try {
    await open(page, `dotsOutcome=${outcome}`)
    await wait(page, `document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Enable Dots access')`)
    await page.evaluate(`document.getElementById('command-palette-option-session.dots.access').click()`)
    await wait(page, `[...document.querySelectorAll('dialog[aria-label="Command palette"] [role="status"]')].some(node => node.textContent.includes(${JSON.stringify(outcome === "failed" ? "Dots access changed" : "outcome is unknown")}))`)
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(entry => entry.operation === 'session.dots.access.set').length`)).toBe(1)
    expect(await page.evaluate<boolean>(`document.getElementById('command-palette-option-session.dots.access') === null`)).toBe(true)
  } finally { await page.close() }
}, 60_000)

test("a managed child cannot mutate Dots access", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "session_id=ses_child")
    await wait(page, `window.providerAuthState().activeSessionID === 'ses_child'`)
    expect(await page.evaluate<boolean>(`document.getElementById('command-palette-option-session.dots.access') === null`)).toBe(true)
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(entry => entry.operation === 'session.dots.access.set').length`)).toBe(0)
  } finally { await page.close() }
}, 60_000)

test("a late reply during disconnect cannot leave access pending after reconnect", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "dotsOutcome=hold")
    await wait(page, `document.getElementById('command-palette-option-session.dots.access') !== null`)
    await page.evaluate(`document.getElementById('command-palette-option-session.dots.access').click()`)
    await wait(page, `window.remoteMutationReport().some(entry => entry.operation === 'session.dots.access.set')`)
    await page.evaluate(`document.querySelector('.fixture__controls button:nth-child(2)').click(); window.dotsFixture.release()`)
    await wait(page, `window.providerAuthState().transport.kind === 'connecting'`)
    expect(await page.evaluate<boolean>(`document.getElementById('command-palette-option-session.dots.access') === null`)).toBe(true)
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(entry => entry.operation === 'session.dots.access.set').length`)).toBe(1)
    await wait(page, `window.providerAuthState().transport.kind === 'open'`)
    await wait(page, `document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Disable Dots access')`)
  } finally { await page.close() }
}, 60_000)

test.each([1440, 390])("keyboard Dots access toggles preserve the draft and focus at %i px", async (width) => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(width, 900)
    await page.setCoarsePointer(width === 390)
    await open(page, "dots=on")
    await wait(page, `document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Disable Dots access')`)
    await page.pressEscape()
    await wait(page, `document.querySelector('dialog[aria-label="Command palette"]') === null`)
    await page.evaluate(`(() => { const input = document.querySelector('.composer__input'); input.value = 'Keep this draft'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })) })()`)
    await wait(page, `document.querySelector('dialog[aria-label="Command palette"]')?.open === true`)
    await wait(page, `document.getElementById('command-palette-option-session.dots.access') !== null`)
    await page.evaluate(`(() => { const input = document.getElementById('command-palette-input'); input.value = 'dots access'; input.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
    await page.pressKey("Enter", "Enter", 13)
    await wait(page, `document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Enable Dots access')`)
    await page.pressKey("Enter", "Enter", 13)
    await wait(page, `document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Disable Dots access')`)
    expect(await page.evaluate<{ enabled: boolean; expectedRevision: number }[]>(`window.remoteMutationReport().filter(entry => entry.operation === 'session.dots.access.set').map(entry => entry.input)`)).toEqual([{ enabled: false, expectedRevision: 1 }, { enabled: true, expectedRevision: 2 }])
    await page.evaluate(`Promise.all(document.querySelector('dialog[aria-label="Command palette"]').getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))`)
    expect(await page.evaluate<boolean>(`(() => { const row = document.getElementById('command-palette-option-session.dots.access').getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth && row.left >= 0 && row.right <= innerWidth && row.height >= 44 && document.activeElement === document.getElementById('command-palette-input') })()`)).toBe(true)
    await page.pressEscape()
    await wait(page, `document.querySelector('dialog[aria-label="Command palette"]') === null`)
    expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.composer__input') && document.activeElement.value === 'Keep this draft'`)).toBe(true)
  } finally { await page.close() }
}, 60_000)

test("a late reply after reconnect cannot update the current access read", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "dotsOutcome=hold")
    await wait(page, `document.getElementById('command-palette-option-session.dots.access') !== null`)
    await page.evaluate(`document.getElementById('command-palette-option-session.dots.access').click(); document.querySelector('.fixture__controls button:nth-child(2)').click()`)
    await wait(page, `window.providerAuthState().transport.kind === 'connecting'`)
    await wait(page, `window.providerAuthState().transport.kind === 'open' && document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Enable Dots access')`)
    const reads = await page.evaluate<number>(`window.requestLog.filter(entry => entry.operation === 'session.dots.access.get').length`)
    await page.evaluate(`window.dotsFixture.release()`)
    expect(await page.evaluate<number>(`window.requestLog.filter(entry => entry.operation === 'session.dots.access.get').length`)).toBe(reads)
    expect(await page.evaluate<boolean>(`document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Enable Dots access')`)).toBe(true)
  } finally { await page.close() }
}, 60_000)

test("a late root reply cannot update a selected child", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "dotsOutcome=hold")
    await wait(page, `document.getElementById('command-palette-option-session.dots.access') !== null`)
    await page.evaluate(`document.getElementById('command-palette-option-session.dots.access').click()`)
    await page.pressEscape()
    await wait(page, `document.querySelector('dialog[aria-label="Command palette"]') === null`)
    await page.evaluate(`document.querySelector('.app-header [aria-label="Open Team"]').click()`)
    await wait(page, `document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="open"]') !== null`)
    await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="open"]').click()`)
    await wait(page, `window.providerAuthState().activeSessionID === 'ses_child' && document.querySelector('.subagent-bar') !== null`)
    await page.evaluate(`document.querySelector('button[aria-label="Open command palette"]').click()`)
    await wait(page, `document.querySelector('dialog[aria-label="Command palette"]')?.open === true`)
    await page.evaluate(`window.dotsFixture.release()`)
    expect(await page.evaluate<boolean>(`window.providerAuthState().activeSessionID === 'ses_child' && document.getElementById('command-palette-option-session.dots.access') === null`)).toBe(true)
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(entry => entry.operation === 'session.dots.access.set').length`)).toBe(1)
  } finally { await page.close() }
}, 60_000)

test("a late reply from another machine cannot change the selected family's access", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "dotsOutcome=hold&machines=distinct")
    await wait(page, `document.getElementById('command-palette-option-session.dots.access') !== null`)
    await page.evaluate(`document.getElementById('command-palette-option-session.dots.access').click(); document.getElementById('command-palette-option-nav.settings').click()`)
    await wait(page, `location.pathname === '/remote/settings' && document.querySelector('dialog[aria-label="Command palette"]') === null`)
    await page.evaluate(`document.querySelector('button[aria-label="Open command palette"]').click()`)
    await wait(page, `document.getElementById('command-palette-option-device.switch.dev_laptop') !== null`)
    await page.evaluate(`document.getElementById('command-palette-option-device.switch.dev_laptop').click()`)
    await wait(page, `window.providerAuthState().activeDeviceID === 'dev_laptop' && window.providerAuthState().sessionListStatus === 'ready' && document.querySelector('dialog[aria-label="Command palette"]') === null`)
    await page.evaluate(`document.querySelector('button[aria-label="Open command palette"]').click()`)
    await wait(page, `document.getElementById('command-palette-option-session.open.ses_laptop') !== null`)
    await page.evaluate(`document.getElementById('command-palette-option-session.open.ses_laptop').click()`)
    await wait(page, `window.providerAuthState().activeSessionID === 'ses_laptop' && document.querySelector('dialog[aria-label="Command palette"]') === null`)
    await page.evaluate(`document.querySelector('button[aria-label="Open command palette"]').click()`)
    await wait(page, `document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Enable Dots access')`)
    const reads = await page.evaluate<number>(`window.requestLog.filter(entry => entry.operation === 'session.dots.access.get').length`)
    await page.evaluate(`window.dotsFixture.release()`)
    expect(await page.evaluate<boolean>(`window.providerAuthState().activeSessionID === 'ses_laptop' && document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Enable Dots access')`)).toBe(true)
    expect(await page.evaluate<number>(`window.requestLog.filter(entry => entry.operation === 'session.dots.access.get').length`)).toBe(reads)
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(entry => entry.operation === 'session.dots.access.set').length`)).toBe(1)
  } finally { await page.close() }
}, 60_000)

test("a stale revision refreshes access without replaying the mutation", async () => {
  const page = await browser!.openPage()
  try {
    await open(page)
    await wait(page, `document.getElementById('command-palette-option-session.dots.access') !== null`)
    await page.evaluate(`window.dotsFixture.change(true, false); document.getElementById('command-palette-option-session.dots.access').click()`)
    await wait(page, `[...document.querySelectorAll('dialog[aria-label="Command palette"] [role="status"]')].some(node => node.textContent.includes('Dots access changed'))`)
    expect(await page.evaluate<{ enabled: boolean; expectedRevision: number }[]>(`window.remoteMutationReport().filter(entry => entry.operation === 'session.dots.access.set').map(entry => entry.input)`)).toEqual([{ enabled: true, expectedRevision: 1 }])
    await page.pressEscape()
    await wait(page, `document.querySelector('dialog[aria-label="Command palette"]') === null`)
    await page.evaluate(`document.querySelector('button[aria-label="Open command palette"]').click()`)
    await wait(page, `document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Disable Dots access')`)
    await page.evaluate(`window.dotsFixture.change(false, true)`)
    await wait(page, `document.getElementById('command-palette-option-session.dots.access')?.textContent.includes('Enable Dots access')`)
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(entry => entry.operation === 'session.dots.access.set').length`)).toBe(1)
  } finally { await page.close() }
}, 60_000)
