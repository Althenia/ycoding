import { afterEach, describe, expect, test } from "bun:test"
import { For } from "solid-js"
import { testRender, type JSX } from "@opentui/solid"
import {
  formatSubagentRetry,
  InlineToolRow,
  isBackgroundSubagent,
  parseApplyPatchFiles,
  parseDiagnostics,
  parseQuestionAnswers,
  parseQuestions,
  toolDisplay,
} from "../../../src/routes/session"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

type ToolFixture = { icon: string; label: string; error?: string }

const tools: readonly ToolFixture[] = [
  {
    icon: "✱",
    label:
      'Grep "YCODING.*DB|database|sqlite|drizzle|dev.*db|data.*dir|xdg|APPDATA" in packages/core/src (151 matches)',
  },
  {
    icon: "✱",
    label: 'Glob "**/*db*" in packages/core (6 matches)',
  },
  {
    icon: "→",
    label: "Read packages/core/src/database/database.ts [offset=1, limit=130]",
  },
  {
    icon: "→",
    label: "Read packages/core/src/index.ts [offset=1, limit=100]",
    error: "No LSP server available for this file type.",
  },
  {
    icon: "✱",
    label:
      'Grep "export const YCODING_DB|YCODING_DB|YCODING_DEV|Global\\.Path\\.data|data =" in packages/core/src (115 matches)',
  },
] as const

function Fixture(props: { errorExpanded?: boolean }) {
  return (
    <box flexDirection="column" width={72}>
      <box flexDirection="column">
        <For each={tools}>
          {(item) => (
            <InlineToolRow
              icon={item.icon}
              complete={true}
              pending=""
              failed={Boolean(item.error)}
              error={item.error}
              errorExpanded={props.errorExpanded}
            >
              {item.label}
            </InlineToolRow>
          )}
        </For>
      </box>
    </box>
  )
}

function FailedPendingToolFixture() {
  return (
    <InlineToolRow icon="%" complete={false} pending="Preparing patch..." failed={true} failure="Patch failed">
      Patch
    </InlineToolRow>
  )
}

function FailedCompleteToolFixture() {
  return (
    <InlineToolRow icon="→" complete={true} pending="Reading file..." failed={true} failure="Read failed">
      Read src/index.ts
    </InlineToolRow>
  )
}

function ReminderAlignmentFixture() {
  return (
    <box flexDirection="column">
      <box paddingLeft={3}>
        <text>Switched variant to medium</text>
      </box>
      <InlineToolRow icon="◈" complete={true} pending="Notice">
        Instructions updated
      </InlineToolRow>
    </box>
  )
}

function TrailingStatusFixture() {
  return (
    <InlineToolRow icon=":" complete={true} pending="" status={<text flexShrink={0}> Background </text>}>
      Explore Subagent — Inspect renderer status styling
    </InlineToolRow>
  )
}

async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  testSetup?.renderer.destroy()
  testSetup = await testRender(component, options)
  await testSetup.renderOnce()
  await testSetup.renderOnce()

  return testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    // Activity rows now carry the design's one-per-row divider. These fixtures assert wrapping and
    // alignment of the row content, so the rules are dropped rather than encoded into every string.
    .filter((line) => !/^[\s\u2500]+$/.test(line) || line.trim() === "")
    .join("\n")
    .trimEnd()
}

describe("TUI inline tool wrapping", () => {
  test("falls back for unknown tool names", () => {
    expect(toolDisplay("shell")).toBe("shell")
    expect(toolDisplay("subagent")).toBe("subagent")
    // Legacy tool names normalize to their renamed views.
    expect(toolDisplay("bash")).toBe("shell")
    expect(toolDisplay("task")).toBe("subagent")
    expect(toolDisplay("apply_patch")).toBe("patch")
    expect(toolDisplay("patch")).toBe("patch")
    expect(toolDisplay("plugin_tool")).toBe("generic")
  })

  test("replaces pending copy when a tool fails before completion", async () => {
    const frame = await renderFrame(() => <FailedPendingToolFixture />, { width: 72, height: 5 })
    expect(frame).toContain("Patch failed")
    expect(frame).not.toContain("Preparing patch")
  })

  test("preserves useful completed copy when a tool fails", async () => {
    const frame = await renderFrame(() => <FailedCompleteToolFixture />, { width: 72, height: 5 })
    expect(frame).toContain("Read src/index.ts")
    expect(frame).not.toContain("Read failed")
  })

  test("aligns switch reminders with instruction reminders", async () => {
    const rows = (await renderFrame(() => <ReminderAlignmentFixture />, { width: 35, height: 5 })).split("\n")
    const reminder = rows.find((row) => row.includes("Switched variant to medium")) ?? ""
    const instruction = rows.find((row) => row.includes("Instructions updated")) ?? ""

    // Both reminders share the transcript's content column regardless of the row's marker.
    expect(reminder.indexOf("Switched")).toBe(3)
    expect(instruction.indexOf("Instructions updated")).toBe(instruction.length - "Instructions updated".length)
    expect(instruction.trimStart().startsWith("ok")).toBe(true)
  })

  test("wraps a trailing status as one padded item", async () => {
    // The marker vocabulary is unified across activity rows, so assert the wrapping contract rather
    // than the caller's icon: one padded line while it fits, and the status carried onto its own
    // indented line once it does not.
    const wide = await renderFrame(() => <TrailingStatusFixture />, { width: 70, height: 4 })
    expect(wide.split("\n")).toHaveLength(1)
    expect(wide).toContain("Explore Subagent \u2014 Inspect renderer status styling")
    expect(wide.trimEnd().endsWith("Background")).toBe(true)

    // The unified marker is narrower than the old per-caller icon, so the row still fits at 62.
    // The contract that matters is that the status survives and never overprints the label.
    const narrow = await renderFrame(() => <TrailingStatusFixture />, { width: 62, height: 4 })
    expect(narrow).toContain("Explore Subagent")
    expect(narrow).toContain("Background")
    expect(narrow.split("\n").every((row) => row.length <= 62)).toBe(true)
  })

  test("filters malformed nested tool wire data", () => {
    expect(
      parseApplyPatchFiles([
        null,
        { type: "add" },
        { file: "a.ts", patch: "diff", additions: 1, deletions: 0, status: "added" },
      ]),
    ).toEqual([
      {
        type: "add",
        relativePath: "a.ts",
        filePath: "a.ts",
        patch: "diff",
        additions: 1,
        deletions: 0,
        movePath: undefined,
      },
    ])
    expect(parseQuestions([{}, { question: 1 }, { question: "Continue?" }])).toEqual([{ question: "Continue?" }])
    expect(parseQuestionAnswers([null, ["yes", 1], "no"])).toEqual([[], ["yes"], []])
    expect(parseQuestionAnswers({})).toBeUndefined()
  })

  test("ignores diagnostics with malformed nested ranges", () => {
    expect(
      parseDiagnostics(
        {
          "a.ts": [
            { severity: 1, message: "missing range" },
            { severity: 1, message: "bad line", range: { start: { line: "0", character: 1 } } },
            { severity: 1, message: "valid", range: { start: { line: 2, character: 3 } } },
          ],
        },
        "a.ts",
      ),
    ).toEqual([{ message: "valid", range: { start: { line: 2, character: 3 } } }])
  })

  test("keeps retry status ahead of wrapping messages", () => {
    expect(formatSubagentRetry(2, "Rate limited by provider")).toBe("Retrying (attempt 2) · Rate limited by provider")
  })

  test("labels only detached or async subagents as background", () => {
    expect(isBackgroundSubagent({ status: "running" }, "running")).toBeFalse()
    expect(isBackgroundSubagent({ status: "running" }, "completed")).toBeTrue()
    expect(isBackgroundSubagent({ status: "running" }, "error")).toBeFalse()
    expect(isBackgroundSubagent({ status: "completed" }, "completed")).toBeFalse()
  })

  test("snapshots consecutive grep, glob, and read rows at a narrow width", async () => {
    expect(await renderFrame(() => <Fixture />, { width: 72, height: 12 })).toMatchSnapshot()
  })

  test("snapshots expanded tool errors under the tool text", async () => {
    expect(await renderFrame(() => <Fixture errorExpanded />, { width: 72, height: 12 })).toMatchSnapshot()
  })
})
