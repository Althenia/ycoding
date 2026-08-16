import type { SessionCacheDiagnostics } from "@ycoding-ai/client"
import { useTerminalDimensions } from "@opentui/solid"
import { Plugin } from "@ycoding-ai/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { cacheHitPercent, cachePrefixLabel, contextModelLabel } from "../../util/cache-diagnostics"
import { Locale } from "../../util/locale"
import { railMetrics, railWidth } from "../../routes/session/rail"
import { RailRow, RailSection, RailSubheading, useRail } from "../../routes/session/rail-section"

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
  const dimensions = useTerminalDimensions()
  const rail = useRail()
  const diagnostics = createMemo(props.diagnostics)
  const fallback = createMemo(() => props.fallback?.())
  // A rail row right-aligns its value, so an over-long model identity would run into it. Rows are bounded
  // by the docked rail width minus its horizontal padding; outside a rail the section spans the terminal.
  const rowWidth = createMemo(() => {
    if (!rail) return dimensions().width
    const metrics = railMetrics(dimensions().width)
    return Math.floor(railWidth(dimensions().width)) - metrics.paddingLeft - metrics.paddingRight
  })
  const modelText = (model: SessionCacheDiagnostics["model"], opposite: string) =>
    Locale.truncateWidth(contextModelLabel(model), Math.max(1, rowWidth() - opposite.length - 1))
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
  const spent = createMemo(() => {
    const value = diagnostics() ? props.cost?.() : fallback()?.cost
    return value === undefined ? undefined : { value }
  })
  const subagentCost = createMemo(() => {
    const value = props.subagentCost?.()
    return value === undefined || value === 0 ? undefined : { value }
  })
  const context = createMemo(() => {
    const value = diagnostics()?.context
    if (!value || value.limit === undefined) return "unreported"
    return `${value.total.toLocaleString()} / ${value.limit.toLocaleString()}`
  })
  const cache = createMemo(() => {
    const percent = cacheHitPercent(diagnostics()?.cache.hitRatio)
    return percent === undefined ? "unreported" : `${percent}%`
  })
  // Provider telemetry that never reported a cost stays unreported; zero would claim a free request.
  const modelSpend = createMemo(() =>
    (diagnostics()?.requests?.models ?? []).map((entry) => {
      const value = entry.cost === undefined ? "unreported" : money.format(entry.cost)
      return { label: modelText(entry.model, value), value }
    }),
  )
  const hasSpend = createMemo(() => Boolean(diagnostics() ?? fallback()))
  const hasCacheDetails = createMemo(() => {
    const value = diagnostics()
    if (!value) return false
    return Boolean(
      cachePrefixLabel(value.requests?.latestInvalidation) || value.cache.readReported || value.cache.writeReported,
    )
  })

  return (
    <RailSection section="context" title="CONTEXT" summary={summary()}>
      <Show when={diagnostics()}>
        {(value) => (
          <>
            <RailRow label="Model" value={modelText(value().model, "Model")} />
            <RailRow label="Context" value={context()} />
            <RailRow label="Cache" value={cache()} valueColor={themeV2.text.feedback.success.default} />
          </>
        )}
      </Show>
      <Show when={hasSpend()}>
        <>
          <Show when={diagnostics()}>
            <box height={1} flexShrink={0} />
          </Show>
          <RailSubheading>SPEND</RailSubheading>
          <For each={modelSpend()}>{(entry) => <RailRow label={entry.label} value={entry.value} />}</For>
          <Show when={spent()} fallback={<RailRow label="Total" value="unreported" />}>
            {(total) => <RailRow label="Total" value={money.format(total().value)} />}
          </Show>
          <Show when={subagentCost()}>
            {(subagentCost) => <RailRow label="· subagents" value={money.format(subagentCost().value)} />}
          </Show>
        </>
      </Show>
      <Show when={hasCacheDetails()}>
        <>
          <box height={1} flexShrink={0} />
          <RailSubheading>CACHE</RailSubheading>
        </>
      </Show>
      <Show when={diagnostics()}>
        {(value) => (
          <>
            <Show when={cachePrefixLabel(value().requests?.latestInvalidation)}>
              {(prefix) => <RailRow label="Prefix" value={prefix()} valueColor={themeV2.text.feedback.success.default} />}
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
