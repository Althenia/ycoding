import { expect, test } from "bun:test"
import { defaultDiffPreferences, parseDiffPreferences, diffFileTree } from "../src/diff-preferences"

test("diff preferences preserve supported display choices and recover malformed storage", () => {
  expect(parseDiffPreferences(null)).toEqual(defaultDiffPreferences)
  expect(parseDiffPreferences("broken")).toEqual(defaultDiffPreferences)
  expect(parseDiffPreferences(JSON.stringify({ view: "split", wrap: "none", tree: false, single: true }))).toEqual({ view: "split", wrap: "none", tree: false, single: true })
  expect(parseDiffPreferences(JSON.stringify({ view: "unknown", wrap: "none", tree: "no", single: true }))).toEqual({ ...defaultDiffPreferences, wrap: "none", single: true })
})

test("diff file trees preserve nested paths without conflating directories and file names", () => {
  expect(diffFileTree(["src/lib/a.ts", "README.md", "src/b.ts"])).toEqual([
    { name: "README.md", path: "README.md", children: [] },
    { name: "src", path: undefined, children: [
      { name: "b.ts", path: "src/b.ts", children: [] },
      { name: "lib", path: undefined, children: [{ name: "a.ts", path: "src/lib/a.ts", children: [] }] },
    ] },
  ])
})
