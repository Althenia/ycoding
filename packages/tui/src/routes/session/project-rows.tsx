import { InputRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, Index, Show, type Accessor, type JSX } from "solid-js"
import { useTheme } from "../../context/theme"
import { Keymap } from "../../context/keymap"
import { Locale } from "../../util/locale"
import { stringWidth } from "../../util/string-width"

export type Tone = "success" | "warning" | "error" | "subdued"

export type Row = {
  key: string
  kind: "heading" | "info" | "item"
  label: string
  value?: string
  tone?: Tone
  indent?: number
  marker?: "✎" | "›"
  shortcut?: { key: string; available: boolean }
  activate?: () => void
  step?: (direction: 1 | -1) => void
  edit?: { initial: string; commit: (text: string) => void }
}

export function Panel(props: {
  title: string
  active?: boolean
  width?: number | `${number}%`
  height?: number
  flexGrow?: number
  children?: JSX.Element
}) {
  const { theme } = useTheme()
  return (
    <box
      border
      borderStyle="single"
      borderColor={props.active ? theme.text.feedback.info.default : theme.border.default}
      title={`${props.active ? "▸ " : ""}${props.title}`}
      width={props.width}
      height={props.height}
      flexGrow={props.flexGrow}
      flexBasis={props.flexGrow ? 0 : undefined}
      minWidth={0}
      minHeight={0}
      flexShrink={props.flexGrow ? 1 : 0}
      paddingLeft={1}
      paddingRight={1}
    >
      {props.children}
    </box>
  )
}

export function rowText(row: Row) {
  const prefix = row.shortcut ? (row.shortcut.available ? `[${row.shortcut.key}] ` : `(${row.shortcut.key}) `) : ""
  return `${" ".repeat(row.indent ?? 0)}${prefix}${row.label}`
}

export function createRowList(input: {
  rows: Accessor<Row[]>
  active: Accessor<boolean>
  labelWidth: Accessor<number>
  contentWidth: Accessor<number>
  busy?: Accessor<boolean>
}) {
  const { theme } = useTheme()
  const [cursorKey, setCursorKey] = createSignal<string>()
  const [lastIndex, setLastIndex] = createSignal(0)
  const [editing, setEditing] = createSignal<{ key: string; draft: string }>()
  const [editor, setEditor] = createSignal<InputRenderable>()
  let scroll: ScrollBoxRenderable | undefined

  const selectable = createMemo(() => input.rows().filter((row) => row.kind === "item"))
  const cursor = createMemo(
    () =>
      selectable().find((row) => row.key === cursorKey()) ??
      selectable()[Math.min(lastIndex(), selectable().length - 1)],
  )

  function reveal() {
    const current = cursor()
    if (!scroll || scroll.isDestroyed || !current) return
    const rows = input.rows()
    const index = rows.findIndex((row) => row.key === current.key)
    const line = index + rows.slice(0, index).filter((row) => row.kind === "heading").length + 1
    const top = scroll.scrollTop
    const height = Math.max(1, scroll.viewport.height)
    if (line < top) scroll.scrollTo(line)
    else if (line >= top + height) scroll.scrollTo(line - height + 1)
  }

  function moveTo(index: number) {
    const target = selectable()[Math.max(0, Math.min(index, selectable().length - 1))]
    if (!target) return
    setCursorKey(target.key)
    setLastIndex(selectable().indexOf(target))
    requestAnimationFrame(reveal)
  }
  const move = (delta: number) => moveTo(selectable().indexOf(cursor()!) + delta)
  const focusKey = (key: string) => {
    const index = selectable().findIndex((row) => row.key === key)
    if (index >= 0) moveTo(index)
  }

  function startEdit(row: Row) {
    if (!row.edit || input.busy?.()) return
    setEditing({ key: row.key, draft: row.edit.initial })
  }
  function activate(row: Row | undefined) {
    if (!row) return
    if (row.edit) return startEdit(row)
    row.activate?.()
  }
  function commit() {
    const current = editing()
    const row = input.rows().find((item) => item.key === current?.key)
    setEditing(undefined)
    if (current && row?.edit) row.edit.commit(current.draft)
  }
  const cancel = () => setEditing(undefined)
  Keymap.createLayer(() => ({
    priority: 20,
    target: editor,
    enabled: editing() !== undefined,
    commands: [
      { bind: "escape", title: "Cancel edit", run: cancel },
      { bind: "return", title: "Save edit", run: commit },
    ],
  }))

  const toneColor = (tone: Tone | undefined) =>
    tone === "success"
      ? theme.text.feedback.success.default
      : tone === "warning"
        ? theme.text.feedback.warning.default
        : tone === "error"
          ? theme.text.feedback.error.default
          : tone === "subdued"
            ? theme.text.subdued
            : theme.text.default

  function RowLine(line: { row: Row }) {
    const row = () => line.row
    const selected = () => cursor()?.key === row().key
    const unavailable = () => row().shortcut?.available === false
    const fill = () =>
      selected()
        ? input.active()
          ? theme.background.action.primary.focused
          : theme.background.surface.overlay
        : undefined
    const foreground = () =>
      selected() && input.active()
        ? theme.text.action.primary.focused
        : unavailable()
          ? theme.text.subdued
          : theme.text.default
    const column = () => Math.min(input.labelWidth(), Math.max(8, input.contentWidth() - 12))
    const labelText = () => {
      const text = Locale.truncateWidth(rowText(row()), row().value === undefined ? input.contentWidth() - 2 : column())
      return row().value === undefined ? text : text + " ".repeat(Math.max(0, column() - stringWidth(text)))
    }
    const valueText = () =>
      Locale.truncateWidth(
        `${row().marker ? row().marker + " " : ""}${row().value ?? ""}`,
        Math.max(1, input.contentWidth() - 2 - column() - 1),
      )
    return (
      <Show
        when={row().kind !== "heading"}
        fallback={
          <box marginTop={1} height={1} flexShrink={0}>
            <text fg={theme.text.subdued} attributes={TextAttributes.BOLD}>
              {row().label}
            </text>
          </box>
        }
      >
        <box
          flexDirection="row"
          height={1}
          flexShrink={0}
          backgroundColor={fill()}
          onMouseUp={() => {
            if (row().kind !== "item") return
            setCursorKey(row().key)
            setLastIndex(selectable().findIndex((item) => item.key === row().key))
            activate(row())
          }}
        >
          <text flexShrink={0} fg={selected() ? foreground() : theme.text.subdued}>
            {selected() ? "▸ " : "  "}
          </text>
          <text
            flexShrink={0}
            fg={
              selected()
                ? foreground()
                : row().kind === "info" || unavailable()
                  ? theme.text.subdued
                  : theme.text.default
            }
            attributes={selected() ? TextAttributes.BOLD : undefined}
          >
            {labelText()}
          </text>
          <Show
            when={editing()?.key === row().key}
            fallback={
              <Show when={row().value !== undefined}>
                <text fg={selected() && input.active() ? foreground() : toneColor(row().tone)}>
                  {" " + valueText()}
                </text>
              </Show>
            }
          >
            <input
              ref={(value: InputRenderable) => {
                setEditor(value)
                setTimeout(() => {
                  if (value.isDestroyed) return
                  value.focus()
                  value.gotoLineEnd()
                }, 1)
              }}
              value={editing()?.draft ?? ""}
              onInput={(text: string) => setEditing((current) => (current ? { ...current, draft: text } : current))}
              onSubmit={commit}
              onKeyDown={(event: { name: string; preventDefault(): void }) => {
                if (event.name !== "escape") return
                event.preventDefault()
                cancel()
              }}
              flexGrow={1}
              focusedBackgroundColor="transparent"
              focusedTextColor={theme.text.default}
              cursorColor={theme.text.feedback.info.default}
            />
          </Show>
        </box>
      </Show>
    )
  }

  function Rows() {
    return (
      <scrollbox
        ref={(value: ScrollBoxRenderable) => {
          scroll = value
        }}
        flexGrow={1}
        minHeight={0}
        horizontalScrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{
          trackOptions: { backgroundColor: theme.background.default, foregroundColor: theme.scrollbar.default },
        }}
      >
        <Index each={input.rows()}>{(row) => <RowLine row={row()} />}</Index>
      </scrollbox>
    )
  }

  return { selectable, cursor, editing, moveTo, move, focusKey, activate, startEdit, commit, cancel, Rows }
}
