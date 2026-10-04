import { describe, expect, test } from "bun:test"
import { inlineSegments } from "./inline"

describe("inlineSegments", () => {
  test("marks every backtick pair as inline code", () => {
    expect(inlineSegments("Run `ycoding` or `ycoding run --yolo`.")).toEqual([
      { code: false, text: "Run " },
      { code: true, text: "ycoding" },
      { code: false, text: " or " },
      { code: true, text: "ycoding run --yolo" },
      { code: false, text: "." },
    ])
  })

  test("marks **bold** pairs outside code as strong", () => {
    expect(inlineSegments("**Symptom:** `ycoding` is not found.")).toEqual([
      { code: false, strong: true, text: "Symptom:" },
      { code: false, text: " " },
      { code: true, text: "ycoding" },
      { code: false, text: " is not found." },
    ])
    expect(inlineSegments("Globs like `src/**` stay code.")).toEqual([
      { code: false, text: "Globs like " },
      { code: true, text: "src/**" },
      { code: false, text: " stay code." },
    ])
  })

  test.each([
    ["Run the terminal interface.", [{ code: false, text: "Run the terminal interface." }]],
    ["Quote with ` alone", [{ code: false, text: "Quote with ` alone" }]],
    ["`cli.json`", [{ code: true, text: "cli.json" }]],
  ])("keeps prose, unpaired backticks and empty runs literal: %p", (text, segments) => {
    expect(inlineSegments(text)).toEqual(segments)
  })
})
