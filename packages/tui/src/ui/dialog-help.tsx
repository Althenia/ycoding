import { Keymap } from "../context/keymap"
import { useDialog } from "./dialog"
import { DialogSelect } from "./dialog-select"

export function DialogHelp(props: { shortcuts?: Readonly<Record<string, string>> } = {}) {
  const dialog = useDialog()
  const shortcuts = Keymap.useShortcuts()
  const keymap = Keymap.use()
  const option = (title: string, command: string, category: string, footer?: string) => ({
    title,
    value: command,
    category,
    footer: footer ?? props.shortcuts?.[command] ?? shortcut(shortcuts.get(command)),
  })

  return (
    <DialogSelect
      title="Keyboard shortcuts"
      options={[
        option("Switch session", "session.list", "Session"),
        option("New session", "session.new", "Session"),
        option("Compact", "session.compact", "Session"),
        option("Open picker", "session.child.first", "Subagents"),
        option(
          "Next / previous",
          "session.child.next",
          "Subagents",
          props.shortcuts?.["session.child.next"] && props.shortcuts?.["session.child.previous"]
            ? `${props.shortcuts["session.child.next"]} / ${props.shortcuts["session.child.previous"]}`
            : `${shortcut(shortcuts.get("session.child.next"))} / ${shortcut(shortcuts.get("session.child.previous"))}`,
        ),
        option("Back to parent", "session.parent", "Subagents"),
        option("Switch model", "model.list", "Model"),
        option("Cycle variant", "variant.cycle", "Model"),
      ]}
      onSelect={(item) => {
        dialog.clear()
        keymap.dispatch(item.value)
      }}
    />
  )
}

function shortcut(value: string | undefined) {
  if (!value) return ""
  return value
    .replace(/^ctrl\+x /, "⌃x ")
    .replace(/^ctrl\+/, "⌃")
    .replace("down", "↓")
    .replace("up", "↑")
    .replace("right", "→")
    .replace("left", "←")
}
