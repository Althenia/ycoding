import { expect, test } from "bun:test"
import { toolOutputDisplay } from "../src/util/collapse-tool-output"
import { sessionSkillContent } from "../src/util/session-skills"

test("shows output within the preview budget without an expand affordance", () => {
  expect(toolOutputDisplay("done", false, 4, 80)).toEqual({
    output: "done",
    visible: true,
    expandable: false,
  })
})

test("bounds output exceeding the preview budget and makes it expandable", () => {
  const output = ["one", "two", "three", "four", "five"].join("\n")
  const display = toolOutputDisplay(output, false, 4, 80)

  expect(display.visible).toBe(true)
  expect(display.expandable).toBe(true)
  expect(display.output).toBe("one\ntwo\nthree\nfour…")
})

test("shows complete output after expansion", () => {
  const output = ["one", "two", "three", "four", "five"].join("\n")

  expect(toolOutputDisplay(output, true, 4, 80).output).toBe(output)
})

test("hides empty and whitespace-only output", () => {
  expect(toolOutputDisplay("", false, 4, 80).visible).toBe(false)
  expect(toolOutputDisplay(" \n\t ", false, 4, 80).visible).toBe(false)
})

test("keeps error output visible", () => {
  const display = toolOutputDisplay("permission denied", false, 4, 80)

  expect(display.visible).toBe(true)
  expect(display.output).toBe("permission denied")
})

test("keeps loaded skill output collapsed until expansion", () => {
  const content = sessionSkillContent(["one", "two", "three", "four", "five"].join("\n"))

  expect(toolOutputDisplay(content, false, 4, 80).output).toBe("one\ntwo\nthree\nfour…")
  expect(toolOutputDisplay(content, true, 4, 80).output).toBe(content)
})
