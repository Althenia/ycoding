import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4794
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to the pinned Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>
type AccessChange = { readonly enabled: boolean; readonly expectedRevision: number }
type DialogLayout = { readonly pageFits: boolean; readonly dialogFits: boolean; readonly buttonFits: boolean; readonly touchTarget: boolean; readonly oneClose: boolean; readonly focused: boolean }

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
  for (let index = 0; index < 160; index++) { if (await page.evaluate<boolean>(condition)) return; await Bun.sleep(50) }
  throw new Error(`Dots state did not settle: ${condition}\n${await page.evaluate<string>(`document.querySelector('dialog[aria-label="Dots connection"]')?.textContent`)}`)
}
async function open(page: Page, query = "") {
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&${query}`)
  await wait(page, `document.querySelector('button[aria-label="Open command palette"]') !== null`)
  await page.evaluate(`document.querySelector('button[aria-label="Open command palette"]').click()`)
  await wait(page, `document.querySelector('dialog[aria-label="Command palette"]')?.open === true`)
  await wait(page, `document.getElementById('command-palette-option-dots.connection') !== null`)
  await page.evaluate(`document.getElementById('command-palette-option-dots.connection').click()`)
  await wait(page, `document.querySelector('dialog[aria-label="Dots connection"]')?.open === true`)
}

const action = ".dots-connection__actions button:first-child"
const fact = (name: string) => `[...document.querySelectorAll('.dots-connection dt')].find(node => node.textContent === ${JSON.stringify(name)})?.nextElementSibling?.textContent.trim()`
const changes = `window.remoteMutationReport().filter(entry => entry.operation === 'dots.set')`

test("named Dots computers render distinct registered names and confirm their exact target once", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "dots=on&dotsName=Native%20desk&dotsExecutorName=Executor%20desk")
    await wait(page, `${fact("Name")} === 'Native desk' && ${fact("Executor name")} === 'Executor desk'`)
    expect(await page.evaluate<string>(fact("Computer"))).toBe("Studio Mac")
    expect(await page.evaluate<string>(fact("Executor"))).toBe("Not attached")
    await page.evaluate(`[...document.querySelectorAll('.dots-connection button')].find(node => node.textContent === 'Use this computer for Dots tasks').click()`)
    await wait(page, `document.querySelector('[aria-label="Confirm computer change"]') !== null`)
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(entry => entry.operation === 'dots.attach').length`)).toBe(0)
    await page.evaluate(`const button = document.querySelector('[aria-label="Confirm computer change"] .button--primary'); button.click(); button.click()`)
    await wait(page, `${fact("Executor")} === 'Attached'`)
    expect(await page.evaluate<unknown[]>(`window.remoteMutationReport().filter(entry => entry.operation === 'dots.attach').map(entry => entry.input)`)).toEqual([
      { replaceOthers: true, expectedTarget: { dotID: "dot_fixture", threadID: "thread_fixture", environmentID: "env_dev_studio", revision: "a".repeat(64) } },
    ])
    expect(await page.evaluate<string>(fact("Name"))).toBe("Native desk")
    expect(await page.evaluate<string>(fact("Executor name"))).toBe("Executor desk")
  } finally { await page.close() }
}, 60_000)

test.each(["", "noSelection=1", "session_id=ses_child"])("backend Dots information and controls are available from %s", async (query) => {
  const page = await browser!.openPage()
  try {
    await open(page, query)
    await wait(page, `${fact("Access")} === 'Off'`)
    expect(await page.evaluate<(string | undefined)[]>(`['Computer', 'Profile', 'Configuration', 'Access', 'Transport'].map(name => [...document.querySelectorAll('.dots-connection dt')].find(node => node.textContent === name)?.nextElementSibling.textContent.trim())`)).toEqual(["Studio Mac", "native-test", "Ready", "Off", "Off"])
    expect(await page.evaluate<boolean>(`document.querySelector('.dots-connection').textContent.includes('every existing and future eligible Session')`)).toBe(true)
    await page.evaluate(`document.querySelector('${action}').click()`)
    await wait(page, `${fact("Access")} === 'On' && !document.querySelector('${action}').disabled`)
    expect(await page.evaluate<AccessChange[]>(`${changes}.map(entry => entry.input)`)).toEqual([{ enabled: true, expectedRevision: 1 }])
    expect(await page.evaluate<boolean>(`window.remoteDeviceRequests.filter(entry => entry.operation.startsWith('dots.')).every(entry => entry.sessionID === undefined)`)).toBe(true)
  } finally { await page.close() }
}, 60_000)

test("pending access is not optimistic and repeated activation sends once", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "dotsOutcome=hold&dotsTransport=connecting")
    await wait(page, `!document.querySelector('${action}').disabled`)
    await page.evaluate(`document.querySelector('${action}').click(); document.querySelector('${action}').click()`)
    await wait(page, `document.querySelector('.dots-connection').getAttribute('aria-busy') === 'true'`)
    expect(await page.evaluate<string | undefined>(fact("Access"))).toBe("Off")
    expect(await page.evaluate<string | undefined>(fact("Transport"))).toBe("Connecting")
    expect(await page.evaluate<number>(`${changes}.length`)).toBe(1)
    await page.evaluate(`window.dotsFixture.release()`)
    await wait(page, `${fact("Access")} === 'On' && !document.querySelector('${action}').disabled`)
    expect(await page.evaluate<string | undefined>(fact("Transport"))).toBe("Connecting")
  } finally { await page.close() }
}, 60_000)

test.each(["off", "unavailable"])("unready configuration or status %s disables access with recovery", async (state) => {
  const page = await browser!.openPage()
  try {
    await open(page, `dotsCapability=${state}`)
    await wait(page, `document.querySelector('.dots-connection').textContent.includes(${JSON.stringify(state === "off" ? "Configure Dots" : "Dots status is unavailable")})`)
    expect(await page.evaluate<boolean>(`document.querySelector('${action}').disabled`)).toBe(true)
    expect(await page.evaluate<string | undefined>(fact("Access"))).toBe(state === "off" ? "Off" : "Unreported")
    expect(await page.evaluate<string>(`document.querySelector('.dots-connection__actions button:last-child').textContent`)).toBe("Refresh")
  } finally { await page.close() }
}, 60_000)

test.each(["failed", "unknown"])("%s access outcomes reread without replay", async (outcome) => {
  const page = await browser!.openPage()
  try {
    await open(page, `dotsOutcome=${outcome}`)
    await wait(page, `!document.querySelector('${action}').disabled`)
    await page.evaluate(`document.querySelector('${action}').click()`)
    await wait(page, `document.querySelector('.dots-connection [role="alert"]')?.textContent.includes(${JSON.stringify(outcome === "failed" ? "Dots access changed" : "outcome is unknown")})`)
    await wait(page, `window.requestLog.filter(entry => entry.operation === 'dots.get').length >= 2`)
    expect(await page.evaluate<number>(`${changes}.length`)).toBe(1)
    expect(await page.evaluate<string | undefined>(fact("Access"))).toBe("Off")
  } finally { await page.close() }
}, 60_000)

test("stale revision rereads authoritative access and polls external transport changes", async () => {
  const page = await browser!.openPage()
  try {
    await open(page)
    await wait(page, `!document.querySelector('${action}').disabled`)
    await page.evaluate(`window.dotsFixture.change(true); document.querySelector('${action}').click()`)
    await wait(page, `document.querySelector('.dots-connection [role="alert"]')?.textContent.includes('Dots access changed') && ${fact("Access")} === 'On'`)
    expect(await page.evaluate<AccessChange[]>(`${changes}.map(entry => entry.input)`)).toEqual([{ enabled: true, expectedRevision: 1 }])
    await page.evaluate(`window.dotsFixture.transport('error')`)
    await wait(page, `${fact("Transport")}?.includes('Native transport failed')`)
    expect(await page.evaluate<string | undefined>(fact("Access"))).toBe("On")
    expect(await page.evaluate<number>(`${changes}.length`)).toBe(1)
  } finally { await page.close() }
}, 60_000)

test("loading and reconnect discard obsolete pending feedback and reread without replay", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "dotsRead=hold&dotsOutcome=hold")
    await wait(page, `document.querySelector('.dots-connection').textContent.includes('Loading Dots connection')`)
    expect(await page.evaluate<string | undefined>(fact("Access"))).toBe("Unreported")
    expect(await page.evaluate<boolean>(`document.querySelector('${action}').disabled`)).toBe(true)
    await page.evaluate(`window.dotsFixture.release()`)
    await wait(page, `!document.querySelector('${action}').disabled`)
    await page.evaluate(`document.querySelector('${action}').click()`)
    await wait(page, `${changes}.length === 1`)
    await page.evaluate(`document.querySelector('.fixture__controls button:nth-child(2)').click()`)
    await wait(page, `document.querySelector('.dots-connection').textContent.includes('Reconnect')`)
    expect(await page.evaluate<boolean>(`document.querySelector('${action}').disabled`)).toBe(true)
    await wait(page, `window.providerAuthState().transport.kind === 'open' && !document.querySelector('${action}').disabled`)
    const reads = await page.evaluate<number>(`window.requestLog.filter(entry => entry.operation === 'dots.get').length`)
    await page.evaluate(`window.dotsFixture.release()`)
    expect(await page.evaluate<number>(`window.requestLog.filter(entry => entry.operation === 'dots.get').length`)).toBe(reads)
    expect(await page.evaluate<string | undefined>(fact("Access"))).toBe("Off")
    expect(await page.evaluate<number>(`${changes}.length`)).toBe(1)
  } finally { await page.close() }
}, 60_000)

test("Session selection preserves global ownership while machine replacement rejects late settlement", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "dotsOutcome=hold&machines=distinct")
    await wait(page, `!document.querySelector('${action}').disabled`)
    await page.evaluate(`document.querySelector('${action}').click(); document.querySelector('a[href^="/remote/settings"]').click()`)
    await wait(page, `location.pathname === '/remote/settings'`)
    await page.evaluate(`window.dotsFixture.select('ses_child')`)
    await wait(page, `window.providerAuthState().activeSessionID === 'ses_child'`)
    expect(await page.evaluate<string | null>(`document.querySelector('.dots-connection').getAttribute('aria-busy')`)).toBe("true")
    await page.evaluate(`window.dotsFixture.connect('dev_laptop')`)
    await wait(page, `${fact("Computer")} === 'Laptop' && !document.querySelector('${action}').disabled`)
    expect(await page.evaluate<string | undefined>(fact("Access"))).toBe("Off")
    const reads = await page.evaluate<number>(`window.requestLog.filter(entry => entry.operation === 'dots.get').length`)
    await page.evaluate(`window.dotsFixture.release()`)
    expect(await page.evaluate<string | undefined>(fact("Access"))).toBe("Off")
    expect(await page.evaluate<number>(`window.requestLog.filter(entry => entry.operation === 'dots.get').length`)).toBe(reads)
    expect(await page.evaluate<number>(`${changes}.length`)).toBe(1)
  } finally { await page.close() }
}, 60_000)

test("a dismissed mutation cannot invalidate a newly opened dialog", async () => {
  const page = await browser!.openPage()
  try {
    await open(page, "dotsOutcome=hold")
    await wait(page, `!document.querySelector('${action}').disabled`)
    await page.evaluate(`document.querySelector('${action}').click()`)
    await page.pressEscape()
    await wait(page, `document.querySelector('dialog[aria-label="Dots connection"]') === null`)
    await page.evaluate(`document.querySelector('button[aria-label="Open command palette"]').click()`)
    await wait(page, `document.getElementById('command-palette-option-dots.connection') !== null`)
    await page.evaluate(`document.getElementById('command-palette-option-dots.connection').click()`)
    await wait(page, `!document.querySelector('${action}').disabled`)
    const reads = await page.evaluate<number>(`window.requestLog.filter(entry => entry.operation === 'dots.get').length`)
    await page.evaluate(`window.dotsFixture.release()`)
    expect(await page.evaluate<string | undefined>(fact("Access"))).toBe("Off")
    expect(await page.evaluate<number>(`window.requestLog.filter(entry => entry.operation === 'dots.get').length`)).toBe(reads)
  } finally { await page.close() }
}, 60_000)

test.each([320, 390, 767, 768, 1440])("keyboard focus, both themes and wrapping retain the draft at %i px", async (width) => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(width, 900)
    await page.setCoarsePointer(width < 768)
    await page.setReducedMotion(width === 320)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&dots=on&dotsProfile=${'long-profile-'.repeat(12)}`)
    await wait(page, `document.querySelector('.composer__input') !== null`)
    await page.evaluate(`(() => { const input = document.querySelector('.composer__input'); input.value = 'Keep this draft'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })) })()`)
    await wait(page, `document.getElementById('command-palette-option-dots.connection') !== null`)
    await page.evaluate(`(() => { const input = document.getElementById('command-palette-input'); input.value = 'dots connection'; input.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('${action}') && !document.querySelector('${action}').disabled`)
    await page.evaluate(`document.querySelector('${action}').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `${fact("Access")} === 'Off' && !document.querySelector('${action}').disabled`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `${fact("Access")} === 'On' && !document.querySelector('${action}').disabled`)
    expect(await page.evaluate<AccessChange[]>(`${changes}.map(entry => entry.input)`)).toEqual([{ enabled: false, expectedRevision: 1 }, { enabled: true, expectedRevision: 2 }])
    for (const scheme of ["light", "dark"] as const) {
      await page.setColorScheme(scheme)
      await page.evaluate(`document.documentElement.dataset.theme = '${scheme}'`)
      await page.evaluate(`Promise.all(document.querySelector('dialog[aria-label="Dots connection"]').getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))`)
      expect(await page.evaluate<DialogLayout>(`(() => { const dialog = document.querySelector('dialog[aria-label="Dots connection"]'); const button = document.querySelector('${action}'); const box = button.getBoundingClientRect(); return { pageFits: document.documentElement.scrollWidth <= innerWidth, dialogFits: dialog.scrollWidth <= dialog.clientWidth, buttonFits: box.left >= 0 && box.right <= innerWidth, touchTarget: box.height >= 44, oneClose: dialog.querySelectorAll('button[aria-label="Close Dots connection"]').length === 1, focused: document.activeElement === button } })()`)).toEqual({ pageFits: true, dialogFits: true, buttonFits: true, touchTarget: true, oneClose: true, focused: true })
      if (width === 320 || width === 1440) await Bun.write(new URL(`../.artifacts/dots-connection-${width}-${scheme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    }
    await page.pressKey("Tab", "Tab", 9)
    await page.pressKey("Tab", "Tab", 9)
    expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('dialog[aria-label="Dots connection"] button[aria-label="Close Dots connection"]')`)).toBe(true)
    await page.pressEscape()
    await wait(page, `document.querySelector('dialog[aria-label="Dots connection"]') === null`)
    expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.composer__input') && document.activeElement.value === 'Keep this draft'`)).toBe(true)
    expect(await page.evaluate<number>(`window.requestLog.filter(entry => entry.operation.startsWith('session.dots.')).length`)).toBe(0)
  } finally { await page.close() }
}, 60_000)
