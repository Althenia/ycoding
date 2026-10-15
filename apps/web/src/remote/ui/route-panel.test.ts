import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"

test("the remote shell has no Suspense boundary, so a pending read never blanks a route panel", async () => {
  expect(await Bun.file(new URL("./shell.tsx", import.meta.url)).text()).not.toMatch(/\bSuspense\b/)
})

test("the remote shell's warm-up never reads Usage, which loads when its page opens", async () => {
  const shell = await Bun.file(new URL("./shell.tsx", import.meta.url)).text()
  expect(shell).not.toMatch(/preloadUsage/)
  expect(shell).toMatch(/preloadKeepAwake\(remote\)/)
  expect(await Bun.file(new URL("../../app.tsx", import.meta.url)).text()).toMatch(/usage: preloadUsage/)
})

test("remote views read queries through the non-suspending observer, never createQuery", async () => {
  const directory = new URL("./", import.meta.url)
  const sources = (await readdir(directory)).filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
  for (const name of sources) expect({ name, uses: /\bcreateQuery\b/.test(await Bun.file(new URL(name, directory)).text()) }).toEqual({ name, uses: false })
})
