import { describe, expect, test } from "bun:test"
import { inlineSegments } from "./inline"

describe("inlineSegments", () => {
  test("keeps plain prose as one run", () => {
    expect(inlineSegments("Run the terminal interface.")).toEqual([{ code: false, text: "Run the terminal interface." }])
  })

  test("marks every backtick pair as inline code", () => {
    expect(inlineSegments("Run `ycoding` or `ycoding run --yolo`.")).toEqual([
      { code: false, text: "Run " },
      { code: true, text: "ycoding" },
      { code: false, text: " or " },
      { code: true, text: "ycoding run --yolo" },
      { code: false, text: "." },
    ])
  })

  test("leaves text with an unpaired backtick literal", () => {
    expect(inlineSegments("Quote with ` alone")).toEqual([{ code: false, text: "Quote with ` alone" }])
  })

  test("drops empty runs", () => {
    expect(inlineSegments("`cli.json`")).toEqual([{ code: true, text: "cli.json" }])
  })
})
