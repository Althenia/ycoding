import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"
import { startRelayDouble } from "../test/relay-double"
import { createProviderAuthFixture } from "./provider-auth-fixture"

const port = 4753
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to the pinned Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<NonNullable<typeof browser>["openPage"]>>
beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore" })
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/provider-modal-fixture.html`).then((r) => r.ok, () => false)) { browser = await launchBrowser(executable, 1440, 900); return }
    await Bun.sleep(100)
  }
  throw new Error("Provider modal fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })
async function wait(page: Page, expression: string) {
  for (let i = 0; i < 100; i++) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return
    await Bun.sleep(30)
  }
  throw new Error(`Timed out: ${expression}`)
}
async function choose(page: Page, label: string, option: string) {
  await page.evaluate(`document.querySelector('dialog[aria-label="Connect provider"] button[aria-label=${JSON.stringify(label)}]').click()`)
  await wait(page, `[...document.querySelectorAll('[role=option]')].some(item=>item.textContent.includes(${JSON.stringify(option)}))`)
  await page.evaluate(`[...document.querySelectorAll('[role=option]')].find(item=>item.textContent.includes(${JSON.stringify(option)})).click()`)
  await page.evaluate(`document.querySelector('dialog[aria-label="${label}"] .custom-select__confirm')?.click()`)
  await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Confirm Selection')?.click()`)
  await wait(page, `document.querySelector('dialog[aria-label="Connect provider"] button[aria-label=${JSON.stringify(label)}]').textContent.includes(${JSON.stringify(option)})`)
}
async function harness(width: number) {
  const fixture = createProviderAuthFixture()
  const relay = await startRelayDouble({ handler: (request) => {
    if (!request.operation.startsWith("provider.auth.")) return "default"
    if (request.operation === "provider.auth.begin") fixture.failRead()
    if (request.operation === "provider.auth.key") fixture.unknownKey()
    const result = fixture.request(request.operation, request.input)
    if (result.status === "ok") return { ok: true, value: result.value }
    return { ok: false, code: result.status === "unknown" ? "outcome_unknown" : "internal_error", message: "Synthetic fixture error" }
  } })
  const page = await browser!.openPage()
  await page.setViewport(width, 900)
  if (width === 390) await page.setCoarsePointer(true)
  await page.navigate(`http://127.0.0.1:${port}/verify/provider-modal-fixture.html?relay=${encodeURIComponent(relay.wsURL("dev_1"))}`)
  await wait(page, `document.querySelector('main button')?.disabled === false`)
  await page.evaluate(`document.querySelector('main button').click()`)
  await wait(page, `document.querySelector('dialog[aria-label="Connect provider"] button[aria-label="Provider"]') !== null`)
  await choose(page, "Provider", "OpenAI")
  return { page, relay, close: async () => { await page.close(); await relay.stop() } }
}

test("unresolved authorization retains check and cancel without a no-op refresh", async () => {
  for (const width of [390, 1440]) {
    const h = await harness(width)
    try {
      await choose(h.page, "Authentication method", "CLI account")
      await h.page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Connect profile').click()`)
      await wait(h.page, `document.getElementById('provider-authorization-code') !== null`)
      await h.page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Check authentication status').click()`)
      await wait(h.page, `document.querySelector('dialog[aria-label="Connect provider"]').textContent.includes('Provider authentication could not finish.')`)
      const state = await h.page.evaluate<{ check: boolean; cancel: boolean; refresh: boolean; connect: boolean; overflow: boolean }>(`(() => { const d=document.querySelector('dialog[aria-label="Connect provider"]'); const buttons=[...d.querySelectorAll('button')]; const enabled=(name)=>buttons.some(b=>b.textContent.trim()===name&&!b.disabled); return {check:enabled('Check authentication status'),cancel:enabled('Cancel authentication'),refresh:buttons.some(b=>b.textContent.trim()==='Refresh provider profiles'),connect:buttons.some(b=>b.textContent.trim()==='Connect profile'),overflow:document.documentElement.scrollWidth>innerWidth||d.scrollWidth>d.clientWidth}; })()`)
      expect(state).toEqual({ check: true, cancel: true, refresh: false, connect: false, overflow: false })
      expect(h.relay.requests.filter((r) => r.operation === "provider.auth.begin")).toHaveLength(1)
      expect(h.relay.requests.filter((r) => r.operation === "provider.auth.list")).toHaveLength(1)
      expect(h.relay.requests.filter((r) => r.operation === "provider.auth.key")).toHaveLength(0)
      await h.page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Cancel authentication').click()`)
      await wait(h.page, `document.getElementById('provider-authorization-code')===null`)
      expect(h.relay.requests.filter((r) => r.operation === "provider.auth.cancel")).toHaveLength(1)
      expect(h.relay.requests.filter((r) => r.operation === "provider.auth.complete")).toHaveLength(0)
    } finally { await h.close() }
  }
}, 30000)

test("unconfirmed key without an attempt refreshes profiles without replay", async () => {
  const h = await harness(1440)
  try {
    await choose(h.page, "Authentication method", "API key")
    await h.page.evaluate(`(() => { const f=document.getElementById('provider-api-key');f.value='synthetic-test-key';f.dispatchEvent(new InputEvent('input',{bubbles:true})) })()`)
    await h.page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Connect profile').click()`)
    await wait(h.page, `document.querySelector('dialog[aria-label="Connect provider"]').textContent.includes('The machine did not confirm the result.')`)
    await h.page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Refresh provider profiles').click()`)
    await wait(h.page, `[...document.querySelectorAll('dialog button')].every(item=>item.textContent.trim()!=='Refresh provider profiles')`)
    expect(h.relay.requests.filter((r) => r.operation === "provider.auth.list")).toHaveLength(2)
    expect(h.relay.requests.filter((r) => r.operation === "provider.auth.key")).toHaveLength(1)
  } finally { await h.close() }
}, 30000)
