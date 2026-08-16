import { InputRenderable } from "@opentui/core"
import { onMount } from "solid-js"
import { DialogHeader, DialogSearchRow, DialogTitle, type DialogContext, useDialog } from "../ui/dialog"
import { useClient } from "../context/client"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"

export function DialogSessionRename(props: { sessionID: string; currentTitle?: string }) {
  const dialog = useDialog()
  const client = useClient()
  const toast = useToast()
  const { themeV2 } = useTheme().contextual("elevated")
  let input: InputRenderable

  const confirm = () => {
    const title = input.value.trim()
    if (!title) return
    void client.api.session
      .rename({ sessionID: props.sessionID, title })
      .then(() => dialog.clear())
      .catch((error) =>
        toast.show({
          message: `Failed to rename session: ${errorMessage(error)}`,
          variant: "error",
          duration: 5000,
        }),
      )
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [{ id: "dialog.session.rename", bind: "return", title: "Save session name", group: "Dialog", run: confirm }],
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => input?.focus(), 1)
  })

  return (
    <box paddingTop={1} paddingBottom={1}>
      <DialogHeader title={<DialogTitle>Rename session</DialogTitle>} />
      <DialogSearchRow />
      <box paddingTop={1} paddingLeft={6} paddingRight={4}>
        <input
          ref={(value: InputRenderable) => {
            input = value
            input.value = props.currentTitle ?? ""
          }}
          placeholder="Session title"
          placeholderColor={themeV2.text.subdued}
          textColor={themeV2.text.formfield.default}
          focusedTextColor={themeV2.text.formfield.default}
          cursorColor={themeV2.text.formfield.default}
          onSubmit={confirm}
        />
      </box>
      <box paddingTop={2} paddingLeft={6} paddingRight={4}>
        <text fg={themeV2.text.default}>Enter <span style={{ fg: themeV2.text.subdued }}>save · Esc cancel</span></text>
      </box>
    </box>
  )
}

DialogSessionRename.show = (dialog: DialogContext, sessionID: string, currentTitle?: string) =>
  dialog.replace(() => <DialogSessionRename sessionID={sessionID} currentTitle={currentTitle} />)
