import { batch, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import type { DesktopAPI, SessionTerminal, TerminalAccess, TerminalControlInput } from "./contract"
import { TerminalEmulator, terminalKey, terminalPaste, type TerminalColor, type TerminalPoint, type TerminalStyle } from "./terminal-emulator"
import { fromBase64 } from "./terminal-protocol"
import { TerminalState } from "./terminal-state"

type TerminalAPI = Pick<DesktopAPI, "terminal" | "terminalConnect" | "terminalRead" | "terminalWrite" | "terminalClose" | "terminalControl" | "terminalResize" | "readClipboard" | "onEvent">

const ansi = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"]
const cube = [0, 95, 135, 175, 215, 255]
const hex = (...channels: number[]) => `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export function terminalColor(color: TerminalColor) {
  if (typeof color === "string") return color
  if (color < 16) return ansi[color] ?? ansi[7]!
  if (color < 232) { const value = color - 16; return hex(cube[Math.floor(value / 36)]!, cube[Math.floor(value / 6) % 6]!, cube[value % 6]!) }
  const gray = 8 + (Math.min(color, 255) - 232) * 10
  return hex(gray, gray, gray)
}

export function terminalCss(style: TerminalStyle, selected: boolean): JSX.CSSProperties {
  const fg = style.fg === undefined ? "var(--yc-ink)" : terminalColor(style.fg)
  const bg = style.bg === undefined ? undefined : terminalColor(style.bg)
  const [color, background] = style.inverse ? [bg ?? "var(--yc-plane-hover)", fg] : [fg, bg]
  const decoration = [style.underline ? "underline" : "", style.strike ? "line-through" : ""].filter(Boolean).join(" ")
  return {
    color,
    ...(selected ? { "background-color": "var(--yc-focus-ring-soft)" } : background ? { "background-color": background } : {}),
    ...(style.bold ? { "font-weight": "700" } : {}),
    ...(style.italic ? { "font-style": "italic" } : {}),
    ...(decoration ? { "text-decoration": decoration } : {}),
    ...(style.dim ? { opacity: "0.6" } : {}),
  }
}

export function fitTerminal(width: number, height: number, cell: { readonly width: number; readonly height: number }) {
  if (!(cell.width > 0) || !(cell.height > 0)) return undefined
  return { cols: clamp(Math.floor(width / cell.width), 1, 500), rows: clamp(Math.floor(height / cell.height), 1, 200) }
}

function pieces(text: string) {
  const out: string[] = []
  let current = ""
  for (const char of text) {
    if (current.length + char.length > 16_384) { out.push(current); current = "" }
    current += char
  }
  if (current) out.push(current)
  return out
}

const failure = (cause: unknown, fallback: string) => cause instanceof Error && cause.message ? cause.message : fallback
const own = (value: unknown, key: string): unknown => typeof value === "object" && value !== null ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined

export function TerminalInspector(props: { api: TerminalAPI; info: SessionTerminal; copy: (text: string) => Promise<void> }) {
  const { api } = props
  const sessionID = props.info.sessionID, ptyID = props.info.id
  const state = new TerminalState(props.info)
  const [revision, setRevision] = createSignal(0)
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [scroll, setScroll] = createSignal(0)
  let streamID: string | undefined
  let connection = 0
  let refreshes = 0
  let disposed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let writes = Promise.resolve()
  let viewport: HTMLDivElement | undefined
  let grid: HTMLDivElement | undefined
  let probe: HTMLSpanElement | undefined
  const send = (data: string) => {
    const target = streamID
    if (!target || !state.canInput()) return
    for (const piece of pieces(data)) writes = writes.then(() => api.terminalWrite({ streamID: target, data: piece })).catch(() => { if (!disposed) setError("Terminal input was not delivered. Check the output before typing again.") })
  }
  const emulator = new TerminalEmulator({ cols: props.info.size.cols, rows: props.info.size.rows, scrollback: 2000, onResponse: send })
  state.attach(emulator)
  const bump = () => setRevision((value) => value + 1)
  const snapshot = () => { revision(); return state.snapshot() }
  const canInput = () => { revision(); return state.canInput() }
  const rows = () => { revision(); return emulator.view(scroll()) }
  const cursor = () => { revision(); return emulator.cursor() }
  const selected = () => { revision(); return emulator.hasSelection() }
  const owner = () => snapshot().info.control.owner
  const access = (): TerminalAccess => state.snapshot().info.control.owner === "user" ? "control" : "inspect"

  const closeStream = () => {
    const target = streamID
    streamID = undefined
    if (target) void api.terminalClose({ streamID: target }).catch(() => undefined)
  }

  function reconnect(mode: TerminalAccess) {
    const current = state.snapshot()
    if (disposed || current.connection === "ended" || current.synchronization === "unsynchronized") return
    clearTimeout(reconnectTimer)
    const generation = ++connection
    closeStream()
    const input = state.reconnectInput(mode)
    state.connecting(input)
    void (async () => {
      try {
        const stream = await api.terminalConnect({ sessionID, ptyID, generation: input.generation, offset: input.offset, access: input.access, ...(input.fence === undefined ? {} : { fence: input.fence }) })
        if (disposed || generation !== connection) { void api.terminalClose({ streamID: stream.streamID }).catch(() => undefined); return }
        streamID = stream.streamID
        while (!disposed && generation === connection) {
          const result = await api.terminalRead({ streamID: stream.streamID })
          if (disposed || generation !== connection) return
          batch(() => { for (const frame of result.frames) state.apply(fromBase64(frame)) })
          if (state.snapshot().synchronization === "synchronized") setError(undefined)
          if (result.status !== "open") { disconnected(generation, result.status === "error" ? "Unable to connect to terminal" : undefined); return }
        }
      } catch { disconnected(generation, "Unable to connect to terminal") }
    })()
  }

  function disconnected(generation: number, reason?: string) {
    if (disposed || generation !== connection || state.snapshot().connection === "ended") return
    streamID = undefined
    clearTimeout(reconnectTimer)
    state.disconnected(reason)
    if (reason) setError(reason)
    if (state.snapshot().synchronization === "unsynchronized") return
    reconnectTimer = setTimeout(() => reconnect(access()), 1_000)
  }

  const refresh = () => {
    const request = ++refreshes
    void api.terminal({ sessionID, ptyID }).then((read) => { if (!disposed && request === refreshes) state.updateInfo(read.item) }).catch(() => undefined)
  }

  onMount(() => {
    const unsubscribe = state.subscribe(() => {
      const size = state.snapshot().info.size, current = emulator.size()
      if (size.cols !== current.cols || size.rows !== current.rows) emulator.resize(size.cols, size.rows)
      bump()
    })
    const events = api.onEvent((event) => {
      const type: string = event.type
      const data: unknown = "data" in event ? event.data : undefined
      const id = type === "pty.updated" ? own(own(data, "info"), "id") : own(data, "id")
      if (id !== ptyID) return
      if (type === "pty.updated" || type === "pty.exited") refresh()
      if (type !== "pty.deleted") return
      connection++
      closeStream()
      state.disconnected("Terminal is no longer available")
      setError("Terminal is no longer available")
    })
    reconnect(access())
    onCleanup(() => {
      disposed = true
      connection++
      clearTimeout(reconnectTimer)
      closeStream()
      events()
      unsubscribe()
    })
  })

  async function control(action: TerminalControlInput["action"]) {
    if (busy()) return false
    const info = state.snapshot().info
    setBusy(true)
    setError(undefined)
    const next = await api.terminalControl({ sessionID, ptyID, generation: info.generation, expectedFence: info.control.fence, action }).catch((cause: unknown) => { if (!disposed) setError(failure(cause, action === "pause" ? "Unable to return terminal control" : "Unable to change terminal control")) })
    if (disposed) return false
    setBusy(false)
    if (!next) return false
    state.updateInfo(next.item)
    reconnect(next.item.control.owner === "user" ? "control" : "inspect")
    viewport?.focus()
    return true
  }

  const cell = () => {
    const rect = probe?.getBoundingClientRect()
    return { width: rect ? rect.width / 10 : 0, height: rect?.height ?? 0 }
  }

  async function fit() {
    if (!viewport || !state.canInput() || busy()) return
    const style = getComputedStyle(viewport)
    const size = fitTerminal(viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom), cell())
    if (!size) return
    const info = state.snapshot().info
    setBusy(true)
    setError(undefined)
    const next = await api.terminalResize({ sessionID, ptyID, generation: info.generation, expectedFence: info.control.fence, size }).catch((cause: unknown) => { if (!disposed) setError(failure(cause, "Unable to resize terminal")) })
    if (disposed) return
    setBusy(false)
    if (next) state.updateInfo(next.item)
  }

  async function copySelection() {
    const text = state.selectedText()
    if (!text) return
    await props.copy(text).catch(() => setError("Unable to copy terminal selection"))
  }

  const scrollBy = (lines: number) => setScroll((value) => clamp(value + lines, 0, Math.max(0, emulator.lineCount() - emulator.size().rows)))

  const point = (event: MouseEvent): TerminalPoint => {
    const rect = grid!.getBoundingClientRect(), size = cell(), view = rows()
    const row = clamp(Math.floor((event.clientY - rect.top) / (size.height || 1)), 0, view.length - 1)
    return { line: view[row]?.line ?? 0, col: clamp(Math.floor((event.clientX - rect.left) / (size.width || 1)), 0, emulator.size().cols - 1) }
  }

  const select = (event: MouseEvent) => {
    if (event.button !== 0 || !grid) return
    viewport?.focus()
    event.preventDefault()
    const anchor = point(event)
    let moved = false
    emulator.clearSelection()
    bump()
    const move = (next: MouseEvent) => { moved = true; emulator.select(anchor, point(next)); bump() }
    const up = () => {
      window.removeEventListener("mousemove", move)
      window.removeEventListener("mouseup", up)
      if (!moved) { emulator.clearSelection(); bump() }
    }
    window.addEventListener("mousemove", move)
    window.addEventListener("mouseup", up)
  }

  const paste = (text: string) => {
    if (!text) return
    setScroll(0)
    send(terminalPaste(text, emulator.modes().bracketedPaste))
  }

  const key = (event: KeyboardEvent) => {
    const stop = () => { event.preventDefault(); event.stopPropagation() }
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "]") {
      if (state.canInput()) { stop(); void control("pause") }
      return
    }
    if (event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "PageUp" || event.key === "PageDown")) { stop(); scrollBy((event.key === "PageUp" ? 1 : -1) * emulator.size().rows); return }
    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "c") {
      if (emulator.hasSelection()) { stop(); void copySelection() }
      return
    }
    if (!state.canInput() || event.isComposing) return
    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") {
      stop()
      void api.readClipboard().then((content) => paste(content.text ?? "")).catch(() => setError("Unable to read the clipboard"))
      return
    }
    const data = terminalKey(event, emulator.modes())
    if (data === undefined) return
    stop()
    setScroll(0)
    emulator.clearSelection()
    send(data)
  }

  return <section class="terminal-inspector" aria-label="Terminal inspector">
    <p class="terminal-inspector__status">{snapshot().info.title || snapshot().info.command} · {snapshot().info.status} · {snapshot().info.size.cols}×{snapshot().info.size.rows} · {owner() === "user" ? "You" : owner()}</p>
    <Show when={snapshot().synchronization !== "synchronized"}><p role="status">Terminal {snapshot().synchronization}: {snapshot().reason ?? "waiting for ordered replay"}</p></Show>
    <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
    <div ref={viewport} class="terminal-inspector__viewport" tabIndex={0} role="group" aria-roledescription="terminal" aria-label={canInput() ? "Terminal input. Press Control+] to return control." : "Terminal output, read-only"} data-input={canInput() ? "on" : "off"}
      onKeyDown={key} onPaste={(event) => { if (!state.canInput()) return; event.preventDefault(); paste(event.clipboardData?.getData("text/plain") ?? "") }}
      onCopy={(event) => { const text = state.selectedText(); if (!text || !event.clipboardData) return; event.preventDefault(); event.clipboardData.setData("text/plain", text) }}
      onWheel={(event) => { const lines = Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / (cell().height || 16))); if (!lines) return; event.preventDefault(); scrollBy(-lines) }}>
      <div ref={grid} class="terminal-inspector__grid" style={{ width: `${snapshot().info.size.cols}ch` }} onMouseDown={select}>
        <For each={rows()}>{(row) => <div class="terminal-inspector__row"><For each={row.runs}>{(run) => <span style={terminalCss(run.style, run.selected)}>{run.text}</span>}</For></div>}</For>
        <Show when={scroll() === 0 && cursor().visible}><span class="terminal-inspector__cursor" aria-hidden="true" style={{ left: `${cursor().x}ch`, top: `calc(${cursor().y} * var(--terminal-line))` }} /></Show>
      </div>
      <span ref={probe} class="terminal-inspector__probe" aria-hidden="true">MMMMMMMMMM</span>
    </div>
    <Show when={scroll() > 0}><p role="status">Viewing scrollback, {scroll()} lines above the live screen.</p></Show>
    <div class="desktop-dialog__actions">
      <Show when={owner() !== "user" && snapshot().synchronization === "synchronized"}><button type="button" class="rl-btn" disabled={busy()} onClick={() => void control("take")}>{busy() ? "Changing control…" : "Take control"}</button></Show>
      <Show when={owner() === "user"}>
        <button type="button" class="rl-btn" disabled={busy()} onClick={() => void control("pause")}>Return control</button>
        <button type="button" class="rl-btn" disabled={busy() || !canInput()} onClick={() => void fit()}>Fit terminal to pane</button>
      </Show>
      <Show when={owner() === "paused" && snapshot().synchronization === "synchronized"}><button type="button" class="rl-btn" disabled={busy()} onClick={() => void control("agent")}>Resume agent</button></Show>
      <Show when={selected()}><button type="button" class="rl-btn" onClick={() => void copySelection()}>Copy selection</button></Show>
      <Show when={scroll() > 0}><button type="button" class="rl-btn" onClick={() => setScroll(0)}>Jump to live output</button></Show>
    </div>
  </section>
}
