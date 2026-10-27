import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("the composer owns no Dots connection or per-family access lifecycle", async () => {
  const source = await readFile(new URL("../src/component/prompt/index.tsx", import.meta.url), "utf8")
  for (const obsolete of ["createDotsAccess", "dotsAccessCommand", "api.dots.access", "session.dots.access.changed", "Select Dots destination", "Unbind Dots destination", "Coordinator bindings", "dotsInput", "dotsCapability", "dotsTarget", 'slash: { name: "dots"', "api.dots.status", "api.dots.send", "api.dots.bind", "api.dots.delegation"])
    expect(source.includes(obsolete)).toBe(false)
})
