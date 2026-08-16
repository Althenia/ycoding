import { expect, test } from "bun:test"
import path from "node:path"

test("package root exposes only current plugin entrypoints", async () => {
  const root = await import("@ycoding-ai/plugin")
  const effect = await import("@ycoding-ai/plugin/effect")
  const tui = await import("@ycoding-ai/plugin/tui")
  const manifest = await Bun.file(path.resolve(import.meta.dir, "../package.json")).json()

  for (const name of ["Agent", "Command", "Integration", "Model", "Plugin", "Provider", "Reference", "Skill"]) {
    expect(root).toHaveProperty(name)
    expect(effect).toHaveProperty(name)
  }
  expect(tui).toHaveProperty("Plugin")
  expect(Object.keys(manifest.exports).some((key) => key.includes("/v2"))).toBe(false)
  expect(Object.keys(manifest.exports).sort()).toEqual([".", "./effect", "./effect/*", "./tool", "./tui", "./tui/*"])
})
