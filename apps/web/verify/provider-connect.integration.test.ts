import { afterAll, beforeAll, expect, test } from "bun:test"
import { decodeNumber, decodeRecord, launchBrowser } from "./cdp"

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
    if (await page.evaluate(`Boolean(${expression})`)) return
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
async function choose(page: Page, label: string, option: string, expectedOptions?: readonly string[]) {
  await page.evaluate(`document.querySelector('dialog[aria-label="Connect provider"] button[aria-label=${JSON.stringify(label)}]').click()`)
  await wait(page, `[...document.querySelectorAll('[role=option]')].some(item=>item.textContent.includes(${JSON.stringify(option)}))`)
  if (expectedOptions) expect(await page.evaluate(`[...document.querySelectorAll('[role=listbox][aria-label="${label}"] [role=option]')].map(item=>item.textContent.trim())`)).toEqual(expectedOptions)
  await page.evaluate(`[...document.querySelectorAll('[role=option]')].find(item=>item.textContent.includes(${JSON.stringify(option)})).click()`)
  await page.evaluate(`document.querySelector('dialog[aria-label="${label}"] .custom-select__confirm')?.click()`)
  await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Confirm Selection')?.click()`)
  await wait(page, `document.querySelector('dialog[aria-label="Connect provider"] button[aria-label=${JSON.stringify(label)}]').textContent.includes(${JSON.stringify(option)})`)
}
async function input(page: Page, id: string, value: string) {
  await page.evaluate(`(() => { const field=document.getElementById(${JSON.stringify(id)});field.value=${JSON.stringify(value)};field.dispatchEvent(new InputEvent('input',{bubbles:true})) })()`)
}

test("provider picker keeps supported routes and their profile details when an older machine advertises retired providers", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
    await wait(page, `!!window.providerAuthFixture && !!document.querySelector('.app-header__palette')`)
    await page.evaluate(`window.providerAuthFixture.staleProviderList()`)
    await palette(page)
    const providerOptions = ["OpenAI", "Claude", "OpenRouter", "Custom OpenAI-compatible Endpoint"]
    for (const [name, profile, kind, status] of [
      ["OpenAI", "Work (provider default)", "OAuth", "Connected"],
      ["Claude", "Claude account", "OAuth", "Expired"],
      ["OpenRouter", "Shared gateway (provider default)", "API key", "Connected"],
      ["Custom OpenAI-compatible Endpoint", "Local endpoint (provider default)", "API key", "Connected"],
    ] as const) {
      await choose(page, "Provider", name, name === "OpenAI" ? providerOptions : undefined)
      if (name === "Custom OpenAI-compatible Endpoint") {
        await choose(page, "Configured endpoint", "Environment provider", ["Environment provider"])
      }
      const card = await page.evaluate(`(() => {
        const profile = document.querySelector('.provider-profile');
        return ['name', 'kind', 'state'].map(field => profile.querySelector('.provider-profile__' + field).textContent.trim());
      })()`)
      expect(card).toEqual([profile, kind, status])
    }
    expect(await page.evaluate(`window.requestLog.filter(item => item.operation.startsWith('provider.auth.')).map(item => item.operation)`)).toEqual(["provider.auth.list"])
  } finally { await page.close() }
}, 30_000)

test("connected profiles fit more whole cards on wide screens and keep complete status on phones", async () => {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, height)
      await page.setCoarsePointer(width === 390)
      await page.setReducedMotion(true)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&presentation=conversation&team=two&childTranscript=ready&childQuestion=1`)
      await wait(page, `!!window.providerAuthFixture && !!document.querySelector('.app-header__palette')`)
      await page.evaluate(`window.providerAuthFixture.report().profiles.push(...Array.from({length:9},(_,i)=>({name:'Example profile '+(i+1),active:false,kind:'oauth',status:'connected'})))`)
      await palette(page)
      await choose(page, "Provider", "OpenAI")
      const geometry = await page.evaluate(`(() => {
        const body = document.querySelector('dialog[aria-label="Connect provider"] .overlay__body');
        body.scrollTop = 0;
        const box = node => node.getBoundingClientRect();
        const top = box(body).top + body.clientTop, bottom = top + body.clientHeight;
        const cards = [...body.querySelectorAll('.provider-profile')];
        const sample = cards[1], name = box(sample.querySelector('.provider-profile__name')), kind = box(sample.querySelector('.provider-profile__kind'));
        const state = sample.querySelector('.provider-profile__state');
        return { cards: cards.length, full: cards.filter(card => box(card).top >= top && box(card).bottom <= bottom).length,
          inline: name.top < kind.bottom && kind.top < name.bottom,
          status: state.textContent, kind: sample.querySelector('.provider-profile__kind').textContent,
          contained: box(state).right <= box(sample).right && body.scrollWidth <= body.clientWidth && body.scrollHeight > body.clientHeight,
          inset: name.left - box(sample).left,
          hit: [...sample.querySelectorAll('button')].every(button => box(button).height >= (innerWidth < 768 ? 44 : 36)) };
      })()`, decodeRecord)
      expect(geometry).toMatchObject({ cards: 10, inline: width === 1440, status: "Connected", kind: "OAuth", contained: true, inset: width === 1440 ? 16 : 12, hit: true })
      if (width === 1440) expect(decodeNumber(geometry["full"])).toBeGreaterThanOrEqual(5)
    } finally { await page.close() }
  }
}, 30000)

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
      await page.evaluate(`Promise.allSettled(document.querySelector('.overlay--provider-connect .overlay__surface').getAnimations().map(animation => animation.finished)).then(() => true)`)
      expect(await page.evaluate(`(() => {
        const card = document.querySelector('.provider-profile');
        const name = card.querySelector('.provider-profile__name');
        const kind = card.querySelector('.provider-profile__kind');
        const actions = card.querySelector('.provider-profile__actions');
        const bounds = node => node.getBoundingClientRect();
        const body = card.closest('.overlay__body');
        return {
          nameInset: bounds(name).left - bounds(card).left,
          metadataBelowName: bounds(kind).top >= bounds(name).bottom,
          actionsContained: bounds(actions).right <= bounds(card).right && bounds(actions).bottom <= bounds(card).bottom,
          fits: body.scrollWidth <= body.clientWidth,
        };
      })()`)).toMatchObject({ nameInset: width === 390 ? 12 : 16, ...(width === 390 ? { metadataBelowName: true } : {}), actionsContained: true, fits: true })
      await choose(page, "Authentication method", "API key")
      await input(page, "provider-profile-name", "Web profile")
      await input(page, "provider-api-key", "synthetic-test-key")
      expect(await page.evaluate(`document.getElementById('provider-api-key').type==='password'`)).toBe(true)
      await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Connect profile').click()`)
      await wait(page, `window.providerAuthFixture.report().acceptedKey===true`)
      await wait(page, `document.querySelector('dialog[aria-label="Connect provider"]').textContent.includes('Provider profile connected.')`)
      expect(await page.evaluate(`window.requestLog.find(item=>item.operation==='provider.auth.key').input`)).toEqual({ target: { sessionID: "ses_fixture" }, integrationID: "openai", label: "Web profile" })
      expect(await page.evaluate(`JSON.stringify(window.providerAuthState())+JSON.stringify(window.requestLog)+JSON.stringify(localStorage)`)).not.toContain("synthetic-test-key")
      expect(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true)
      expect(await page.evaluate(`document.getElementById('provider-api-key').value===''`)).toBe(true)
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
    expect(await page.evaluate(`[...document.querySelectorAll('dialog button')].some(item=>item.textContent.trim()==='Connect profile')`)).toBe(false)
    expect(await page.evaluate(`[...document.querySelectorAll('dialog button')].some(item=>item.textContent.trim()==='Refresh provider profiles')`)).toBe(false)
    expect(await page.evaluate(`[...document.querySelectorAll('dialog button')].some(item=>item.textContent.trim()==='Check authentication status' && !item.disabled)`)).toBe(true)
    expect(await page.evaluate(`[...document.querySelectorAll('dialog button')].some(item=>item.textContent.trim()==='Cancel authentication' && !item.disabled)`)).toBe(true)
    expect(await page.evaluate(`document.getElementById('provider-authorization-code').disabled`)).toBe(true)
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Check authentication status').click()`)
    await wait(page, `document.getElementById('provider-authorization-code').disabled===false`)
    await input(page, "provider-authorization-code", "synthetic-test-code")
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Submit authorization code').click()`)
    await wait(page, `window.providerAuthFixture.report().acceptedCode===true && document.getElementById('provider-authorization-code')===null`)
    expect(await page.evaluate(`window.requestLog.filter(item=>item.operation==='provider.auth.complete').length`)).toBe(1)
    expect(await page.evaluate(`JSON.stringify(window.providerAuthState())+JSON.stringify(window.requestLog)+JSON.stringify(localStorage)`)).not.toContain("synthetic-test-code")
  } finally { await page.close() }
}, 30000)

test("an unconfirmed key without an attempt can refresh provider profiles", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
    await wait(page, `document.querySelector('.composer-resident:not([inert]) .composer__input') !== null`)
    await palette(page)
    await choose(page, "Provider", "OpenAI")
    await choose(page, "Authentication method", "API key")
    await input(page, "provider-api-key", "synthetic-test-key")
    await page.evaluate(`window.providerAuthFixture.unknownKey();[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Connect profile').click()`)
    await wait(page, `document.querySelector('dialog[aria-label="Connect provider"]').textContent.includes('The machine did not confirm the result.')`)
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Refresh provider profiles').click()`)
    await wait(page, `window.requestLog.filter(item=>item.operation==='provider.auth.list').length===2`)
    expect(await page.evaluate(`window.requestLog.filter(item=>item.operation==='provider.auth.key').length`)).toBe(1)
    expect(await page.evaluate(`[...document.querySelectorAll('dialog button')].some(item=>item.textContent.trim()==='Refresh provider profiles')`)).toBe(false)
  } finally { await page.close() }
}, 30000)

test("landing provider auth uses the chosen repository and exposes a local-only method as a blocker", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&workspace_id=workspace_other&source=sessions`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]')?.textContent.includes('Other repository')`)
    await palette(page)
    expect(await page.evaluate(`window.requestLog.find(item=>item.operation==='provider.auth.list').input.target`)).toEqual({ workspace: "workspace_other" })
    await choose(page, "Provider", "OpenAI")
    await choose(page, "Authentication method", "Local browser")
    expect(await page.evaluate(`document.querySelector('dialog[aria-label="Connect provider"]').textContent.includes('Sign in on the backend machine')`)).toBe(true)
    expect(await page.evaluate(`[...document.querySelectorAll('dialog button')].find(item=>item.textContent.trim()==='Connect profile').disabled`)).toBe(true)
    expect(await page.evaluate(`window.requestLog.filter(item=>item.operation==='provider.auth.begin').length`)).toBe(0)
    await choose(page, "Provider", "Custom OpenAI-compatible Endpoint")
    await choose(page, "Configured endpoint", "Environment provider")
    expect(await page.evaluate(`document.querySelector('dialog[aria-label="Connect provider"] button[aria-label="Authentication method"]')===null`)).toBe(true)
    expect(await page.evaluate(`document.querySelector('dialog[aria-label="Connect provider"]').textContent.includes('requires machine-local configuration')`)).toBe(true)
  } finally { await page.close() }
}, 30000)
