import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import { header } from "../../logo"

export type SessionHeaderState =
  | { type: "ready" }
  | { type: "working"; elapsed: number }
  | { type: "awaiting-input"; count: number }
  | { type: "provider-error"; code?: number }
  | { type: "yolo" }

export type SessionHeaderSegmentKey = "path" | "branch" | "agent" | "model" | "variant"

export type SessionHeaderIdentity = {
  path?: string
  branch?: string
  agent?: string
  model?: string
  variant?: string
}

const SEGMENT_HINT: Partial<Record<SessionHeaderSegmentKey, string>> = {
  path: "\u2303x u move",
  agent: "\u2303x a change",
  model: "\u2303x m change",
  variant: "\u2303t cycle",
}

/**
 * Truncation ladder from the design contract: ellipsize identifiers and drop them whole rather than
 * shrink a state word, because a truncated state word reads as a different state.
 */
export function headerSegments(input: SessionHeaderIdentity & { width: number }) {
  const path = input.width >= 120 ? truncatePath(input.path, input.width) : undefined
  const branch = input.width >= 100 ? input.branch : undefined
  const model = input.width >= 120 ? input.model : shortModel(input.model)
  const ordered: Array<[SessionHeaderSegmentKey, string | undefined]> = [
    ["path", path],
    ["branch", branch],
    ["agent", input.agent],
    ["model", model],
    ["variant", input.variant],
  ]
  return ordered.flatMap(([key, label]) => (label ? [{ key, label }] : []))
}

export function headerStatusLabel(state: SessionHeaderState) {
  if (state.type === "working") return `working ${state.elapsed.toFixed(1)}s`
  if (state.type === "awaiting-input")
    return `${state.count} subagent${state.count > 1 ? "s" : ""} awaiting input`
  if (state.type === "provider-error") return state.code ? `provider error \u00b7 ${state.code}` : "provider error"
  if (state.type === "yolo") return "YOLO \u00b7 auto-approve"
  return "ready"
}

export function Header(props: SessionHeaderIdentity & { state: SessionHeaderState; focused?: SessionHeaderSegmentKey }) {
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()
  const segments = createMemo(() =>
    headerSegments({
      width: dimensions().width,
      path: props.path,
      branch: props.branch,
      agent: props.agent,
      model: props.model,
      variant: props.variant,
    }),
  )
  const statusColor = createMemo(() => {
    if (props.state.type === "provider-error" || props.state.type === "yolo")
      return themeV2.text.feedback.error.default
    if (props.state.type === "awaiting-input") return themeV2.text.feedback.warning.default
    if (props.state.type === "working") return themeV2.text.feedback.info.default
    return themeV2.text.subdued
  })

  return (
    <>
      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} flexShrink={0}>
        <text fg={themeV2.text.feedback.success.default} wrapMode="none">
          {header}
        </text>
        <text flexGrow={1} wrapMode="none">
          <For each={segments()}>
            {(segment, index) => (
              <>
                <Show when={index() > 0}>
                  <span style={{ fg: themeV2.text.subdued }}> {"\u00b7"} </span>
                </Show>
                <span
                  style={{
                    fg: props.focused === segment.key ? themeV2.text.feedback.info.default : themeV2.text.default,
                  }}
                >
                  {segment.label}
                </span>
                <Show when={props.focused === segment.key && SEGMENT_HINT[segment.key]}>
                  <span style={{ fg: themeV2.text.subdued }}> {SEGMENT_HINT[segment.key]}</span>
                </Show>
              </>
            )}
          </For>
        </text>
        <text fg={statusColor()} wrapMode="none" flexShrink={0}>
          {headerStatusLabel(props.state)}
        </text>
      </box>
      <Show when={props.state.type === "yolo"}>
        <box paddingLeft={2} paddingRight={2} flexShrink={0}>
          <text fg={themeV2.text.feedback.error.default} wrapMode="none">
            {"\u2500".repeat(Math.max(1, dimensions().width - 4))}
          </text>
        </box>
      </Show>
    </>
  )
}

function truncatePath(value: string | undefined, width: number) {
  if (!value) return undefined
  if (width >= 160) return value
  const parts = value.split("/").filter(Boolean)
  if (width >= 140) return parts.slice(-2).join("/")
  return parts.at(-1)
}

function shortModel(value: string | undefined) {
  return value?.split("/").at(-1)
}
