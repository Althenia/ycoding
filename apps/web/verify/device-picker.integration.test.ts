import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4391
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)
    if (ready) {
      browser = await launchBrowser(browserPath, 390, 844)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Vite did not start the machine picker fixture")
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("machine settings row", () => {
  test("keeps offline and unenrolled machine states nonselectable without hiding recovery actions", async () => {
    if (!browser) throw new Error("Chrome was not initialized")
    for (const [mode, placeholder] of [["offline", "No machines online"], ["none", "No machine enrolled"]] as const) {
      const page = await browser.openPage()
      try {
        await page.setViewport(390, 844)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=settings&devices=${mode}`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] .machine-row__item, [aria-labelledby="machine-settings"] .machine-row__empty') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<{ readonly selectable: number; readonly text: string }>(`(() => { const section = document.querySelector('[aria-labelledby="machine-settings"]'); return { selectable: [...section.querySelectorAll('.machine-row__connect')].filter(button => !button.disabled).length, text: section.querySelector('.machine-row__empty, .machine-row__note')?.textContent?.trim() ?? '' } })()`)).toEqual({ selectable: 0, text: placeholder === "No machines online" ? "No machines online." : placeholder })
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&devices=${mode}`)
        const expectedAlert = mode === "offline"
          ? "The machine for this Session is offline. Reconnect that machine to open its Session."
          : "The machine for this Session is unavailable to this account."
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('[role="alert"]')?.textContent?.trim() === ${JSON.stringify(expectedAlert)}`); attempt += 1) await Bun.sleep(50)
        const state = await page.evaluate<{ readonly pathname: string; readonly search: string; readonly activeView: string; readonly alert: string; readonly requests: readonly { readonly deviceID: string; readonly operation: string }[]; readonly text: string }>(`({ pathname: location.pathname, search: location.search, activeView: document.querySelector('.remote-nav__link--active')?.textContent?.trim() ?? '', alert: document.querySelector('[role="alert"]')?.textContent?.trim() ?? '', requests: window.remoteDeviceRequests, text: document.body.innerText })`)
        expect(state.pathname).toBe("/remote/session")
        expect(state.search).toContain("session_id=ses_fixture")
        expect(state.search).toContain("device_id=dev_studio")
        expect(state.activeView).toBe("Sessions")
        expect(state.alert).toBe(expectedAlert)
        expect(state.requests).toEqual([])
        expect(state.text).not.toContain("ycoding remote connect")
      } finally { await page.close() }
    }
  }, 30_000)

  test("keeps offline and revoked machine notes beside the Settings row", async () => {
    if (!browser) throw new Error("Chrome was not initialized")
    for (const width of [1440, 390] as const) {
      const page = await browser.openPage()
      try {
        await page.setViewport(width, width === 390 ? 844 : 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=devices-enrollment-${width}`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] .machine-row__item') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<string>(`document.querySelector('[aria-labelledby="machine-settings"] .machine-row__note')?.textContent?.trim() ?? ''`)).toBe("1 revoked machine is managed in Settings → Devices.")
        expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll('[aria-labelledby="machine-settings"] .machine-row__item')].map(item => item.querySelector('.machine-row__name').textContent + ':' + item.querySelector('.machine-row__state').textContent.trim() + ':' + item.querySelector('.machine-row__connect').disabled)`)).toEqual(["Studio Mac:Online:true", "Workstation-Box:Offline:true"])
      } finally { await page.close() }
    }
  }, 30_000)

  test("shows connection in the header and switches machines from Settings at each breakpoint", async () => {
    if (!browser) throw new Error("Chrome was not initialized")
    for (const [width, height] of [[1440, 900], [820, 1180], [390, 844]] as const) {
      const page = await browser.openPage()
      try {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-${width === 1440 ? 1440 : 390}`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.remote-connection') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<boolean>(`document.querySelector('.app-header [aria-label="Machine"]') === null && document.querySelector('.app-header .remote-connection') !== null`)).toBe(true)
        await page.evaluate(`document.querySelector('a[href="/remote/settings"]')?.click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('#device-settings') !== null`); attempt += 1) await Bun.sleep(50)
        const current = `[...document.querySelectorAll('[aria-labelledby="machine-settings"] .machine-row__item[aria-current="true"] .machine-row__name')].map(name => name.textContent.trim()).join()`
        expect(await page.evaluate<string>(current)).toBe("Studio Mac")
        await page.evaluate(`[...document.querySelectorAll('[aria-labelledby="machine-settings"] .machine-row__item')].find(item => item.querySelector('.machine-row__name').textContent === 'Dev Linux').querySelector('.machine-row__connect').click()`)
        for (let attempt = 0; attempt < 40 && await page.evaluate<string>(current) !== "Dev Linux"; attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<string>(current)).toBe("Dev Linux")
      } finally { await page.close() }
    }
  }, 30_000)

  test("keeps long machine names on one line with ellipsis without viewport overflow", async () => {
    if (!browser) throw new Error("Chrome was not initialized")
    const longName = "build-agent-west-coast-production-07.example.internal"
    for (const width of [1440, 1280, 1024, 768, 390, 320]) {
      const page = await browser.openPage()
      try {
        await page.setViewport(width, 844)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=settings&machineName=${encodeURIComponent(longName)}`)
        for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] .machine-row__name') !== null`); attempt += 1) await Bun.sleep(50)
        const result = await page.evaluate<{ readonly text: string; readonly lines: number; readonly truncated: boolean; readonly whiteSpace: string; readonly textOverflow: string; readonly title: string | null; readonly itemRight: number; readonly documentOverflow: boolean }>(`(() => {
          const name = document.querySelector('[aria-labelledby="machine-settings"] .machine-row__name')
          const item = name.closest('.machine-row__item')
          const range = document.createRange(); range.selectNodeContents(name)
          const style = getComputedStyle(name)
          return { text: name.textContent, lines: new Set([...range.getClientRects()].map(rect => rect.top + ':' + rect.bottom)).size, truncated: name.scrollWidth > name.clientWidth && style.overflowX === 'hidden', whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, title: name.getAttribute('title'), itemRight: item.getBoundingClientRect().right - name.closest('.machine-row').getBoundingClientRect().left, documentOverflow: document.documentElement.scrollWidth > innerWidth }
        })()`)
        expect(result.text).toBe(longName)
        expect(result.title).toBe(longName)
        expect(result.whiteSpace).toBe("nowrap")
        expect(result.textOverflow).toBe("ellipsis")
        expect(result.lines).toBe(1)
        if (width < 768) expect(result.truncated).toBe(true)
        expect(result.documentOverflow).toBe(false)
      } finally { await page.close() }
    }
  }, 60_000)

  test("widens the Settings machine item to fit a typical machine hostname", async () => {
    if (!browser) throw new Error("Chrome was not initialized")
    for (const width of [1280, 1440]) {
      const page = await browser.openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=settings&machineName=${encodeURIComponent("Developer-MacBook-Pro.local")}`)
        for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] .machine-row__name') !== null`); attempt += 1) await Bun.sleep(50)
        const result = await page.evaluate<{ readonly fits: boolean; readonly itemWidth: number }>(`(() => {
          const name = document.querySelector('[aria-labelledby="machine-settings"] .machine-row__name')
          if (!name) throw new Error('Machine row did not render')
          return { fits: name.scrollWidth <= name.clientWidth, itemWidth: name.closest('.machine-row__item').getBoundingClientRect().width }
        })()`)
        expect(result.fits).toBe(true)
        expect(result.itemWidth).toBeGreaterThan(240)
      } finally { await page.close() }
    }
  }, 30_000)
})
