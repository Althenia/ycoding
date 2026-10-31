/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { parsePatch } from "diff"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { filetype } from "../../util/filetype"

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
  status?: string
}

type InlineDiffFileStatus = "created" | "deleted" | "modified"

export type InlineDiffGroup = {
  path: string
  additions: number
  deletions: number
  files: InlineDiffFile[]
  status?: InlineDiffFileStatus
}

function inlineDiffFileStatus(file: InlineDiffFile): InlineDiffFileStatus {
  const raw = typeof file.status === "string" ? file.status.toLowerCase() : undefined
  if (raw === "created" || raw === "added" || raw === "create") return "created"
  if (raw === "deleted" || raw === "removed" || raw === "delete") return "deleted"
  if (raw === "modified" || raw === "updated" || raw === "changed") return "modified"
  const parsed = parseInlineDiff(file.diff)
  const patch = parsed?.patch
  if (patch) {
    if (patch.oldFileName === "/dev/null" && patch.newFileName !== "/dev/null") return "created"
    if (patch.newFileName === "/dev/null" && patch.oldFileName !== "/dev/null") return "deleted"
  }
  return "modified"
}

/**
 * Path and change counts a file's diff reports, preferring the tool's own structured values and
 * falling back to the patch itself. Shared so the collapsed summary and the expanded diff can never
 * disagree about what a file changed.
 */
function inlineDiffSummary(file: InlineDiffFile) {
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
    status: inlineDiffFileStatus(file),
    lines,
  }
}

export function InlineDiff(props: InlineDiffGroup & { wrapMode?: "word" | "none"; heading?: boolean; view?: "split" | "unified" }) {
  const { theme, syntax } = useTheme()
  const patches = createMemo(() => props.files.filter((file) => parseInlineDiff(file.diff)?.patch))
  const hunkLines = createMemo(() => props.files.flatMap((file) => inlineDiffSummary(file).lines))

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} gap={1} flexShrink={0}>
      <box
        flexDirection="column"
        border={props.heading === false ? [] : ["left", "right", "top", "bottom"]}
        borderColor={theme.border.default}
        paddingLeft={props.heading === false ? 1 : 0}
        paddingRight={props.heading === false ? 1 : 0}
      >
        <Show when={props.heading !== false}>
          <box
            width="100%"
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={theme.background.surface.offset}
          >
            <Show
              when={props.status === "created" || props.status === "deleted"}
              fallback={
                <text flexShrink={1} wrapMode="none" truncate={true} fg={theme.text.default}>
                  {props.path}
                </text>
              }
            >
              <text
                flexShrink={1}
                wrapMode="none"
                truncate={true}
                fg={props.status === "created" ? theme.diff.text.added : theme.diff.text.removed}
              >
                {props.status === "created" ? `+ ${props.path}` : `− ${props.path}`}
              </text>
            </Show>
            <box flexGrow={1} flexShrink={0} />
            <Show when={props.additions > 0}>
              <text flexShrink={0} fg={theme.diff.text.added} attributes={TextAttributes.BOLD}>
                +{props.additions}
              </text>
            </Show>
            <Show when={props.additions > 0 && props.deletions > 0}>
              <box width={1} flexShrink={0} />
            </Show>
            <Show when={props.deletions > 0}>
              <text flexShrink={0} fg={theme.diff.text.removed} attributes={TextAttributes.BOLD}>
                −{props.deletions}
              </text>
            </Show>
          </box>
          <box height={1} flexShrink={0} border={["top"]} borderColor={theme.border.default} />
        </Show>
        <box flexDirection="column" paddingTop={1} paddingBottom={1} flexShrink={0} paddingLeft={props.view === "split" ? 5 : 0}>
          <Show
            when={props.view === "split"}
            fallback={
              <For each={hunkLines()}>
                {(item) => {
                  const rowBg =
                    item.kind === "added"
                      ? theme.diff.background.added
                      : item.kind === "removed"
                        ? theme.diff.background.removed
                        : undefined
                  const gutterBg =
                    item.kind === "added"
                      ? theme.diff.lineNumber.background.added
                      : item.kind === "removed"
                        ? theme.diff.lineNumber.background.removed
                        : theme.diff.background.context
                  return (
                    <box flexShrink={0} backgroundColor={rowBg}>
                      <text
                        wrapMode={props.wrapMode ?? "none"}
                        truncate={props.wrapMode !== "word"}
                        fg={
                          item.kind === "added"
                            ? theme.diff.text.added
                            : item.kind === "removed"
                              ? theme.diff.text.removed
                              : theme.diff.text.context
                        }
                      >
                        {" "}
                        <span
                          style={{
                            fg: theme.diff.lineNumber.text,
                            bg: gutterBg,
                          }}
                        >
                          {item.lineNum.slice(0, 6)}
                        </span>
                        {"  "}
                        {item.kind === "context" ? item.line : `${item.kind === "added" ? "+" : "-"} ${item.line.trimStart()}`}
                      </text>
                    </box>
                  )
                }}
              </For>
            }
          >
            <For each={patches()}>
              {(file) => (
                <diff
                  diff={file.diff}
                  view="split"
                  filetype={filetype(props.path)}
                  syntaxStyle={syntax()}
                  showLineNumbers={true}
                  width="100%"
                  wrapMode={props.wrapMode ?? "none"}
                  fg={theme.text.default}
                  addedBg={theme.diff.background.added}
                  removedBg={theme.diff.background.removed}
                  contextBg={theme.diff.background.context}
                  addedSignColor={theme.diff.highlight.added}
                  removedSignColor={theme.diff.highlight.removed}
                  lineNumberFg={theme.diff.lineNumber.text}
                  lineNumberBg={theme.diff.background.context}
                  addedLineNumberBg={theme.diff.lineNumber.background.added}
                  removedLineNumberBg={theme.diff.lineNumber.background.removed}
                />
              )}
            </For>
          </Show>
        </box>
      </box>
    </box>
  )
}
