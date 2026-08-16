import { createContext, createEffect, createMemo, createSignal, Show, useContext, type ParentProps } from "solid-js"
import { useTheme } from "../../context/theme"
import { collapseSection, defaultExpanded, expandSection, type RailSectionKey } from "./rail"

type RailStore = {
  expanded: (key: RailSectionKey) => boolean
  attend: (key: RailSectionKey, needsAttention: boolean) => void
}

const RailContext = createContext<RailStore>()

export function RailProvider(props: ParentProps<{ goal?: boolean; autonomy?: boolean }>) {
  const [order, setOrder] = createSignal(defaultExpanded({ goal: props.goal, autonomy: props.autonomy }))
  // Tracks which sections are open only because of an attention event, so clearing the event can
  // re-collapse exactly those and leave the default-expanded ones alone.
  const [attending, setAttending] = createSignal<RailSectionKey[]>([])

  const store: RailStore = {
    expanded: (key) => order().includes(key),
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

  createEffect(() => rail?.attend(props.section, Boolean(props.attention)))

  return (
    <box flexShrink={0}>
      <box flexDirection="row" gap={1}>
        <text fg={themeV2.text.subdued} wrapMode="none" flexShrink={0}>
          {expanded() ? "\u25be" : "\u25b8"}
        </text>
        <text fg={themeV2.text.default} wrapMode="none" flexGrow={1}>
          <b>{props.title}</b>
        </text>
        <Show when={!expanded() && props.summary}>
          {(summary) => (
            <text
              fg={props.attention ? themeV2.text.feedback.warning.default : themeV2.text.subdued}
              wrapMode="none"
              flexShrink={0}
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
