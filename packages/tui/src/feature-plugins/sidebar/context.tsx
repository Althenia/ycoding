import type { ProviderRequestSummary, SessionCacheDiagnostics, SessionMessageInfo } from "@ycoding-ai/client"
import { useTerminalDimensions } from "@opentui/solid"
import { Plugin } from "@ycoding-ai/plugin/tui"
import { createEffect, createMemo, For, Show } from "solid-js"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"
import {
  cacheHitPercent,
  cachePrefixLabel,
  contextModelLabel,
  formatDiagnosticsModel,
} from "../../util/cache-diagnostics"
import { Locale } from "../../util/locale"
import { railMetrics, railWidth } from "../../routes/session/rail"
import { RailRow, RailSection, RailSubheading, useRail } from "../../routes/session/rail-section"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function SidebarCacheContent(props: {
  diagnostics: () => SessionCacheDiagnostics | null | undefined
  usage?: () => ProviderRequestSummary | undefined
  summarizing?: () => boolean
  fallback?: () => { tokens: { input: number; output: number }; cost: number } | undefined
  currentModel?: () => { identity: string; limit: number } | undefined
  cost?: () => number | undefined
}) {
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()
  const rail = useRail()
  const diagnostics = createMemo(props.diagnostics)
  const usage = createMemo(() => props.usage?.() ?? diagnostics()?.requests)
  const summarizing = createMemo(() => props.summarizing?.() ?? false)
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
  // Spend rows stay provider-distinct (costs are provider-priced), so the label carries provider+model+
  // variant to keep same id/variant rows from OpenRouter and OpenAI distinguishable. The Context Model row
  // keeps the shorter id-only label via modelText.
  const spendModelLabel = (model: SessionCacheDiagnostics["model"], opposite: string) =>
    Locale.truncateWidth(
      formatDiagnosticsModel(model) ?? contextModelLabel(model),
      Math.max(1, rowWidth() - opposite.length - 1),
    )
  const summary = createMemo(() => {
    const value = diagnostics()
    return value
      ? [
          value.context.percent === undefined ? undefined : `${value.context.percent}%`,
          cacheHitPercent(value.cache.hitRatio) === undefined
            ? undefined
            : `${cacheHitPercent(value.cache.hitRatio)}% hit`,
        ]
          .filter((item): item is string => item !== undefined)
          .join(" · ")
      : undefined
  })
  // The provider-request summary collapses the session cost to undefined when any request's cost is
  // unknown, so Total reflects "unknown" rather than a $0-derived sum. Only the priced requests are summed.
  const spent = createMemo(() => {
    const requests = usage()
    if (requests) return requests.cost === undefined ? undefined : { value: requests.cost }
    const value = diagnostics() ? props.cost?.() : fallback()?.cost
    return value === undefined ? undefined : { value }
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
  const modelSpend = createMemo(() =>
    (usage()?.models ?? []).map((entry) => {
      const value = entry.cost === undefined ? "Not reported" : money.format(entry.cost)
      return { label: spendModelLabel(entry.model, value), value }
    }),
  )
  const hasSpend = createMemo(() => Boolean(usage() ?? diagnostics() ?? fallback()))
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
            <Show when={summarizing()}>
              <RailRow label="Status" value="Summarizing" valueColor={themeV2.text.feedback.info.default} />
            </Show>
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
          <Show when={spent()} fallback={<RailRow label="Total" value="Not reported" />}>
            {(total) => <RailRow label="Total" value={money.format(total().value)} />}
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
  const data = useData()
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const diagnostics = createMemo(() => props.context.data.session.diagnostics.get(props.sessionID))
  const usage = createMemo(() => data.session.usage.get(props.sessionID))
  const summarizing = createMemo(() =>
    isConversationSummarizing(
      props.context.data.session.message.list(props.sessionID),
      data.session.compaction.list(props.sessionID),
    ),
  )
  const fallback = createMemo(() => {
    const current = session()
    return current
      ? { tokens: { input: current.tokens.input, output: current.tokens.output }, cost: current.cost }
      : undefined
  })
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))
  createEffect(() => {
    const current = session()
    if (!current) return
    void data.session.usage.sync(current.id).catch(() => undefined)
  })

  return (
    <SidebarCacheContent
      diagnostics={diagnostics}
      usage={usage}
      summarizing={summarizing}
      fallback={fallback}
      cost={cost}
    />
  )
}

export function isConversationSummarizing(
  messages: readonly SessionMessageInfo[],
  compactions: readonly { status: "pending" | "running" | "completed" | "failed" }[] = [],
) {
  return (
    compactions.some((item) => item.status !== "completed" && item.status !== "failed") ||
    messages.some((message) => message.type === "compaction" && !("jobID" in message) && message.status === "running")
  )
}

export default Plugin.define({
  id: "internal:sidebar-context",
  setup(context) {
    context.ui.slot("sidebar.content", (props) => <View context={context} sessionID={props.sessionID} />)
  },
})
