import { createMemo, onMount } from "solid-js"
import { useData } from "../../context/data"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { DialogMessage } from "./dialog-message"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../prompt/history"

export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
  setPrompt?: (prompt: PromptInfo) => void
  presentation?: readonly {
    id: string
    title: string
    age: string
    status: string
    category: "Today"
    done?: boolean
  }[]
}) {
  const data = useData()
  const dialog = useDialog()

  onMount(() => {
    dialog.setSize("large")
  })

  type TimelineValue = { type: "message"; id: string }

  const options = createMemo((): DialogSelectOption<TimelineValue>[] => {
    if (props.presentation)
      return props.presentation.map((entry) => ({
        title: entry.title,
        description: entry.age,
        footer: entry.status,
        category: entry.category,
        state: entry.done ? "connected" : undefined,
        value: { type: "message" as const, id: entry.id },
      }))
    const messages = data.session.message.list(props.sessionID)
    const result = [] as DialogSelectOption<TimelineValue>[]
    for (const message of messages) {
      if (message.type !== "user") continue
      result.push({
        title: message.text.replace(/\n/g, " "),
        value: { type: "message", id: message.id },
        footer: Locale.time(message.time.created),
        onSelect: (dialog) => {
          dialog.replace(() => (
            <DialogMessage messageID={message.id} sessionID={props.sessionID} setPrompt={props.setPrompt} />
          ))
        },
      })
    }
    result.reverse()
    return result
  })

  return (
    <DialogSelect
      onMove={(option) => option.value.type === "message" && props.onMove(option.value.id)}
      title="Session timeline"
      // Newly arriving messages rebuild this list and shift every index, so selection follows the
      // option's value rather than its position.
      preserveSelection
      options={options()}
    />
  )
}
