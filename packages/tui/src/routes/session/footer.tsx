import { createMemo, For, Show } from "solid-js"
import type { SessionAutonomyView } from "@ycoding-ai/client"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import { useData } from "../../context/data"
import { Keymap } from "../../context/keymap"
import { useRoute } from "../../context/route"
import { readableForeground, readableTint } from "../../theme/component"
import { Locale } from "../../util/locale"
import { groupSessionShells } from "../../util/session"
import { autonomyModeWord, autonomyRows } from "../../util/session-autonomy"
import { stringWidth } from "../../util/string-width"
import type { ProjectContext } from "../../util/coordination"

type AutonomyLevel = 0 | 1 | 2 | 3
type AutonomyPart = { text: string; tone?: "manual" | "auto" | "yolo" | "asleep" }

export function FooterAutonomy(props: { autonomy?: SessionAutonomyView; width?: number }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const muted = createMemo(() => readableTint(theme.text.subdued, theme.background.chrome))
  const available = () => props.width ?? dimensions().width - 6
  const padded = createMemo(() => autonomyWidth(props.autonomy, 3, true) <= available())
  const level = createMemo(() => fittedAutonomyLevel(props.autonomy, available(), padded()))
  const style = (tone: AutonomyPart["tone"]) => {
    if (tone === "manual")
      return {
        fg: readableForeground(theme.text.action.primary.focused, theme.text.feedback.success.default),
        bg: theme.text.feedback.success.default,
      }
    if (tone === "yolo")
      return {
        fg: readableForeground(theme.text.action.primary.focused, theme.text.feedback.warning.default),
        bg: theme.text.feedback.warning.default,
      }
    if (tone === "auto")
      return {
        fg: readableForeground(theme.text.action.destructive.default, theme.background.action.destructive.default),
        bg: theme.background.action.destructive.default,
      }
    if (tone === "asleep")
      return {
        fg: readableForeground(theme.text.action.primary.focused, theme.background.action.primary.focused),
        bg: theme.background.action.primary.focused,
      }
    return { fg: muted(), bg: undefined }
  }
  return (
    <box flexDirection="row" height={1} flexShrink={0} gap={autonomyGap(level())}>
      <For each={autonomyItems(props.autonomy, level(), padded())}>
        {(item) => (
          <box flexDirection="row" flexShrink={0}>
            <For each={item}>
              {(part) => (
                <text wrapMode="none" flexShrink={0} fg={style(part.tone).fg} bg={style(part.tone).bg}>
                  {part.text}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

export function Footer(props: {
  branch?: string
  sessionID: string
  subagent?: boolean
  project?: ProjectContext
  autonomy?: SessionAutonomyView
  onProjectIdentity?: () => void
  onProjectTab?: () => void
}) {
  const { theme } = useTheme()
  const data = useData()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const muted = createMemo(() => readableTint(theme.text.subdued, theme.background.chrome))
  const paletteShortcut = Keymap.useShortcut("command.palette.show")
  const usageShortcut = Keymap.useShortcut("session.provider-usage.open")
  const projectShortcut = Keymap.useShortcut("project.members")
  const subagents = createMemo(() => data.session.subagent.summary(props.sessionID)?.active ?? 0)
  const shells = createMemo(() => {
    const session = data.session.get(props.sessionID)
    if (!session) return 0
    return groupSessionShells(data.shell.list(session.location), data.session.list(), session.id).reduce(
      (count, group) => count + group.shells.length,
      0,
    )
  })
  const openUsage = () => route.navigate({ type: "provider-usage", sessionID: props.sessionID })
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: "session.provider-usage.open",
        title: "Open provider usage",
        group: "Session",
        bind: "<leader>shift+u",
        run: openUsage,
      },
      {
        id: "session.context-breakdown.open",
        title: "Open context breakdown",
        group: "Session",
        palette: true,
        run: () => route.navigate({ type: "session-context", sessionID: props.sessionID }),
      },
    ],
    bindings: ["session.provider-usage.open"],
  }))
  const layout = createMemo(() =>
    footerLayout({
      terminal: dimensions().width,
      identity: props.project && dimensions().width > 40 ? projectIdentity(props.project) : undefined,
      branch: props.branch,
      subagents: subagents(),
      shells: shells(),
      autonomy: props.autonomy,
      hints: [
        ...(props.project && projectShortcut() ? [{ id: "project" as const, key: projectShortcut()!, label: "project" }] : []),
        ...(usageShortcut() ? [{ id: "usage" as const, key: usageShortcut()!, label: "usage" }] : []),
        ...(paletteShortcut() ? [{ id: "palette" as const, key: paletteShortcut()!, label: "commands" }] : []),
      ],
    }),
  )
  const hintAction = (id: FooterHint["id"]) => (id === "project" ? props.onProjectTab : id === "usage" ? openUsage : undefined)

  return (
    <box
      width="100%"
      height={3}
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      paddingLeft={3}
      paddingRight={3}
      backgroundColor={theme.background.chrome}
    >
      <box flexDirection="row" gap={layout().gap} flexShrink={0}>
        <Show when={props.project && layout().identity}>
          <ProjectFooterLine owner={props.project!} width={layout().identity} onIdentity={props.onProjectIdentity} />
        </Show>
        <Show when={layout().branch}>
          {(branch) => (
            <text fg={muted()} wrapMode="none" flexShrink={0}>
              {branch()}
            </text>
          )}
        </Show>
        <For each={layout().meta}>
          {(item) => (
            <text fg={muted()} wrapMode="none" flexShrink={0}>
              {item}
            </text>
          )}
        </For>
        <FooterAutonomy autonomy={props.autonomy} width={layout().autonomy} />
      </box>
      <box flexGrow={1} minWidth={0} />
      <box flexDirection="row" gap={layout().gap} flexShrink={0}>
        <For each={layout().hints}>
          {(hint) => (
            <text fg={theme.text.default} wrapMode="none" flexShrink={0} onMouseUp={hintAction(hint.id)}>
              {hint.key}
              <Show when={hint.label}>
                <span style={{ fg: muted() }}> {hint.label}</span>
              </Show>
            </text>
          )}
        </For>
      </box>
    </box>
  )
}

export function ProjectFooterLine(props: { owner: ProjectContext; onIdentity?: () => void; onTab?: () => void; width?: number }) {
  const { theme } = useTheme()
  const muted = createMemo(() => readableTint(theme.text.subdued, theme.background.chrome))
  return (
    <box id="session.footer.project" height={1} flexShrink={props.width === undefined ? 1 : 0} minWidth={0} flexDirection="row">
      <text fg={muted()} wrapMode="none" truncate flexShrink={1} minWidth={0} onMouseUp={props.onIdentity}>
        {props.width === undefined ? projectIdentity(props.owner) : Locale.truncateWidth(projectIdentity(props.owner), props.width)}
      </text>
    </box>
  )
}

type FooterHint = { id: "project" | "usage" | "palette"; key: string; label: string }

type FooterState = {
  gap: number
  level: AutonomyLevel
  meta: "full" | "compact" | "shells"
  hints: "full" | "keys" | "palette"
  branch: boolean
  identity: boolean
  padded: boolean
}

const identityMinimum = 12
const branchMinimum = 8

function footerLayout(input: {
  terminal: number
  identity?: string
  branch?: string
  subagents: number
  shells: number
  autonomy?: SessionAutonomyView
  hints: FooterHint[]
}) {
  const available = input.terminal - 6
  const steps: Partial<FooterState>[] = [
    { level: 1 },
    { meta: "compact" },
    { level: 2 },
    { hints: "keys" },
    { branch: false },
    { level: 3 },
    { gap: 1 },
    ...(input.terminal < 60 ? [{ identity: false }] : []),
    { padded: false },
    { hints: "palette" as const },
    { meta: "shells" as const },
  ]
  const states = steps.reduce<FooterState[]>((all, step) => [...all, { ...all.at(-1)!, ...step }], [
    { gap: 2, level: 0, meta: "full", hints: "full", branch: true, identity: true, padded: true },
  ])
  const measure = (state: FooterState) => {
    const meta =
      state.meta === "full"
        ? [`subagents ${input.subagents}`, `shells ${input.shells}`]
        : state.meta === "compact"
          ? [`sa${input.subagents}`, `sh${input.shells}`]
          : [`sh${input.shells}`]
    const hints = input.hints
      .filter((hint) => state.hints !== "palette" || hint.id === "palette")
      .map((hint) =>
        state.hints === "full"
          ? { id: hint.id, key: hint.key.replaceAll("ctrl+", "⌃"), label: hint.label }
          : { id: hint.id, key: hint.key.replaceAll("ctrl+", "⌃").replaceAll("shift+", "⇧"), label: "" },
      )
    const identity = state.identity && input.identity ? Math.min(stringWidth(input.identity), identityMinimum) : 0
    const branch = state.branch && input.branch ? Math.min(stringWidth(input.branch), branchMinimum) : 0
    const autonomy = autonomyWidth(input.autonomy, state.level, state.padded)
    const left = [identity, branch, ...meta.map((item) => stringWidth(item)), autonomy].filter((width) => width > 0)
    const right = hints.map((hint) => stringWidth(hint.key) + (hint.label ? 1 + stringWidth(hint.label) : 0))
    const fixed =
      left.reduce((sum, width) => sum + width, 0) +
      state.gap * (left.length - 1) +
      (right.length ? state.gap * right.length + right.reduce((sum, width) => sum + width, 0) : 0)
    return { state, meta, hints, identity, branch, autonomy, fixed }
  }
  const measured = states.map(measure)
  const chosen = measured.find((entry) => entry.fixed <= available) ?? measured.at(-1)!
  const spare = Math.max(0, available - chosen.fixed)
  const identity = chosen.identity
    ? Math.min(stringWidth(input.identity ?? ""), chosen.identity + spare)
    : 0
  const branchSpare = spare - (identity - chosen.identity)
  const branch = chosen.branch ? Locale.truncateWidth(input.branch ?? "", chosen.branch + branchSpare) : undefined
  return {
    gap: chosen.state.gap,
    identity: identity || undefined,
    branch,
    meta: chosen.meta,
    autonomy: chosen.autonomy,
    hints: chosen.hints,
  }
}

function projectIdentity(owner: ProjectContext) {
  if (owner.role === "master") return `◇ Master of ${owner.project.name}`
  return owner.role === "supervisor" ? `↑ Supervisor in ${owner.project.name}` : `↑ Member of ${owner.project.name}`
}

function fittedAutonomyLevel(view: SessionAutonomyView | undefined, width: number, padded: boolean): AutonomyLevel {
  return ([0, 1, 2] as const).find((level) => autonomyWidth(view, level, padded) <= width) ?? 3
}

function autonomyGap(level: AutonomyLevel) {
  return level === 3 ? 1 : 2
}

function autonomyWidth(view: SessionAutonomyView | undefined, level: AutonomyLevel, padded: boolean) {
  const items = autonomyItems(view, level, padded)
  return (
    items.reduce((sum, item) => sum + item.reduce((width, part) => width + stringWidth(part.text), 0), 0) +
    autonomyGap(level) * (items.length - 1)
  )
}

function autonomyItems(view: SessionAutonomyView | undefined, level: AutonomyLevel, padded: boolean): AutonomyPart[][] {
  const words = level < 2
  const categories = autonomyRows(view).map((row) => {
    const label = level === 0 ? `${row.title} ` : level === 3 ? `${row.title[0]}:` : `${row.title[0]} `
    const value = row.effective
      ? level === 3
        ? { manual: "M", auto: "A", yolo: "Y" }[row.effective]
        : autonomyModeWord(row.effective)
      : level === 3
        ? "?"
        : "unknown"
    const disabled = row.category === "guardrails" && row.effective !== undefined && view?.effective?.guardrailsEnabled === false
    const annotations = disabled ? (words ? " · disabled" : "!") : ""
    return [
      { text: padded && row.effective ? ` ${label}${value} ` : `${label}${value}`, tone: row.effective },
      ...(annotations ? [{ text: annotations }] : []),
    ]
  })
  const sleep = typeof view?.effective?.asleep === "boolean" ? (view.effective.asleep ? "asleep" : "awake") : "unknown"
  const sleepText =
    sleep === "asleep"
      ? level === 3
        ? "sl*"
        : "asleep"
      : sleep === "awake"
        ? level === 3
          ? "sl"
          : "sleep"
        : level === 3
          ? "sl?"
          : level === 2
            ? "sleep ?"
            : "sleep unknown"
  return [...categories, [{ text: padded && sleep === "asleep" ? ` ${sleepText} ` : sleepText, tone: sleep === "asleep" ? ("asleep" as const) : undefined }]]
}
