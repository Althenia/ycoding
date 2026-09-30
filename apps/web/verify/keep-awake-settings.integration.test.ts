import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4423
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (
      await fetch(`http://127.0.0.1:${port}/verify/keep-awake-settings-fixture.html`).then(
        (response) => response.ok,
        () => false,
      )
    ) {
      browser = await launchBrowser(executable, 1440, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Keep machine awake fixture did not start")
})
afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

const control = `document.querySelector('input[aria-labelledby="machine-awake-label"]')`
const label = `${control}.nextElementSibling.textContent`
const detail = `document.getElementById('machine-awake-status').textContent`
const count = (operation: "get" | "set") =>
  `window.keepAwakeFixture.calls.filter(call => call.operation === 'machine.keepAwake.${operation}').length`

async function until(page: { evaluate<T>(expression: string): Promise<T> }, expression: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return
    await Bun.sleep(30)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

async function open(read = "held", theme = "light", width = 1440) {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  await page.setViewport(width, 900)
  await page.setCoarsePointer(width < 768)
  await page.setReducedMotion(true)
  await page.navigate(`http://127.0.0.1:${port}/verify/keep-awake-settings-fixture.html?read=${read}&theme=${theme}`)
  await until(page, `${control} !== null`)
  return page
}

describe("Settings Keep machine awake", () => {
  test("shows the backend state, reserves geometry, and changes it only from a keyboard action without browser persistence", async () => {
    for (const width of [320, 390, 1440])
      for (const theme of ["light", "dark"]) {
        const page = await open("held", theme, width)
        try {
          expect(
            await page.evaluate<{ label: string; disabled: boolean; checked: boolean }>(
              `({ label: ${label}, disabled: ${control}.disabled, checked: ${control}.checked })`,
            ),
          ).toEqual({ label: "Checking", disabled: true, checked: false })
          const before = await page.evaluate<{ top: number; storage: string }>(
            `({ top: document.getElementById('following-settings').getBoundingClientRect().top, storage: JSON.stringify(localStorage) })`,
          )
          expect(await page.evaluate<string>(`document.getElementById('machine-awake-caveat').textContent`)).toMatch(
            /macOS.*idle sleep only.*manual sleep or closing the lid.*stops or restarts/,
          )
          await page.evaluate(`window.keepAwakeFixture.releaseRead('off')`)
          await until(page, `${label} === 'Off' && !${control}.disabled`)
          expect(
            await page.evaluate<number>(`document.getElementById('following-settings').getBoundingClientRect().top`),
          ).toBe(before.top)
          expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
          if (width < 768)
            expect(
              await page.evaluate<number>(`${control}.closest('label').getBoundingClientRect().height`),
            ).toBeGreaterThanOrEqual(44)
          await page.evaluate(`${control}.focus()`)
          expect(await page.evaluate<boolean>(`${control}.matches(':focus-visible')`)).toBe(true)
          await page.pressKey(" ", "Space", 32)
          await until(page, `${count("set")} === 1`)
          expect(
            await page.evaluate<{ disabled: boolean; checked: boolean; message: string }>(
              `({ disabled: ${control}.disabled, checked: ${control}.checked, message: ${detail} })`,
            ),
          ).toEqual({ disabled: true, checked: false, message: "Turning on…" })
          await page.evaluate(`window.keepAwakeFixture.releaseSet('on')`)
          await until(page, `${label} === 'On' && !${control}.disabled`)
          expect(await page.evaluate<boolean>(`${control}.checked`)).toBe(true)
          expect(
            await page.evaluate<unknown>(
              `window.keepAwakeFixture.calls.find(call => call.operation === 'machine.keepAwake.set').request.input`,
            ),
          ).toEqual({ enabled: true })
          expect(await page.evaluate<string>(`JSON.stringify(localStorage)`)).toBe(before.storage)
        } finally {
          await page.close()
        }
      }
  }, 60_000)

  test("old, silent, unsupported, failed, and machine-error answers stay explicit instead of pretending to be Off", async () => {
    for (const [mode, state, disabled, expected] of [
      ["old", "Unavailable", true, /Update YCoding/],
      ["silent", "Unavailable", true, /did not answer.*Update YCoding/],
      ["unsupported", "Unsupported", true, /only on macOS/],
      ["failed", "Unavailable", true, /Machine request failed/],
      ["error", "Error", false, /ended unexpectedly/],
    ] as const) {
      const page = await open(mode, "dark", 390)
      try {
        await until(page, `${label} === '${state}'`)
        expect(await page.evaluate<boolean>(`${control}.disabled`)).toBe(disabled)
        expect(await page.evaluate<boolean>(`${control}.checked`)).toBe(false)
        expect(await page.evaluate<string>(detail)).toMatch(expected)
        expect(
          await page.evaluate<string>(`document.getElementById('machine-awake-status').getAttribute('aria-live')`),
        ).toBe("polite")
        expect(await page.evaluate<number>(count("set"))).toBe(0)
        if (mode === "failed" || mode === "silent") {
          await page.evaluate(
            `window.keepAwakeFixture.read('on'); document.querySelector('[aria-label="Retry Keep machine awake"]').click()`,
          )
          await until(page, `${label} === 'On'`)
          expect(await page.evaluate<number>(count("get"))).toBe(2)
        }
      } finally {
        await page.close()
      }
    }
  }, 30_000)

  test("unknown changes reconcile once without replay or confirmation; failure keeps the reported state", async () => {
    const page = await open("off")
    try {
      await until(page, `${label} === 'Off'`)
      await page.evaluate(
        `window.keepAwakeFixture.read('on'); window.keepAwakeFixture.mutation('silent'); ${control}.click()`,
      )
      await until(page, `${label} === 'On' && ${detail}.includes('unconfirmed')`)
      expect(await page.evaluate<number>(count("set"))).toBe(1)
      expect(await page.evaluate<number>(count("get"))).toBe(2)
      expect(await page.evaluate<string>(detail)).not.toMatch(/turned on|confirmed on/)
      await page.evaluate(`window.keepAwakeFixture.mutation('failed'); ${control}.click()`)
      await until(page, `${detail}.includes('Machine request failed')`)
      expect(await page.evaluate<string>(label)).toBe("On")
      expect(await page.evaluate<boolean>(`${control}.checked`)).toBe(true)
    } finally {
      await page.close()
    }
  })

  test("switches and reconnects read the owning machine, ignore late answers, and reread when Settings reopens", async () => {
    const page = await open("held")
    try {
      await page.evaluate(`window.keepAwakeFixture.store.connect('dev_laptop')`)
      await until(page, `${count("get")} === 2`)
      await page.evaluate(`window.keepAwakeFixture.releaseRead('on')`)
      expect(await page.evaluate<string>(label)).toBe("Checking")
      await page.evaluate(`window.keepAwakeFixture.releaseRead('off'); window.keepAwakeFixture.read('off')`)
      await until(page, `${label} === 'Off'`)
      await page.evaluate(`${control}.click()`)
      await until(page, `${count("set")} === 1`)
      await page.evaluate(`window.keepAwakeFixture.drop()`)
      await until(page, `${label} === 'Unavailable' && ${control}.disabled`)
      await page.evaluate(`window.keepAwakeFixture.reconnect()`)
      await until(page, `${label} === 'Off' && ${detail}.includes('unconfirmed')`)
      await page.evaluate(`window.keepAwakeFixture.releaseSet('on')`)
      expect(await page.evaluate<string>(label)).toBe("Off")
      expect(await page.evaluate<number>(count("set"))).toBe(1)
      await page.evaluate(`window.keepAwakeFixture.show(false)`)
      await until(page, `${control} === null`)
      const before = await page.evaluate<number>(count("get"))
      await page.evaluate(`window.keepAwakeFixture.read('on'); window.keepAwakeFixture.show(true)`)
      await until(page, `${label} === 'On'`)
      expect(await page.evaluate<number>(count("get"))).toBe(before + 1)
      expect(await page.evaluate<number>(count("set"))).toBe(1)
    } finally {
      await page.close()
    }
  })
})
