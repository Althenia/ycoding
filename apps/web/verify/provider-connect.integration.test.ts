import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4752
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>
beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) { browser = await launchBrowser(executable, 1440, 900); return }
    await Bun.sleep(100)
  }
  throw new Error("Provider-connect fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })
async function wait(page: Page, expression: string) {
  for (let remaining = 100; remaining > 0; remaining--) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return
    await Bun.sleep(30)
  }
  throw new Error(`Timed out: ${expression}`)
}
async function palette(page: Page) {
  await page.evaluate(`document.querySelector('.app-header__palette').click()`)
  await wait(page, `document.getElementById('command-palette-input') !== null`)
  await page.evaluate(`(() => { const input=document.getElementById('command-palette-input');input.value='connect provider';input.dispatchEvent(new InputEvent('input',{bubbles:true})) })()`)
  await wait(page, `[...document.querySelectorAll('.command-palette__title')].some(item=>item.textContent==='Connect provider…')`)
  await page.evaluate(`[...document.querySelectorAll('dialog.overlay--command-palette [role=option]')].find(item=>item.textContent.includes('Connect provider')).click()`)
  await wait(page, `document.querySelector('dialog[aria-label="Connect provider"][open] button[aria-label="Provider"]') !== null`)
}
async function choose(page: Page, label: string, option: string) {
  await page.evaluate(`document.querySelector('dialog[aria-label="Connect provider"] button[aria-label=${JSON.stringify(label)}]').click()`)
  await wait(page, `[...document.querySelectorAll('[role=option]')].some(item=>item.textContent.includes(${JSON.stringify(option)}))`)
  await page.evaluate(`[...document.querySelectorAll('[role=option]')].find(item=>item.textContent.includes(${JSON.stringify(option)})).click()`)
  await page.evaluate(`document.querySelector('dialog[aria-label="${label}"] .custom-select__confirm')?.click()`)
  await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Confirm Selection')?.click()`)
  await wait(page, `document.querySelector('dialog[aria-label="Connect provider"] button[aria-label=${JSON.stringify(label)}]').textContent.includes(${JSON.stringify(option)})`)
}
async function input(page: Page, id: string, value: string) {
  await page.evaluate(`(() => { const field=document.getElementById(${JSON.stringify(id)});field.value=${JSON.stringify(value)};field.dispatchEvent(new InputEvent('input',{bubbles:true})) })()`)
}

test("palette provider connection adds a named key profile to the Session's machine and keeps secrets out of state and request records", async () => {
  for (const width of [390, 1440]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      if (width === 390) await page.setCoarsePointer(true)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
      await wait(page, `document.querySelector('.composer-resident:not([inert]) .composer__input') !== null`)
      await palette(page)
      await choose(page, "Provider", "OpenAI")
      await choose(page, "Authentication method", "API key")
      await input(page, "provider-profile-name", "Web profile")
      await input(page, "provider-api-key", "synthetic-test-key")
      expect(await page.evaluate<boolean>(`document.getElementById('provider-api-key').type==='password'`)).toBe(true)
      await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Connect profile').click()`)
      await wait(page, `window.providerAuthFixture.report().acceptedKey===true`)
      await wait(page, `document.querySelector('dialog[aria-label="Connect provider"]').textContent.includes('Provider profile connected.')`)
      expect(await page.evaluate<unknown>(`window.requestLog.find(item=>item.operation==='provider.auth.key').input`)).toEqual({ target: { sessionID: "ses_fixture" }, integrationID: "openai", label: "Web profile" })
      expect(await page.evaluate<string>(`JSON.stringify(window.providerAuthState())+JSON.stringify(window.requestLog)+JSON.stringify(localStorage)`)).not.toContain("synthetic-test-key")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true)
      expect(await page.evaluate<boolean>(`document.getElementById('provider-api-key').value===''`)).toBe(true)
    } finally { await page.close() }
  }
}, 60000)

test("manual-code auth keeps a failed status read unresolved, submits once, then removes the completed attempt", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
    await wait(page, `document.querySelector('.composer-resident:not([inert]) .composer__input') !== null`)
    await palette(page)
    await choose(page, "Provider", "OpenAI")
    await choose(page, "Authentication method", "CLI account")
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Connect profile').click()`)
    await wait(page, `document.getElementById('provider-authorization-code') !== null`)
    await page.evaluate(`window.providerAuthFixture.failRead();[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Check authentication status').click()`)
    await wait(page, `document.querySelector('dialog[aria-label="Connect provider"]').textContent.includes('Provider authentication could not finish.')`)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('dialog button')].some(item=>item.textContent.trim()==='Connect profile')`)).toBe(false)
    expect(await page.evaluate<boolean>(`document.getElementById('provider-authorization-code').disabled`)).toBe(true)
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Check authentication status').click()`)
    await wait(page, `document.getElementById('provider-authorization-code').disabled===false`)
    await input(page, "provider-authorization-code", "synthetic-test-code")
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Submit authorization code').click()`)
    await wait(page, `window.providerAuthFixture.report().acceptedCode===true && document.getElementById('provider-authorization-code')===null`)
    expect(await page.evaluate<number>(`window.requestLog.filter(item=>item.operation==='provider.auth.complete').length`)).toBe(1)
    expect(await page.evaluate<string>(`JSON.stringify(window.providerAuthState())+JSON.stringify(window.requestLog)+JSON.stringify(localStorage)`)).not.toContain("synthetic-test-code")
  } finally { await page.close() }
}, 30000)

test("landing provider auth uses the chosen repository and exposes a local-only method as a blocker", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&workspace_id=workspace_other&source=sessions`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]')?.textContent.includes('Other repository')`)
    await palette(page)
    expect(await page.evaluate<unknown>(`window.requestLog.find(item=>item.operation==='provider.auth.list').input.target`)).toEqual({ workspace: "workspace_other" })
    await choose(page, "Provider", "OpenAI")
    await choose(page, "Authentication method", "Local browser")
    expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Connect provider"]').textContent.includes('Sign in on the backend machine')`)).toBe(true)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Connect profile').disabled`)).toBe(true)
    expect(await page.evaluate<number>(`window.requestLog.filter(item=>item.operation==='provider.auth.begin').length`)).toBe(0)
    await choose(page, "Provider", "Environment provider")
    expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Connect provider"] button[aria-label="Authentication method"]')===null`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Connect provider"]').textContent.includes('requires machine-local configuration')`)).toBe(true)
  } finally { await page.close() }
}, 30000)
