import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogTitle, dialogMessageLines, dialogPanelWidth, useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { createMemo, For, onCleanup } from "solid-js"
import { Locale } from "../util/locale"
import { useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { stringWidth } from "../util/string-width"

export type DialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
  label?: string
}

type DialogConfirmResult = boolean | undefined

export function DialogConfirm(props: DialogConfirmProps) {
  const dialog = useDialog()
  const { theme } = useTheme().contextual("elevated")
  const dimensions = useTerminalDimensions()
  const [store, setStore] = createStore({
    active: "confirm" as "confirm" | "cancel",
  })
  const lines = createMemo(() => dialogMessageLines(props.message))
  const title = () => Locale.truncateWidth(props.title, Math.max(1, dialogPanelWidth(dimensions().width) - 14))
  const detailWidth = () => Math.max(1, dialogPanelWidth(dimensions().width) - 7)
  const titleLines = createMemo(() => title() === props.title ? [] : dialogMessageLines(props.title, detailWidth()))
  const detailHeight = () => Math.min(
    Math.max(1, lines().length * 2 + titleLines().reduce((count, line) => count + Math.max(1, Math.ceil(stringWidth(line) / detailWidth())), 0)),
    Math.max(1, dimensions().height - Math.ceil(dimensions().height / 4) - 8),
  )
  const entry = dialog.stack.at(-1)
  let settled = false
  let details: ScrollBoxRenderable | undefined
  onCleanup(() => { settled = true })

  const settle = (choice: "confirm" | "cancel") => {
    if (settled) return
    settled = true
    try {
      if (choice === "confirm") props.onConfirm?.()
      if (choice === "cancel") props.onCancel?.()
    } finally {
      if (dialog.stack.at(-1) === entry) dialog.clear()
    }
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: "Confirm dialog selection",
        group: "Dialog",
        run: () => settle(store.active),
      },
      {
        bind: "up",
        title: "Select cancel",
        group: "Dialog",
        run: () => setStore("active", "cancel"),
      },
      {
        bind: "down",
        title: "Select confirm",
        group: "Dialog",
        run: () => setStore("active", "confirm"),
      },
      {
        bind: "pageup",
        title: "Previous confirmation details",
        group: "Dialog",
        run: () => details?.scrollBy(-Math.max(1, details.viewport.height)),
      },
      {
        bind: "pagedown",
        title: "Next confirmation details",
        group: "Dialog",
        run: () => details?.scrollBy(Math.max(1, details.viewport.height)),
      },
      {
        bind: "left",
        title: "Previous dialog option",
        group: "Dialog",
        run: () => {
          setStore("active", store.active === "confirm" ? "cancel" : "confirm")
        },
      },
      {
        bind: "right",
        title: "Next dialog option",
        group: "Dialog",
        run: () => {
          setStore("active", store.active === "confirm" ? "cancel" : "confirm")
        },
      },
    ],
  }))
  return (
    <box paddingTop={1} paddingBottom={1}>
      <DialogHeader title={<DialogTitle>{title()}</DialogTitle>} />
      <scrollbox
        ref={(value: ScrollBoxRenderable) => { details = value }}
        marginTop={1}
        paddingLeft={3}
        paddingRight={4}
        height={detailHeight()}
        scrollbarOptions={{ visible: false }}
      >
        <For each={titleLines()}>{(line) => <text fg={theme.text.default} wrapMode="word">{line}</text>}</For>
        <For each={lines()}>
          {(line) => (
            <box height={2}>
              <text fg={theme.text.subdued}>{line}</text>
            </box>
          )}
        </For>
      </scrollbox>
      <box>
        <For each={["cancel", "confirm"] as const}>
          {(key) => (
            <box
              height={1}
              width={dialogPanelWidth(dimensions().width)}
              onMouseDown={() => setStore("active", key)}
              onMouseUp={() => settle(key)}
            >
              <box
                height={1}
                width={dialogPanelWidth(dimensions().width)}
                paddingLeft={6}
                paddingRight={4}
                backgroundColor={key === store.active ? theme.background.action.primary.focused : undefined}
              >
                <text fg={key === store.active ? theme.text.action.primary.focused : theme.text.subdued}>
                  {Locale.titlecase(key === "confirm" ? (props.label ?? key) : key)}
                </text>
              </box>
            </box>
          )}
        </For>
      </box>
      <box paddingLeft={6} paddingTop={1}><text fg={theme.text.subdued}>↑↓/←→ choose · enter confirm · esc cancel</text></box>
    </box>
  )
}

DialogConfirm.show = (dialog: DialogContext, title: string, message: string, label?: string) => {
  return new Promise<DialogConfirmResult>((resolve) => {
    dialog.replace(
      () => (
        <DialogConfirm
          title={title}
          message={message}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
          label={label}
        />
      ),
      () => resolve(undefined),
    )
  })
}
