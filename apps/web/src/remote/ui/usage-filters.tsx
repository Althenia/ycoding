import { createSignal, For, Show } from "solid-js"
import { CustomSelect } from "../../ui/custom-select"
import { customUsageRange, usageGroups, type UsageGroupPresentation, type UsageFiltersPresentation } from "./usage-filter-model"
import "./usage-filters.css"

export function UsageGroupControl(props: { readonly value: UsageGroupPresentation; readonly onChange: (group: UsageGroupPresentation) => void }) {
  return <CustomSelect label="Usage group" placeholder="Choose group" value={props.value} options={usageGroups} onChange={(value) => {
    const group = usageGroups.find((option) => option.value === value)
    if (group) props.onChange(group.value)
  }} />
}

export function UsageFilterControls(props: {
  readonly value: UsageFiltersPresentation
  readonly providers: readonly { readonly id: string; readonly label: string }[]
  readonly onChange: (value: UsageFiltersPresentation) => void
}) {
  const [from, setFrom] = createSignal("")
  const [to, setTo] = createSignal("")
  const [custom, setCustom] = createSignal(false)
  const [error, setError] = createSignal(false)
  return <div class="usage-filter-controls">
    <CustomSelect label="Usage provider" placeholder="All providers" value={props.value.provider} options={[{ value: "", label: "All providers" }, ...props.providers.map((provider) => ({ value: provider.id, label: provider.label }))]}
      onChange={(provider) => props.onChange({ ...props.value, provider, profile: "" })} />
    <For each={[{ key: "profile", label: "Recorded profile" }, { key: "model", label: "Model ID" }, { key: "effort", label: "Selected effort" }] as const}>{(field) =>
      <label class="field"><span class="field__label">{field.label}</span><input class="input" value={props.value[field.key]} placeholder="All" onChange={(event) => props.onChange({ ...props.value, [field.key]: event.currentTarget.value.trim() })} /></label>
    }</For>
    <CustomSelect label="Usage range" placeholder="Choose range" value={custom() ? "custom" : props.value.range} options={[{ value: "last7", label: "Last 7 days" }, { value: "last30", label: "Last 30 days" }, { value: "all", label: "All retained history" }, { value: "custom", label: "Custom UTC range" }]}
      onChange={(range) => {
        setCustom(range === "custom")
        if (range === "last7" || range === "last30" || range === "all") props.onChange({ ...props.value, range, from: undefined, to: undefined })
      }} />
    <Show when={custom()}><form class="usage-filter-controls__range" onSubmit={(event) => {
      event.preventDefault()
      const bounds = customUsageRange(from(), to())
      setError(bounds === undefined)
      if (bounds) props.onChange({ ...props.value, range: "custom", ...bounds })
    }}>
      <label class="field"><span class="field__label">From UTC (inclusive)</span><input class="input" aria-label="Usage from UTC" placeholder="YYYY-MM-DD" value={from()} onInput={(event) => setFrom(event.currentTarget.value)} /></label>
      <label class="field"><span class="field__label">To UTC (exclusive)</span><input class="input" aria-label="Usage to UTC" placeholder="YYYY-MM-DD" value={to()} onInput={(event) => setTo(event.currentTarget.value)} /></label>
      <button type="submit" class="button button--secondary">Apply range</button>
      <Show when={error()}><p class="field__hint" role="alert">Enter valid UTC dates with From before To.</p></Show>
    </form></Show>
  </div>
}
