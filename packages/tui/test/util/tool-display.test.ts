import { describe, expect, test } from "bun:test"
import {
  canonicalToolName,
  finiteNumber,
  primitiveInputSummary,
  toolDisplayMetadata,
  webSearchProviderLabel,
} from "../../src/util/tool-display"

test("normalizes shared tool primitives", () => {
  expect(["bash", "task", "apply_patch", "plugin_tool"].map(canonicalToolName)).toEqual([
    "shell",
    "subagent",
    "patch",
    "plugin_tool",
  ])
  expect([finiteNumber(-1.5), finiteNumber(Number.NaN), finiteNumber("1")]).toEqual([-1.5, undefined, undefined])
  expect(primitiveInputSummary({ command: "pwd", count: 2, nested: {} })).toBe("[command=pwd, count=2]")
  expect(primitiveInputSummary({ path: "src/a.ts", line: 2 }, ["path"])).toBe("[line=2]")
})

describe("webSearchProviderLabel", () => {
  test("labels known providers", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
  })

  test("uses the generic label for unsupported provider values", () => {
    for (const provider of [undefined, null, {}, [], 1, "other"])
      expect(webSearchProviderLabel(provider)).toBe("Web Search")
  })
})

describe("toolDisplayMetadata", () => {
  test("returns structured metadata for non-pending states", () => {
    const structured = { provider: "parallel", numResults: 3 }

    expect(toolDisplayMetadata({ status: "running", structured })).toBe(structured)
    expect(toolDisplayMetadata({ status: "completed", structured })).toBe(structured)
    expect(toolDisplayMetadata({ status: "error", structured })).toBe(structured)
  })

  test("does not expose pending or malformed metadata", () => {
    expect(toolDisplayMetadata({ status: "streaming", structured: { provider: "exa" } })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed" })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", structured: null })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", structured: [] })).toEqual({})
    expect(toolDisplayMetadata(undefined)).toEqual({})
  })
})
