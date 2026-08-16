import { createMemo } from "solid-js"
import { useData } from "../../context/data"
import { DialogSelect } from "../../ui/dialog-select"
import { useClipboard } from "../../context/clipboard"
import { useToast } from "../../ui/toast"
import { useClient } from "../../context/client"
import { errorMessage } from "../../util/error"
import { DialogFork } from "./dialog-fork"
import type { PromptInfo } from "../../prompt/history"
import { projectedPromptInput } from "../../prompt/codec"
import { Keymap } from "../../context/keymap"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  shortcuts?: { editor?: string; fork?: string }
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const data = useData()
  const clipboard = useClipboard()
  const toast = useToast()
  const client = useClient()
  const keymap = Keymap.use()
  const shortcuts = Keymap.useShortcuts()
  const message = createMemo(() => data.session.message.get(props.sessionID, props.messageID))
  const copy = async () => {
    const value = message()
    if (!value) return
    const text =
      value.type === "user"
        ? value.text
        : value.type === "assistant"
          ? value.content
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("\n")
          : "text" in value
            ? value.text
            : ""
    await clipboard.write?.(text)
  }

  return (
    <DialogSelect
      title="Message actions"
      options={[
        {
          title: "Copy message",
          value: "message.copy",
          onSelect: async (dialog) => {
            await copy()
            dialog.clear()
          },
        },
        {
          title: "Copy as markdown",
          value: "message.copy-markdown",
          onSelect: async (dialog) => {
            await copy()
            dialog.clear()
          },
        },
        {
          title: "Open in editor",
          value: "message.editor",
          footer: props.shortcuts?.editor ?? shortcut(shortcuts.get("prompt.editor")),
          onSelect: (dialog) => {
            dialog.clear()
            keymap.dispatch("prompt.editor")
          },
        },
        {
          title: "Fork from here",
          value: "session.fork",
          footer: props.shortcuts?.fork ?? shortcut(shortcuts.get("session.fork")),
          onSelect: (dialog) => {
            const value = message()
            if (!value || value.type !== "user") return
            dialog.replace(() => <DialogFork sessionID={props.sessionID} messageID={props.messageID} />)
          },
        },
        {
          title: "Revert to here",
          value: "session.revert",
          onSelect: (dialog) => {
            const value = message()
            if (value?.type === "user") {
              props.setPrompt?.({
                ...projectedPromptInput(value),
                pasted: [],
              })
            }
            void client.api.session.revert
              .stage({ sessionID: props.sessionID, messageID: props.messageID })
              .catch((error) => toast.show({ message: errorMessage(error), variant: "error", duration: 5000 }))
            dialog.clear()
          },
        },
        { title: "Jump to message", value: "message.jump", onSelect: (dialog) => dialog.clear() },
      ]}
    />
  )
}

function shortcut(value: string | undefined) {
  return value?.replace(/^ctrl\+x /, "⌃x ").replace(/^ctrl\+/, "⌃")
}
