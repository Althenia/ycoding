import { expect, test } from "bun:test"
import { descriptor, go, header, logo, terminal, wordmark } from "../src/logo"

test("uses the YCoding wordmark and compact YC mark", () => {
  expect(logo).toEqual({
    left: ["     ", "█   █", "▀█ █▀", "  █  "],
    right: [
      "              ▄          ",
      "█▀▀▀ █▀▀█ █▀▀▄ ▀█▀ █▄_█ █▀▀▀",
      "█___ █__█ █__█ _█_ █_▀█ █_^█",
      "▀▀▀▀ ▀▀▀▀ ▀▀▀  ▀▀▀ ▀  ▀ ▀▀▀▀",
    ],
  })
  expect(go).toEqual({
    left: ["     ", "█   █", "▀█ █▀", "  █  "],
    right: ["    ", "█▀▀▀", "█___", "▀▀▀▀"],
  })
})

test("exports the Penpot terminal mark and header lockup", () => {
  expect(terminal).toEqual(["\u2588   \u2588", "\u2580\u2588 \u2588\u2580", "  \u2588"])
  expect(header).toBe("y. ycoding")
  expect(descriptor).toBe("terminal coding agent")
  expect(wordmark).toBe("YCoding")
})
