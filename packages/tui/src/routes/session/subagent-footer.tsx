import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import type { SessionCacheDiagnostics, SessionInfo, SessionOrchestrationTask } from "@ycoding-ai/client"
import { useRoute, useRouteData } from "../../context/route"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { Locale } from "../../util/locale"
import { useTerminalDimensions } from "@opentui/solid"
import { formatCacheDiagnostics, formatDiagnosticsModel } from "../../util/cache-diagnostics"
import { Keymap } from "../../context/keymap"

export function subagentSiblingSessionIDs(tasks: ReadonlyArray<SessionOrchestrationTask>) {
  return [...tasks]
    .toSorted((left, right) => {
      const created = left.time.created - right.time.created
      if (created !== 0) return created
      return left.sessionID.localeCompare(right.sessionID)
    })
    .map((task) => task.sessionID)
}

export function subagentSiblingSessionID(
  tasks: ReadonlyArray<SessionOrchestrationTask>,
  currentSessionID: string,
  direction: -1 | 1,
) {
  const siblings = subagentSiblingSessionIDs(tasks)
  const current = siblings.indexOf(currentSessionID)
  if (current < 0 || siblings.length < 2) return undefined
  return siblings[(current + direction + siblings.length) % siblings.length]
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

type SubagentFooterUsage = {
  model?: string
  context?: string
  cache?: string
  cost?: string
}

export type SubagentEconomics = {
  summary?: string
  strip: readonly string[]
  context?: string
  cacheHit?: string
  prefix?: string
  reads?: string
  writes?: string
  spent?: string
  rollsUpTo?: string
}

function totalTokens(session: Pick<SessionInfo, "tokens">) {
  return session.tokens.input + session.tokens.output + session.tokens.reasoning + session.tokens.cache.read + session.tokens.cache.write
}

export function subagentEconomics(
  session: Pick<SessionInfo, "cost" | "tokens"> | undefined,
  diagnostics: SessionCacheDiagnostics | null | undefined,
  parentTitle: string | undefined,
): SubagentEconomics | undefined {
  if (!session) return undefined
  const tokens = totalTokens(session)
  const cacheHit = diagnostics?.cache.hitRatio === undefined ? undefined : `${Math.round(diagnostics.cache.hitRatio * 100)}%`
  const hit = cacheHit === undefined ? undefined : `${cacheHit} hit`
  const context = diagnostics
    ? `${compactNumber(diagnostics.context.total)} / ${diagnostics.context.limit === undefined ? "unreported" : compactNumber(diagnostics.context.limit)}${diagnostics.context.percent === undefined ? "" : ` · ${diagnostics.context.percent}%`}`
    : undefined
  const prefix = diagnostics?.requests?.latestInvalidation === "stable-hit" ? "stable" : undefined
  const reads = diagnostics?.cache.readReported ? number(diagnostics.tokens.cacheRead) : undefined
  const writes = diagnostics?.cache.writeReported ? number(diagnostics.tokens.cacheWrite) : undefined
  const spent = session.cost > 0 ? money.format(session.cost) : undefined
  const summary = [
    tokens > 0 ? `${Locale.number(tokens)}${diagnostics?.context.percent === undefined ? "" : ` (${diagnostics.context.percent}%)`}` : undefined,
    hit,
    spent,
  ]
    .filter(Boolean)
    .join(" · ")
  const strip = [
    context ? `Context ${context}` : undefined,
    diagnostics && !hit ? "hit unreported" : undefined,
    prefix ? `prefix ${prefix}` : undefined,
    diagnostics ? (reads ? `${reads} read` : "read unreported") : undefined,
    diagnostics ? (writes ? `${writes} write` : "write unreported") : undefined,
    spent,
    parentTitle ? `rolls up to ${parentTitle}` : undefined,
  ].filter((value): value is string => Boolean(value))
  if (!summary && strip.length === 0) return undefined
  return {
    summary: summary || undefined,
    strip,
    context,
    cacheHit,
    prefix,
    reads,
    writes,
    spent,
    rollsUpTo: parentTitle,
  }
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

function number(value: number) {
  return new Intl.NumberFormat("en-US").format(value)
}

export function subagentSiblingEconomics(session: Pick<SessionInfo, "cost" | "tokens"> | undefined) {
  if (!session) return undefined
  const tokens = totalTokens(session)
  const output = [session.cost > 0 ? money.format(session.cost) : undefined, tokens > 0 ? Locale.number(tokens) : undefined]
    .filter(Boolean)
    .join(" · ")
  return output || undefined
}

export function subagentFooterData(
  session: Pick<SessionInfo, "agent" | "model" | "cost"> | undefined,
  diagnostics: SessionCacheDiagnostics | null | undefined,
) {
  const formatted = diagnostics ? formatCacheDiagnostics(diagnostics) : undefined
  return {
    title: session?.agent ? Locale.titlecase(session.agent) : "Subagent",
    usage: session
      ? {
          model: formatted?.model ?? formatDiagnosticsModel(session.model),
          context: formatted?.context,
          cache: formatted?.cache,
          cost: session.cost > 0 ? money.format(session.cost) : undefined,
        }
      : undefined,
  }
}

export function SubagentFooterContent(props: {
  title: string
  usage: () => SubagentFooterUsage | undefined
  parentTitle?: string
  siblings?: ReadonlyArray<SessionOrchestrationTask>
  currentSessionID?: string
  onNavigate?: (sessionID: string) => void
  economics?: SubagentEconomics
  siblingEconomics?: Readonly<Record<string, string | undefined>>
  blocked?: boolean
}) {
  const { themeV2 } = useTheme().contextual("elevated")
  const keymap = Keymap.use()
  const shortcuts = Keymap.useShortcuts()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 60)
  const siblings = createMemo(() => props.siblings ?? [])
  const currentTask = createMemo(() => siblings().find((task) => task.sessionID === props.currentSessionID))
  const borderColor = createMemo(() => props.blocked ? themeV2.text.feedback.warning.default : themeV2.border.default)

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={borderColor()}
        flexShrink={0}
        backgroundColor={themeV2.background.default}
      >
        <box flexDirection="row" flexWrap="wrap" justifyContent="space-between" gap={1}>
          <box flexDirection="row" flexWrap="wrap" gap={1} flexGrow={1} minWidth={0}>
            <text fg={props.blocked ? themeV2.text.feedback.warning.default : themeV2.text.default}>
              <b>{props.title}</b>
            </text>
            <Show when={props.usage()}>
              {(item) => (
                <box flexDirection="column" minWidth={0} flexGrow={1}>
                  <text fg={themeV2.text.subdued} wrapMode="none">
                    {[item().model, item().context, item().cache, item().cost].filter(Boolean).join(" · ")}
                  </text>
                </box>
              )}
            </Show>
            <Show when={props.economics?.summary}>
              {(summary) => <text fg={themeV2.text.default} wrapMode="none">{summary()}</text>}
            </Show>
          </box>
          <Show when={props.economics?.strip.length}>
            <box flexDirection="row" flexWrap="wrap" gap={1} flexShrink={1} minWidth={0}>
              <For each={props.economics?.strip}>{(item) => <text fg={themeV2.text.subdued} wrapMode="none">{item}</text>}</For>
            </box>
          </Show>
          <Show when={currentTask()?.question?.text}>
            {(question) => (
              <text fg={themeV2.text.feedback.warning.default} wrapMode="none">
                ? {question()}
              </text>
            )}
          </Show>
          <Show when={siblings().length > 0}>
            <box flexDirection="row" flexWrap="wrap" gap={1}>
              <box
                onMouseUp={() => keymap.dispatch("session.parent")}
                backgroundColor={themeV2.background.default}
              >
                <text fg={themeV2.text.action.primary.default} wrapMode="none">
                  ↑ {props.parentTitle ?? "Parent"}
                </text>
              </box>
              <For each={siblings()}>
                {(task) => {
                  const attached = () => task.sessionID === props.currentSessionID
                  return (
                    <box
                      onMouseUp={() => props.onNavigate?.(task.sessionID)}
                      backgroundColor={
                        attached() ? themeV2.background.action.primary.focused : themeV2.background.default
                      }
                    >
                      <text
                        fg={attached() ? themeV2.text.action.primary.focused : themeV2.text.feedback.info.default}
                        wrapMode="none"
                      >
                        <Show when={task.question?.text}>
                          <span style={{ fg: themeV2.text.feedback.warning.default }}>? </span>
                        </Show>
                        ◦ {Locale.titlecase(task.agent)}
                        <Show when={props.siblingEconomics?.[task.sessionID]}>
                          {(economics) => <span style={{ fg: themeV2.text.subdued }}> {economics()}</span>}
                        </Show>
                        <Show when={formatDiagnosticsModel(task.model)}>
                          {(model) => <span style={{ fg: themeV2.text.subdued }}> · {model()}</span>}
                        </Show>
                      </text>
                    </box>
                  )
                }}
              </For>
            </box>
          </Show>
          <box flexDirection="row" flexWrap="wrap" justifyContent="flex-end" gap={1} flexShrink={0}>
            <box
              onMouseOver={() => setHover("parent")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatch("session.parent")}
              backgroundColor={
                hover() === "parent" ? themeV2.background.action.primary.hovered : themeV2.background.default
              }
            >
              <text fg={themeV2.text.default}>
                {compact() ? "↖" : "Parent"}{" "}
                <span style={{ fg: themeV2.text.subdued }}>{shortcuts.get("session.parent")}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("prev")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatch("session.child.previous")}
              backgroundColor={
                hover() === "prev" ? themeV2.background.action.primary.hovered : themeV2.background.default
              }
            >
              <text fg={themeV2.text.default}>
                {compact() ? "←" : `${siblings().findIndex((task) => task.sessionID === props.currentSessionID) + 1}/${siblings().length} ←`}{" "}
                <span style={{ fg: themeV2.text.subdued }}>{shortcuts.get("session.child.previous")}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("next")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatch("session.child.next")}
              backgroundColor={
                hover() === "next" ? themeV2.background.action.primary.hovered : themeV2.background.default
              }
            >
              <text fg={themeV2.text.default}>
                {compact() ? "→" : "→"}{" "}
                <span style={{ fg: themeV2.text.subdued }}>{shortcuts.get("session.child.next")}</span>
              </text>
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}

export function SubagentFooter() {
  const route = useRouteData("session")
  const navigation = useRoute()
  const data = useData()
  const session = createMemo(() => data.session.get(route.sessionID))
  const parentID = createMemo(() => session()?.parentID)
  const siblings = createMemo(() => {
    const parent = parentID()
    if (!parent) return []
    const tasks = data.session.subagent.list(parent)
    return subagentSiblingSessionIDs(tasks).flatMap((id) => tasks.find((task) => task.sessionID === id) ?? [])
  })
  const parent = createMemo(() => (parentID() ? data.session.get(parentID()!) : undefined))

  createEffect(
    on(
      () => route.sessionID,
      (sessionID) => void data.session.diagnostics.sync(sessionID).catch(() => undefined),
    ),
  )
  createEffect(() => {
    const id = parentID()
    if (!id) return
    void data.session.subagent.sync(id).catch(() => undefined)
  })
  createEffect(() => {
    siblings().forEach((task) => {
      if (data.session.get(task.sessionID)) return
      void data.session.sync(task.sessionID).catch(() => undefined)
    })
  })

  const economics = createMemo(() => subagentEconomics(session(), data.session.diagnostics.get(route.sessionID), parent()?.title))
  const currentTask = createMemo(() => siblings().find((task) => task.sessionID === route.sessionID))
  const current = createMemo(() => siblings().findIndex((task) => task.sessionID === route.sessionID) + 1)
  const agent = createMemo(() => currentTask()?.agent ?? "subagent")
  const context = createMemo(() => {
    const [total, percent] = economics()?.context?.split(" · ") ?? []
    if (!total || !percent) return undefined
    return `${total.split(" / ")[0]} (${percent})`
  })
  const blocked = createMemo(() => currentTask()?.state === "waiting" && Boolean(currentTask()?.question))
  const { themeV2 } = useTheme().contextual("elevated")

  return (
    <box height={2} paddingLeft={3} paddingRight={3} alignItems="flex-start" flexDirection="row" flexShrink={0}>
      <Show
        when={blocked()}
        fallback={
          <>
            <box width={21} flexShrink={0}>
              <text fg={themeV2.text.default} wrapMode="none">{agent()} ({current()} of {siblings().length})</text>
            </box>
            <box width={13} flexShrink={0}>
              <text fg={themeV2.text.subdued} wrapMode="none">{context()}</text>
            </box>
            <box width={10} flexShrink={0}>
              <text fg={themeV2.text.subdued} wrapMode="none">{economics()?.cacheHit} hit</text>
            </box>
            <box flexShrink={0}>
              <text fg={themeV2.text.subdued} wrapMode="none">{economics()?.spent} · durable · resumable</text>
            </box>
            <box flexGrow={1} />
            <text fg={themeV2.text.action.primary.default} wrapMode="none" onMouseUp={() => {
              const sibling = subagentSiblingSessionID(siblings(), route.sessionID, 1)
              if (sibling) navigation.navigate({ type: "session", sessionID: sibling })
            }}>→ next</text>
          </>
        }
      >
        <>
          <box width={23} flexShrink={0}>
            <text fg={themeV2.text.default} wrapMode="none">{agent()} ({current()} of {siblings().length})</text>
          </box>
          <box width={14} flexShrink={0}>
            <text fg={themeV2.text.subdued} wrapMode="none">{context()}</text>
          </box>
          <box width={10} flexShrink={0}>
            <text fg={themeV2.text.subdued} wrapMode="none">{economics()?.cacheHit} hit</text>
          </box>
          <box width={8} flexShrink={0}>
            <text fg={themeV2.text.subdued} wrapMode="none">{economics()?.spent}</text>
          </box>
          <text fg={themeV2.text.feedback.warning.default} wrapMode="none">awaiting input</text>
          <box flexGrow={1} />
          <text fg={themeV2.text.action.primary.default} wrapMode="none">Enter answer</text>
        </>
      </Show>
    </box>
  )
}
