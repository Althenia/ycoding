import type { RGBA } from "@opentui/core"
import { createContext, createEffect, createMemo, createSignal, Show, useContext, type ParentProps } from "solid-js"
import { useTheme } from "../../context/theme"
import { collapseSection, defaultExpanded, expandSection, type RailSectionKey } from "./rail"

type RailStore = {
  expanded: (key: RailSectionKey) => boolean
  toggle: (key: RailSectionKey) => void
  attend: (key: RailSectionKey, needsAttention: boolean) => void
}

const RailContext = createContext<RailStore>()

export function RailProvider(props: ParentProps<{ goal?: boolean; autonomy?: boolean; shellSurface?: boolean }>) {
  const [order, setOrder] = createSignal(
    defaultExpanded({ goal: props.goal, autonomy: props.autonomy, shellSurface: props.shellSurface }),
  )
  // Tracks which sections are open only because of an attention event, so clearing the event can
  // re-collapse exactly those and leave the default-expanded ones alone.
  const [attending, setAttending] = createSignal<RailSectionKey[]>([])

  createEffect(() =>
    setOrder(defaultExpanded({ goal: props.goal, autonomy: props.autonomy, shellSurface: props.shellSurface })),
  )

  const store: RailStore = {
    expanded: (key) => order().includes(key),
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
  const rail = useRail()
  const expanded = createMemo(() => (rail ? rail.expanded(props.section) : true))
  const headerColor = createMemo(() => {
    if (props.attention) return themeV2.text.feedback.warning.default
    return expanded() ? themeV2.text.feedback.success.default : themeV2.text.feedback.info.default
  })
  const toggle = () => rail?.toggle(props.section)

  createEffect(() => rail?.attend(props.section, Boolean(props.attention)))

  return (
    <box flexShrink={0}>
      <box flexDirection="row" gap={1}>
        <text fg={headerColor()} wrapMode="none" flexShrink={0} onMouseUp={toggle}>
          {expanded() ? "\u2212" : "\u002b"}
        </text>
        <text fg={headerColor()} wrapMode="none" flexGrow={1} onMouseUp={toggle}>
          <b>{props.title}</b>
        </text>
        <Show when={props.summary}>
          {(summary) => (
            <text
              fg={props.attention ? themeV2.text.feedback.warning.default : themeV2.text.subdued}
              wrapMode="none"
              flexShrink={0}
              onMouseUp={toggle}
            >
              {summary()}
            </text>
          )}
        </Show>
      </box>
      <Show when={expanded()}>{props.children}</Show>
    </box>
  )
}

export function RailSubheading(props: ParentProps) {
  const { themeV2 } = useTheme()

  return <text fg={themeV2.text.label}>{props.children}</text>
}

export function RailRow(props: { label: string; value: string; valueColor?: RGBA }) {
  const { themeV2 } = useTheme()

  return (
    <box width="100%" flexDirection="row" justifyContent="space-between" overflow="hidden">
      <text fg={themeV2.text.subdued} wrapMode="none" flexGrow={1} flexShrink={1} overflow="hidden">
        {props.label}
      </text>
      <text fg={props.valueColor ?? themeV2.text.default} wrapMode="none" flexShrink={0}>
        {props.value}
      </text>
    </box>
  )
}
