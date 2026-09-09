import { createSignal } from "solid-js"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { createSessionMessageID } from "../util/session-autonomy"
import { errorMessage } from "../util/error"

export function DialogBtwExport(props: {
  parentTitle: string
  sourceTitle: string
  value: string
  send: (input: { id: string; text: string }) => Promise<void>
}) {
  const dialog = useDialog()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)
  let retained: { id: string; text: string } | undefined

  return (
    <DialogPrompt
      title={`Send to ${props.parentTitle}`}
      value={props.value}
      placeholder="Context to send to the parent"
      busy={busy()}
      busyText={`Sending to ${props.parentTitle}...`}
      description={() => (
        <box flexDirection="column">
          <text>Destination: {props.parentTitle}</text>
          <text>Source: {props.sourceTitle}</text>
          <text>Only the reviewed text below is sent as a steer. The parent is not interrupted.</text>
        </box>
      )}
      onConfirm={(value) => {
        if (!value.trim()) {
          toast.show({ message: "Export text is required", variant: "error" })
          return
        }
        if (retained && retained.text !== value) {
          toast.show({
            message: "Retry the previous exact export or cancel before sending changed text",
            variant: "error",
            duration: 5000,
          })
          return
        }
        retained ??= { id: createSessionMessageID(), text: value }
        setBusy(true)
        void props.send(retained).then(
          () => {
            retained = undefined
            toast.show({ message: `Sent to ${props.parentTitle}`, variant: "success", duration: 3000 })
            dialog.clear()
          },
          (error) => {
            setBusy(false)
            toast.show({
              title: `Failed to send to ${props.parentTitle}`,
              message: errorMessage(error),
              variant: "error",
              duration: 5000,
            })
          },
        )
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
