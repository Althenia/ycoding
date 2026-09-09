import {
  EmbeddedTerminalRenderable,
  type EmbeddedTerminalDataSource,
  type EmbeddedTerminalOptions,
  type KeyEvent,
  type PasteEvent,
  type RenderContext,
} from "@opentui/core"
import { extend } from "@opentui/solid"
import type { Pty } from "@ycoding-ai/schema/pty"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import type { TerminalInspectorState } from "./terminal-inspector-state"

type ViewportOptions = EmbeddedTerminalOptions & {
  interactive?: boolean
  sendData?: (data: Uint8Array, source: EmbeddedTerminalDataSource) => void
}

export class TerminalViewportRenderable extends EmbeddedTerminalRenderable {
  private allowInput = false
  private dispatch?: ViewportOptions["sendData"]

  constructor(ctx: RenderContext, options: ViewportOptions) {
    let dispatch: ViewportOptions["sendData"]
    super(ctx, { ...options, onData: (data, source) => dispatch?.(data, source) })
    dispatch = (data, source) => this.dispatch?.(data, source)
    this.allowInput = options.interactive === true
    this.dispatch = options.sendData
  }

  set interactive(value: boolean) {
    this.allowInput = value
    if (!value && this.focused) super.blur()
  }

  set sendData(value: ViewportOptions["sendData"]) {
    this.dispatch = value
  }

  override focus() {
    if (this.allowInput) super.focus()
  }

  override handleKeyPress(key: KeyEvent) {
    return this.allowInput && super.handleKeyPress(key)
  }

  override handlePaste(event: PasteEvent) {
    if (this.allowInput) super.handlePaste(event)
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    terminal_viewport: typeof TerminalViewportRenderable
  }
}

extend({ terminal_viewport: TerminalViewportRenderable })

export type TerminalInspectorTransport = {
  connect(
    input: { generation: number; offset: number; access: Pty.Access; fence?: number },
    handlers: {
      frame: (frame: string | Uint8Array | ArrayBuffer) => void
      close: () => void
      error?: () => void
    },
  ): () => void
  control(input: Pty.ControlInput, options?: { signal?: AbortSignal }): Promise<Pty.Info>
  resize(input: Pty.UpdateInput, options?: { signal?: AbortSignal }): Promise<Pty.Info>
  write(data: Uint8Array): void
}

export type TerminalInspectorRef = {
  close(): Promise<boolean>
  takeControl(): Promise<boolean>
  returnControl(): Promise<boolean>
  resumeAgent(): Promise<boolean>
  fit(): Promise<boolean>
  copySelection(): Promise<boolean>
}

export function TerminalInspector(props: {
  state: TerminalInspectorState
  transport: TerminalInspectorTransport
  pane: { rows: number; cols: number }
  onClose: () => void
  copy?: (text: string) => Promise<void>
  reconnectDelay?: number
  closeHint?: string
  leaveInputHint?: string
  ref?: (ref: TerminalInspectorRef) => void
}) {
  const [revision, setRevision] = createSignal(0)
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  let terminal: TerminalViewportRenderable | undefined
  let disconnect: (() => void) | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let connectionGeneration = 0
  let disposed = false
  const requests = new AbortController()
  const snapshot = () => {
    revision()
    return props.state.snapshot()
  }
  const canInput = () => {
    revision()
    return props.state.canInput()
  }

  function syncInput() {
    const enabled = props.state.canInput()
    if (terminal) terminal.interactive = enabled
    if (enabled) terminal?.focus()
  }

  function reconnect(access: Pty.Access = "inspect") {
    if (disposed || snapshot().connection === "ended" || snapshot().synchronization === "unsynchronized") return
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    connectionGeneration += 1
    const generation = connectionGeneration
    disconnect?.()
    const input = props.state.reconnectInput(access)
    props.state.connecting(input)
    syncInput()
    disconnect = props.transport.connect(input, {
      frame: (frame) => {
        if (disposed || generation !== connectionGeneration) return
        props.state.apply(frame)
        syncInput()
        if (props.state.snapshot().synchronization === "synchronized") setError(undefined)
      },
      close: () => disconnected(generation),
      error: () => disconnected(generation, "Unable to connect to terminal"),
    })
  }

  function disconnected(generation: number, reason?: string) {
    if (disposed || generation !== connectionGeneration || snapshot().connection === "ended") return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    props.state.disconnected(reason)
    syncInput()
    if (reason) setError(reason)
    if (snapshot().synchronization === "unsynchronized") return
    reconnectTimer = setTimeout(
      () => reconnect(snapshot().info.control.owner === "user" ? "control" : "inspect"),
      props.reconnectDelay ?? 1_000,
    )
  }

  onMount(() => {
    const unsubscribe = props.state.subscribe(() => setRevision((value) => value + 1))
    reconnect(snapshot().info.control.owner === "user" ? "control" : "inspect")
    onCleanup(() => {
      disposed = true
      requests.abort()
      connectionGeneration += 1
      if (reconnectTimer) clearTimeout(reconnectTimer)
      disconnect?.()
      unsubscribe()
    })
  })

  async function control(action: Pty.ControlInput["action"], reconnectTransport = true) {
    if (busy()) return false
    const info = snapshot().info
    setBusy(true)
    setError(undefined)
    const next = await props.transport
      .control(
        {
          sessionID: info.sessionID,
          generation: info.generation,
          expectedFence: info.control.fence,
          action,
        },
        { signal: requests.signal },
      )
      .catch(() => undefined)
    if (requests.signal.aborted) return false
    setBusy(false)
    if (!next) {
      setError(action === "pause" ? "Unable to return terminal control" : "Unable to change terminal control")
      return false
    }
    props.state.updateInfo(next)
    if (reconnectTransport) reconnect(next.control.owner === "user" ? "control" : "inspect")
    syncInput()
    return true
  }

  async function close() {
    if (snapshot().info.control.owner === "user" && !(await control("pause", false))) return false
    props.onClose()
    return true
  }

  async function fit() {
    if (!props.state.canInput() || busy()) return false
    const info = snapshot().info
    setBusy(true)
    setError(undefined)
    const next = await props.transport
      .resize(
        {
          sessionID: info.sessionID,
          generation: info.generation,
          expectedFence: info.control.fence,
          actor: "user",
          size: props.pane,
        },
        { signal: requests.signal },
      )
      .catch(() => undefined)
    if (requests.signal.aborted) return false
    setBusy(false)
    if (!next) {
      setError("Unable to resize terminal")
      return false
    }
    props.state.updateInfo(next)
    return true
  }

  async function copySelection() {
    const selected = props.state.selectedText()
    if (!selected || !props.copy || busy()) return false
    setBusy(true)
    setError(undefined)
    const copied = await props
      .copy(selected)
      .then(() => true)
      .catch(() => false)
    setBusy(false)
    if (!copied) setError("Unable to copy terminal selection")
    return copied
  }

  props.ref?.({
    close,
    takeControl: () => control("take"),
    returnControl: () => control("pause"),
    resumeAgent: () => control("agent"),
    fit,
    copySelection,
  })

  return (
    <box width="100%" height="100%" flexDirection="column">
      <text>
        {snapshot().info.title} · {snapshot().info.sessionID} · {snapshot().info.status} · {snapshot().info.size.cols}×
        {snapshot().info.size.rows} · {snapshot().info.control.owner === "user" ? "You" : snapshot().info.control.owner}
      </text>
      <Show when={snapshot().synchronization !== "synchronized"}>
        <text>
          Terminal {snapshot().synchronization}: {snapshot().reason ?? "waiting for ordered replay"}
        </text>
      </Show>
      <Show when={error()}>{(message) => <text>{message()}</text>}</Show>
      <box width={props.pane.cols} height={props.pane.rows} overflow="hidden" flexShrink={1}>
        <terminal_viewport
          ref={(value: TerminalViewportRenderable) => {
            terminal = value
            props.state.attach(value)
          }}
          width={snapshot().info.size.cols}
          height={snapshot().info.size.rows}
          cols={snapshot().info.size.cols}
          rows={snapshot().info.size.rows}
          maxScrollback={2000}
          selectable
          interactive={canInput()}
          sendData={(data) => {
            if (props.state.canInput()) props.transport.write(data)
          }}
        />
      </box>
      <box flexDirection="row" gap={2}>
        <Show when={snapshot().info.control.owner !== "user" && snapshot().synchronization === "synchronized"}>
          <text onMouseUp={() => void control("take")}>{busy() ? "Changing control…" : "Take control"}</text>
        </Show>
        <Show when={snapshot().info.control.owner === "user"}>
          <text onMouseUp={() => void control("pause")}>
            {props.leaveInputHint ? `${props.leaveInputHint} ` : ""}Return control
          </text>
          <text onMouseUp={() => void fit()}>Fit terminal to pane</text>
        </Show>
        <Show when={snapshot().info.control.owner === "paused" && snapshot().synchronization === "synchronized"}>
          <text onMouseUp={() => void control("agent")}>Resume agent</text>
        </Show>
        <Show when={props.copy && props.state.selectedText()}>
          <text onMouseUp={() => void copySelection()}>Copy selection</text>
        </Show>
        <text onMouseUp={() => void close()}>{props.closeHint ? `${props.closeHint} ` : ""}Close view</text>
      </box>
    </box>
  )
}
