/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { parsePatch } from "diff"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"

type InlineDiffLine = { kind: "added" | "removed" | "context"; line: string; lineNum: string }

export function parseInlineDiff(diff: string) {
  try {
    const patch = parsePatch(diff)[0]
    if (!patch?.hunks.length) return
    const lines: InlineDiffLine[] = []
    patch.hunks.forEach((hunk) => {
      let oldLine = hunk.oldStart
      let newLine = hunk.newStart
      hunk.lines.forEach((line) => {
        if (line.startsWith("+")) {
          lines.push({ kind: "added", line: line.slice(1), lineNum: `${newLine++}    ` })
          return
        }
        if (line.startsWith("-")) {
          lines.push({ kind: "removed", line: line.slice(1), lineNum: `${oldLine++}    ` })
          return
        }
        if (!line.startsWith(" ")) return
        lines.push({ kind: "context", line: line.slice(1), lineNum: `${newLine++}    ` })
        oldLine++
      })
    })
    return { patch, lines }
  } catch {
    return undefined
  }
}

export type InlineDiffFile = {
  path?: string
  diff: string
  additions?: number
  deletions?: number
}

export type InlineDiffGroup = {
  path: string
  additions: number
  deletions: number
  files: InlineDiffFile[]
}

/**
 * Path and change counts a file's diff reports, preferring the tool's own structured values and
 * falling back to the patch itself. Shared so the collapsed summary and the expanded diff can never
 * disagree about what a file changed.
 */
export function inlineDiffSummary(file: InlineDiffFile) {
  const parsed = parseInlineDiff(file.diff)
  const lines = parsed?.lines ?? []
  return {
    path:
      file.path ??
      [parsed?.patch.newFileName, parsed?.patch.oldFileName]
        .find((item) => item && item !== "/dev/null")
        ?.replace(/^[ab]\//, "") ??
      "unknown",
    additions: file.additions ?? lines.filter((line) => line.kind === "added").length,
    deletions: file.deletions ?? lines.filter((line) => line.kind === "removed").length,
    lines,
  }
}

export function inlineDiffGroups(files: InlineDiffFile[]): InlineDiffGroup[] {
  const groups = new Map<string, InlineDiffGroup>()
  return files.flatMap((file) => {
    const summary = inlineDiffSummary(file)
    const group = groups.get(summary.path)
    if (group) {
      group.additions += summary.additions
      group.deletions += summary.deletions
      group.files.push(file)
      return []
    }
    const next = { path: summary.path, additions: summary.additions, deletions: summary.deletions, files: [file] }
    groups.set(next.path, next)
    return [next]
  })
}

export function InlineDiff(props: InlineDiffGroup & { wrapMode?: "word" | "none"; heading?: boolean }) {
  const { themeV2 } = useTheme()

  const hunkLines = createMemo(() => props.files.flatMap((file) => inlineDiffSummary(file).lines))

  return (
    <box flexDirection="column" paddingLeft={1} paddingTop={2} paddingBottom={3} gap={1} flexShrink={0}>
      <Show when={props.heading !== false}>
        <box width="100%" flexDirection="row">
          <text width={55} flexShrink={1} wrapMode="none" truncate={true} fg={themeV2.text.default}>
            {props.path}
          </text>
          <Show when={props.additions > 0}>
            <text flexShrink={0} fg={themeV2.diff.text.added} attributes={TextAttributes.BOLD}>
              +{props.additions}
            </text>
          </Show>
          <box width={3} flexShrink={0} />
          <Show when={props.deletions > 0}>
            <text flexShrink={0} fg={themeV2.diff.text.removed} attributes={TextAttributes.BOLD}>
              −{props.deletions}
            </text>
          </Show>
        </box>
      </Show>
      <For each={hunkLines()}>
        {(item) => (
          <text
            wrapMode={props.wrapMode ?? "none"}
            fg={
              item.kind === "added"
                ? themeV2.diff.text.added
                : item.kind === "removed"
                  ? themeV2.diff.text.removed
                  : themeV2.diff.text.context
            }
          >
            {"  "}
            <span
              style={{
                fg: themeV2.diff.lineNumber.text,
                bg:
                  item.kind === "added"
                    ? themeV2.diff.lineNumber.background.added
                    : item.kind === "removed"
                      ? themeV2.diff.lineNumber.background.removed
                      : themeV2.diff.background.context,
              }}
            >
              {item.lineNum.slice(0, 6)}
            </span>
            {"  "}
            {item.kind === "context" ? item.line : `${item.kind === "added" ? "+" : "-"} ${item.line.trimStart()}`}
          </text>
        )}
      </For>
    </box>
  )
}
