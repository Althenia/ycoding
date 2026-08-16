import { expect, test } from "bun:test"
import path from "node:path"
import { descriptor, go, header, logo, terminal, wordmark } from "../src/logo"

const root = path.resolve(import.meta.dirname, "..")

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

test("contains no legacy product copy in active TUI presentation sources", async () => {
  const files = [
    "src/app.tsx",
    "src/attention.ts",
    "src/mini/splash.ts",
    "src/util/presentation.ts",
    "../cli/src/commands/handlers/tui-shared.ts",
  ]
  const legacy = ["open", "code"].join("")
  const product = new RegExp(`\\b${legacy}\\b`, "i")
  const resume = new RegExp(`\\b${legacy}\\s+(?:mini\\s+)?-s\\b`, "i")
  const stale: string[] = []
  for (const file of files) {
    const content = await Bun.file(path.join(root, file)).text()
    if (product.test(content) || resume.test(content)) stale.push(file)
  }
  expect(stale).toEqual([])
})
