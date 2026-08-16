import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogSearchRow, DialogTitle, dialogMessageLines, dialogPanelWidth, useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { createMemo, For } from "solid-js"
import { Locale } from "../util/locale"
import { useTerminalDimensions } from "@opentui/solid"

export type DialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
  label?: string
}

export type DialogConfirmResult = boolean | undefined

export function DialogConfirm(props: DialogConfirmProps) {
  const dialog = useDialog()
  const { themeV2 } = useTheme().contextual("elevated")
  const dimensions = useTerminalDimensions()
  const [store, setStore] = createStore({
    active: "confirm" as "confirm" | "cancel",
  })
  const lines = createMemo(() => dialogMessageLines(props.message))

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: "Confirm dialog selection",
        group: "Dialog",
        run: () => {
          if (store.active === "confirm") props.onConfirm?.()
          if (store.active === "cancel") props.onCancel?.()
          dialog.clear()
        },
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
    <box paddingTop={1}>
      <DialogHeader title={<DialogTitle>{props.title}</DialogTitle>} />
      <DialogSearchRow />
      <box paddingTop={2} paddingLeft={3} paddingRight={4}>
        <For each={lines()}>
          {(line) => (
            <box height={2}>
              <text fg={themeV2.text.subdued}>{line}</text>
            </box>
          )}
        </For>
      </box>
      <box>
        <For each={["cancel", "confirm"] as const}>
          {(key) => (
            <box
              height={1}
              width={dialogPanelWidth(dimensions().width)}
              onMouseUp={() => {
                if (key === "confirm") props.onConfirm?.()
                if (key === "cancel") props.onCancel?.()
                dialog.clear()
              }}
            >
              <box
                height={1}
                width={dialogPanelWidth(dimensions().width)}
                paddingLeft={6}
                paddingRight={4}
                backgroundColor={key === store.active ? themeV2.background.action.primary.focused : undefined}
              >
                <text fg={key === store.active ? themeV2.text.action.primary.focused : themeV2.text.subdued}>
                  {Locale.titlecase(key === "confirm" ? (props.label ?? key) : key)}
                </text>
              </box>
            </box>
          )}
        </For>
      </box>
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
