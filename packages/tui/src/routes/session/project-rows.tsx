import { InputRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, Index, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { useTheme } from "../../context/theme"
import { readableTint } from "../../theme/component"
import { Keymap } from "../../context/keymap"
import { Locale } from "../../util/locale"
import { stringWidth } from "../../util/string-width"

export type Tone = "success" | "warning" | "error" | "subdued"

export type Row = {
  key: string
  kind: "heading" | "info" | "item"
  label: string
  value?: string
  detail?: string
  badge?: string
  disabled?: boolean
  tone?: Tone
  indent?: number
  marker?: "✎" | "›"
  shortcut?: { key: string; available: boolean }
  activate?: () => void
  step?: (direction: 1 | -1) => void
  truncate?: "start"
  edit?: { initial: string; commit: (text: string) => void; onInput?: (text: string) => void }
}

export function quietInk(theme: ReturnType<typeof useTheme>["theme"]) {
  return readableTint(theme.text.subdued, theme.background.default)
}

export function infoInk(theme: ReturnType<typeof useTheme>["theme"]) {
  return readableTint(theme.text.feedback.info.default, theme.background.default)
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
      borderColor={props.active ? infoInk(theme) : theme.border.default}
      title={`${props.active ? "▸ " : ""}${props.title}`}
      titleColor={props.active ? infoInk(theme) : quietInk(theme)}
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
  mode?: string
}) {
  const { theme } = useTheme()
  const [cursorKey, setCursorKey] = createSignal<string>()
  const [lastIndex, setLastIndex] = createSignal(0)
  const [editing, setEditing] = createSignal<{ key: string; draft: string; initial: string }>()
  const [editor, setEditor] = createSignal<InputRenderable>()
  const keymap = Keymap.use()
  onCleanup(
    keymap.intercept("key", (context) => {
      if (!input.active() || !editing() || !editor()?.focused) return
      if (keymap.mode.current() !== (input.mode ?? "base")) return
      if (context.event.name === "escape" || context.event.name === "return") return
      if (editor()!.handleKeyPress(context.event)) context.consume()
    }),
  )
  let scroll: ScrollBoxRenderable | undefined
  const [measuredWidth, setMeasuredWidth] = createSignal(0)
  const contentWidth = () => Math.min(input.contentWidth(), measuredWidth() || input.contentWidth())

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
    const line = rows
      .slice(0, index)
      .reduce((sum, row) => sum + (row.kind === "heading" || row.detail !== undefined ? 2 : 1), 0)
    const bottom = line + (current.detail === undefined ? 1 : 2)
    const top = scroll.scrollTop
    const height = Math.max(1, scroll.viewport.height)
    if (line < top) scroll.scrollTo(line)
    else if (bottom > top + height) scroll.scrollTo(bottom - height)
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
    focusKey(row.key)
    setEditing({ key: row.key, draft: row.edit.initial, initial: row.edit.initial })
  }
  function activate(row: Row | undefined) {
    if (!row || row.disabled || (input.busy?.() && row.key !== "cancel")) return
    if (row.edit) return startEdit(row)
    row.activate?.()
  }
  function commit() {
    const current = editing()
    const row = input.rows().find((item) => item.key === current?.key)
    setEditing(undefined)
    if (current && row?.edit) row.edit.commit(current.draft)
  }
  const cancel = () => {
    const current = editing()
    const row = input.rows().find((item) => item.key === current?.key)
    setEditing(undefined)
    if (current && current.draft !== current.initial) row?.edit?.onInput?.(current.initial)
  }
  Keymap.createLayer(() => ({
    mode: input.mode,
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
      ? readableTint(theme.text.feedback.success.default, theme.background.default)
      : tone === "warning"
        ? readableTint(theme.text.feedback.warning.default, theme.background.default)
        : tone === "error"
          ? readableTint(theme.text.feedback.error.default, theme.background.default)
          : tone === "subdued"
            ? quietInk(theme)
            : theme.text.default

  function RowLine(line: { row: Row }) {
    const row = () => line.row
    const selected = () => cursor()?.key === row().key
    const unavailable = () => row().disabled || row().shortcut?.available === false
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
          ? quietInk(theme)
          : theme.text.default
    const column = () => Math.min(input.labelWidth(), Math.max(8, contentWidth() - 12))
    const labelText = () => {
      const text = Locale.truncateWidth(
        rowText(row()),
        row().value === undefined ? contentWidth() - 2 - (row().badge ? stringWidth(row().badge!) + 2 : 0) : column(),
      )
      return row().value === undefined ? text : text + " ".repeat(Math.max(0, column() - stringWidth(text)))
    }
    const valueText = () => {
      const width = Math.max(1, contentWidth() - 2 - column() - 2)
      const marker = row().marker ? row().marker + " " : ""
      if (row().truncate === "start")
        return marker + Locale.truncateLeft(row().value ?? "", Math.max(1, width - marker.length))
      return Locale.truncateWidth(`${marker}${row().value ?? ""}`, width)
    }
    return (
      <Show
        when={row().kind !== "heading"}
        fallback={
          <box marginTop={1} height={1} flexShrink={0}>
            <text fg={quietInk(theme)} attributes={TextAttributes.BOLD}>
              {row().label}
            </text>
          </box>
        }
      >
        <box
          flexDirection="column"
          height={row().detail === undefined ? 1 : 2}
          flexShrink={0}
          backgroundColor={fill()}
          onMouseUp={() => {
            if (row().kind !== "item") return
            setCursorKey(row().key)
            setLastIndex(selectable().findIndex((item) => item.key === row().key))
            activate(row())
          }}
        >
          <box flexDirection="row" height={1} flexShrink={0}>
            <text selectable={row().kind !== "item"} flexShrink={0} fg={selected() ? foreground() : quietInk(theme)}>
              {selected() ? "▸ " : "  "}
            </text>
            <text
              selectable={row().kind !== "item"}
              flexShrink={0}
              fg={
                selected()
                  ? foreground()
                  : row().kind === "info" || unavailable()
                    ? quietInk(theme)
                    : theme.text.default
              }
              attributes={selected() ? TextAttributes.BOLD : undefined}
            >
              {labelText()}
            </text>
            <Show when={row().badge}>
              <box flexGrow={1} />
              <text selectable={false} fg={selected() && input.active() ? foreground() : quietInk(theme)}>
                {row().badge}
              </text>
            </Show>
            <Show
              when={editing()?.key === row().key}
              fallback={
                <Show when={row().value !== undefined}>
                  <text
                    selectable={row().kind !== "item"}
                    fg={selected() && input.active() ? foreground() : toneColor(row().tone)}
                  >
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
                onInput={(text: string) => {
                  setEditing((current) => (current ? { ...current, draft: text } : current))
                  row().edit?.onInput?.(text)
                }}
                onSubmit={commit}
                onKeyDown={(event: { name: string; preventDefault(): void }) => {
                  if (event.name !== "escape") return
                  event.preventDefault()
                  cancel()
                }}
                flexGrow={1}
                focusedBackgroundColor="transparent"
                textColor={foreground()}
                focusedTextColor={foreground()}
                cursorColor={foreground()}
              />
            </Show>
          </box>
          <Show when={row().detail !== undefined}>
            <text selectable={false} fg={selected() && input.active() ? foreground() : quietInk(theme)} wrapMode="none">
              {"  "}
              {Locale.truncateLeft(row().detail ?? "", Math.max(1, contentWidth() - 2))}
            </text>
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
          requestAnimationFrame(() => {
            if (!value.isDestroyed) setMeasuredWidth(value.viewport.width)
          })
        }}
        onSizeChange={() => setMeasuredWidth(scroll?.viewport.width ?? 0)}
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
