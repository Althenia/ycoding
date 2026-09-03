import { createEffect, createMemo, createSignal, For, onCleanup, Show, useContext } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { useData } from "../../context/data"
import { Keymap } from "../../context/keymap"
import { LocalContext } from "../../context/local"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { getGlyph } from "../../ui/glyph"
import { Locale } from "../../util/locale"
import { formatDuration } from "../../util/format"
import { normalizeModelVariant } from "../../model-preference"
import { BrandMark } from "../../component/logo"
import { DOT_TRAIL_FRAMES, Spinner } from "../../component/spinner"

export type SessionHeaderOperationalState =
  // Penpot's resting frame displays the existing working state with its elapsed value.
  | { type: "ready" }
  | { type: "working"; elapsed?: number; startedAt?: number }
  | { type: "thinking"; elapsed?: number; startedAt?: number }
  | { type: "tool-running"; elapsed?: number; startedAt?: number }
  | { type: "waiting"; count: number }
  | { type: "awaiting-input"; count: number; elapsed?: number }
  | { type: "provider-error"; message?: string; code?: number }
  // A retry is two phases with opposite indicator rules. `retry-scheduled` is the backoff worker:
  // the next attempt has not started, so it shows only the countdown to `at` and no animation.
  // `retrying` is the live attempt in progress, which animates and shows no countdown.
  | { type: "retry-scheduled"; attempt: number; at: number }
  | { type: "retrying"; attempt: number }

export type SessionHeaderState =
  | SessionHeaderOperationalState
  | { type: "autonomy"; yolo: number; goalActive: boolean; state: SessionHeaderOperationalState }

type SessionHeaderTimedState = Extract<
  SessionHeaderOperationalState,
  { type: "working" } | { type: "thinking" } | { type: "tool-running" }
>

export type SessionHeaderSegmentKey = "path" | "branch" | "agent" | "model" | "variant"

export type SessionHeaderIdentity = {
  path?: string
  branch?: string
  agent?: string
  model?: string
  variant?: string
  pendingAgent?: string
  pendingModel?: string
  pendingVariant?: string
}

type ResolvedSessionHeaderIdentity = SessionHeaderIdentity & { runningShells?: number }

const SEGMENT_HINT: Partial<Record<SessionHeaderSegmentKey, { command: string; verb: string }>> = {
  path: { command: "session.move", verb: "move" },
  agent: { command: "agent.list", verb: "change" },
  model: { command: "model.list", verb: "change" },
  variant: { command: "variant.cycle", verb: "cycle" },
}

export function headerModelLabel(input: { providerID?: string; modelID?: string; name?: string }) {
  const id = input.modelID ?? input.name ?? ""
  const resolvedName = input.name ?? Locale.titlecase(id.replaceAll("-", " "))
  return input.providerID ? `${input.providerID}/${resolvedName}` : resolvedName
}

/**
 * Truncation ladder from the design contract: ellipsize identifiers and drop them whole rather than
 * shorten status labels; below 120 columns, only working drops its state word.
 */
export function headerSegments(input: SessionHeaderIdentity & { width: number }) {
  const path = input.width >= 120 ? truncatePath(input.path, input.width) : undefined
  const branch = input.width >= 100 ? input.branch : undefined
  const model = input.width >= 120 ? input.model : shortModel(input.model)
  const variant = normalizeModelVariant(input.variant)
  const ordered: Array<[SessionHeaderSegmentKey, string | undefined]> = [
    ["path", path],
    ["branch", branch],
    ["agent", input.agent],
    ["model", model],
    ["variant", variant],
  ]
  return ordered.flatMap(([key, label]) => (label ? [{ key, label }] : []))
}

export function pendingModelVariant(
  current: Pick<SessionHeaderIdentity, "model" | "variant">,
  pending: Pick<SessionHeaderIdentity, "pendingModel" | "pendingVariant">,
) {
  if (!pending.pendingModel) return
  const currentVariant = normalizeModelVariant(current.variant)
  const pendingVariant = normalizeModelVariant(pending.pendingVariant)
  if (current.model === pending.pendingModel && currentVariant === pendingVariant) return
  return `→ ${pending.pendingModel}${pendingVariant ? ` · ${pendingVariant}` : ""}`
}

function pendingAgent(current: string | undefined, pending: string | undefined) {
  return pending && current?.toLocaleLowerCase() !== pending.toLocaleLowerCase() ? `→ ${pending}` : undefined
}

function headerYoloLevel(yolo: unknown): number {
  if (typeof yolo === "number") return yolo
  if (yolo === true) return 2
  return 0
}

export function headerStatusLabel(state: SessionHeaderState, width: number, runningShells?: number, now = Date.now()): string {
  if (state.type === "autonomy") {
    const level = headerYoloLevel(state.yolo)
    let autonomy: string
    if (level > 0 && state.goalActive) autonomy = `YOLO ${level} + Goal · autonomous`
    else if (level > 0) autonomy = `YOLO ${level} · auto-approve`
    else if (state.goalActive) autonomy = "Goal · autonomous"
    else autonomy = "autonomous"
    return `${autonomy} · ${headerStatusLabel(state.state, width, runningShells, now)}`
  }
  if (state.type === "retry-scheduled")
    return `${state.attempt - 1} failed · retry ${state.attempt} · in ${Math.max(0, Math.ceil((state.at - now) / 1_000))}s`
  if (state.type === "retrying") return `retrying · attempt ${state.attempt}`
  if (state.type === "working" || state.type === "thinking" || state.type === "tool-running" || state.type === "awaiting-input") {
    // One rule for every surface: the design writes sub-minute working time with a decimal
    // ("4.1s", "8.4s") and anything longer as "2m14s". formatDuration floors to whole seconds, so
    // it alone cannot express the decimal form.
    const elapsed = state.elapsed === undefined ? undefined : state.elapsed < 60 ? `${state.elapsed.toFixed(1)}s` : formatDuration(state.elapsed)
    if (state.type === "working") return elapsed ? (width < 120 ? elapsed : `cooking ${elapsed}`) : "cooking"
    if (state.type === "thinking") return elapsed ? `thinking · ${elapsed}` : "thinking"
    if (state.type === "tool-running") return elapsed ? `tool running · ${elapsed}` : "tool running"
    return elapsed ? `? awaiting input · ${elapsed}` : "? awaiting input"
  }
  if (state.type === "waiting") return `waiting · ${state.count} subagent${state.count === 1 ? "" : "s"}`
  if (state.type === "provider-error") return "provider error"
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
  const [now, setNow] = createSignal(Date.now())
  const operational = createMemo(() => (props.state.type === "autonomy" ? props.state.state : props.state))
  // `retry-scheduled` is the backoff countdown phase; once `at` is reached the
  // retry is in-flight and should render as `retrying` (spinner, no countdown).
  const effectiveOperational = createMemo<SessionHeaderOperationalState>(() => {
    const current = operational()
    if (current.type === "retry-scheduled" && current.at <= now()) return { type: "retrying", attempt: current.attempt }
    return current
  })
  const timed = createMemo<SessionHeaderTimedState | undefined>(() => {
    const current = operational()
    if (current.type === "working" || current.type === "thinking" || current.type === "tool-running") return current
  })
  createEffect(() => {
    // The shared `now` tick drives the retry countdown and the working/thinking/tool-running elapsed;
    // terminal states (ready/waiting/provider-error/cancelled/completed/failed/lost) freeze elapsed and stop the tick.
    const active = timed()
    const op = operational()
    if (active?.startedAt === undefined && op.type !== "retry-scheduled") return
    setNow(Date.now())
    const interval = op.type === "retry-scheduled" ? 1_000 : 100
    const timer = setInterval(() => setNow(Date.now()), interval)
    onCleanup(() => clearInterval(timer))
  })
  const state = createMemo<SessionHeaderState>(() => {
    const active = timed()
    if (!active?.startedAt) {
      const op = operational()
      const eff = effectiveOperational()
      if (op.type !== eff.type) {
        if (props.state.type === "autonomy") return { ...props.state, state: eff as SessionHeaderOperationalState }
        return eff as SessionHeaderState
      }
      return props.state
    }
    const elapsed = { ...active, elapsed: Math.max(0, (now() - active.startedAt) / 1000) }
    if (props.state.type === "autonomy") return { ...props.state, state: elapsed }
    return elapsed
  })
  const identity = createMemo(() => resolveIdentity(props))
  const pending = createMemo(() => {
    if (props.subagent) return []
    return [
      pendingAgent(identity().agent, props.pendingAgent),
      pendingModelVariant(
        { model: identity().model, variant: identity().variant },
        { pendingModel: props.pendingModel, pendingVariant: props.pendingVariant },
      ),
    ].filter((value): value is string => !!value)
  })
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
    const current = state()
    const active = current.type === "autonomy" ? current.state : current
    if (current.type === "autonomy") return headerYoloLevel(current.yolo) > 0 ? themeV2.text.feedback.error.default : themeV2.text.feedback.success.default
    if (active.type === "provider-error")
      return themeV2.text.feedback.error.default
    if (active.type === "retrying" || active.type === "retry-scheduled")
      return themeV2.text.feedback.warning.default
    if (active.type === "awaiting-input") return themeV2.text.feedback.warning.default
    if (active.type === "tool-running" || active.type === "waiting") return themeV2.text.feedback.info.default
    if (active.type === "working" || active.type === "thinking")
      return props.subagent ? themeV2.text.feedback.info.default : themeV2.text.feedback.success.default
    return themeV2.text.subdued
  })
  // Optional: the header is also mounted standalone by component tests with no LocalProvider.
  const local = useContext(LocalContext)
  const segmentColor = (key: SessionHeaderSegmentKey) => {
    if (key === "path") return themeV2.text.subdued
    if (key === "branch") return themeV2.text.feedback.info.default
    if (key === "model") return themeV2.text.subdued
    if (key === "variant") return themeV2.text.feedback.success.default
    // The agent carries its own configured colour, so the header names it the way every other
    // agent affordance does instead of rendering it as plain default ink.
    if (key === "agent") {
      const agent = local?.agent
        .list()
        .find((item) => item.id === props.agent || item.name === props.agent || Locale.titlecase(item.id) === props.agent)
      if (agent) return local!.agent.color(agent.id)
    }
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
        gap={props.subagent ? 6 : 2}
        paddingLeft={props.subagent ? 3 : 1}
        paddingRight={3}
        height={3}
        flexShrink={0}
        alignItems="center"
        backgroundColor={themeV2.background.chrome}
      >
        <Show
          when={props.subagent}
          fallback={
            <box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
              <BrandMark width={2} height={1} />
              <text fg={themeV2.text.subdued} wrapMode="none">v{InstallationVersion}</text>
            </box>
          }
        >
          <text fg={themeV2.text.feedback.info.default} wrapMode="none">
            {getGlyph("subagent").glyph} subagent
          </text>
        </Show>
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
          <For each={pending()}>{(value) => <span style={{ fg: themeV2.text.subdued }}> {"·"} {value}</span>}</For>
        </text>
        <box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
          <Show when={(effectiveOperational().type === "working" && !props.subagent) || effectiveOperational().type === "retrying"}>
            <Spinner color={statusColor()} frames={DOT_TRAIL_FRAMES} interval={160} />
          </Show>
          <text fg={statusColor()} wrapMode="none">
            {headerStatusLabel(state(), dimensions().width, identity().runningShells, now())}
          </text>
        </box>
      </box>
    </>
  )
}

function resolveIdentity(props: SessionHeaderIdentity): ResolvedSessionHeaderIdentity {
  if (props.agent && props.model && props.variant) return { ...props, variant: normalizeModelVariant(props.variant) }
  const route = useRoute().data
  const data = useData()
  if (route.type === "home") {
    return { ...props, variant: normalizeModelVariant(props.variant) }
  }
  if (route.type !== "session") return { ...props, variant: normalizeModelVariant(props.variant) }
  const session = data.session.get(route.sessionID)
  const sessionModel = session?.model
  if (!session || !sessionModel) return { ...props, variant: normalizeModelVariant(props.variant) }
  const model = data.location
    .model
    .list(session.location)
    ?.find((item) => item.providerID === sessionModel.providerID && item.id === sessionModel.id)
  const modelLabel = headerModelLabel({ providerID: model?.providerID ?? sessionModel.providerID, modelID: sessionModel.id, name: model?.name })
  return {
    ...props,
    agent: props.agent ?? (session.agent ? Locale.titlecase(session.agent) : undefined),
    model: props.model ?? modelLabel,
    variant: normalizeModelVariant(props.variant ?? sessionModel.variant),
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
  return value
}
