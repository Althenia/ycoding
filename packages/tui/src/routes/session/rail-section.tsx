import { TextAttributes, type RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createContext, createEffect, createMemo, createSignal, Show, useContext, type ParentProps } from "solid-js"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import {
  collapseSection,
  defaultExpanded,
  expandSection,
  railMetrics,
  RAIL_SECTION_BAND_HEIGHT,
  type RailSectionKey,
} from "./rail"

type RailStore = {
  allExpanded: () => boolean
  expanded: (key: RailSectionKey) => boolean
  leftRule: boolean
  shellSurface: boolean
  showTodo: () => boolean
  toggle: (key: RailSectionKey) => void
  attend: (key: RailSectionKey, needsAttention: boolean) => void
}

const RailContext = createContext<RailStore>()

export function RailProvider(
  props: ParentProps<{ goal?: boolean; autonomy?: boolean; shellSurface?: boolean; allExpanded?: boolean; leftRule?: boolean }>,
) {
  const [order, setOrder] = createSignal(
    defaultExpanded({
      goal: props.goal,
      autonomy: props.autonomy,
      shellSurface: props.shellSurface,
      allExpanded: props.allExpanded,
    }),
  )
  // Tracks which sections are open only because of an attention event, so clearing the event can
  // re-collapse exactly those and leave the default-expanded ones alone.
  const [attending, setAttending] = createSignal<RailSectionKey[]>([])

  createEffect(() =>
    setOrder(
      defaultExpanded({
        goal: props.goal,
        autonomy: props.autonomy,
        shellSurface: props.shellSurface,
        allExpanded: props.allExpanded,
      }),
    ),
  )

  const store: RailStore = {
    allExpanded: () => Boolean(props.allExpanded),
    expanded: (key) => order().includes(key),
    leftRule: Boolean(props.leftRule),
    shellSurface: Boolean(props.shellSurface),
    showTodo: () => true,
    toggle: (key) =>
      setOrder((current) => (current.includes(key) ? collapseSection(current, key) : expandSection(current, key))),
    attend: (key, needsAttention) => {
      if (needsAttention === attending().includes(key)) return
      if (needsAttention) {
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
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()
  const rail = useRail()
  const metrics = createMemo(() => railMetrics(dimensions().width))
  const expanded = createMemo(() => (rail ? rail.expanded(props.section) : true))
  const headerColor = createMemo(() => {
    if (props.attention) return themeV2.text.feedback.warning.default
    return expanded() ? themeV2.text.feedback.success.default : themeV2.text.feedback.info.default
  })
  const titleText = createMemo(() => Locale.truncate(String(props.title ?? "").trim() || "—", 80))
  const summaryText = createMemo(() => {
    const raw = String(props.summary ?? "").trim()
    return raw ? Locale.truncate(raw, 80) : ""
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
        backgroundColor={themeV2.background.surface.overlay}
        onMouseUp={toggle}
      >
        <text fg={headerColor()} wrapMode="none" flexShrink={0}>
          {expanded() ? "\u2212" : "\u002b"}
        </text>
        <box flexGrow={1} paddingLeft={metrics().sectionLabelPadding}>
          <text fg={headerColor()} wrapMode="none" attributes={TextAttributes.BOLD}>
            {titleText()}
          </text>
        </box>
        <Show when={summaryText()}>
          <text
            fg={props.attention ? themeV2.text.feedback.warning.default : themeV2.text.subdued}
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

export function RailSubheading(props: ParentProps) {
  const { themeV2 } = useTheme()
  const text = () => Locale.truncate(String(props.children ?? "").trim() || "—", 80)

  return <text fg={themeV2.text.label}>{text()}</text>
}

export function RailRow(props: { label: string; value: string; valueColor?: RGBA }) {
  const { themeV2 } = useTheme()
  const label = () => Locale.truncate(String(props.label ?? "").trim() || "—", 120)
  const value = () => Locale.truncate(String(props.value ?? "").trim() || "—", 80)

  return (
    <box width="100%" flexDirection="row" justifyContent="space-between" gap={1}>
      <text fg={themeV2.text.subdued} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
        {label()}
      </text>
      <text fg={props.valueColor ?? themeV2.text.default} wrapMode="none" flexShrink={0}>
        {value()}
      </text>
    </box>
  )
}
