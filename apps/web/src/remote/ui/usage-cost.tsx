import { For, Show } from "solid-js"
import { Icon } from "../../ui/icon"
import { costCoverage, forecastLines, measuredSpeedLines, unitCostLines, type CostPresentation, type ForecastPresentation, type SpeedPresentation, type UnitCostPresentation } from "./usage-accounting"
import "./usage-cost.css"

export function PromptCostBlock(props: { readonly unit: UnitCostPresentation }) {
  const lines = () => unitCostLines(props.unit)
  return <section class="usage-unit-cost" aria-label="Prompt cost" data-input-id={props.unit.inputID}>
    <strong classList={{ "usage-unit-cost__partial": !props.unit.complete }}>{lines()[0]}</strong>
    <details class="usage-unit-cost__details"><summary><Icon name="chevron-right" size={12} /> Cost breakdown</summary>
      <For each={lines().slice(1)}>{(line) => <p>{line}</p>}</For>
      <Show when={!props.unit.complete}><p>Retained evidence only; this is not a complete historical bill.</p></Show>
    </details>
  </section>
}

export function UsageStatisticsDetails(props: {
  readonly tokens: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cache: { readonly read: number; readonly write: number } }
  readonly cost?: CostPresentation
  readonly speed?: SpeedPresentation
}) {
  const count = (value: number) => value.toLocaleString("en-US")
  return <details class="usage-unit-cost__details usage-statistics-details"><summary><Icon name="chevron-right" size={12} /> Usage details</summary>
    <p>Input {count(props.tokens.input)} · Visible output {count(props.tokens.output)} · Reasoning {count(props.tokens.reasoning)}</p>
    <p>Cache read {count(props.tokens.cache.read)} · Cache write {count(props.tokens.cache.write)}</p>
    <Show when={props.cost}>{(cost) => <p>{costCoverage(cost())}</p>}</Show>
    <For each={measuredSpeedLines(props.speed)}>{(line) => <p>{line}</p>}</For>
  </details>
}

export function TaskCostDetails(props: { readonly unit: Omit<UnitCostPresentation, "inputID"> }) {
  const lines = () => unitCostLines(props.unit, "Task cost (inclusive)")
  return <details class="usage-unit-cost__details usage-statistics-details" aria-label="Recursive task cost"><summary><Icon name="chevron-right" size={12} /> {lines()[0]}</summary>
    <p>Includes descendants and later dispatches. Inclusive task rows overlap; do not add them for a family total.</p>
    <For each={lines().slice(1)}>{(line) => <p>{line}</p>}</For>
  </details>
}

export function QuotaForecastBlock(props: { readonly forecast: ForecastPresentation; readonly now: number; readonly asOf?: number }) {
  return <div class="usage-quota-forecast" aria-label="Quota forecast"><For each={forecastLines(props.forecast, props.now, props.asOf)}>{(line) => <p>{line}</p>}</For></div>
}
