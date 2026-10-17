import { For, Show, onMount } from "solid-js"
import { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Keymap } from "../../context/keymap"
import { DialogHeader, DialogTitle, useDialog } from "../../ui/dialog"
import { useTheme } from "../../context/theme"
import { forecastLines, forecastSummary, measuredSpeedLines, unitCostLines, type ForecastPresentation, type SpeedPresentation, type UnitCostPresentation } from "../../util/usage-accounting"

export function UsageSpeedDetails(props: { speed?: SpeedPresentation }) {
  const { theme } = useTheme()
  return <box flexDirection="column" flexShrink={0}><For each={measuredSpeedLines(props.speed)}>{(line) => <text fg={theme.text.subdued} wrapMode="word">{line}</text>}</For></box>
}

export function TaskCostDetails(props: { unit: Omit<UnitCostPresentation, "inputID"> }) {
  const { theme } = useTheme()
  return <box flexDirection="column" flexShrink={0}>
    <For each={unitCostLines(props.unit, "Task cost (inclusive)")}>{(line) => <text fg={theme.text.subdued} wrapMode="word">{line}</text>}</For>
    <text fg={theme.text.subdued} wrapMode="word">Includes descendants and later dispatches. Inclusive task rows overlap; do not add them for a family total.</text>
  </box>
}

export function QuotaForecastBlock(props: { forecast: ForecastPresentation; now: number; asOf?: number }) {
  const { theme } = useTheme()
  return <box flexDirection="column" flexShrink={0}><For each={forecastLines(props.forecast, props.now, props.asOf)}>{(line) => <text fg={theme.text.subdued} wrapMode="word">{line}</text>}</For></box>
}

export function QuotaForecastSummary(props: { forecast: ForecastPresentation; now: number; asOf?: number }) {
  const { theme } = useTheme()
  const summary = () => forecastSummary(props.forecast, props.now, props.asOf)
  return <text fg={summary().tone === "error" ? theme.text.feedback.error.default : summary().tone === "warning" ? theme.text.feedback.warning.default : theme.text.subdued} wrapMode="word">{summary().text}</text>
}

export function TaskCostDialog(props: { unit?: Omit<UnitCostPresentation, "inputID">; loading: boolean; onRefresh: () => void }) {
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  let scroll: ScrollBoxRenderable | undefined
  onMount(() => dialog.setSize("medium"))
  Keymap.createLayer(() => ({ mode: "modal", commands: [
    { id: "task-cost.page-up", title: "Scroll task cost up", bind: "pageup", run: () => scroll?.scrollBy(-Math.max(1, scroll.viewport.height)) },
    { id: "task-cost.page-down", title: "Scroll task cost down", bind: "pagedown", run: () => scroll?.scrollBy(Math.max(1, scroll.viewport.height)) },
    { id: "task-cost.refresh", title: "Refresh recursive task cost", bind: "r", run: props.onRefresh },
  ] }))
  return <box flexDirection="column" paddingBottom={1}>
    <DialogHeader title={<DialogTitle>Recursive task cost (inclusive)</DialogTitle>} />
    <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} maxHeight={Math.max(3, dimensions().height - Math.floor(dimensions().height / 4) - 6)} scrollbarOptions={{ visible: false }}>
      <box paddingLeft={3} paddingRight={3}><Show when={props.unit} fallback={<text fg={theme.text.subdued}>Task cost (inclusive) {props.loading ? "loading" : "unreported"}</text>}>{(unit) => <TaskCostDetails unit={unit()} />}</Show></box>
    </scrollbox>
    <text paddingLeft={3} fg={theme.text.subdued}>Page Up/Page Down scroll · r refresh · Escape close</text>
  </box>
}
