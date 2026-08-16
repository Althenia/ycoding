/** @jsxImportSource @opentui/solid */
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { TextAttributes } from "@opentui/core"
import { parsePatch } from "diff"

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

export function InlineDiff(props: {
  path?: string
  diff: string
  additions?: number
  deletions?: number
}) {
  const { themeV2 } = useTheme()

  const parsed = createMemo(() => parseInlineDiff(props.diff))
  const path = createMemo(
    () =>
      props.path ??
      [parsed()?.patch.newFileName, parsed()?.patch.oldFileName]
        .find((item) => item && item !== "/dev/null")
        ?.replace(/^[ab]\//, "") ??
      "unknown",
  )
  const hunkLines = createMemo(() => parsed()?.lines ?? [])

  const additions = createMemo(() => props.additions ?? hunkLines().filter((l) => l.kind === "added").length)
  const deletions = createMemo(() => props.deletions ?? hunkLines().filter((l) => l.kind === "removed").length)

  return (
    <box flexDirection="column" paddingLeft={1} paddingTop={2} paddingBottom={3} gap={1} flexShrink={0}>
      <text wrapMode="none" fg={themeV2.text.default}>
        <span style={{ fg: themeV2.text.default }}>{path()}</span>
        <Show when={additions() > 0}>
          <span style={{ fg: themeV2.diff.text.added, attributes: TextAttributes.BOLD }}>
            {"                    "}+{additions()}
          </span>
        </Show>
        <Show when={deletions() > 0}>
          <span style={{ fg: themeV2.diff.text.removed, attributes: TextAttributes.BOLD }}>
            {"   "}−{deletions()}
          </span>
        </Show>
      </text>
      <For each={hunkLines()}>
        {(item) => (
          <text wrapMode="none" fg={
            item.kind === "added"
              ? themeV2.diff.text.added
              : item.kind === "removed"
                ? themeV2.diff.text.removed
                : themeV2.diff.text.context
          }>
            {"  "}
            <span style={{
              fg: themeV2.diff.lineNumber.text,
              bg: item.kind === "added" ? themeV2.diff.lineNumber.background.added : item.kind === "removed" ? themeV2.diff.lineNumber.background.removed : themeV2.diff.background.context,
            }}>
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
