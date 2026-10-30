import { createMemo, createSignal, createUniqueId, For, Index, Show } from "solid-js"
import { Icon, type IconName } from "../../ui/icon"
import {
  chartHeight, chartMax, chartWidth, fastestModels, generationFigureIDs, generationFigures, latencyLabel, liveHistory, liveModels, lineSegments, modelSpeedRows, rateLabel, stackedBars, trendDays,
  type UsageLive,
} from "./usage-speed-model"
import { joinParts } from "./usage-accounting"
import type { UsageReport } from "./usage-model"
import { UsageHeading } from "./usage-sections"
import "./usage-speed.css"

const grouped = new Intl.NumberFormat("en-US")
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

type ChartSeries = { readonly id: string; readonly label: string; readonly values: readonly (number | undefined)[]; readonly color: string }

function SeriesChart(props: {
  readonly id: string
  readonly title: string
  readonly icon: IconName
  readonly note: string
  readonly ordinal?: number | undefined
  readonly labels: readonly string[]
  readonly series: readonly ChartSeries[]
  readonly mode: "line" | "stacked"
  readonly format: (value: number) => string
  readonly empty: string
}) {
  const tableID = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const values = () => props.series.map((entry) => entry.values)
  const max = createMemo(() => chartMax(values(), props.mode === "stacked"))
  const measured = () => props.series.some((entry) => entry.values.some((value) => value !== undefined && (props.mode === "line" || value > 0)))
  const ids = createMemo(() => props.series.map((entry) => entry.id))
  const lines = createMemo(() => props.series.map((entry) => lineSegments(entry.values, max())))
  const bars = createMemo(() => stackedBars(values(), max()))
  const ticks = () => [props.labels[0], props.labels[Math.floor((props.labels.length - 1) / 2)], props.labels.at(-1)]
  const summary = () => `${props.title}: ${props.series.map((entry) => `${entry.label} peak ${props.format(Math.max(0, ...entry.values.flatMap((value) => value === undefined ? [] : [value])))}`).join(", ")}; exact values are in the table`
  return <div class="usage-series" data-chart={props.id}>
    <div class="usage-series__head"><div><UsageHeading level={3} ordinal={props.ordinal}><Icon name={props.icon} />{props.title}</UsageHeading><p>{props.note}</p></div>
      <Show when={measured()}><button type="button" aria-expanded={open()} aria-controls={tableID} onClick={() => setOpen(!open())}><Icon name="sessions" />{open() ? "Hide table" : "View table"}</button></Show></div>
    <Show when={measured()} fallback={<p class="usage-series__empty">{props.empty}</p>}>
      <svg viewBox={`0 0 ${chartWidth} ${chartHeight + 4}`} role="img" aria-label={summary()} preserveAspectRatio="none">
        <line x1="0" y1={chartHeight} x2={chartWidth} y2={chartHeight} class="usage-series__axis" />
        <For each={ids()}>{(id, seriesIndex) => {
          const color = () => props.series[seriesIndex()]?.color
          return <Show when={props.mode === "line"} fallback={<Index each={bars()[seriesIndex()]}>{(bar) => <rect x={bar().x} y={bar().y} width={bar().width} height={Math.max(bar().height, 0)} rx="2" fill={color()} data-series={id} />}</Index>}>
            <Index each={lines()[seriesIndex()]}>{(segment) => <Show when={segment().length > 1} fallback={<circle cx={segment()[0]!.x} cy={segment()[0]!.y} r="3" fill={color()} data-series={id} />}>
              <polyline points={segment().map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")} fill="none" stroke={color()} stroke-width="2" vector-effect="non-scaling-stroke" data-series={id} />
            </Show>}</Index>
          </Show>
        }}</For>
      </svg>
      <div class="usage-series__labels"><span>{ticks()[0]}</span><span>{ticks()[1]}</span><span>{ticks()[2]}</span></div>
      <ul class="usage-series__legend" aria-label={`${props.title} series`}><For each={ids()}>{(id, index) => <li><span class="usage-series__swatch" style={{ background: props.series[index()]?.color }} aria-hidden="true" />{props.series[index()]?.label ?? id}</li>}</For></ul>
      <Show when={open()}><div id={tableID} class="usage-table-wrap"><table><caption>{props.title}</caption>
        <thead><tr><th scope="col">Time</th><For each={props.series}>{(entry) => <th scope="col">{entry.label}</th>}</For></tr></thead>
        <tbody><Index each={props.labels}>{(label, row) => <tr><th scope="row">{label()}</th><For each={props.series}>{(entry) => <td>{entry.values[row] === undefined ? "" : props.format(entry.values[row]!)}</td>}</For></tr>}</Index></tbody>
      </table></div></Show>
    </Show>
  </div>
}

const green = "var(--yc-green-strong)"
const yellow = "var(--yc-yellow-strong)"
const muted = "var(--yc-text-muted)"
const danger = "var(--yc-danger)"
const soft = "var(--yc-green)"
const border = "var(--yc-border-strong)"

export function GenerationOverview(props: { readonly live: UsageLive; readonly monthly: UsageReport | undefined; readonly ordinal: number }) {
  const figures = createMemo(() => generationFigures(props.live, props.monthly))
  const history = createMemo(() => liveHistory(props.live))
  const models = createMemo(() => liveModels(props.live))
  const modelKeys = createMemo(() => models().map((entry) => entry.key))
  return <section class="usage-generation" aria-labelledby="usage-generation-title">
    <div class="usage-section-head"><UsageHeading level={2} id="usage-generation-title" ordinal={props.ordinal}><Icon name="zap" />Generation</UsageHeading><p>Live figures are estimated from received output; monthly figures come from recorded requests</p></div>
    <dl class="usage-figures"><For each={generationFigureIDs}>{(id) => {
      const figure = () => figures().find((entry) => entry.id === id)!
      return <div class="usage-figure" data-figure={id}><dt>{figure().label}</dt><dd class="usage-figure__value">{figure().value}</dd><Show when={figure().note !== ""}><dd class="usage-figure__note">{figure().note}</dd></Show></div>
    }}</For></dl>
    <div class="usage-series-grid" data-group="live">
      <SeriesChart id="live-rate" title="Live output rate" icon="zap" note="Aggregate tok/s · 5 s resolution · estimated" labels={history().map((point) => point.label)}
        series={[{ id: "rate", label: "Output tok/s", values: history().map((point) => point.rate), color: green }]} mode="line" format={(value) => rateLabel(value, true)} empty="No live output in the recent window." />
      <SeriesChart id="live-concurrency" title="Concurrent generations" icon="sessions" note="Active generations · 5 s resolution" labels={history().map((point) => point.label)}
        series={[{ id: "active", label: "Active", values: history().map((point) => point.active), color: yellow }]} mode="line" format={(value) => grouped.format(value)} empty="No generations in the recent window." />
    </div>
    <Show when={models().length > 0}><ul class="usage-live-models" aria-label="Active models"><For each={modelKeys()}>{(key) => {
      const entry = () => models().find((item) => item.key === key)!
      return <li><span class="usage-live-models__name">{entry().model}<span class="usage-provider-chip">{entry().provider}</span></span><span>{grouped.format(entry().active)} active · {grouped.format(entry().streaming)} streaming</span><strong>{entry().rate}</strong></li>
    }}</For></ul></Show>
  </section>
}

export function UsageTrends(props: { readonly daily: UsageReport | undefined; readonly now: number; readonly timeZone: string | undefined; readonly zoneLabel: string; readonly scope?: string | undefined; readonly ordinal: number }) {
  const days = createMemo(() => trendDays(props.daily, props.now, props.timeZone))
  const labels = () => days().map((day) => day.key)
  const note = () => `${props.zoneLabel} days · last 30${props.scope === undefined ? "" : ` · ${props.scope}`}`
  return <section class="usage-trends" aria-label="Performance over time" data-group="trends">
    <SeriesChart id="requests" title="Request volume" icon="sessions" note={note()} ordinal={props.ordinal} labels={labels()} series={[{ id: "requests", label: "Requests", values: days().map((day) => day.requests), color: green }]} mode="stacked" format={(value) => grouped.format(value)} empty="No requests in this period." />
    <SeriesChart id="tokens" title="Token consumption" icon="hash" note={note()} labels={labels()} mode="stacked" format={(value) => compact.format(value)} empty="No tokens recorded in this period."
      series={[
        { id: "input", label: "Input", values: days().map((day) => day.input), color: green },
        { id: "output", label: "Output", values: days().map((day) => day.output), color: yellow },
        { id: "reasoning", label: "Reasoning", values: days().map((day) => day.reasoning), color: muted },
        { id: "cacheRead", label: "Cache read", values: days().map((day) => day.cacheRead), color: soft },
        { id: "cacheWrite", label: "Cache write", values: days().map((day) => day.cacheWrite), color: border },
      ]} />
    <SeriesChart id="ttft" title="Time to first output" icon="zap" note={`${note()} · daily percentiles`} labels={labels()} mode="line" format={latencyLabel} empty="No first-output samples in this period."
      series={[{ id: "p50", label: "p50", values: days().map((day) => day.ttftP50), color: green }, { id: "p95", label: "p95", values: days().map((day) => day.ttftP95), color: yellow }]} />
    <SeriesChart id="latency" title="Request latency" icon="sessions" note={`${note()} · daily percentiles`} labels={labels()} mode="line" format={latencyLabel} empty="No latency samples in this period."
      series={[{ id: "p50", label: "p50", values: days().map((day) => day.totalP50), color: green }, { id: "p95", label: "p95", values: days().map((day) => day.totalP95), color: yellow }]} />
    <SeriesChart id="errors" title="Error rate" icon="usage" note={`${note()} · failed share of finished requests`} labels={labels()} mode="stacked" format={(value) => `${oneDecimal.format(value)}%`} empty="No outcome data in this period."
      series={[{ id: "errorRate", label: "Failed", values: days().map((day) => day.errorRate), color: danger }]} />
    <SeriesChart id="throughput" title="Output throughput" icon="zap" note={`${note()} · aggregate tok/s`} labels={labels()} mode="line" format={(value) => rateLabel(value)} empty="No measurable throughput in this period."
      series={[{ id: "rate", label: "Output tok/s", values: days().map((day) => day.rate), color: green }]} />
    <SeriesChart id="concurrency" title="Average concurrency" icon="sessions" note={`${note()} · concurrent requests`} labels={labels()} mode="line" format={(value) => oneDecimal.format(value)} empty="No concurrency data in this period."
      series={[{ id: "concurrency", label: "Concurrent requests", values: days().map((day) => day.concurrency), color: yellow }]} />
  </section>
}

export function ModelSpeedComparison(props: { readonly monthly: UsageReport | undefined; readonly providers: readonly { readonly providerID: string; readonly label: string }[]; readonly ordinal: number }) {
  const rows = createMemo(() => fastestModels(modelSpeedRows(props.monthly, props.providers)))
  const keys = createMemo(() => rows().map((row) => row.key))
  const peak = () => Math.max(1, ...rows().map((row) => row.mean ?? 0))
  return <section class="usage-model-speed" aria-labelledby="usage-model-speed-title" data-group="comparison">
    <div class="usage-section-head"><UsageHeading level={2} id="usage-model-speed-title" ordinal={props.ordinal}><Icon name="cpu" />Model speed · this month</UsageHeading><p>Average tok/s is the mean of per-request rates</p></div>
    <Show when={keys().length > 0} fallback={<p class="usage-message">No measurable generation speed by model this month.</p>}>
      <ul class="usage-speed-bars"><For each={keys()}>{(key) => {
        const row = () => rows().find((entry) => entry.key === key)!
        return <li data-model-speed={key}><span class="usage-speed-bars__name">{row().model}<span class="usage-provider-chip">{row().provider}</span></span>
          <span class="usage-speed-bars__track" aria-hidden="true"><span style={{ width: `${(row().mean ?? 0) / peak() * 100}%` }} /></span>
          <strong>{rateLabel(row().mean)}</strong><span class="usage-speed-bars__meta">{joinParts([row().ttftP95 === undefined ? undefined : `P95 TTFT ${latencyLabel(row().ttftP95)}`, `${grouped.format(row().requests)} requests`])}</span></li>
      }}</For></ul>
    </Show>
  </section>
}
