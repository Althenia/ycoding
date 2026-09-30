import { expect, test } from "bun:test"
import { declarationsWhere, parseStylesheet, readStylesheet } from "./css-rules"

test("the design system owns cursor values for existing web interactions", async () => {
  const tokens = declarationsWhere(await readStylesheet("tokens.css"), (rule) => rule.header === ":root")
  expect(Object.fromEntries(Object.entries(tokens).filter(([key]) => key.startsWith("--yc-cursor-")))).toEqual({
    "--yc-cursor-surface": "default",
    "--yc-cursor-action": "pointer",
    "--yc-cursor-text": "text",
    "--yc-cursor-disabled": "not-allowed",
    "--yc-cursor-busy": "progress",
    "--yc-cursor-pan": "grab",
    "--yc-cursor-panning": "grabbing",
    "--yc-cursor-zoom-in": "zoom-in",
    "--yc-cursor-adjust-x": "ew-resize",
    "--yc-cursor-resize-y": "ns-resize",
  })
})

test("only the shared foundation assigns cursor roles, never component stylesheets", async () => {
  const files = await Array.fromAsync(new Bun.Glob("**/*.css").scan({ cwd: new URL("../", import.meta.url).pathname }))
  const assignments = (await Promise.all(files.map(async (file) => {
    const sheet = parseStylesheet(file, await Bun.file(new URL(`../${file}`, import.meta.url)).text())
    return sheet.rules.filter((rule) => rule.declarations.cursor !== undefined).map((rule) => ({
      file, selector: rule.header, cursor: rule.declarations.cursor,
    }))
  }))).flat()
  expect(assignments.length).toBeGreaterThan(0)
  expect(assignments.filter((assignment) => assignment.file !== "styles/base.css")).toEqual([])
  expect(assignments.every((assignment) => assignment.cursor === "inherit" || /^var\(--yc-cursor-[a-z-]+\)$/.test(assignment.cursor!))).toBe(true)
})
