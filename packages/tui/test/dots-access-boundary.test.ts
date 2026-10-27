import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("the composer exposes one access command and no room transport or binding controls", async () => {
  const source = await readFile(new URL("../src/component/prompt/index.tsx", import.meta.url), "utf8")
  expect(source.includes("dotsAccessCommand(dotsAccess)")).toBe(true)
  expect(source.includes("client.api.dots.access.get")).toBe(true)
  expect(source.includes("client.api.dots.access.set")).toBe(true)
  expect(source.includes('data.on("session.dots.access.changed"')).toBe(true)
  expect(source.includes('dialog.size === "command-palette"')).toBe(true)
  for (const obsolete of ["Select Dots destination", "Unbind Dots destination", "Coordinator bindings", "dotsInput", "dotsCapability", "dotsTarget", 'slash: { name: "dots"', "api.dots.status", "api.dots.send", "api.dots.bind", "api.dots.delegation"])
    expect(source.includes(obsolete)).toBe(false)
})
