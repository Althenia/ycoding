import { InputRenderable, RGBA, TextAttributes } from "@opentui/core"
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLocal } from "../context/local"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { Keymap } from "../context/keymap"
import { DialogHeader, DialogTitle, type DialogContext } from "../ui/dialog"

export type CustomEndpointResult = {
  baseURL: string
  api: "chat" | "responses"
  provider?: string
  apiKey?: string
}

const API_OPTIONS = ["chat", "responses"] as const

function isValidURL(url: string): boolean {
  if (!url.trim()) return false
  try {
    new URL(url.trim())
    return true
  } catch {
    return false
  }
}

export function DialogCustomEndpoint(props: {
  onComplete?: (result: CustomEndpointResult) => void
  onCancel?: () => void
}) {
  const local = useLocal()
  const dialog = useDialog()
  const { themeV2 } = useTheme().contextual("elevated")
  const [baseURL, setBaseURL] = createSignal("")
  const [api, setApi] = createSignal<"chat" | "responses">("chat")
  const [provider, setProvider] = createSignal("")
  const [apiKey, setApiKey] = createSignal("")
  const [error, setError] = createSignal("")
  let baseURLInput: InputRenderable | undefined
  let settled = false
  onCleanup(() => {
    if (settled) return
    props.onCancel?.()
  })

  const validURL = createMemo(() => isValidURL(baseURL()))

  function submit() {
    const url = baseURL().trim()
    if (!url) {
      setError("Endpoint URL is required")
      return
    }
    if (!isValidURL(url)) {
      setError("Invalid URL format")
      return
    }
    settled = true
    props.onComplete?.({
      baseURL: url,
      api: api(),
      provider: provider().trim() || undefined,
      apiKey: apiKey().trim() || undefined,
    })
    dialog.clear()
  }

  function cancel() {
    props.onCancel?.()
    dialog.clear()
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        id: "custom-endpoint.submit",
        bind: "return",
        title: "Submit endpoint",
        group: "Dialog",
        run: submit,
      },
      {
        id: "custom-endpoint.cancel",
        bind: "escape",
        title: "Cancel",
        group: "Dialog",
        run: cancel,
      },
    ],
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => baseURLInput?.focus(), 1)
  })

  return (
    <box paddingTop={1} paddingBottom={1}>
      <DialogHeader title={<DialogTitle>Custom OpenAI-Compatible Endpoint</DialogTitle>} />
      <box flexDirection="column" paddingTop={1} paddingLeft={6} paddingRight={4}>
        <box flexDirection="column">
          <text fg={themeV2.text.default} attributes={TextAttributes.BOLD}>
            Endpoint URL
          </text>
          <input
            ref={(value: InputRenderable) => {
              baseURLInput = value
            }}
            value={baseURL()}
            onInput={(e) => {
              setBaseURL(e)
              setError("")
            }}
            placeholder="https://api.example.com/v1"
            placeholderColor={themeV2.text.subdued}
            textColor={themeV2.text.formfield.default}
            focusedTextColor={themeV2.text.formfield.default}
            cursorColor={themeV2.text.formfield.default}
            onSubmit={submit}
          />
          <Show when={error()}>
            <text fg={themeV2.text.feedback.error.default}>{error()}</text>
          </Show>
          <Show when={validURL()}>
            <text fg={themeV2.text.feedback.success.default}>Valid endpoint URL</text>
          </Show>
        </box>

        <box flexDirection="column" paddingTop={1}>
          <text fg={themeV2.text.default} attributes={TextAttributes.BOLD}>
            API Type
          </text>
          <box flexDirection="row" gap={1}>
            <button
              onClick={() => setApi("chat")}
              onMouseUp={() => setApi("chat")}
            >
              <box
                paddingX={1}
                backgroundColor={
                  api() === "chat"
                    ? themeV2.background.action.primary.focused
                    : RGBA.fromInts(0, 0, 0, 0)
                }
              >
                <text
                  fg={
                    api() === "chat"
                      ? themeV2.text.action.primary.focused
                      : themeV2.text.subdued
                  }
                  attributes={api() === "chat" ? TextAttributes.BOLD : undefined}
                >
                  Chat
                </text>
              </box>
            </button>
            <button
              onClick={() => setApi("responses")}
              onMouseUp={() => setApi("responses")}
            >
              <box
                paddingX={1}
                backgroundColor={
                  api() === "responses"
                    ? themeV2.background.action.primary.focused
                    : RGBA.fromInts(0, 0, 0, 0)
                }
              >
                <text
                  fg={
                    api() === "responses"
                      ? themeV2.text.action.primary.focused
                      : themeV2.text.subdued
                  }
                  attributes={api() === "responses" ? TextAttributes.BOLD : undefined}
                >
                  Responses
                </text>
              </box>
            </button>
          </box>
        </box>

        <box flexDirection="column" paddingTop={1}>
          <text fg={themeV2.text.default} attributes={TextAttributes.BOLD}>
            Provider (optional)
          </text>
          <input
            value={provider()}
            onInput={(e) => setProvider(e)}
            placeholder="e.g., openai"
            placeholderColor={themeV2.text.subdued}
            textColor={themeV2.text.formfield.default}
            focusedTextColor={themeV2.text.formfield.default}
            cursorColor={themeV2.text.formfield.default}
          />
        </box>

        <box flexDirection="column" paddingTop={1}>
          <text fg={themeV2.text.default} attributes={TextAttributes.BOLD}>
            API Key (optional)
          </text>
          <input
            value={apiKey()}
            onInput={(e) => setApiKey(e)}
            placeholder="sk-..."
            placeholderColor={themeV2.text.subdued}
            textColor={themeV2.text.formfield.default}
            focusedTextColor={themeV2.text.formfield.default}
            cursorColor={themeV2.text.formfield.default}
          />
        </box>
      </box>
      <box paddingTop={2} paddingLeft={6} paddingRight={4}>
        <text fg={themeV2.text.default}>Enter <span style={{ fg: themeV2.text.subdued }}>submit · Esc cancel</span></text>
      </box>
    </box>
  )
}

DialogCustomEndpoint.show = (dialog: DialogContext, opts?: { onComplete?: (result: CustomEndpointResult) => void; onCancel?: () => void }) =>
  dialog.replace(() => <DialogCustomEndpoint onComplete={opts?.onComplete} onCancel={opts?.onCancel} />)
