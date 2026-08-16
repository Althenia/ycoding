import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { createMemo, createSignal } from "solid-js"
import { Locale } from "../util/locale"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { usePromptStash, type StashEntry } from "./prompt/stash"

function getRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  if (hours < 24) return `${hours} hr ago`
  if (days === 1) return "yesterday"
  if (days < 7) return `${days} days ago`
  return Locale.datetime(timestamp)
}

function getStashPreview(input: string, maxLength: number = 50): string {
  const firstLine = input.split("\n")[0].trim()
  return Locale.truncate(firstLine, maxLength)
}

export function DialogStash(props: { onSelect: (entry: StashEntry) => void }) {
  const dialog = useDialog()
  const stash = usePromptStash()
  const { theme } = useTheme()
  const shortcuts = Keymap.useShortcuts()

  const [toDelete, setToDelete] = createSignal<number>()

  const options = createMemo(() => {
    const entries = stash.list()
    // Show most recent first
    return entries
      .map((entry, index) => {
        const isDeleting = toDelete() === index
        const lineCount = (entry.prompt.text.match(/\n/g)?.length ?? 0) + 1
        return {
          title: isDeleting
            ? `Press ${shortcuts.get("stash.delete")} again to confirm`
            : getStashPreview(entry.prompt.text),
          bg: isDeleting ? theme.error : undefined,
          value: index,
          description: getRelativeTime(entry.timestamp),
          footer:
            entry.prompt.pasted.length > 0
              ? `${entry.prompt.pasted.length} file${entry.prompt.pasted.length === 1 ? "" : "s"}`
              : lineCount > 1
                ? `~${lineCount} lines`
                : undefined,
        }
      })
      .toReversed()
  })

  return (
    <DialogSelect
      title="Stashes"
      options={options()}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        const entries = stash.list()
        const entry = entries[option.value]
        if (entry) {
          stash.remove(option.value)
          props.onSelect(entry)
        }
        dialog.clear()
      }}
      footer={<text>⌃x k drop</text>}
      actions={[
        {
          command: "stash.delete",
          title: "drop",
          onTrigger: (option) => {
            if (toDelete() === option.value) {
              stash.remove(option.value)
              setToDelete(undefined)
              return
            }
            setToDelete(option.value)
          },
        },
      ]}
    />
  )
}
