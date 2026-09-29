import type { ProviderRequestSummary, SessionCacheDiagnostics, SessionContextBreakdown, SessionInfo, SessionMessageInfo } from "@ycoding-ai/client"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, onMount, Show } from "solid-js"
import { BrandMark } from "../../component/logo"
import { useData } from "../../context/data"
import { Keymap } from "../../context/keymap"
import { useRoute, useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { formatDiagnosticsModel } from "../../util/cache-diagnostics"
import { Locale } from "../../util/locale"

const categories = [
  ["system", "System"], ["tools", "Tools"], ["user", "User"], ["assistant", "Assistant"],
  ["reasoning", "Reasoning"], ["toolCalls", "Tool calls"], ["other", "Other"],
] as const

export function contextBarCells(breakdown: SessionContextBreakdown, width: number) {
  const total = categories.reduce((sum, [key]) => sum + breakdown[key], 0)
  if (!total) return categories.map(() => 0)
  const nonzero = categories.filter(([key]) => breakdown[key] > 0).length
  const size = Math.max(nonzero, Math.trunc(width))
  const available = size - nonzero
  const raw = categories.map(([key]) => breakdown[key] > 0 ? (available * breakdown[key]) / total : 0)
  const cells = raw.map((value, index) => (breakdown[categories[index][0]] > 0 ? 1 : 0) + Math.floor(value))
  const remaining = size - cells.reduce((sum, count) => sum + count, 0)
  raw.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .toSorted((left, right) => right.fraction - left.fraction || left.index - right.index)
    .slice(0, remaining)
    .forEach(({ index }) => { cells[index] += 1 })
  return cells
}

export function SessionContextScreen() {
  const route = useRouteData("session-context")
  const router = useRoute()
  const data = useData()
  onMount(() => {
    void data.session.sync(route.sessionID).catch(() => undefined)
    void data.session.message.sync(route.sessionID).catch(() => undefined)
    void data.session.diagnostics.sync(route.sessionID).catch(() => undefined)
    void data.session.usage.sync(route.sessionID).catch(() => undefined)
  })
  return <ContextBreakdownContent
    session={data.session.get(route.sessionID)}
    messages={data.session.message.list(route.sessionID)}
    diagnostics={data.session.diagnostics.get(route.sessionID) ?? undefined}
    usage={data.session.usage.get(route.sessionID)}
    onBack={() => router.navigate({ type: "session", sessionID: route.sessionID })}
  />
}

export function ContextBreakdownContent(props: {
  session?: Pick<SessionInfo, "title" | "model" | "tokens" | "cost" | "time">
  messages: readonly Pick<SessionMessageInfo, "type">[]
  diagnostics?: SessionCacheDiagnostics
  usage?: ProviderRequestSummary
  onBack: () => void
}) {
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()
  const backShortcut = Keymap.useShortcut("session-context.back")
  Keymap.createLayer(() => ({
    mode: "base",
    commands: [{ id: "session-context.back", title: "Back to session", group: "Session", bind: "escape", run: props.onBack }],
    bindings: ["session-context.back"],
  }))
  const breakdown = () => props.diagnostics?.contextBreakdown
  const total = createMemo(() => categories.reduce((sum, [key]) => sum + (breakdown()?.[key] ?? 0), 0))
  const cells = createMemo(() => breakdown() ? contextBarCells(breakdown()!, Math.max(7, dimensions().width - 8)) : [])
  const tokens = () => props.diagnostics
    ? {
        input: props.diagnostics.tokens.uncachedInput,
        output: props.diagnostics.tokens.output,
        reasoning: props.diagnostics.tokens.reasoning,
        cacheRead: props.diagnostics.tokens.cacheRead,
        cacheWrite: props.diagnostics.tokens.cacheWrite,
      }
    : props.session?.tokens && {
        input: props.session.tokens.input,
        output: props.session.tokens.output,
        reasoning: props.session.tokens.reasoning,
        cacheRead: props.session.tokens.cache.read,
        cacheWrite: props.session.tokens.cache.write,
      }
  const rows = createMemo(() => [
    ["Session", props.session?.title ?? "—"],
    ["Messages", props.messages.length.toLocaleString()],
    ["Provider", props.diagnostics?.model.providerID ?? props.session?.model?.providerID ?? "—"],
    ["Model", formatDiagnosticsModel(props.diagnostics?.model ?? props.session?.model) ?? "—"],
    ["Context Limit", props.diagnostics?.context.limit?.toLocaleString() ?? "—"],
    ["Total Tokens", props.diagnostics?.context.total.toLocaleString() ?? "—"],
    ["Usage %", props.diagnostics?.context.percent === undefined ? "—" : `${props.diagnostics.context.percent}%`],
    ["Input Tokens", tokens()?.input.toLocaleString() ?? "—"],
    ["Output Tokens", tokens()?.output.toLocaleString() ?? "—"],
    ["Reasoning Tokens", tokens()?.reasoning.toLocaleString() ?? "—"],
    ["Cache Tokens read/write", tokens() ? `${tokens()!.cacheRead.toLocaleString()} / ${tokens()!.cacheWrite.toLocaleString()}` : "—"],
    ["User Messages", props.messages.filter((message) => message.type === "user").length.toLocaleString()],
    ["Assistant Messages", props.messages.filter((message) => message.type === "assistant").length.toLocaleString()],
    ["Total Cost", new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(props.usage ? props.usage.cost ?? 0 : props.session?.cost ?? 0)],
    ["Session Created", props.session ? Locale.datetime(props.session.time.created) : "—"],
    ["Last Activity", props.session?.time.active === undefined ? "—" : Locale.datetime(props.session.time.active)],
  ] as const)
  const hues = ["blue", "purple", "green", "orange", "red", "cyan", "yellow"] as const
  const color = (index: number) => themeV2.hue[hues[index]][500]

  return <box width={dimensions().width} height={dimensions().height} flexDirection="column" backgroundColor={themeV2.background.default}>
    <box height={3} flexShrink={0} flexDirection="row" alignItems="center" paddingLeft={3} paddingRight={3} backgroundColor={themeV2.background.chrome}>
      <BrandMark width={2} height={1} /><text> Context breakdown</text><box flexGrow={1} />
      <text fg={themeV2.text.subdued} onMouseUp={props.onBack}>{backShortcut() ?? "esc"} back</text>
    </box>
    <scrollbox flexGrow={1} paddingLeft={3} paddingRight={3} paddingTop={1}>
      <box flexDirection="column" gap={1}>
        <For each={Array.from({ length: dimensions().width >= 84 ? 8 : 16 }, (_, index) => index)}>{(index) =>
          <box flexDirection={dimensions().width >= 84 ? "row" : "column"}>
            <For each={dimensions().width >= 84 ? [rows()[index * 2], rows()[index * 2 + 1]] : [rows()[index]]}>
              {(row) => <box flexDirection="row" width={dimensions().width >= 84 ? "50%" : "100%"} minWidth={0}>
                <text width={25} fg={themeV2.text.subdued}>{row[0]}</text><text truncate>{row[1]}</text>
              </box>}
            </For>
          </box>
        }</For>
        <text fg={themeV2.text.default}>Context breakdown</text>
        <Show when={breakdown()} fallback={<text fg={themeV2.text.subdued}>The breakdown appears after this Session's next model step.</text>}>
          <box flexDirection="column" gap={1}>
            <box flexDirection="row"><For each={cells()}>{(count, index) => <text fg={color(index())}>{"█".repeat(count)}</text>}</For></box>
            <box flexDirection="row" flexWrap="wrap" gap={2}>
              <For each={categories}>{([key, label], index) => <text fg={color(index())}>● {label} {total() ? (100 * breakdown()![key] / total()).toFixed(1) : "0.0"}%</text>}</For>
            </box>
            <box flexDirection="row">
              <text width={29} fg={themeV2.text.subdued}>Category</text><text width={13} fg={themeV2.text.subdued}>{"Tokens".padStart(13)}</text><text width={8} fg={themeV2.text.subdued}>{"%".padStart(8)}</text>
            </box>
            <For each={categories}>{([key, label], index) => <box flexDirection="row">
              <text width={29} fg={color(index())}>{label}</text>
              <text width={13}>{breakdown()![key].toLocaleString().padStart(13)}</text>
              <text width={8}>{`${total() ? (100 * breakdown()![key] / total()).toFixed(1) : "0.0"}%`.padStart(8)}</text>
            </box>}</For>
            <box flexDirection="row"><text width={29}>Total</text><text width={13}>{total().toLocaleString().padStart(13)}</text><text width={8}>{(total() ? "100.0%" : "0.0%").padStart(8)}</text></box>
          </box>
        </Show>
      </box>
    </scrollbox>
  </box>
}
