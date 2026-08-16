import { useRenderer } from "@opentui/solid"
import { createMemo, onCleanup } from "solid-js"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useDialog, type DialogContext } from "../ui/dialog"
import { COMMAND_PALETTE_COMMAND, Keymap, type KeymapCommand } from "../context/keymap"

function isSuggestedPaletteCommand(command: KeymapCommand) {
  const suggested = command.suggested
  if (typeof suggested === "boolean") return suggested
  if (typeof suggested === "function") return suggested() === true
  return false
}

export function CommandPaletteDialog() {
  const dialog = useDialog()
  const renderer = useRenderer()
  const keymap = Keymap.use()
  const commands = Keymap.useCommands()
  const shortcuts = Keymap.useShortcuts()

  // Close before the app-level selection handler consumes Escape to clear selected text.
  const offEscape = keymap.intercept(
    "key",
    ({ event }) => {
      if (event.name !== "escape" || !renderer.getSelection()?.getSelectedText()) return
      renderer.clearSelection()
      dialog.clear()
      event.preventDefault()
      event.stopPropagation()
    },
    { priority: 2 },
  )
  onCleanup(offEscape)

  const options = createMemo(() =>
    commands().flatMap((command) => {
      if (!command.id || !command.palette || command.id === COMMAND_PALETTE_COMMAND) return []
      return {
        title: command.title ?? command.id,
        description: command.description,
        category: command.group,
        footer: shortcuts.all(command.id),
        value: command.id,
        suggested: isSuggestedPaletteCommand(command),
        onSelect: (dialog: DialogContext) => {
          dialog.clear()
          command.run()
        },
      }
    }),
  )

  let ref: DialogSelectRef<string>
  const list = () => {
    if (ref?.filter) return options()
    return [
      ...options()
        .filter((option) => option.suggested)
        .map((option) => ({
          ...option,
          value: `suggested:${option.value}`,
          category: "Suggested",
        })),
      ...options().filter((option) => !option.suggested),
    ]
  }

  return <DialogSelect ref={(value) => (ref = value)} title="Commands" options={list()} />
}
