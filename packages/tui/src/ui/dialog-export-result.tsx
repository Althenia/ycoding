import { useDialog, type DialogContext } from "./dialog"
import { DialogSelect } from "./dialog-select"
import { useClipboard } from "../context/clipboard"
import open from "open"

export function DialogExportResult(props: { path: string; size?: string; onClose?: () => void }) {
  const dialog = useDialog()
  const clipboard = useClipboard()

  const close = () => {
    props.onClose?.()
    dialog.clear()
  }

  return (
    <DialogSelect
      title="Export complete"
      options={[
        { title: props.path, footer: props.size, state: "connected", category: "Written to", value: "path" },
        { title: "Open in editor", category: "Written to", value: "open", onSelect: () => void open(props.path) },
        { title: "Copy path", category: "Written to", value: "copy", onSelect: () => void clipboard.write?.(props.path) },
        { title: "Dismiss", category: "Written to", value: "dismiss", onSelect: close },
      ]}
    />
  )
}

DialogExportResult.show = (dialog: DialogContext, path: string) =>
  new Promise<void>((resolve) => {
    dialog.replace(() => <DialogExportResult path={path} onClose={resolve} />, resolve)
  })
