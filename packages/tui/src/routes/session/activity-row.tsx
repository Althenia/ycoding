import { BoxRenderable, ScrollBoxRenderable, type RGBA } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { SPINNER_FRAMES } from "../../component/spinner-frames"
import { useConfigOptional } from "../../config"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { stringWidth } from "../../util/string-width"
import type { SessionRow } from "./rows"

type ActivityRow = Extract<SessionRow, { type: "guardrail" | "subagent" | "task" }>

export type ToolLifecycleInput = {
  status: "streaming" | "running" | "completed" | "error"
  time: { created?: number; ran?: number; completed?: number }
  error?: { type?: string; message?: string }
  failed?: boolean
  cancelled?: boolean
  summary?: string
  now?: number
}

export type ToolLifecyclePresentation = {
  label: "pending" | "running" | "done" | "failed" | "cancelled"
  status: string
  variant: "pending" | "running" | "success" | "error" | "warning"
  active: boolean
  duration?: string
}

export function toolLifecyclePresentation(input: ToolLifecycleInput): ToolLifecyclePresentation {
  const cancelled = input.cancelled === true || isCancelledToolError(input.error)
  const failed = input.failed === true || (input.status === "error" && !cancelled)
  const label =
    input.status === "streaming"
      ? "pending"
      : input.status === "running"
        ? "running"
        : cancelled
          ? "cancelled"
          : failed
            ? "failed"
            : "done"
  const variant =
    label === "pending"
      ? "pending"
      : label === "running"
        ? "running"
        : label === "cancelled"
          ? "warning"
          : label === "failed"
            ? "error"
            : "success"
  const start = validTimestamp(input.status === "streaming" ? input.time.created : (input.time.ran ?? input.time.created))
  const terminal = input.status === "completed" || input.status === "error"
  const end = validTimestamp(terminal ? input.time.completed : (input.now ?? Date.now()))
  const duration = start !== undefined && end !== undefined && end >= start ? Locale.duration(end - start) : undefined
  const summary = input.summary?.trim()
  const status = [label, summary && summary !== label ? summary : undefined, duration].filter(Boolean).join(" · ")
  return {
    label,
    status,
    variant,
    active: label === "pending" || label === "running",
    ...(duration === undefined ? {} : { duration }),
  }
}

function validTimestamp(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isCancelledToolError(error: ToolLifecycleInput["error"]) {
  if (!error) return false
  return /abort|cancel|interrupt|kill/.test(`${error.type ?? ""} ${error.message ?? ""}`.toLowerCase())
}

export function ToolLifecycleStatus(props: { lifecycle: ToolLifecycleInput }) {
  const { themeV2 } = useTheme()
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (props.lifecycle.status !== "streaming" && props.lifecycle.status !== "running") return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })
  const presentation = createMemo(() => toolLifecyclePresentation({ ...props.lifecycle, now: now() }))
  const color = createMemo(() => {
    if (presentation().variant === "error") return themeV2.text.feedback.error.default
    if (presentation().variant === "warning") return themeV2.text.feedback.warning.default
    return themeV2.text.subdued
  })
  return <text flexShrink={0} fg={color()}>{presentation().status}</text>
}

export function SessionActivityRow(props: {
  row: ActivityRow
  /** Whether the Session is executing. An idle Session must not animate a live indicator. */
  running?: boolean
  width?: number
  onGuardrail?: (requestID: string) => void
  onSubagent?: (sessionID: string) => void
}) {
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()
  // A todo stays in_progress after the Session goes idle, so the row's own status cannot drive the
  // spinner: it kept animating on an idle Session and read as stuck work.
  const running = () =>
    props.row.type === "subagent" ||
    (props.row.type === "task" && props.row.status === "in_progress" && props.running === true)
  const markerColor = () => {
    if (props.row.type === "guardrail") return themeV2.text.feedback.warning.default
    if (props.row.type === "subagent") return themeV2.text.feedback.info.default
    if (props.row.status === "completed") return themeV2.text.feedback.success.default
    return themeV2.text.feedback.info.default
  }
  const statusColor = () => {
    if (props.row.type === "guardrail") return themeV2.text.feedback.warning.default
    if (props.row.type === "subagent") return themeV2.text.feedback.info.default
    if (props.row.status === "completed") return themeV2.text.subdued
    return themeV2.text.feedback.success.default
  }
  const open = () => {
    if (props.row.type === "guardrail") props.onGuardrail?.(props.row.requestID)
    if (props.row.type === "subagent") props.onSubagent?.(props.row.sessionID)
  }
  const status = () => {
    if (props.row.type === "guardrail") return "needs approval"
    if (props.row.type === "subagent")
      return `running ${Locale.duration(Math.max(0, Date.now() - props.row.created))} · ↓ open`
    return props.row.status === "completed" ? "done" : "active"
  }
  const label = () => {
    if (props.row.type === "guardrail") return `guardrail · ${props.row.reason}`
    if (props.row.type === "subagent") return `subagent ${props.row.agent}`
    return props.row.content
  }
  const labelWidth = () =>
    Math.max(1, (props.width ?? dimensions().width) - 1 - 2 - 5 - 1 - stringWidth(status()))

  return (
    <box
      width={props.width ?? "100%"}
      flexDirection="column"
      paddingLeft={1}
      onMouseUp={open}
    >
      <box width="100%" border={["top"]} borderColor={themeV2.border.default} flexDirection="row">
        <text width={2} flexShrink={0} fg={markerColor()}>
          {props.row.type === "guardrail"
            ? "!!"
            : props.row.type === "subagent"
              ? "◦"
              : props.row.status === "completed"
                ? "ok"
                : ".."}
        </text>
        <SessionActivitySpacer running={running()} color={markerColor()} />
        <text
          width={labelWidth()}
          flexShrink={1}
          wrapMode="none"
          truncate={true}
          fg={themeV2.text.default}
        >
          {label()}
        </text>
        <box flexGrow={1} />
        <text flexShrink={0} fg={statusColor()}>{status()}</text>
      </box>
    </box>
  )
}

export function SessionToolActivityRow(props: {
  tool: string
  detail: string
  status?: string
  width?: number
  variant?: "success" | "error" | "running" | "pending" | "warning" | "subagent"
  lifecycle?: ToolLifecycleInput
  details?: { request: string[]; response: string[] }
}) {
  const { themeV2 } = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [expanded, setExpanded] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (props.lifecycle?.status !== "streaming" && props.lifecycle?.status !== "running") return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })
  const lifecycle = createMemo(() =>
    props.lifecycle ? toolLifecyclePresentation({ ...props.lifecycle, now: now() }) : undefined,
  )
  const variant = createMemo(() =>
    props.variant === "subagent" && lifecycle()?.label === "done" ? "subagent" : (lifecycle()?.variant ?? props.variant),
  )
  const active = createMemo(() => variant() === "running" || variant() === "pending")
  const expandable = createMemo(() => Boolean(props.details?.request.length || props.details?.response.length))
  const detailHeight = createMemo(() => Math.max(4, Math.min(12, Math.floor(dimensions().height / 3))))
  const marker = createMemo(() => {
    if (variant() === "error" || variant() === "warning") return "!!"
    if (active()) return ".."
    if (variant() === "subagent") return "◦"
    return "ok"
  })
  const color = createMemo(() => {
    if (variant() === "error") return themeV2.text.feedback.error.default
    if (variant() === "warning") return themeV2.text.feedback.warning.default
    if (active() || variant() === "subagent") return themeV2.text.feedback.info.default
    return themeV2.text.feedback.success.default
  })
  const label = createMemo(() => `${props.tool}${props.detail ? ` ${props.detail}` : ""}`)
  const status = createMemo(() => lifecycle()?.status ?? props.status ?? "")
  const labelWidth = createMemo(() =>
    Math.max(1, (props.width ?? dimensions().width) - 1 - 2 - 5 - 1 - stringWidth(status())),
  )
  let row: BoxRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  const toggle = () => {
    if (!expandable() || renderer.getSelection()?.getSelectedText()) return
    setExpanded((value) => !value)
  }
  const onKeyDown = (key: { name: string }) => {
    if (key.name === "return" || key.name === "space") return toggle()
    if (!expanded()) return
    if (key.name === "up") return scroll?.scrollBy(-1)
    if (key.name === "down") return scroll?.scrollBy(1)
    if (key.name === "pageup") return scroll?.scrollBy(-detailHeight())
    if (key.name === "pagedown") return scroll?.scrollBy(detailHeight())
    if (key.name === "home") return scroll?.scrollTo(0)
    if (key.name === "end" && scroll) return scroll.scrollTo(scroll.scrollHeight)
  }

  return (
    <box
      ref={(element: BoxRenderable) => (row = element)}
      width={props.width ?? "100%"}
      flexDirection="column"
      paddingLeft={1}
      focusable={expandable()}
      onMouseDown={() => row?.focus()}
      onMouseUp={toggle}
      onKeyDown={onKeyDown}
    >
      <box width="100%" border={["top"]} borderColor={themeV2.border.default} flexDirection="row">
        <text width={2} flexShrink={0} fg={color()}>{marker()}</text>
        <SessionActivitySpacer running={active()} color={color()} />
        <text
          width={labelWidth()}
          flexShrink={1}
          wrapMode="none"
          truncate={true}
          fg={themeV2.text.default}
        >
          {label()}
        </text>
        <box flexGrow={1} />
        <text flexShrink={0} fg={variant() === "error" || variant() === "warning" ? color() : themeV2.text.subdued}>
          {status()}
        </text>
      </box>
      <Show when={expanded() && props.details}>
        {(details) => (
          <scrollbox
            ref={(element: ScrollBoxRenderable) => (scroll = element)}
            maxHeight={detailHeight()}
            paddingLeft={7}
            paddingTop={1}
            scrollbarOptions={{ visible: false }}
          >
            <Show when={details().request.length > 0}>
              <text fg={themeV2.text.label}>− Request</text>
              <For each={details().request}>{(line) => <text fg={themeV2.text.subdued} wrapMode="word">  {line}</text>}</For>
            </Show>
            <Show when={details().response.length > 0}>
              <text fg={themeV2.text.label}>− Response</text>
              <For each={details().response}>{(line) => <text fg={themeV2.text.subdued} wrapMode="word">  {line}</text>}</For>
            </Show>
          </scrollbox>
        )}
      </Show>
    </box>
  )
}

export function SessionActivitySpacer(props: { running: boolean; color?: RGBA }) {
  // Optional: this spacer is also mounted by component tests that provide no ConfigProvider.
  const config = useConfigOptional()?.data
  return (
    <box width={5} flexShrink={0} flexDirection="row">
      <Show when={props.running}>
        <Show when={config?.animations ?? true} fallback={<text fg={props.color}>⋯</text>}>
          <spinner frames={SPINNER_FRAMES} interval={80} color={props.color} />
        </Show>
      </Show>
    </box>
  )
}
