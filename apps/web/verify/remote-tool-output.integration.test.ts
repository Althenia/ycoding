import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
let origin = ""

beforeAll(async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = 4220 + (process.pid % 100) + attempt * 101
    const candidate = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: import.meta.dir.replace(/\/verify$/, ""),
      stdout: "ignore",
      stderr: "ignore",
    })
    for (let poll = 0; poll < 60 && candidate.exitCode === null; poll += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`)
        if (response.ok) {
          server = candidate
          origin = `http://127.0.0.1:${port}`
          browser = await launchBrowser(browserPath, 390, 844)
          return
        }
      } catch {
        // Wait for the local source server.
      }
      await Bun.sleep(100)
    }
    candidate.kill()
    await candidate.exited
  }
  throw new Error("Vite did not start for the tool-output render test")
}, 30_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("remote tool output rendering", () => {
  test("hides both local capture paths, caps visible text, and labels client and device limits separately", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`${origin}/verify/transcript.html?tool-output=1`)
      const displayed = await page.evaluate<{
        readonly output: string
        readonly notes: readonly string[]
      }>(`(async () => {
        for (let i = 0; i < 40 && document.querySelectorAll('.transcript-tool').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 25));
        document.querySelectorAll('.transcript-tool__toggle').forEach(button => button.click());
        await new Promise(resolve => setTimeout(resolve, 25));
        const output = [...document.querySelectorAll('.transcript-tool .output code')].map(element => element.textContent ?? '').join('\\n');
        const notes = [...document.querySelectorAll('.transcript-tool')].map(tool => [...tool.querySelectorAll('.transcript-tool__note')].map(note => note.textContent ?? '').join(' '));
        return { output, notes };
      })()`)
      expect(displayed.output).toContain("first line")
      expect(displayed.output).toContain("shell result")
      expect(displayed.output).not.toContain("/private/fixture/")
      expect(displayed.output.length).toBeLessThan(5_000)
      expect(displayed.notes[0]).toContain("available tool output")
      expect(displayed.notes[0]).toContain("truncated on the device")
      expect(displayed.notes[1]).toContain("truncated on the device")
      expect(displayed.notes[1]).not.toContain("available tool output")
    } finally {
      await page.close()
    }
  }, 30_000)
})
