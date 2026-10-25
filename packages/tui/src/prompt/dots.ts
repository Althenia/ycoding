import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import type { PromptInput } from "@ycoding-ai/schema/prompt-input"
import { parseSlashHead } from "./parse"

export function dotsInput(text: string, files: readonly PromptInput.FileAttachment[], id: string) {
  const command = parseSlashHead(text)
  if (command?.name !== "dots") return
  if (!command.arguments.trim() && files.length === 0) return { kind: "select" as const }
  return {
    kind: "send" as const,
    input: { id, text: command.arguments, ...(files.length ? { files } : {}) },
  }
}

export function createDotsCapability(input: {
  sessionID: () => string | undefined
  connected: () => boolean
  read: (sessionID: string, signal: AbortSignal) => Promise<boolean>
  reset: () => void
}) {
  const [enabled, setEnabled] = createSignal(false)
  let fence = 0
  let reading: AbortController | undefined
  createEffect(() => {
    const sessionID = input.sessionID()
    const connected = input.connected()
    const current = ++fence
    reading?.abort()
    reading = undefined
    setEnabled(false)
    untrack(input.reset)
    if (!sessionID || !connected) return
    const controller = new AbortController()
    reading = controller
    void untrack(() => input.read(sessionID, controller.signal)).then(
      (value) => value === true,
      () => false,
    ).then((value) => {
      if (current === fence) setEnabled(value)
    })
  })
  onCleanup(() => {
    fence++
    reading?.abort()
  })
  return {
    enabled,
    fence: () => fence,
    disable() {
      fence++
      reading?.abort()
      reading = undefined
      setEnabled(false)
      input.reset()
    },
  }
}
