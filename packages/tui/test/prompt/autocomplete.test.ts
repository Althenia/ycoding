import { describe, expect, test } from "bun:test"
import {
  AUTOCOMPLETE_NON_FILE_LIMIT,
  MENTION_DIRECTORY_LIMIT,
  MENTION_RESULT_LIMIT,
  autocompleteWindow,
  clampAutocompleteIndex,
  expandDirectoryQuery,
  mergeAutocompleteOptions,
  mergeFileSearchEntries,
} from "../../src/prompt/autocomplete"

type Entry = { path: string; type: "file" | "directory" }

function directories(count: number): Entry[] {
  return Array.from({ length: count }, (_, index) => ({ path: `dir-${index}/`, type: "directory" }))
}

function files(count: number): Entry[] {
  return Array.from({ length: count }, (_, index) => ({ path: `file-${index}.ts`, type: "file" }))
}

describe("mention search results", () => {
  test("lists directories before files while preserving backend ranking", () => {
    const merged = mergeFileSearchEntries(
      [
        { path: "packages/tui/", type: "directory" },
        { path: "packages/core/", type: "directory" },
      ],
      [
        { path: "packages/tui/src/index.tsx", type: "file" },
        { path: "packages/core/src/app.ts", type: "file" },
      ],
    )

    expect(merged.map((item) => item.path)).toEqual([
      "packages/tui/",
      "packages/core/",
      "packages/tui/src/index.tsx",
      "packages/core/src/app.ts",
    ])
  })

  test("keeps folders visible even when the file search fills every slot", () => {
    const merged = mergeFileSearchEntries([{ path: "packages/tui/", type: "directory" }], files(MENTION_RESULT_LIMIT))

    expect(merged[0]?.path).toBe("packages/tui/")
    expect(merged).toHaveLength(MENTION_RESULT_LIMIT)
  })

  test("caps folders so file results always keep slots", () => {
    const merged = mergeFileSearchEntries(directories(MENTION_DIRECTORY_LIMIT + 6), files(MENTION_RESULT_LIMIT))

    expect(merged.filter((item) => item.type === "directory")).toHaveLength(MENTION_DIRECTORY_LIMIT)
    expect(merged.filter((item) => item.type === "file")).toHaveLength(MENTION_RESULT_LIMIT - MENTION_DIRECTORY_LIMIT)
  })

  test("keeps a single row when both searches return the same path", () => {
    const merged = mergeFileSearchEntries(
      [{ path: "src/", type: "directory" }],
      [
        { path: "src/", type: "file" },
        { path: "src/app.ts", type: "file" },
      ],
    )

    expect(merged.map((item) => item.path)).toEqual(["src/", "src/app.ts"])
  })

  test("still returns results when one of the two searches came back empty", () => {
    expect(mergeFileSearchEntries([], files(3)).map((item) => item.path)).toEqual([
      "file-0.ts",
      "file-1.ts",
      "file-2.ts",
    ])
    expect(mergeFileSearchEntries(directories(2), []).map((item) => item.path)).toEqual(["dir-0/", "dir-1/"])
  })
})

describe("mention result caps", () => {
  test("never lets agents and references crowd out file results", () => {
    const nonFiles = Array.from({ length: 12 }, (_, index) => ({ display: `@agent-${index}` }))
    const fileOptions = Array.from({ length: 20 }, (_, index) => ({ display: `file-${index}.ts` }))

    const merged = mergeAutocompleteOptions(nonFiles, fileOptions)

    expect(merged.filter((item) => item.display.startsWith("file-"))).toHaveLength(20)
    expect(merged.filter((item) => item.display.startsWith("@agent-"))).toHaveLength(AUTOCOMPLETE_NON_FILE_LIMIT)
    expect(merged.slice(0, AUTOCOMPLETE_NON_FILE_LIMIT).every((item) => item.display.startsWith("@agent-"))).toBe(true)
  })

  test("leaves command and skill lists untouched when there are no file results", () => {
    const nonFiles = Array.from({ length: 9 }, (_, index) => ({ display: `/command-${index}` }))
    expect(mergeAutocompleteOptions(nonFiles, [])).toHaveLength(9)
  })
})

describe("selection clamping", () => {
  test("keeps the highlighted row inside the current option list", () => {
    expect(clampAutocompleteIndex(7, 3)).toBe(2)
    expect(clampAutocompleteIndex(1, 5)).toBe(1)
    expect(clampAutocompleteIndex(-2, 5)).toBe(0)
    expect(clampAutocompleteIndex(3, 0)).toBe(0)
  })
})

describe("render window", () => {
  test("keeps only the selected viewport resident while preserving option indexes", () => {
    const options = Array.from({ length: 20 }, (_, index) => `option-${index}`)

    expect(autocompleteWindow(options, 0, 10)).toEqual({ start: 0, options: options.slice(0, 10) })
    expect(autocompleteWindow(options, 10, 10)).toEqual({ start: 1, options: options.slice(1, 11) })
    expect(autocompleteWindow(options, 19, 10)).toEqual({ start: 10, options: options.slice(10) })
  })
})

describe("directory expansion", () => {
  test("does not double the trailing separator for directory entries", () => {
    expect(expandDirectoryQuery("packages/tui/")).toBe("packages/tui/")
    expect(expandDirectoryQuery("packages/tui")).toBe("packages/tui/")
    expect(expandDirectoryQuery("@packages/tui/")).toBe("packages/tui/")
    expect(expandDirectoryQuery("@packages/tui  ")).toBe("packages/tui/")
  })

  test("normalizes the platform separator the search backend appends", () => {
    expect(expandDirectoryQuery("packages/tui\\")).toBe("packages/tui/")
    expect(expandDirectoryQuery("@packages/tui\\ ")).toBe("packages/tui/")
  })
})
