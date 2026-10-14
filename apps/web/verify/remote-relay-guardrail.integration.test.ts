import { afterAll, beforeAll, expect, test } from "bun:test"
import type { RelayRequestView } from "../src/remote/wire-views"
import { startRelayDouble } from "../test/relay-double"
import { launchBrowser } from "./cdp"

const port = 4196
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let vite: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  vite = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (
      await fetch(`http://127.0.0.1:${port}/verify/remote.html`)
        .then((response) => response.ok)
        .catch(() => false)
    )
      break
    await Bun.sleep(100)
  }
  browser = await launchBrowser(browserPath, 1440, 1200)
})

afterAll(async () => {
  await browser?.close()
  vite?.kill()
  if (vite) await vite.exited
})

for (const [decision, reply] of [
  ["Reject", "reject"],
  ["Approve once", "once"],
] as const) {
  test(`a rendered hard review sends one ${decision} over the relay wire and removes its card`, async () => {
    const requests: RelayRequestView[] = []
    const acknowledgement = Promise.withResolvers<void>()
    const relay = await startRelayDouble({
      handler: async (request) => {
        requests.push(request)
        await acknowledgement.promise
        return { ok: true, value: null }
      },
    })
    const page = await browser!.openPage()
    try {
      await page.navigate(
        `http://127.0.0.1:${port}/verify/remote.html?scenario=permission-guardrail-hard-review-form-requests-1440&relay=${encodeURIComponent(relay.wsURL("dev_studio"))}`,
      )
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('.request--hard') !== null`)) break
        await Bun.sleep(100)
      }
      expect(
        await page.evaluate<readonly string[]>(
          `[...document.querySelectorAll('.request--hard .request__actions button')].map(button => button.textContent.trim())`,
        ),
      ).toEqual(["Approve once", "Reject"])
      await page.evaluate(
        `[...document.querySelectorAll('.request--hard .request__actions button')].find(button => button.textContent.trim() === ${JSON.stringify(decision)})?.click()`,
      )
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (requests.length > 0) break
        await Bun.sleep(50)
      }
      expect(relay.rejectedFrames).toEqual([])
      expect(
        requests.map((request) => ({
          operation: request.operation,
          sessionID: request.sessionID,
          input: request.input,
        })),
      ).toEqual([
        {
          operation: "session.guardrail.request.reply",
          sessionID: "ses_fixture",
          input: { requestID: "grq_hard", reply },
        },
      ])
      expect(await page.evaluate<boolean>(`document.querySelector('.request--hard') !== null`)).toBe(true)
      expect(requests).toHaveLength(1)
      acknowledgement.resolve()
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('.request--hard') === null`)) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<boolean>(`document.querySelector('.request--hard') === null`)).toBe(true)
      expect(requests).toHaveLength(1)
    } finally {
      await page.close()
      acknowledgement.resolve()
      await relay.stop()
    }
  }, 30_000)
}
