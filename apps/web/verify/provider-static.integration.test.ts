import { expect, test } from "bun:test"
import { launchBrowser } from "./cdp"
import { startRelayDouble } from "../test/relay-double"
import { createProviderAuthFixture } from "./provider-auth-fixture"

const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to the pinned Chrome executable.")

test("built App opens provider authentication from the palette and resolves a failed status read", async () => {
  const fixture = createProviderAuthFixture()
  const relay = await startRelayDouble({
    handler: (request) => {
      if (!request.operation.startsWith("provider.auth.")) return "default"
      if (request.operation === "provider.auth.begin") fixture.failRead()
      const outcome = fixture.request(request.operation, request.input)
      if (outcome.status === "ok") return { ok: true, value: outcome.value }
      return { ok: false, code: "internal_error", message: "Synthetic fixture error" }
    },
    fallback: async (request) => {
      const pathname = new URL(request.url).pathname
      const path = pathname.startsWith("/assets/") ? pathname : pathname.startsWith("/remote") ? "/index.html" : undefined
      if (path === undefined) return new Response("Not found", { status: 404 })
      const file = Bun.file(new URL(`../dist${path}`, import.meta.url))
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
    },
  })
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
  try {
    browser = await launchBrowser(executable, 1440, 900)
    const page = await browser.openPage()
    const wait = async (expression: string) => {
      for (let i = 0; i < 150; i++) {
        if (await page.evaluate<boolean>(`Boolean(${expression})`)) return
        await Bun.sleep(30)
      }
      throw new Error(`Timed out: ${expression}`)
    }
    const choose = async (label: string, option: string) => {
      await page.evaluate(`document.querySelector('dialog[aria-label="Connect provider"] button[aria-label=${JSON.stringify(label)}]').click()`)
      await wait(`[...document.querySelectorAll('[role=option]')].some(item=>item.textContent.includes(${JSON.stringify(option)}))`)
      await page.evaluate(`[...document.querySelectorAll('[role=option]')].find(item=>item.textContent.includes(${JSON.stringify(option)})).click()`)
      await wait(`document.querySelector('dialog[aria-label="Connect provider"] button[aria-label=${JSON.stringify(label)}]').textContent.includes(${JSON.stringify(option)})`)
    }
    await page.navigate(`${relay.httpURL}/remote/session?session_id=ses_a&device_id=dev_1`)
    await wait(`document.querySelector('.composer-resident:not([inert]) .composer__input') !== null`)
    await page.evaluate(`document.querySelector('.app-header__palette').click()`)
    await wait(`document.getElementById('command-palette-input') !== null`)
    await page.evaluate(`(() => { const input=document.getElementById('command-palette-input');input.value='connect provider';input.dispatchEvent(new InputEvent('input',{bubbles:true})) })()`)
    await wait(`[...document.querySelectorAll('.command-palette__title')].some(item=>item.textContent==='Connect provider…')`)
    await page.evaluate(`[...document.querySelectorAll('dialog.overlay--command-palette [role=option]')].find(item=>item.textContent.includes('Connect provider')).click()`)
    await wait(`document.querySelector('dialog[aria-label="Connect provider"] button[aria-label="Provider"]') !== null`)
    await choose("Provider", "OpenAI")
    await choose("Authentication method", "CLI account")
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Connect profile').click()`)
    await wait(`document.getElementById('provider-authorization-code') !== null`)
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Check authentication status').click()`)
    await wait(`document.querySelector('dialog[aria-label="Connect provider"]').textContent.includes('Provider authentication could not finish.')`)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('dialog button')].some(item=>item.textContent.trim()==='Refresh provider profiles')`)).toBe(false)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('dialog button')].some(item=>item.textContent.trim()==='Connect profile')`)).toBe(false)
    expect(await page.evaluate<boolean>(`document.getElementById('provider-authorization-code').disabled`)).toBe(true)
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Check authentication status').click()`)
    await wait(`document.getElementById('provider-authorization-code').disabled===false`)
    await page.evaluate(`(() => { const field=document.getElementById('provider-authorization-code');field.value='synthetic-test-code';field.dispatchEvent(new InputEvent('input',{bubbles:true})) })()`)
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Submit authorization code').click()`)
    await wait(`document.querySelector('dialog[aria-label="Connect provider"]').textContent.includes('Provider profile connected.')`)
    expect(fixture.report().acceptedCode).toBe(true)
    expect(relay.requests.filter((r) => r.operation === "provider.auth.begin")).toHaveLength(1)
    expect(relay.requests.filter((r) => r.operation === "provider.auth.complete")).toHaveLength(1)
    expect(await page.evaluate<boolean>(`document.getElementById('provider-authorization-code')===null`)).toBe(true)
    await page.close()
  } finally {
    await browser?.close()
    await relay.stop()
  }
}, 30000)
