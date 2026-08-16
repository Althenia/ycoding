import type { SessionCacheDiagnostics } from "@ycoding-ai/client"
import { Plugin } from "@ycoding-ai/plugin/tui"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { cacheHitPercent, cachePrefixLabel } from "../../util/cache-diagnostics"
import { RailRow, RailSection, RailSubheading } from "../../routes/session/rail-section"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function SidebarCacheContent(props: {
  diagnostics: () => SessionCacheDiagnostics | null | undefined
  fallback?: () => { tokens: { input: number; output: number }; cost: number } | undefined
  currentModel?: () => { identity: string; limit: number } | undefined
  cost?: () => number | undefined
  subagentCost?: () => number | undefined
}) {
  const { themeV2 } = useTheme()
  const diagnostics = createMemo(props.diagnostics)
  const fallback = createMemo(() => props.fallback?.())
  const summary = createMemo(() => {
    const value = diagnostics()
    return value
      ? [
          value.context.percent === undefined ? undefined : `${value.context.percent}%`,
          cacheHitPercent(value.cache.hitRatio) === undefined ? undefined : `${cacheHitPercent(value.cache.hitRatio)}% hit`,
        ]
          .filter((item): item is string => item !== undefined)
          .join(" · ")
      : undefined
  })
  const input = createMemo(() => {
    const measurement = diagnostics()
    const value = measurement ? measurement.tokens.uncachedInput : fallback()?.tokens.input
    return value === undefined ? undefined : { value }
  })
  const output = createMemo(() => {
    const measurement = diagnostics()
    const value = measurement ? measurement.tokens.output : fallback()?.tokens.output
    return value === undefined ? undefined : { value }
  })
  const spent = createMemo(() => {
    const value = diagnostics() ? props.cost?.() : fallback()?.cost
    return value === undefined ? undefined : { value }
  })
  const subagentCost = createMemo(() => {
    const value = props.subagentCost?.()
    return value === undefined ? undefined : { value }
  })

  return (
    <RailSection section="context" title="CONTEXT" summary={summary()}>
      <Show when={input()}>{(input) => <RailRow label="Input" value={input().value.toLocaleString()} />}</Show>
      <Show when={output()}>{(output) => <RailRow label="Output" value={output().value.toLocaleString()} />}</Show>
      <Show when={diagnostics()}>
        {(value) => (
          <>
            <Show when={value().context.percent !== undefined}>
              <RailRow label="Used" value={`${value().context.percent}%`} />
            </Show>
          </>
        )}
      </Show>
      <Show when={spent()}>{(spent) => <RailRow label="Spent" value={money.format(spent().value)} />}</Show>
      <Show when={subagentCost()}>
        {(subagentCost) => <RailRow label="· subagents" value={money.format(subagentCost().value)} />}
      </Show>
      <RailSubheading>CACHE</RailSubheading>
      <Show when={diagnostics()}>
        {(value) => (
          <>
            <Show when={cacheHitPercent(value().cache.hitRatio) !== undefined}>
              <RailRow
                label="Hit ratio"
                value={`${cacheHitPercent(value().cache.hitRatio)}%`}
                valueColor={themeV2.text.feedback.success.default}
              />
            </Show>
            <Show when={cachePrefixLabel(value().requests?.latestInvalidation)}>
              {(prefix) => (
                <RailRow label="Prefix" value={prefix()} valueColor={themeV2.text.feedback.success.default} />
              )}
            </Show>
            <Show when={value().cache.readReported}>
              <RailRow label="Reads" value={value().tokens.cacheRead.toLocaleString()} />
            </Show>
            <Show when={value().cache.writeReported}>
              <RailRow label="Writes" value={value().tokens.cacheWrite.toLocaleString()} />
            </Show>
          </>
        )}
      </Show>
    </RailSection>
  )
}

function View(props: { context: Plugin.Context; sessionID: string }) {
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const diagnostics = createMemo(() => props.context.data.session.diagnostics.get(props.sessionID))
  const fallback = createMemo(() => {
    const current = session()
    return current ? { tokens: { input: current.tokens.input, output: current.tokens.output }, cost: current.cost } : undefined
  })
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))
  const subagentCost = createMemo(() => {
    const current = session()
    if (!current || current.parentID) return undefined
    const children = props.context.data.session
      .family(current.id)
      .filter((sessionID) => sessionID !== current.id)
      .flatMap((sessionID) => props.context.data.session.get(sessionID) ?? [])
    if (children.length === 0) return undefined
    return children.reduce((total, child) => total + child.cost, 0)
  })

  return <SidebarCacheContent diagnostics={diagnostics} fallback={fallback} cost={cost} subagentCost={subagentCost} />
}

export default Plugin.define({
  id: "internal:sidebar-context",
  setup(context) {
    context.ui.slot("sidebar.content", (props) => <View context={context} sessionID={props.sessionID} />)
  },
})
