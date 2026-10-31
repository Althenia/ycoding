import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import type { SessionAutonomyView, SessionCacheDiagnostics, SessionInfo, SessionOrchestrationTask } from "@ycoding-ai/client"
import { useRoute, useRouteData } from "../../context/route"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { Locale } from "../../util/locale"
import { useTerminalDimensions } from "@opentui/solid"
import { formatCacheDiagnostics, formatDiagnosticsModel } from "../../util/cache-diagnostics"
import { generationSpeedDisplay } from "../../util/generation-speed"
import { Keymap } from "../../context/keymap"
import { stringWidth } from "../../util/string-width"
import type { ProjectContext } from "../../util/coordination"
import { FooterAutonomy, ProjectFooterLine } from "./footer"
import { readableTint } from "../../theme/component"

type SubagentPagination = {
  page(parentID: string): {
    readonly data: ReadonlyArray<SessionOrchestrationTask>
    readonly offset: number
    readonly position: "top" | "older"
  } | undefined
  navigation(parentID: string): { readonly older: boolean; readonly newer: boolean }
  sync(parentID: string): Promise<void>
  loadOlder(parentID: string): Promise<void>
  loadNewer(parentID: string): Promise<void>
}

export async function hydrateSubagentPage(input: {
  pagination: SubagentPagination
  parentID: string
  currentSessionID: string
}) {
  const containsCurrent = () => input.pagination.page(input.parentID)?.data.some((task) => task.sessionID === input.currentSessionID)
  if (containsCurrent()) return input.pagination.page(input.parentID)
  await input.pagination.sync(input.parentID)
  // The bounded API has no child-ID cursor. Walk only while opening or navigating this one child;
  // each load replaces the resident page instead of retaining prior task records.
  while (!containsCurrent() && input.pagination.navigation(input.parentID).older)
    await input.pagination.loadOlder(input.parentID)
  return input.pagination.page(input.parentID)
}

export async function navigateSubagentSibling(input: {
  pagination: SubagentPagination
  parentID: string
  currentSessionID: string
  direction: -1 | 1
}) {
  const page = await hydrateSubagentPage(input)
  const current = page?.data.findIndex((task) => task.sessionID === input.currentSessionID) ?? -1
  if (current < 0 || !page) return undefined
  if (input.direction === 1) {
    const next = page.data[current + 1]
    if (next) return next.sessionID
    if (input.pagination.navigation(input.parentID).older) {
      await input.pagination.loadOlder(input.parentID)
      return input.pagination.page(input.parentID)?.data[0]?.sessionID
    }
    await input.pagination.sync(input.parentID)
    const first = input.pagination.page(input.parentID)?.data[0]?.sessionID
    return first === input.currentSessionID ? undefined : first
  }
  const previous = page.data[current - 1]
  if (previous) return previous.sessionID
  if (input.pagination.navigation(input.parentID).newer) {
    await input.pagination.loadNewer(input.parentID)
    return input.pagination.page(input.parentID)?.data.at(-1)?.sessionID
  }
  while (input.pagination.navigation(input.parentID).older) await input.pagination.loadOlder(input.parentID)
  const last = input.pagination.page(input.parentID)?.data.at(-1)?.sessionID
  return last === input.currentSessionID ? undefined : last
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
  reads?: string
  writes?: string
  spent?: string
  speed?: string
  rollsUpTo?: string
}

function totalTokens(session: Pick<SessionInfo, "tokens">) {
  return session.tokens.input + session.tokens.output + session.tokens.reasoning + session.tokens.cache.read + session.tokens.cache.write
}

export function subagentEconomics(
  session: (Pick<SessionInfo, "cost" | "tokens"> & Partial<Pick<SessionInfo, "model">>) | undefined,
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
  const reads = diagnostics?.cache.readReported ? number(diagnostics.tokens.cacheRead) : undefined
  const writes = diagnostics?.cache.writeReported ? number(diagnostics.tokens.cacheWrite) : undefined
  const spent = money.format(session.cost)
  const speed = generationSpeedDisplay(diagnostics?.generationSpeed, session.model)?.label
  const summary = [
    tokens > 0 ? `${Locale.number(tokens)}${diagnostics?.context.percent === undefined ? "" : ` (${diagnostics.context.percent}%)`}` : undefined,
    hit,
    spent,
  ]
    .filter(Boolean)
    .join(" · ")
  const strip = [
    speed,
    context ? `Context ${context}` : undefined,
    diagnostics && !hit ? "hit unreported" : undefined,
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
    reads,
    writes,
    spent,
    speed,
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
  const output = [money.format(session.cost), tokens > 0 ? Locale.number(tokens) : undefined]
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
          cost: money.format(session.cost),
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
  const { theme } = useTheme().contextual("elevated")
  const keymap = Keymap.use()
  const shortcuts = Keymap.useShortcuts()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 60)
  const siblings = createMemo(() => props.siblings ?? [])
  const currentTask = createMemo(() => siblings().find((task) => task.sessionID === props.currentSessionID))
  const borderColor = createMemo(() => props.blocked ? theme.text.feedback.warning.default : theme.border.default)

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
        backgroundColor={theme.background.default}
      >
        <box flexDirection="row" flexWrap="wrap" justifyContent="space-between" gap={1}>
          <box flexDirection="row" flexWrap="wrap" gap={1} flexGrow={1} minWidth={0}>
            <text fg={props.blocked ? theme.text.feedback.warning.default : theme.text.default}>
              <b>{props.title}</b>
            </text>
            <Show when={props.usage()}>
              {(item) => (
                <box flexDirection="column" minWidth={0} flexGrow={1}>
                  <text fg={theme.text.subdued} wrapMode="none">
                    {[item().model, item().context, item().cache, item().cost].filter(Boolean).join(" · ")}
                  </text>
                </box>
              )}
            </Show>
            <Show when={props.economics?.summary}>
              {(summary) => <text fg={theme.text.default} wrapMode="none">{summary()}</text>}
            </Show>
          </box>
          <Show when={props.economics?.strip.length}>
            <box flexDirection="row" flexWrap="wrap" gap={1} flexShrink={1} minWidth={0}>
              <For each={props.economics?.strip}>{(item) => <text fg={theme.text.subdued} wrapMode="none">{item}</text>}</For>
            </box>
          </Show>
          <Show when={currentTask()?.question?.text}>
            {(question) => (
              <text fg={theme.text.feedback.warning.default} wrapMode="none">
                ? {question()}
              </text>
            )}
          </Show>
          <Show when={siblings().length > 0}>
            <box flexDirection="row" flexWrap="wrap" gap={1}>
              <box
                onMouseUp={() => keymap.dispatch("session.parent")}
                backgroundColor={theme.background.default}
              >
                <text fg={theme.text.action.primary.default} wrapMode="none">
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
                        attached() ? theme.background.action.primary.focused : theme.background.default
                      }
                    >
                      <text
                        fg={attached() ? theme.text.action.primary.focused : theme.text.feedback.info.default}
                        wrapMode="none"
                      >
                        <Show when={task.question?.text}>
                          <span style={{ fg: theme.text.feedback.warning.default }}>? </span>
                        </Show>
                        ◦ {Locale.titlecase(task.agent)}
                        <Show when={props.siblingEconomics?.[task.sessionID]}>
                          {(economics) => <span style={{ fg: theme.text.subdued }}> {economics()}</span>}
                        </Show>
                        <Show when={formatDiagnosticsModel(task.model)}>
                          {(model) => <span style={{ fg: theme.text.subdued }}> · {model()}</span>}
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
                hover() === "parent" ? theme.background.action.primary.hovered : theme.background.default
              }
            >
              <text fg={theme.text.default}>
                {compact() ? "↖" : "Parent"}{" "}
                <span style={{ fg: theme.text.subdued }}>{shortcuts.get("session.parent")}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("prev")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatch("session.child.previous")}
              backgroundColor={
                hover() === "prev" ? theme.background.action.primary.hovered : theme.background.default
              }
            >
              <text fg={theme.text.default}>
                {compact() ? "←" : `${siblings().findIndex((task) => task.sessionID === props.currentSessionID) + 1}/${siblings().length} ←`}{" "}
                <span style={{ fg: theme.text.subdued }}>{shortcuts.get("session.child.previous")}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("next")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatch("session.child.next")}
              backgroundColor={
                hover() === "next" ? theme.background.action.primary.hovered : theme.background.default
              }
            >
              <text fg={theme.text.default}>
                {compact() ? "→" : "→"}{" "}
                <span style={{ fg: theme.text.subdued }}>{shortcuts.get("session.child.next")}</span>
              </text>
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}

export function SubagentFooter(props: {
  reviewing?: boolean
  autonomy?: SessionAutonomyView
  project?: ProjectContext
  onProjectIdentity?: () => void
  onProjectTab?: () => void
}) {
  const dimensions = useTerminalDimensions()
  const route = useRouteData("session")
  const navigation = useRoute()
  const data = useData()
  const session = createMemo(() => data.session.get(route.sessionID))
  const parentID = createMemo(() => session()?.parentID)
  const page = createMemo(() => {
    const parent = parentID()
    return parent ? data.session.subagent.page(parent) : undefined
  })
  const siblings = createMemo(() => page()?.data ?? [])
  const parent = createMemo(() => (parentID() ? data.session.get(parentID()!) : undefined))

  createEffect(
    on(
      () => route.sessionID,
      (sessionID) => void data.session.diagnostics.sync(sessionID).catch(() => undefined),
    ),
  )
  createEffect(() => {
    siblings().forEach((task) => {
      if (data.session.get(task.sessionID)) return
      void data.session.sync(task.sessionID).catch(() => undefined)
    })
  })

  const economics = createMemo(() => subagentEconomics(session(), data.session.diagnostics.get(route.sessionID), parent()?.title))
  const currentTask = createMemo(() => siblings().find((task) => task.sessionID === route.sessionID))
  const current = createMemo(() => (page()?.offset ?? 0) + siblings().findIndex((task) => task.sessionID === route.sessionID) + 1)
  const total = createMemo(() => page()?.summary.total ?? siblings().length)
  const agent = createMemo(() => currentTask()?.agent ?? "subagent")
  const context = createMemo(() => {
    const [total, percent] = economics()?.context?.split(" · ") ?? []
    if (!total || !percent) return undefined
    return `${total.split(" / ")[0]} (${percent})`
  })
  const blocked = createMemo(() => currentTask()?.state === "waiting" && Boolean(currentTask()?.question))
  const { theme } = useTheme()
  const projectShortcut = Keymap.useShortcut("project.members")
  const gap = () => dimensions().width < 60 ? 1 : 2
  const identity = () => dimensions().width >= 60
    ? Locale.truncateWidth(`${agent()} (${current()} of ${total()})`, dimensions().width < 100 ? 10 : 21)
    : ""
  const projectWidth = () => props.project && dimensions().width >= 60 ? dimensions().width >= 140 ? 24 : 12 : 0
  const projectHint = () => props.project && projectShortcut() && dimensions().width >= 80
    ? `[${projectShortcut()!.replaceAll("ctrl+", "⌃")}] Project`
    : ""
  const detail = () => dimensions().width >= 200
    ? [economics()?.speed, context(), economics()?.cacheHit ? `${economics()?.cacheHit} hit` : undefined, economics()?.spent, "durable", "resumable"].filter(Boolean).join(" · ")
    : ""
  const action = () => blocked()
    ? dimensions().width < 60 ? props.reviewing ? "review" : "reply" : props.reviewing ? "Review pending" : "Enter answer"
    : dimensions().width < 60 ? "next" : "→ next"
  const modeWidth = () => {
    const items = [identity(), projectWidth() ? "project" : "", detail(), projectHint(), action()].filter(Boolean).length
    return Math.max(19, dimensions().width - 6 - stringWidth(identity() + detail() + projectHint() + action()) - projectWidth() - gap() * (items + (dimensions().width >= 40 ? 1 : 0)))
  }
  const quiet = () => readableTint(theme.text.subdued, theme.background.default)
  const nextSibling = () => {
    if (blocked()) return
    const id = parentID()
    if (!id) return
    void navigateSubagentSibling({
      pagination: data.session.subagent,
      parentID: id,
      currentSessionID: route.sessionID,
      direction: 1,
    }).then((sibling) => {
      if (sibling) navigation.navigate({ type: "session", sessionID: sibling })
    }).catch(() => undefined)
  }

  return (
    <box width="100%" height={1} paddingLeft={3} paddingRight={3} alignItems="center" flexDirection="row" flexShrink={0} gap={gap()} backgroundColor={theme.background.default}>
      <Show when={identity()}>{(label) => <text fg={theme.text.default} wrapMode="none" flexShrink={0}>{label()}</text>}</Show>
      <Show when={props.project && projectWidth() > 0 ? props.project : undefined}>
        {(project) => <box width={projectWidth()} flexShrink={0}><ProjectFooterLine owner={project()} width={projectWidth()} onIdentity={props.onProjectIdentity} /></box>}
      </Show>
      <FooterAutonomy autonomy={props.autonomy} width={modeWidth()} />
      <Show when={detail()}>{(label) => <text fg={quiet()} wrapMode="none" flexShrink={0}>{label()}</text>}</Show>
      <Show when={dimensions().width >= 40}><box flexGrow={1} minWidth={0} /></Show>
      <Show when={projectHint()}>
        <text fg={theme.text.default} wrapMode="none" flexShrink={0} onMouseUp={props.onProjectTab}>
          [{projectShortcut()?.replaceAll("ctrl+", "⌃")}] <span style={{ fg: quiet() }}>Project</span>
        </text>
      </Show>
      <text fg={readableTint(blocked() ? theme.text.feedback.warning.default : theme.text.action.primary.default, theme.background.default)} wrapMode="none" flexShrink={0} onMouseUp={nextSibling}>
        {action()}
      </text>
    </box>
  )
}
