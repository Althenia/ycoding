import { TextAttributes, type RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createContext, createEffect, createMemo, createSignal, Show, useContext, type ParentProps } from "solid-js"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { stringWidth } from "../../util/string-width"
import {
  collapseSection,
  defaultExpanded,
  expandSection,
  railMetrics,
  railWidth,
  RAIL_SECTION_BAND_HEIGHT,
  type RailSectionKey,
} from "./rail"

type RailStore = {
  allExpanded: () => boolean
  expanded: (key: RailSectionKey) => boolean
  leftRule: boolean
  showTodo: () => boolean
  toggle: (key: RailSectionKey) => void
  attend: (key: RailSectionKey, needsAttention: boolean) => void
}

const RailContext = createContext<RailStore>()

// Shared across Session remounts so expand/collapse survives main transcript <->
// subagent chat navigation.
let persistedRailOrder: RailSectionKey[] = defaultExpanded()

export function resetRailExpansion() {
  persistedRailOrder = defaultExpanded()
}

export function RailProvider(
  props: ParentProps<{ goal?: boolean; autonomy?: boolean; allExpanded?: boolean; leftRule?: boolean }>,
) {
  // Initial expansion is session/context/todo only. The order signal starts from the
  // shared persisted value and writes back to it, so user toggles survive both
  // sessionID prop changes and full Session remounts (keyed by sessionID).
  const [order, setOrderState] = createSignal<RailSectionKey[]>(persistedRailOrder)
  const setOrder = (update: RailSectionKey[] | ((current: RailSectionKey[]) => RailSectionKey[])) => {
    const next =
      typeof update === "function"
        ? (update as (current: RailSectionKey[]) => RailSectionKey[])(order())
        : update
    persistedRailOrder = [...next]
    setOrderState(persistedRailOrder)
  }
  // Tracks which sections are open only because of an attention event, so clearing the event can
  // re-collapse exactly those and leave the default-expanded ones alone.
  const [attending, setAttending] = createSignal<RailSectionKey[]>([])

  const store: RailStore = {
    allExpanded: () => Boolean(props.allExpanded),
    expanded: (key) => order().includes(key),
    leftRule: Boolean(props.leftRule),
    showTodo: () => true,
    toggle: (key) => {
      setOrder((current) => (current.includes(key) ? collapseSection(current, key) : expandSection(current, key)))
    },
    attend: (key, needsAttention) => {
      if (needsAttention === attending().includes(key)) return
      if (needsAttention) {
        if (order().includes(key)) return
        setAttending((current) => [...current, key])
        setOrder((current) => expandSection(current, key))
        return
      }
      setAttending((current) => current.filter((item) => item !== key))
      setOrder((current) => collapseSection(current, key))
    },
  }

  return <RailContext.Provider value={store}>{props.children}</RailContext.Provider>
}

export function useRail() {
  return useContext(RailContext)
}

/**
 * A rail section collapses to a single header row that still carries its summary, so collapsing costs
 * no information. Sections render expanded when no rail provider is mounted.
 */
export function RailSection(
  props: ParentProps<{
    section: RailSectionKey
    title: string
    summary?: string
    attention?: boolean
  }>,
) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const rail = useRail()
  const metrics = createMemo(() => railMetrics(dimensions().width))
  const expanded = createMemo(() => (rail ? rail.expanded(props.section) : true))
  const headerColor = createMemo(() => {
    if (props.attention) return theme.text.feedback.warning.default
    return expanded() ? theme.text.feedback.success.default : theme.text.feedback.info.default
  })
  const titleText = createMemo(() => Locale.truncate(String(props.title ?? "").trim() || "—", 80))
  const summaryText = createMemo(() => {
    const available = (rail ? railWidth(dimensions().width) - (rail.leftRule ? 1 : 0) : dimensions().width)
      - (rail ? metrics().paddingLeft + metrics().paddingRight : 0)
      - metrics().sectionLabelPadding - stringWidth(titleText()) - 3
    return fitSummary(String(props.summary ?? "").trim(), available)
  })
  const toggle = () => rail?.toggle(props.section)

  createEffect(() => rail?.attend(props.section, Boolean(props.attention)))

  return (
    <box width="100%" flexShrink={0}>
      <box
        width="100%"
        flexDirection="row"
        gap={1}
        height={RAIL_SECTION_BAND_HEIGHT}
        alignItems={rail ? "center" : "flex-start"}
        paddingLeft={rail ? metrics().paddingLeft : 0}
        paddingRight={rail ? metrics().paddingRight : 0}
        marginLeft={rail?.leftRule ? -1 : 0}
        backgroundColor={theme.background.surface.overlay}
        onMouseUp={toggle}
      >
        <text fg={headerColor()} wrapMode="none" flexShrink={0}>
          {expanded() ? "\u2212" : "\u002b"}
        </text>
        <box flexGrow={1} flexShrink={0} paddingLeft={metrics().sectionLabelPadding}>
          <text fg={headerColor()} wrapMode="none" attributes={TextAttributes.BOLD}>
            {titleText()}
          </text>
        </box>
        <Show when={summaryText()}>
          <text
            fg={props.attention ? theme.text.feedback.warning.default : theme.text.subdued}
            wrapMode="none"
            flexShrink={0}
          >
            {summaryText()}
          </text>
        </Show>
      </box>
      <Show when={expanded()}>
        <box
          width="100%"
          paddingLeft={rail ? metrics().paddingLeft - (rail.leftRule ? 1 : 0) : 0}
          paddingRight={rail ? metrics().paddingRight : 0}
        >
          <Show when={props.children}>
            <box height={1} flexShrink={0} />
            {props.children}
            <box height={1} flexShrink={0} />
          </Show>
        </box>
      </Show>
    </box>
  )
}

function fitSummary(value: string, width: number) {
  if (!value) return ""
  const parts = value.split(" · ")
  for (let count = parts.length; count >= 0; count--) {
    const summary = [...parts.slice(0, count), ...(count < parts.length ? [`+${parts.length - count}`] : [])].join(" · ")
    if (stringWidth(summary) <= width) return summary
  }
  return ""
}

export function RailSubheading(props: ParentProps) {
  const { theme } = useTheme()
  const text = () => Locale.truncate(String(props.children ?? "").trim() || "—", 80)

  return <text fg={theme.text.label}>{text()}</text>
}

export function RailRow(props: { label: string; value: string; valueColor?: RGBA }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const rail = useRail()
  const width = () => rail ? railWidth(dimensions().width) - railMetrics(dimensions().width).paddingLeft - railMetrics(dimensions().width).paddingRight : dimensions().width
  const label = () => Locale.truncate(String(props.label ?? "").trim() || "—", 120)
  const value = () => String(props.value ?? "").trim() || "—"
  const stacked = () => stringWidth(value()) > stringWidth(label()) && stringWidth(label()) + stringWidth(value()) + 1 > width()

  return (
    <box width="100%" flexDirection={stacked() ? "column" : "row"} justifyContent="space-between" gap={stacked() ? 0 : 1}>
      <text fg={theme.text.subdued} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
        {label()}
      </text>
      <text fg={props.valueColor ?? theme.text.default} wrapMode="word" flexShrink={0}>
        {value()}
      </text>
    </box>
  )
}
