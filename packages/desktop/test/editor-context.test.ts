import { expect, test } from "bun:test"
import { editorSelectionKey, formatEditorContext } from "../src/editor-format"

test("editor context keeps each selected range and identifies its one-based lines", () => {
  const value = { filePath: "/synthetic/file.ts", source: "websocket" as const, ranges: [
    { text: "first", selection: { start: { line: 3, character: 1 }, end: { line: 3, character: 6 } } },
    { text: "second\nthird", selection: { start: { line: 8, character: 1 }, end: { line: 9, character: 6 } } },
  ] }
  expect(formatEditorContext(value)).toBe('<system-reminder>Note: The user selected Selection 1: #3 from "/synthetic/file.ts". ```first```\n\n\nNote: The user selected Selection 2: #8-9 from "/synthetic/file.ts". ```second\nthird```\n\n This may or may not be relevant to the current task.</system-reminder>\n')
  expect(editorSelectionKey(value)).not.toBe(editorSelectionKey({ ...value, ranges: [value.ranges[1]!] }))
})

test("a cursor-only editor context identifies the open file without inventing selected text", () => {
  const value = { filePath: "/synthetic/file.ts", source: "zed" as const, ranges: [{ text: "", selection: { start: { line: 3, character: 1 }, end: { line: 3, character: 1 } } }] }
  expect(formatEditorContext(value)).toBe('<system-reminder>Note: The user opened the file "/synthetic/file.ts". This may or may not be relevant to the current task.</system-reminder>\n')
})
