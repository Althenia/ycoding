import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 5183
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(browserPath, 1440, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Vite did not start the remote fixture")
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

async function until(page: Page, expression: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(40)
  }
  throw new Error(`Page did not settle: ${expression}`)
}

async function open(query: string, width: number, height: number) {
  if (!browser) throw new Error("Chrome was not initialized")
  const page = await browser.openPage()
  await page.setViewport(width, height)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
  return page
}

describe("selected machine placement", () => {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    test(`Settings → Machine names the selected machine at ${width}px`, async () => {
      const page = await open("view=settings&machines=distinct&machineName=Build%20Box", width, height)
      try {
        await until(page, `document.getElementById('machine-selected-name') !== null`)
        expect(await page.evaluate<{ readonly label: string; readonly name: string; readonly inMachineSection: boolean }>(`(() => {
          const name = document.getElementById('machine-selected-name')
          return {
            label: document.getElementById('machine-selected-label').textContent.trim(),
            name: name.textContent.trim(),
            inMachineSection: name.closest('[aria-labelledby="machine-settings"]') !== null,
          }
        })()`)).toEqual({ label: "Selected machine", name: "Build Box", inMachineSection: true })
      } finally { await page.close() }
    })
  }

  test("the desktop sidebar drops the machine footer and keeps Settings one navigation step away", async () => {
    const page = await open("view=chat", 1440, 900)
    try {
      await until(page, `document.querySelector('.workspace__rail .session-row') !== null && document.querySelector('.remote-connection-label')?.textContent.trim() === 'Connected'`)
      const rail = await page.evaluate<string>(`document.querySelector('.workspace__rail').textContent`)
      expect(rail).not.toContain("Selected machine")
      expect(rail).not.toContain("Manage connection")
      expect(await page.evaluate<number>(`document.querySelectorAll('.workspace__rail-footer').length`)).toBe(0)
      expect(await page.evaluate<string | null>(`document.querySelector('.workspace__rail .remote-nav__link--settings')?.getAttribute('href') ?? null`)).toBe("/remote/settings")
    } finally { await page.close() }
  })
})
