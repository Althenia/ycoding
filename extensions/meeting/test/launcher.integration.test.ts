import { expect, test } from "bun:test"
import { startBackend } from "./fixture/runtime"
import { startMeetingRuntime } from "../script/dev"

test.each(["local", "beta"])(
  "the source launcher owns a Rust Meeting runtime from an ordinary project directory (%s)",
  async (channel) => {
    const backend = await startBackend(channel)
    try {
      expect(backend.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/view#key=[a-f0-9]{64}$/)
      const page = await fetch(backend.url)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain("/view/app.js")
      expect((await fetch(`${backend.origin}/view/state`)).status).toBe(401)
      const initial = await backend.status()
      expect(initial.health?.status).toBe("unloaded")
      expect(initial.analysis.status).toBe("idle")
      if (channel === "local") {
        expect(initial.meeting).toBeUndefined()
        expect(initial.meetings).toEqual([])
      }
      await backend.control({ action: "start", title: "Rust source launcher" })
      expect((await backend.status()).meeting).toMatchObject({ title: "Rust source launcher", status: "ready" })
      expect((await backend.status()).health?.status).toBe("ready")
      expect(await backend.status()).not.toHaveProperty("pairing")
    } finally {
      await backend.stop()
    }
    await expect(fetch(`${backend.origin}/view/state`)).rejects.toThrow()
  },
  60000,
)

test("the source launcher reports an unavailable Rust executable without starting a fallback backend", async () => {
  await expect(
    startMeetingRuntime({
      env: { PATH: process.env.PATH, YCODING_RUNTIME_EXECUTABLE: "/nonexistent/ycoding-runtime" },
    }),
  ).rejects.toThrow()
})
