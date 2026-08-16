import type { SessionCacheDiagnostics } from "@ycoding-ai/client"
import { Plugin } from "@ycoding-ai/plugin/tui"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { formatCacheDiagnostics } from "../../util/cache-diagnostics"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function SidebarCacheContent(props: {
  diagnostics: () => SessionCacheDiagnostics | null | undefined
  currentModel?: () => { identity: string; limit: number } | undefined
  cost?: () => number | undefined
}) {
  const { themeV2 } = useTheme()
  const diagnostics = createMemo(props.diagnostics)
  const formatted = createMemo(() => {
    const value = diagnostics()
    return value ? formatCacheDiagnostics(value) : undefined
  })
  const cost = createMemo(() => props.cost?.() ?? 0)
  const currentModel = createMemo(() => props.currentModel?.())

  return (
    <box>
      <text fg={themeV2.text.default}>
        <b>Last step context</b>
      </text>
      <Show when={diagnostics()} fallback={<text fg={themeV2.text.subdued}>Not measured</text>}>
        {(value) => (
          <>
            <text fg={themeV2.text.subdued}>
              {value().context.total.toLocaleString()}
              {value().context.limit === undefined
                ? " tokens"
                : ` / ${Number(value().context.limit).toLocaleString()} tokens`}
            </text>
            <Show when={value().context.percent !== undefined}>
              <text fg={themeV2.text.subdued}>{value().context.percent}% used</text>
            </Show>
            <Show when={formatted()?.model}>{(model) => <text fg={themeV2.text.subdued}>{model()}</text>}</Show>
            <text fg={themeV2.text.subdued}>Cached tokens still occupy context.</text>
            <text fg={themeV2.text.default} marginTop={1}>
              <b>Last step provider cache</b>
            </text>
            <Show when={formatted()?.cache}>{(cache) => <text fg={themeV2.text.subdued}>{cache()}</text>}</Show>
            <text fg={themeV2.text.subdued}>{value().cache.mechanism}</text>
          </>
        )}
      </Show>
      <Show when={currentModel()}>
        {(value) => (
          <box marginTop={1}>
            <text fg={themeV2.text.default}>
              <b>Current model context</b>
            </text>
            <text fg={themeV2.text.subdued}>{value().identity}</text>
            <text fg={themeV2.text.subdued}>{Number(value().limit).toLocaleString()} tokens</text>
          </box>
        )}
      </Show>
      <text fg={themeV2.text.subdued} marginTop={1}>
        {money.format(cost())} spent
      </text>
    </box>
  )
}

function View(props: { context: Plugin.Context; sessionID: string }) {
  const diagnostics = createMemo(() => props.context.data.session.diagnostics.get(props.sessionID))
  const currentModel = createMemo(() => {
    const session = props.context.data.session.get(props.sessionID)
    if (!session?.model) return
    const model = props.context.data.location
      .model
      .list(session.location)
      ?.find((item) => item.providerID === session.model?.providerID && item.id === session.model?.id)
    if (!model?.limit.context) return
    return {
      identity: `${session.model.providerID}/${session.model.id}`,
      limit: model.limit.context,
    }
  })
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))
  return <SidebarCacheContent diagnostics={diagnostics} currentModel={currentModel} cost={cost} />
}

export default Plugin.define({
  id: "internal:sidebar-context",
  setup(context) {
    context.ui.slot("sidebar.content", (props) => <View context={context} sessionID={props.sessionID} />)
  },
})
