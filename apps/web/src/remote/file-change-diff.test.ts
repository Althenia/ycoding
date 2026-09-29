import { expect, test } from "bun:test"
import { filePathParts, parseUnifiedPatch, summarizeFileChanges } from "./file-change-diff"

test("parses numbered unified lines and aligns replacement, deletion, and context rows side by side", () => {
  const patch = [
    "diff --git a/src/example.ts b/src/example.ts",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -2,4 +2,3 @@ section",
    " keep",
    "-old one",
    "-old two",
    "+new one",
    " keep tail",
    "\\ No newline at end of file",
  ].join("\n")
  expect(parseUnifiedPatch(patch)).toEqual({
    unified: [
      { kind: "hunk", text: "@@ -2,4 +2,3 @@ section" },
      { kind: "context", text: "keep", oldNumber: 2, newNumber: 2 },
      { kind: "removed", text: "old one", oldNumber: 3 },
      { kind: "removed", text: "old two", oldNumber: 4 },
      { kind: "added", text: "new one", newNumber: 3 },
      { kind: "context", text: "keep tail", oldNumber: 5, newNumber: 4 },
    ],
    split: [
      { kind: "hunk", text: "@@ -2,4 +2,3 @@ section" },
      { kind: "line", old: { kind: "context", number: 2, text: "keep" }, new: { kind: "context", number: 2, text: "keep" } },
      { kind: "line", old: { kind: "removed", number: 3, text: "old one" }, new: { kind: "added", number: 3, text: "new one" } },
      { kind: "line", old: { kind: "removed", number: 4, text: "old two" } },
      { kind: "line", old: { kind: "context", number: 5, text: "keep tail" }, new: { kind: "context", number: 4, text: "keep tail" } },
    ],
  })
})

test("handles additions from an empty file, multiple hunks, and CRLF without inventing intervening lines", () => {
  const parsed = parseUnifiedPatch("@@ -0,0 +1,2 @@\r\n+first\r\n+second\r\n@@ -10 +20 @@\r\n-old\r\n+new\r\n")
  expect(parsed?.unified).toEqual([
    { kind: "hunk", text: "@@ -0,0 +1,2 @@" },
    { kind: "added", text: "first", newNumber: 1 },
    { kind: "added", text: "second", newNumber: 2 },
    { kind: "hunk", text: "@@ -10 +20 @@" },
    { kind: "removed", text: "old", oldNumber: 10 },
    { kind: "added", text: "new", newNumber: 20 },
  ])
  expect(parsed?.split).toEqual([
    { kind: "hunk", text: "@@ -0,0 +1,2 @@" },
    { kind: "line", new: { kind: "added", number: 1, text: "first" } },
    { kind: "line", new: { kind: "added", number: 2, text: "second" } },
    { kind: "hunk", text: "@@ -10 +20 @@" },
    { kind: "line", old: { kind: "removed", number: 10, text: "old" }, new: { kind: "added", number: 20, text: "new" } },
  ])
})

test("rejects malformed, incomplete, or binary patches instead of showing invented file contents", () => {
  for (const patch of ["", "--- a/a.ts\n+++ b/a.ts", "@@ -x +1 @@\n+new", "@@ -1 +1 @@\n-old", "Binary files a/a.png and b/a.png differ"])
    expect(parseUnifiedPatch(patch)).toBeUndefined()
})

test("sums supplied per-file counts and separates directory from basename", () => {
  const files = [
    { path: "src/long/name.ts", patch: "", additions: 30, deletions: 0 },
    { path: "README.md", patch: "", additions: 3, deletions: 0 },
    { path: "empty.ts", patch: "", additions: 0, deletions: 0 },
    { path: "ui/index.ts", patch: "", additions: 0, deletions: 0 },
  ]
  expect(summarizeFileChanges(files)).toEqual({ files: 4, additions: 33, deletions: 0 })
  expect(filePathParts("src/long/name.ts")).toEqual({ directory: "src/long/", basename: "name.ts" })
  expect(filePathParts("README.md")).toEqual({ directory: "", basename: "README.md" })
})
