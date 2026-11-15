import { expect, test } from "bun:test"
import type { MentionPick } from "../src/form-rules"
import { PASTE_STORAGE_KEY, expandPastedPrompt, expandPastedText, livePasted, parsePasteMode, placePaste } from "../src/paste"

const three = "first\r\nsecond\rthird"
const place = (text: string, start: number, end: number, clipboard: string, pasted: Parameters<typeof placePaste>[0]["pasted"] = [], mode: "compact" | "full" = "compact") => placePaste({ text, pasted, start, end, clipboard, mode })

test("large pastes become a line-count placeholder holding the trimmed, newline-normalized text", () => {
  expect(place("Before  after", 7, 7, `  ${three}\n`)).toEqual({ text: "Before [Pasted ~3 lines] after", caret: 24, pasted: [{ label: "[Pasted ~3 lines]", text: "first\nsecond\nthird" }] })
  const long = "x".repeat(151)
  expect(place("", 0, 0, long)).toEqual({ text: "[Pasted ~1 lines]", caret: 17, pasted: [{ label: "[Pasted ~1 lines]", text: long }] })
})

test("short pastes, whitespace-only pastes and the full setting insert the normalized text itself", () => {
  expect(place("ab", 1, 1, "one\r\ntwo")).toEqual({ text: "aone\ntwob", caret: 8, pasted: [] })
  expect(place("ab", 1, 1, "x".repeat(150))).toEqual({ text: `a${"x".repeat(150)}b`, caret: 151, pasted: [] })
  expect(place("", 0, 0, "\n\n\n")).toEqual({ text: "\n\n\n", caret: 3, pasted: [] })
  expect(place("ab", 1, 1, three, [], "full")).toEqual({ text: "afirst\nsecond\nthirdb", caret: 19, pasted: [] })
})

test("each placeholder in a draft is unique, and replacing one through a selection drops its text", () => {
  const first = place("", 0, 0, three)
  const second = place(`${first.text} `, first.text.length + 1, first.text.length + 1, "a\nb\nc", first.pasted)
  expect(second.text).toBe("[Pasted ~3 lines] [Pasted ~3 lines #2]")
  expect(second.pasted).toEqual([{ label: "[Pasted ~3 lines]", text: "first\nsecond\nthird" }, { label: "[Pasted ~3 lines #2]", text: "a\nb\nc" }])
  const typed = place("[Pasted ~3 lines] typed literally", 0, 0, three)
  expect(typed.pasted[0]?.label).toBe("[Pasted ~3 lines #2]")
  const replaced = place(second.text, 0, 17, "plain", second.pasted)
  expect(replaced).toEqual({ text: "plain [Pasted ~3 lines #2]", caret: 5, pasted: [{ label: "[Pasted ~3 lines #2]", text: "a\nb\nc" }] })
})

test("placeholders removed by editing no longer carry their pasted text", () => {
  const pasted = [{ label: "[Pasted ~3 lines]", text: "a\nb\nc" }, { label: "[Pasted ~4 lines]", text: "a\nb\nc\nd" }]
  expect(livePasted("keep [Pasted ~4 lines] only", pasted)).toEqual([{ label: "[Pasted ~4 lines]", text: "a\nb\nc\nd" }])
  expect(livePasted("[Pasted ~3 lines", pasted)).toEqual([])
  expect(livePasted("", pasted)).toEqual([])
})

test("sending expands placeholders and moves later file and agent mentions by the inserted length", () => {
  const pasted = [{ label: "[Pasted ~3 lines]", text: "see @a.ts\nline\nend" }]
  const picks: MentionPick[] = [{ kind: "agent", name: "helper", display: "@helper" }, { kind: "file", display: "@a.ts", uri: "file:///repo/a.ts", name: "a.ts" }]
  const text = "@helper [Pasted ~3 lines] then @a.ts"
  const expanded = expandPastedPrompt(text, picks, pasted)
  expect(expanded.text).toBe("@helper see @a.ts\nline\nend then @a.ts")
  expect(expanded.agents).toEqual([{ name: "helper", mention: { start: 0, end: 7, text: "@helper" } }])
  expect(expanded.files).toEqual([{ uri: "file:///repo/a.ts", name: "a.ts", mention: { start: 32, end: 37, text: "@a.ts" } }])
  expect(expanded.text.slice(32, 37)).toBe("@a.ts")
  expect(expandPastedPrompt("no placeholders @a.ts", picks, [])).toEqual({ text: "no placeholders @a.ts", files: [{ uri: "file:///repo/a.ts", name: "a.ts", mention: { start: 16, end: 21, text: "@a.ts" } }], agents: [] })
})

test("several placeholders expand in text order, stale entries are ignored and a repeated label expands once", () => {
  const pasted = [{ label: "[Pasted ~4 lines]", text: "D" }, { label: "[Pasted ~3 lines]", text: "C" }, { label: "[Pasted ~9 lines]", text: "gone" }]
  expect(expandPastedPrompt("[Pasted ~3 lines]-[Pasted ~4 lines]-[Pasted ~3 lines]", [], pasted).text).toBe("C-D-[Pasted ~3 lines]")
})

test("copying a selection expands the placeholders it contains", () => {
  const pasted = [{ label: "[Pasted ~3 lines]", text: "a\nb\nc" }]
  expect(expandPastedText("x [Pasted ~3 lines] y", pasted)).toBe("x a\nb\nc y")
  expect(expandPastedText("[Pasted ~3", pasted)).toBe("[Pasted ~3")
})

test("the large-paste setting parses compact or full and defaults to compact", () => {
  expect(PASTE_STORAGE_KEY).toBe("ycoding.desktop.paste")
  expect(parsePasteMode("full")).toBe("full")
  expect(parsePasteMode("compact")).toBe("compact")
  for (const raw of [null, "", "FULL", "summary"]) expect(parsePasteMode(raw)).toBe("compact")
})
