/** @jsxImportSource @opentui/solid */
import { useKeyboard } from "@opentui/solid"
import { Show, createSignal, onCleanup } from "solid-js"
import type { Browser } from "@ycoding-ai/schema/browser"
import type { RunFooterTheme } from "./theme"

export function RunChromePairingBody(props: {
  theme: () => RunFooterTheme
  address?: () => string | undefined
  onStart: (signal: AbortSignal) => Promise<{ secret: string; expiresAt: number }>
  onStatus: (signal: AbortSignal) => Promise<Browser.Status>
  onForget: (signal: AbortSignal) => Promise<void>
  onClose: () => void
}) {
  const [pending, setPending] = createSignal(false)
  const [secret, setSecret] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [statusError, setStatusError] = createSignal(false)
  const [paired, setPaired] = createSignal(false)
  const [connected, setConnected] = createSignal(false)
  const [statusKnown, setStatusKnown] = createSignal(false)
  let request: AbortController | undefined
  let statusRequest: AbortController | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setInterval> | undefined

  const refresh = () => {
    statusRequest?.abort()
    const controller = new AbortController()
    statusRequest = controller
    void props.onStatus(controller.signal).then((status) => {
      if (controller.signal.aborted) return
      setStatusError(false)
      setStatusKnown(true)
      setPaired(status.paired === true)
      setConnected(status.state === "connected" || status.state === "paused")
    }).catch(() => {
      if (!controller.signal.aborted) setStatusError(true)
    })
  }

  const start = () => {
    if (pending() || secret() || paired() || !statusKnown()) return
    const controller = new AbortController()
    request = controller
    setPending(true)
    setError()
    void props.onStart(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        if (value.expiresAt <= Date.now()) {
          setError("Could not create a code. Press p to retry.")
          return
        }
        setSecret(value.secret)
        expiry = setTimeout(() => setSecret(), value.expiresAt - Date.now())
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not create a code. Press p to retry.")
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false)
      })
  }

  const forget = () => {
    if (pending() || !paired()) return
    const controller = new AbortController()
    request?.abort()
    request = controller
    setPending(true)
    setError()
    void props.onForget(controller.signal).then(() => {
      if (controller.signal.aborted) return
      setPaired(false)
      setConnected(false)
    }).catch(() => {
      if (!controller.signal.aborted) setError("Could not forget pairing. Press f to retry.")
    }).finally(() => {
      if (!controller.signal.aborted) setPending(false)
    })
  }

  refresh()
  poll = setInterval(refresh, 2000)

  onCleanup(() => {
    request?.abort()
    statusRequest?.abort()
    clearTimeout(expiry)
    clearInterval(poll)
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
    if (event.name === "f" && !event.ctrl && !event.meta && !event.super) {
      event.preventDefault()
      forget()
    }
  })

  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={1} gap={1}>
      <text fg={props.theme().text}>Connect Chrome</text>
      <text fg={props.theme().muted}>Pair the unpacked YCoding extension in this Chrome profile.</text>
      <Show when={props.address?.()}>
        <text fg={props.theme().text}>Local service address: {props.address?.()}</text>
      </Show>
      <Show when={secret()}>
        <text fg={props.theme().text}>Pairing code: {secret()}</text>
      </Show>
      <Show when={paired()}>
        <text fg={props.theme().text}>
          {connected() ? "Chrome is paired and connected." : "Chrome is paired; waiting for Chrome to reconnect."}
        </text>
        <text fg={props.theme().muted}>Press f to forget pairing.</text>
      </Show>
      <Show when={!paired()}>
        <Show when={statusKnown()} fallback={<text fg={props.theme().muted}>Loading Chrome pairing status…</text>}>
          <text fg={props.theme().muted}>Press p to create a one-time pairing code.</text>
        </Show>
      </Show>
      <Show when={pending()}>
        <text fg={props.theme().muted}>Working…</text>
      </Show>
      <Show when={statusError()}>
        <text fg={props.theme().error}>Could not load Chrome pairing status.</text>
      </Show>
      <Show when={error()}>
        <text fg={props.theme().error}>{error()}</text>
      </Show>
      <text fg={props.theme().muted}>
        Code expires in two minutes. Esc closes.
      </text>
    </box>
  )
}
