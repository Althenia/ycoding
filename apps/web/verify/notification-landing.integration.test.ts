import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4329
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

const landing = { type: "ycoding:open-session", sessionID: "ses_laptop", deviceID: "dev_laptop", noticeID: "ntc_7" }

test("a service-worker message in an open window on another machine lands on the notified machine's Session", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&machines=distinct`)
    await wait(page, `document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb strong')?.textContent?.includes('Stream remote output safely') === true`)
    expect(await page.evaluate<boolean>(`navigator.serviceWorker !== undefined`)).toBe(true)
    await page.evaluate(`window.remoteDeviceRequests.length = 0; navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(landing)} }))`)
    await expectLanded(page)
  } finally { await page.close() }
}, 30_000)

for (const laptop of ["offline", "unlisted"]) test(`a service-worker message lands on a machine the window's account read listed ${laptop} but is online now`, async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&machines=distinct&laptop=${laptop}`)
    await wait(page, `document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb strong')?.textContent?.includes('Stream remote output safely') === true`)
    expect(await page.evaluate<unknown>(`window.providerAuthState().devices.find(item => item.id === 'dev_laptop')?.online ?? 'unlisted'`)).toBe(laptop === "offline" ? false : "unlisted")
    await page.evaluate(`window.remoteBringLaptopOnline(); window.remoteDeviceRequests.length = 0; navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(landing)} }))`)
    await expectLanded(page)
  } finally { await page.close() }
}, 30_000)

test("a cold notification URL opened while another machine is remembered lands on the notified machine's Session", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&machines=distinct&session_id=ses_laptop&device_id=dev_laptop&notice_id=ntc_7`)
    await expectLanded(page)
  } finally { await page.close() }
}, 30_000)

test("a failed account refresh settles the notification landing without switching machines", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&machines=distinct&laptop=offline&accountRefresh=failed`)
    await wait(page, `document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb strong') !== null`)
    await page.evaluate(`window.remoteBringLaptopOnline(); navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(landing)} }))`)
    await wait(page, `document.querySelector('.route-panel:not([inert]) [role="alert"]')?.textContent?.includes('offline') === true`)
    expect(await page.evaluate<string>(`window.providerAuthState().activeDeviceID`)).toBe("dev_studio")
    expect(await page.evaluate<boolean>(`document.body.innerText.includes('Synthetic account refresh failed')`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

for (const [deviceID, copy] of [["dev_unknown", "unavailable to this account"], ["dev_retired", "unavailable to this account"], ["dev_asleep", "is offline"]] as const)
  test(`a notification for ${deviceID} reports its machine unavailable and keeps the selected machine`, async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&machines=distinct`)
      await wait(page, `document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb strong')?.textContent?.includes('Stream remote output safely') === true`)
      await page.evaluate(`window.remoteDeviceRequests.length = 0; navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify({ ...landing, deviceID })} }))`)
      await wait(page, `document.body.innerText.includes(${JSON.stringify(copy)})`)
      expect(await page.evaluate<unknown>(`(() => { const state = window.providerAuthState(); return { device: state.activeDeviceID, transport: state.transport.kind } })()`)).toEqual({ device: "dev_studio", transport: "open" })
      expect(await page.evaluate<string[]>(`window.remoteMachineStatuses.map(item => item.deviceID).filter(id => id !== 'dev_studio')`)).toEqual([])
      expect(await page.evaluate<unknown>(`window.remoteDeviceRequests.filter(item => item.operation === 'session.subscribe' || item.operation === 'notice.read')`)).toEqual([])
      expect(await page.evaluate<boolean>(`document.querySelector('.remote-conversation-view:not([inert])') === null`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

const usageLanding = { type: "ycoding:open-usage", deviceID: "dev_laptop" }
const studioReady = `document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb strong')?.textContent?.includes('Stream remote output safely') === true`

test("a service-worker usage message in an open window lands on the notified machine's Usage without a Session lookup", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&machines=distinct`)
    await wait(page, studioReady)
    await page.evaluate(`window.remoteDeviceRequests.length = 0; navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(usageLanding)} }))`)
    await expectUsageLanded(page)
  } finally { await page.close() }
}, 30_000)

for (const laptop of ["offline", "unlisted"]) test(`a usage message lands on a machine the window's account read listed ${laptop} but is online now`, async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&machines=distinct&laptop=${laptop}`)
    await wait(page, studioReady)
    await page.evaluate(`window.remoteBringLaptopOnline(); window.remoteDeviceRequests.length = 0; navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(usageLanding)} }))`)
    await expectUsageLanded(page)
  } finally { await page.close() }
}, 30_000)

test("a cold Usage URL opened while another machine is remembered lands on the notified machine's Usage", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=usage&noSelection=1&machines=distinct&device_id=dev_laptop`)
    await expectUsageLanded(page)
  } finally { await page.close() }
}, 30_000)

for (const [deviceID, copy] of [["dev_unknown", "unavailable to this account"], ["dev_retired", "unavailable to this account"], ["dev_asleep", "is offline"]] as const)
  test(`a quota alert for ${deviceID} reports its machine unavailable on Usage and keeps the selected machine`, async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&machines=distinct`)
      await wait(page, studioReady)
      await page.evaluate(`window.remoteDeviceRequests.length = 0; navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify({ ...usageLanding, deviceID })} }))`)
      await wait(page, `document.querySelector('.route-panel:not([inert]) [role="alert"]')?.textContent?.includes(${JSON.stringify(copy)}) === true`)
      expect(await page.evaluate<unknown>(`(() => { const state = window.providerAuthState(); return { device: state.activeDeviceID, transport: state.transport.kind } })()`)).toEqual({ device: "dev_studio", transport: "open" })
      expect(await page.evaluate<string[]>(`window.remoteMachineStatuses.map(item => item.deviceID).filter(id => id !== 'dev_studio')`)).toEqual([])
      expect(await page.evaluate<boolean>(`document.querySelector('.route-panel:not([inert]) .usage-page') === null`)).toBe(true)
      expect(await page.evaluate<unknown>(`window.remoteDeviceRequests.filter(item => item.operation === 'session.subscribe' || item.operation === 'notice.read')`)).toEqual([])
    } finally { await page.close() }
  }, 30_000)

test("a live quota row opens its machine's Usage and settles without a Session notice read", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&machines=distinct`)
    await wait(page, studioReady)
    await page.evaluate(`window.remoteDeviceRequests.length = 0; window.remoteQuotaNotice({ type: 'notice.quota', providerID: 'prov_a', windowID: 'weekly', milestone: 'will-run-out', resetAt: Date.now() + 3600000, at: Date.now() })`)
    await wait(page, `window.providerAuthState().notifications.some(item => item.category === 'quota-pace' && item.deviceID === 'dev_studio')`)
    await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
    await wait(page, `document.querySelector('.yc-notification--quota-pace .yc-notification__open:not([disabled])') !== null`)
    expect(await page.evaluate<string>(`document.querySelector('.yc-notification--quota-pace .yc-notification__open').innerText`)).toContain("A provider quota will run out before it resets. Open Usage to review.")
    await page.evaluate(`document.querySelector('.yc-notification--quota-pace .yc-notification__open').click()`)
    await wait(page, `location.pathname === '/remote/usage' && document.querySelector('.route-panel:not([inert]) .usage-page') !== null`)
    expect(await page.evaluate<unknown>(`(() => { const state = window.providerAuthState(); return { device: state.activeDeviceID, quotaRows: state.notifications.filter(item => item.category === 'quota-pace').length, device_id: new URL(location.href).searchParams.get('device_id') } })()`))
      .toEqual({ device: "dev_studio", quotaRows: 0, device_id: "dev_studio" })
    expect(await page.evaluate<unknown>(`window.remoteDeviceRequests.filter(item => item.operation === 'notice.read' || item.operation === 'session.subscribe')`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

for (const [target, message, panel] of [["Session", landing, `.route-panel:not([inert]) [role="alert"]`], ["Usage", usageLanding, `.route-panel:not([inert]) [role="alert"]`]] as const)
  test(`the same ${target} alert activated again lands once its machine, offline at the first attempt, is online in the account`, async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&machines=distinct&laptop=offline`)
      await wait(page, studioReady)
      await page.evaluate(`window.remoteDeviceRequests.length = 0; navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(message)} }))`)
      await wait(page, `document.querySelector(${JSON.stringify(panel)})?.textContent?.includes('is offline') === true`)
      expect(await page.evaluate<unknown>(`(() => { const state = window.providerAuthState(); return { device: state.activeDeviceID, transport: state.transport.kind } })()`)).toEqual({ device: "dev_studio", transport: "open" })
      expect(await page.evaluate<string[]>(`window.remoteMachineStatuses.map(item => item.deviceID).filter(id => id !== 'dev_studio')`)).toEqual([])
      await page.evaluate(`window.remoteBringLaptopOnline(); window.remoteDeviceRequests.length = 0; navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(message)} }))`)
      if (target === "Session") await expectLanded(page)
      else await expectUsageLanded(page)
    } finally { await page.close() }
  }, 30_000)

async function expectUsageLanded(page: Page) {
  await wait(page, `document.querySelector('.route-panel:not([inert]) .usage-page') !== null`)
  const laptop = await page.evaluate<string[]>(`window.remoteMachineStatuses.filter(item => item.deviceID === 'dev_laptop').map(item => item.kind)`)
  expect(laptop.slice(0, 2)).toEqual(["connecting", "open"])
  expect(await page.evaluate<unknown>(`(() => { const state = window.providerAuthState(); return { device: state.activeDeviceID, transport: state.transport.kind, notice: state.notice } })()`))
    .toEqual({ device: "dev_laptop", transport: "open", notice: undefined })
  expect(await page.evaluate<unknown>(`(() => { const params = new URL(location.href).searchParams; return { path: location.pathname, device: params.get('device_id') } })()`))
    .toEqual({ path: "/remote/usage", device: "dev_laptop" })
  expect(await page.evaluate<unknown>(`window.remoteDeviceRequests.filter(item => item.operation === 'session.subscribe' || item.operation === 'notice.read').map(item => ({ deviceID: item.deviceID, operation: item.operation }))`))
    .toEqual([])
  const text = await page.evaluate<string>(`document.body.innerText`)
  expect(text).not.toContain("unavailable to this account")
  expect(text).not.toContain("is offline")
}

async function expectLanded(page: Page) {
  await wait(page, `document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb strong')?.textContent?.includes('Laptop release check') === true`)
  await wait(page, `document.querySelector('.remote-conversation-view:not([inert])')?.innerText?.includes('The laptop release build passed.') === true`)
  await wait(page, `window.remoteDeviceRequests.some(item => item.operation === 'notice.read')`)
  const laptop = await page.evaluate<string[]>(`window.remoteMachineStatuses.filter(item => item.deviceID === 'dev_laptop').map(item => item.kind)`)
  expect(laptop.slice(0, 2)).toEqual(["connecting", "open"])
  expect(await page.evaluate<unknown>(`(() => { const state = window.providerAuthState(); return { device: state.activeDeviceID, session: state.activeSessionID, view: state.view?.id, transport: state.transport.kind, notice: state.notice } })()`))
    .toEqual({ device: "dev_laptop", session: "ses_laptop", view: "ses_laptop", transport: "open", notice: undefined })
  expect(await page.evaluate<unknown>(`(() => { const params = new URL(location.href).searchParams; return { path: location.pathname, device: params.get('device_id'), session: params.get('session_id') } })()`))
    .toEqual({ path: "/remote/session", device: "dev_laptop", session: "ses_laptop" })
  expect(await page.evaluate<unknown>(`window.remoteDeviceRequests.filter(item => item.operation === 'session.subscribe').map(item => ({ deviceID: item.deviceID, sessionID: item.sessionID, sent: item.sent }))`))
    .toContainEqual({ deviceID: "dev_laptop", sessionID: "ses_laptop", sent: true })
  expect(await page.evaluate<unknown>(`window.remoteDeviceRequests.filter(item => item.operation === 'session.subscribe' && item.sessionID === 'ses_laptop' && item.deviceID !== 'dev_laptop')`)).toEqual([])
  expect(await page.evaluate<unknown>(`window.remoteDeviceRequests.filter(item => item.operation === 'notice.read').map(item => ({ deviceID: item.deviceID, sent: item.sent }))`))
    .toEqual([{ deviceID: "dev_laptop", sent: true }])
  const text = await page.evaluate<string>(`document.body.innerText`)
  expect(text).not.toContain("Session not found")
  expect(text).not.toContain("unavailable to this account")
  expect(text).not.toContain("is offline")
}

async function wait(page: Page, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}; ${await page.evaluate<string>(`JSON.stringify({ url: location.href, breadcrumb: document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb')?.textContent, state: (() => { const state = window.providerAuthState(); return { device: state.activeDeviceID, session: state.activeSessionID, view: state.view?.id, viewStatus: state.view?.status, transport: state.transport.kind, connection: state.connection.kind, notice: state.notice } })(), statuses: window.remoteMachineStatuses, requests: window.remoteDeviceRequests.slice(-12), body: document.body.innerText.slice(-400) })`)}`)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false) }
