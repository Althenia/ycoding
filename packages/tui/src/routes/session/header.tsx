import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useData } from "../../context/data"
import { Keymap } from "../../context/keymap"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { header } from "../../logo"
import { getGlyph } from "../../ui/glyph"
import { Locale } from "../../util/locale"
import { formatDuration } from "../../util/format"

export type SessionHeaderState =
  // Penpot's resting frame displays the existing working state with its elapsed value.
  | { type: "ready" }
  | { type: "working"; elapsed: number }
  | { type: "awaiting-input"; count: number; elapsed?: number }
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

type ResolvedSessionHeaderIdentity = SessionHeaderIdentity & { runningShells?: number }

const SEGMENT_HINT: Partial<Record<SessionHeaderSegmentKey, { command: string; verb: string }>> = {
  path: { command: "session.move", verb: "move" },
  agent: { command: "agent.list", verb: "change" },
  model: { command: "model.list", verb: "change" },
  variant: { command: "variant.cycle", verb: "cycle" },
}

/**
 * Truncation ladder from the design contract: ellipsize identifiers and drop them whole rather than
 * shorten status labels; below 120 columns, only working drops its state word.
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

export function headerStatusLabel(state: SessionHeaderState, width: number, runningShells?: number, subagent = false) {
  if (state.type === "working" || state.type === "awaiting-input") {
    // One rule for every surface: the design writes sub-minute working time with a decimal
    // ("4.1s", "8.4s") and anything longer as "2m14s". formatDuration floors to whole seconds, so
    // it alone cannot express the decimal form.
    const elapsed = state.elapsed === undefined ? undefined : state.elapsed < 60 ? `${state.elapsed.toFixed(1)}s` : formatDuration(state.elapsed)
    if (state.type === "working") return width < 120 ? elapsed : `working ${elapsed}`
    return elapsed ? `? awaiting input · ${elapsed}` : "? awaiting input"
  }
  if (state.type === "provider-error") return state.code ? `provider error \u00b7 ${state.code}` : "provider error"
  if (state.type === "yolo") return "YOLO \u00b7 auto-approve"
  if (runningShells) return `${runningShells} shell${runningShells === 1 ? "" : "s"} running`
  return "ready"
}

export function Header(
  props: SessionHeaderIdentity & { state: SessionHeaderState; focused?: SessionHeaderSegmentKey; subagent?: boolean },
) {
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()
  const shortcuts = Keymap.useShortcuts()
  const leaderActive = Keymap.useLeaderActive()
  const identity = createMemo(() => resolveIdentity(props))
  const segments = createMemo(() =>
    headerSegments({
      width: dimensions().width,
      path: identity().path,
      branch: identity().branch,
      agent: identity().agent,
      model: identity().model,
      variant: identity().variant,
    }),
  )
  const statusColor = createMemo(() => {
    if (props.state.type === "provider-error" || props.state.type === "yolo")
      return themeV2.text.feedback.error.default
    if (props.state.type === "awaiting-input") return themeV2.text.feedback.warning.default
    if (props.state.type === "working")
      return props.subagent ? themeV2.text.feedback.info.default : themeV2.text.feedback.success.default
    return themeV2.text.subdued
  })
  const segmentColor = (key: SessionHeaderSegmentKey) => {
    if (key === "path") return themeV2.text.subdued
    if (key === "branch") return themeV2.text.feedback.info.default
    if (key === "variant") return themeV2.text.feedback.success.default
    // The branch is info by default, so focused segments retain their roles instead of impersonating it.
    return themeV2.text.default
  }
  const hint = (key: SessionHeaderSegmentKey) => {
    const value = SEGMENT_HINT[key]
    if (!value) return undefined
    const shortcut = shortcuts.get(value.command)
    if (!shortcut) return undefined
    return `${shortcut.replaceAll("ctrl+", "\u2303")} ${value.verb}`
  }
  const showHint = (key: SessionHeaderSegmentKey) => (props.focused ? props.focused === key : leaderActive())

  return (
    <>
      <box
        flexDirection="row"
        gap={6}
        paddingLeft={3}
        paddingRight={3}
        height={3}
        flexShrink={0}
        alignItems="center"
        backgroundColor={themeV2.background.chrome}
      >
        <text fg={props.subagent ? themeV2.text.feedback.info.default : themeV2.text.feedback.success.default} wrapMode="none">
          {props.subagent ? `${getGlyph("subagent").glyph} subagent` : header}
        </text>
        <text flexGrow={1} wrapMode="none">
          <For each={segments()}>
            {(segment, index) => (
              <>
                <Show when={index() > 0}>
                  <span style={{ fg: themeV2.text.separator }}> {"\u00b7"} </span>
                </Show>
                <span
                  style={{
                    fg: segmentColor(segment.key),
                    bg: showHint(segment.key) ? themeV2.background.surface.overlay : undefined,
                  }}
                >
                  {segment.label}
                </span>
                <Show when={showHint(segment.key) && hint(segment.key)}>
                  {(value) => <span style={{ fg: themeV2.text.label }}> {value()}</span>}
                </Show>
              </>
            )}
          </For>
        </text>
        <text fg={statusColor()} wrapMode="none" flexShrink={0}>
          {headerStatusLabel(props.state, dimensions().width, identity().runningShells, props.subagent)}
        </text>
      </box>
      <Show when={props.state.type === "yolo"}>
        <box height={1} width="100%" flexShrink={0} backgroundColor={themeV2.background.action.destructive.default} />
      </Show>
    </>
  )
}

function resolveIdentity(props: SessionHeaderIdentity): ResolvedSessionHeaderIdentity {
  if (props.agent && props.model && props.variant) return props
  const route = useRoute().data
  const data = useData()
  if (route.type === "home") {
    const model = data.location.model.list(data.location.default())?.find((item) => item.name === props.model)
    return { ...props, variant: props.variant ?? model?.variants.at(0)?.id }
  }
  if (route.type !== "session") return props
  const session = data.session.get(route.sessionID)
  const sessionModel = session?.model
  if (!session || !sessionModel) return props
  const model = data.location
    .model
    .list(session.location)
    ?.find((item) => item.providerID === sessionModel.providerID && item.id === sessionModel.id)
  return {
    ...props,
    agent: props.agent ?? (session.agent ? Locale.titlecase(session.agent) : undefined),
    model: props.model ?? model?.name ?? Locale.titlecase(sessionModel.id.replaceAll("-", " ")),
    variant: props.variant ?? sessionModel.variant,
    runningShells: data.shell.list(session.location).filter((shell) => shell.status === "running").length,
  }
}

function truncatePath(value: string | undefined, width: number) {
  if (!value) return undefined
  const home = process.env.HOME
  const display = home && value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value
  if (width >= 160) return display
  const parts = display.split("/").filter(Boolean)
  if (width >= 140) return parts.slice(-2).join("/")
  return parts.at(-1)
}

function shortModel(value: string | undefined) {
  return value?.split("/").at(-1)
}
