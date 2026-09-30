import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4495
const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME")
let server: ReturnType<typeof Bun.spawn>
let browser: Awaited<ReturnType<typeof launchBrowser>>

beforeAll(async () => {
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let index = 0; index < 60; index++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/cursors-fixture.html`).then((response) => response.ok).catch(() => false)) break
    await Bun.sleep(100)
  }
  browser = await launchBrowser(chrome, 1440, 1200)
})

afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

async function wait(page: Awaited<ReturnType<typeof browser.openPage>>, expression: string) {
  for (let index = 0; index < 100; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(30)
  }
  throw new Error(`Cursor fixture did not settle: ${expression}`)
}

test("shared cursor roles cover real native and design-system controls in both themes", async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/cursors-fixture.html`)
    await wait(page, `document.querySelector('#action') !== null`)
    const selectors = ["body", "#link", "#link span", "#action", "#action svg", "#action span", "#disabled", "#disabled span", "#aria-disabled", "#busy", "#busy span", "#busy-disabled", "#busy-cancel", "#text", "#readonly", "#disabled-text", "#textarea", "#prose", "#toggle", "#toggle-label span", "#disabled-toggle", "#disabled-toggle-label span", "#fieldset-toggle", "#fieldset-label span", "#summary", "#summary span", '[aria-label="Example selection"]', '[aria-label="Unavailable selection"]']
    const expected = ["default", "pointer", "pointer", "pointer", "pointer", "pointer", "not-allowed", "not-allowed", "not-allowed", "progress", "progress", "progress", "pointer", "text", "text", "not-allowed", "text", "text", "pointer", "pointer", "not-allowed", "not-allowed", "not-allowed", "not-allowed", "pointer", "pointer", "pointer", "not-allowed"]
    for (const theme of ["light", "dark"]) {
      await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      expect(await page.evaluate<string[]>(`${JSON.stringify(selectors)}.map((selector)=>getComputedStyle(document.querySelector(selector)).cursor)`)).toEqual(expected)
    }
    await page.evaluate(`document.querySelector('#action').click()`)
    expect(await page.evaluate<string>(`document.querySelector('output').textContent`)).toBe("1 actions")
    await page.evaluate(`document.querySelector('[aria-label="Example selection"]').click()`)
    await wait(page, `document.querySelector('[role="option"]') !== null`)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('[role="option"]')).cursor`)).toBe("pointer")
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.custom-select__footer')).cursor`)).toBe("pointer")
  } finally { await page.close() }
})

test("cursor inheritance preserves legend actions, disabled native parts, image expansion and resize roles", async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/cursors-fixture.html`)
    await wait(page, `document.querySelector('#fieldset-legend-action') !== null`)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('#fieldset-legend-action')).cursor`)).toBe("pointer")
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('#disabled-file'),'::file-selector-button').cursor`)).toBe("not-allowed")
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('#textarea'),'::-webkit-resizer').cursor`)).toBe("ns-resize")
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.transcript-image img')).cursor`)).toBe("zoom-in")
    await page.evaluate(`document.querySelector('.transcript-image').click()`)
    await wait(page, `document.querySelector('dialog[open]') !== null`)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('dialog'),'::backdrop').cursor`)).toBe("pointer")
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.overlay__surface')).cursor`)).toBe("default")
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.overlay__close svg')).cursor`)).toBe("pointer")
  } finally { await page.close() }
})

test("public links and actual remote composer controls consume the shared cursor roles", async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/`)
    await wait(page, `document.querySelector('.nav__link') !== null`)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.nav__link')).cursor`)).toBe("pointer")
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=dark&responseProbe=1`)
    await wait(page, `document.querySelector('.composer__input') !== null`)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.composer__input')).cursor`)).toBe("text")
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.composer__attach')).cursor`)).toBe("pointer")
    await page.evaluate(`(() => { const input=document.querySelector('.composer__input'); input.value=''; input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'})); })()`)
    await wait(page, `document.querySelector('.mini-composer__send')?.disabled === true`)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.mini-composer__send')).cursor`)).toBe("not-allowed")
    await page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    await wait(page, `document.querySelector('[role="slider"]') !== null`)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('[role="slider"]')).cursor`)).toBe("ew-resize")
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html`)
    await wait(page, `document.querySelector('.usage-chart__bar') !== null && document.querySelector('.usage-donut__arc') !== null`)
    expect(await page.evaluate<string[]>(`['.usage-chart__bar','.usage-donut__arc'].map((selector)=>getComputedStyle(document.querySelector(selector)).cursor)`)).toEqual(["pointer", "pointer"])
    await page.setViewport(390, 844)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=light&responseProbe=1`)
    await wait(page, `document.querySelector('.composer__mobile-trigger')?.getBoundingClientRect().height > 0`)
    await page.evaluate(`document.querySelector('.composer__mobile-trigger').click()`)
    await wait(page, `document.querySelector('.composer__selection-scrim') !== null`)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.composer__selection-scrim')).cursor`)).toBe("pointer")
    await page.evaluate(`document.querySelector('.composer__selection-scrim').click()`)
    await wait(page, `document.querySelector('.composer__selection-scrim') === null && document.querySelector('[aria-label="Open Team"]') !== null`)
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    await wait(page, `document.querySelector('dialog.team-view__sheet[open]') !== null`)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('dialog.team-view__sheet'),'::backdrop').cursor`)).toBe("pointer")
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('dialog.team-view__sheet .overlay__surface')).cursor`)).toBe("default")
    expect(await page.evaluate<unknown>(`(() => { document.querySelector('[aria-label="Close Team"]').click(); const dialog=document.querySelector('dialog.team-view__sheet'); return {inert:dialog.inert,cursor:getComputedStyle(dialog,'::backdrop').cursor}; })()`)).toEqual({ inert: true, cursor: "not-allowed" })
  } finally { await page.close() }
})
