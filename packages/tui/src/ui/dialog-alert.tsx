import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogSearchRow, DialogTitle, dialogMessageLines, dialogPanelWidth, useDialog, type DialogContext } from "./dialog"
import { createMemo, For } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"

export type DialogAlertProps = {
  title: string
  message: string
  onConfirm?: () => void
}

export function DialogAlert(props: DialogAlertProps) {
  const dialog = useDialog()
  const { themeV2 } = useTheme().contextual("elevated")
  const dimensions = useTerminalDimensions()
  const lines = createMemo(() => dialogMessageLines(props.message))

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: "Confirm alert",
        group: "Dialog",
        run: () => {
          props.onConfirm?.()
          dialog.clear()
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
      <box
        height={1}
        width={dialogPanelWidth(dimensions().width)}
        onMouseUp={() => {
          props.onConfirm?.()
          dialog.clear()
        }}
      >
        <box
          height={1}
          width={dialogPanelWidth(dimensions().width)}
          paddingLeft={6}
          paddingRight={4}
          backgroundColor={themeV2.background.action.primary.focused}
        >
          <text fg={themeV2.text.action.primary.focused}>Dismiss</text>
        </box>
      </box>
    </box>
  )
}

DialogAlert.show = (dialog: DialogContext, title: string, message: string) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogAlert title={title} message={message} onConfirm={() => resolve()} />,
      () => resolve(),
    )
  })
}
