import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { createTwoFilesPatch, diffLines, formatPatch, structuredPatch } from "diff"

const cases = [
  {
    id: "distant",
    old: "one\nkeep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\nkeep 6\nkeep 7\nkeep 8\nkeep 9\nkeep 10\nkeep 11\nkeep 12\nkeep 13\nkeep 14\n",
    next: "ONE\nkeep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\nkeep 6\nkeep 7\nkeep 8\nkeep 9\nkeep 10\nkeep 11\nkeep 12\nkeep 13\nkeep 14\nFOURTEEN\n",
  },
  { id: "no-newline", old: "before\nending", next: "before\nending changed" },
  { id: "crlf", old: "first\r\nkeep\r\nlast\r\n", next: "first\r\nmiddle\r\nlast\r\n" },
  { id: "empty", old: "", next: "single" },
  { id: "unicode", old: "naïve 😀\nkeep\n", next: "naïve 🐇\nkeep\n" },
]

const output = cases.map((item) => {
  const filename = `edit-${item.id}.txt`
  const patch = structuredPatch(filename, filename, item.old, item.next, "", "", { context: 4 })
  const formatted = formatPatch(structuredPatch(filename, filename, item.old, item.next, "", "", { context: 4 }))
  return {
    ...item,
    chunks: diffLines(item.old, item.next),
    structured: patch,
    patch: createTwoFilesPatch(filename, filename, item.old, item.next),
    formatted,
  }
})

const path = new URL("../../../rust/crates/core/tests/fixtures/jsdiff-goldens.json", import.meta.url)
await mkdir(dirname(path.pathname), { recursive: true })
await writeFile(path, `${JSON.stringify(output, null, 2)}\n`)
