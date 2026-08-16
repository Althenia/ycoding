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
}) {
  const data = useData()
  const dialog = useDialog()

  onMount(() => {
    dialog.setSize("large")
  })

  type TimelineValue = { type: "message"; id: string } | { type: "history"; cursor?: string }

  const options = createMemo((): DialogSelectOption<TimelineValue>[] => {
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
    const history = data.session.message.history(props.sessionID)
    const expanded = history.findIndex((item) => item.state === "expanded")
    const pending = history.find((item) => item.state === "loading" || item.state === "error")
    const next = pending ?? history[expanded === -1 ? 0 : expanded + 1]
    if (next)
      result.push({
        title:
          next.state === "loading"
            ? "Loading older messages..."
            : next.state === "error"
              ? "Retry older messages"
              : `Load ${next.count ? `${next.count} ` : ""}older messages`,
        value: { type: "history", cursor: next.cursor },
        onSelect: () => {
          if (next.state === "loading") return
          void data.session.message.expand(props.sessionID, next.cursor).catch(() => undefined)
        },
      })
    return result
  })

  return (
    <DialogSelect
      onMove={(option) => option.value.type === "message" && props.onMove(option.value.id)}
      title="Timeline"
      // Expanding history and newly arriving messages both rebuild this list and shift
      // every index, so the selection has to follow the option's value, not its position.
      preserveSelection
      options={options()}
    />
  )
}
