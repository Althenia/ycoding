/** @jsxImportSource @opentui/solid */
import { useKeyboard } from "@opentui/solid"
import { Show, createSignal, onCleanup } from "solid-js"
import type { RunFooterTheme } from "./theme"

export function RunChromePairingBody(props: {
  theme: () => RunFooterTheme
  address?: () => string | undefined
  onStart: (signal: AbortSignal) => Promise<{ secret: string; expiresAt: number }>
  onClose: () => void
}) {
  const [pending, setPending] = createSignal(false)
  const [secret, setSecret] = createSignal<string>()
  const [error, setError] = createSignal(false)
  let request: AbortController | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined

  const start = () => {
    if (pending() || secret()) return
    const controller = new AbortController()
    request = controller
    setPending(true)
    setError(false)
    void props.onStart(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        if (value.expiresAt <= Date.now()) {
          setError(true)
          return
        }
        setSecret(value.secret)
        expiry = setTimeout(() => setSecret(), value.expiresAt - Date.now())
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false)
      })
  }

  onCleanup(() => {
    request?.abort()
    clearTimeout(expiry)
    setSecret()
  })

  useKeyboard((event) => {
    if (event.name === "p" && !event.ctrl && !event.meta && !event.super) {
      event.preventDefault()
      start()
      return
    }
    if (event.name === "escape") {
      event.preventDefault()
      props.onClose()
    }
  })

  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={1} gap={1}>
      <text fg={props.theme().text}>Connect Chrome</text>
      <text fg={props.theme().muted}>Pair the unpacked YCoding extension in this Chrome profile.</text>
      <Show when={props.address?.()}>
        <text fg={props.theme().text}>Local service address: {props.address?.()}</text>
      </Show>
      <Show when={secret()} fallback={<text fg={props.theme().muted}>Press p to create a one-time pairing code.</text>}>
        <text fg={props.theme().text}>Pairing code: {secret()}</text>
      </Show>
      <Show when={pending()}>
        <text fg={props.theme().muted}>Creating code…</text>
      </Show>
      <Show when={error()}>
        <text fg={props.theme().error}>Could not create a code. Press p to retry.</text>
      </Show>
      <text fg={props.theme().muted}>
        Creating a code replaces existing extension trust. Expires in two minutes. Esc closes.
      </text>
    </box>
  )
}
