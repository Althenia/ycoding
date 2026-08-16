import { useRenderer } from "@opentui/solid"
import { createMemo, onCleanup, onMount } from "solid-js"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useDialog, type DialogContext } from "../ui/dialog"
import { COMMAND_PALETTE_COMMAND, Keymap } from "../context/keymap"

const canonicalPromotions = [
  { id: "session.list", title: "Switch session" },
  { id: "model.list", title: "Switch model" },
  { id: "ycoding.settings", title: "Open settings" },
]

export function CommandPaletteDialog() {
  const dialog = useDialog()
  const renderer = useRenderer()
  const keymap = Keymap.use()
  const commands = Keymap.useCommands()
  const shortcuts = Keymap.useShortcuts()

  onMount(() => {
    dialog.setSize("command-palette")
    dialog.setCentered(true)
  })

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
        footer: shortcuts.all(command.id)?.replaceAll("ctrl+", "⌃"),
        value: command.id,
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
    const promoted = canonicalPromotions.flatMap((promotion) => {
      const option = options().find((option) => option.value === promotion.id || option.title === promotion.title)
      if (!option) return []
      return [{ ...option, category: "Suggested" }]
    })
    const promotedIDs = new Set(promoted.map((option) => option.value))
    return [
      ...promoted,
      ...options().filter((option) => !promotedIDs.has(option.value)),
    ]
  }

  return <DialogSelect ref={(value) => (ref = value)} layout="command-palette" title="Commands" options={list()} />
}
