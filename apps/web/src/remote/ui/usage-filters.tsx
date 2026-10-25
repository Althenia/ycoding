import { createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { CustomSelect } from "../../ui/custom-select"
import { Icon } from "../../ui/icon"
import { Modal } from "../../ui/modal"
import { visualViewportFrame, watchVisualViewport } from "../../ui/visual-viewport"
import {
  commitUsageFilterDraft, customUsageRange, defaultUsageFilters, defaultUsageGroup, usageFilterCount, usageFilterDraft, usageFilterSummary, usageGroups, usageRangeChoices,
  type UsageFilterDraft, type UsageGroupPresentation, type UsageFiltersPresentation,
} from "./usage-filter-model"
import "./usage-filters.css"

export function UsageGroupControl(props: { readonly value: UsageGroupPresentation; readonly onChange: (group: UsageGroupPresentation) => void }) {
  return <div class="usage-group-control field"><span class="field__label"><Icon name="sessions" />Group</span><CustomSelect label="Usage group" placeholder="Choose group" value={props.value} options={usageGroups} onChange={(value) => {
    const group = usageGroups.find((option) => option.value === value)
    if (group) props.onChange(group.value)
  }} /></div>
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
    <div class="field"><span class="field__label"><Icon name="package" />Provider</span><CustomSelect label="Usage provider" placeholder="All providers" value={props.value.provider} options={[{ value: "", label: "All providers" }, ...props.providers.map((provider) => ({ value: provider.id, label: provider.label }))]}
      onChange={(provider) => props.onChange({ ...props.value, provider, profile: "" })} /></div>
    <For each={[{ key: "profile", label: "Recorded profile", icon: "user" }, { key: "model", label: "Model ID", icon: "cpu" }, { key: "effort", label: "Selected effort", icon: "sparkles" }] as const}>{(field) =>
      <label class="field"><span class="field__label"><Icon name={field.icon} />{field.label}</span><input class="input" value={props.value[field.key]} placeholder="All" onChange={(event) => props.onChange({ ...props.value, [field.key]: event.currentTarget.value.trim() })} /></label>
    }</For>
    <div class="field"><span class="field__label"><Icon name="sessions" />Range</span><CustomSelect label="Usage range" placeholder="Choose range" value={custom() ? "custom" : props.value.range} options={[{ value: "last7", label: "Last 7 days" }, { value: "last30", label: "Last 30 days" }, { value: "all", label: "All retained history" }, { value: "custom", label: "Custom UTC range" }]}
      onChange={(range) => {
        setCustom(range === "custom")
        if (range === "last7" || range === "last30" || range === "all") props.onChange({ ...props.value, range, from: undefined, to: undefined })
      }} /></div>
    <Show when={custom()}><form class="usage-filter-controls__range" onSubmit={(event) => {
      event.preventDefault()
      const bounds = customUsageRange(from(), to())
      setError(bounds === undefined)
      if (bounds) props.onChange({ ...props.value, range: "custom", ...bounds })
    }}>
      <label class="field"><span class="field__label">From UTC (inclusive)</span><input class="input" aria-label="Usage from UTC" placeholder="YYYY-MM-DD" value={from()} onInput={(event) => setFrom(event.currentTarget.value)} /></label>
      <label class="field"><span class="field__label">To UTC (exclusive)</span><input class="input" aria-label="Usage to UTC" placeholder="YYYY-MM-DD" value={to()} onInput={(event) => setTo(event.currentTarget.value)} /></label>
      <button type="submit" class="button button--secondary"><Icon name="check" />Apply range</button>
      <Show when={error()}><p class="field__hint" role="alert">Enter valid UTC dates with From before To.</p></Show>
    </form></Show>
  </div>
}

type FilterProviders = readonly { readonly id: string; readonly label: string }[]

export function UsageFilterSummary(props: {
  readonly group: UsageGroupPresentation
  readonly filters: UsageFiltersPresentation
  readonly providers: FilterProviders
  readonly onApply: (group: UsageGroupPresentation, filters: UsageFiltersPresentation) => void
}) {
  const [request, setRequest] = createSignal<{ readonly trigger: HTMLButtonElement; readonly pointerOpened: boolean }>()
  const active = () => usageFilterCount(props.group, props.filters)
  const summary = () => usageFilterSummary(props.group, props.filters, props.providers.find((provider) => provider.id === props.filters.provider)?.label).join(" · ")
  return <div class="usage-filter-bar">
    <p class="usage-filter-bar__summary" aria-label={`Active filters: ${summary()}`}>{summary()}</p>
    <button type="button" class="button button--secondary usage-filter-bar__trigger" data-cursor="action" aria-haspopup="dialog" aria-label={active() === 0 ? "Filters" : `Filters, ${active()} active`}
      onClick={(event) => setRequest({ trigger: event.currentTarget, pointerOpened: event.detail > 0 })}>
      <Icon name="settings" />Filters<Show when={active() > 0}><span class="usage-filter-bar__count" aria-hidden="true">{active()}</span></Show>
    </button>
    <Show when={request()} keyed>{(selected) => <Portal><FilterSheet trigger={selected.trigger} pointerOpened={selected.pointerOpened} group={props.group} filters={props.filters} providers={props.providers}
      onApply={props.onApply} onClose={() => setRequest(undefined)} /></Portal>}</Show>
  </div>
}

function FilterSheet(props: {
  readonly trigger: HTMLButtonElement
  readonly pointerOpened: boolean
  readonly group: UsageGroupPresentation
  readonly filters: UsageFiltersPresentation
  readonly providers: FilterProviders
  readonly onApply: (group: UsageGroupPresentation, filters: UsageFiltersPresentation) => void
  readonly onClose: () => void
}) {
  const [draft, setDraft] = createSignal(usageFilterDraft(props.group, props.filters))
  const [invalid, setInvalid] = createSignal(false)
  const [frame, setFrame] = createSignal({ top: 0, height: Math.round(window.visualViewport?.height ?? window.innerHeight) })
  let close: (() => void) | undefined
  onCleanup(watchVisualViewport((viewport) => setFrame(visualViewportFrame(viewport) ?? { top: 0, height: Math.round(window.innerHeight) })))
  const edit = (change: Partial<UsageFilterDraft>) => setDraft({ ...draft(), ...change })
  const apply = (event: SubmitEvent) => {
    event.preventDefault()
    const next = commitUsageFilterDraft(draft())
    setInvalid(next === undefined)
    if (!next) return
    props.onApply(next.group, next.filters)
    close?.()
  }
  return <Modal class="overlay--usage-filters" label="Usage filters" returnFocus={props.trigger} pointerOpened={props.pointerOpened} onClose={props.onClose} requestClose={(handoff) => { close = handoff }}
    surfaceStyle={{ "--usage-filters-top": `${frame().top}px`, "--usage-filters-height": `${frame().height}px` }}>
    <form class="usage-filter-sheet" onSubmit={apply}>
      <div class="usage-filter-sheet__fields">
        <div class="field"><span class="field__label"><Icon name="sessions" />Group</span><CustomSelect label="Usage group" placeholder="Choose group" value={draft().group} options={usageGroups}
          onChange={(value) => { const group = usageGroups.find((option) => option.value === value); if (group) edit({ group: group.value }) }} /></div>
        <div class="field"><span class="field__label"><Icon name="package" />Provider</span><CustomSelect label="Usage provider" placeholder="All providers" value={draft().provider} options={[{ value: "", label: "All providers" }, ...props.providers.map((provider) => ({ value: provider.id, label: provider.label }))]}
          onChange={(provider) => edit({ provider, profile: "" })} /></div>
        <For each={[{ key: "profile", label: "Recorded profile", icon: "user" }, { key: "model", label: "Model ID", icon: "cpu" }, { key: "effort", label: "Selected effort", icon: "sparkles" }] as const}>{(field) =>
          <label class="field"><span class="field__label"><Icon name={field.icon} />{field.label}</span><input class="input" value={draft()[field.key]} placeholder="All" onInput={(event) => setDraft({ ...draft(), [field.key]: event.currentTarget.value })} /></label>
        }</For>
        <div class="field" role="group" aria-label="Usage range"><span class="field__label"><Icon name="sessions" />Range</span>
          <div class="usage-filter-sheet__ranges"><For each={usageRangeChoices}>{(choice) =>
            <button type="button" class="usage-filter-sheet__range" aria-pressed={draft().range === choice.value} data-cursor="action" onClick={() => edit({ range: choice.value })}>
              <Icon name="check" />{choice.label}
            </button>
          }</For></div>
        </div>
        <Show when={draft().range === "custom"}>
          <label class="field"><span class="field__label">From UTC (inclusive)</span><input class="input" aria-label="Usage from UTC" inputmode="numeric" placeholder="YYYY-MM-DD" value={draft().fromText} onInput={(event) => edit({ fromText: event.currentTarget.value })} /></label>
          <label class="field"><span class="field__label">To UTC (exclusive)</span><input class="input" aria-label="Usage to UTC" inputmode="numeric" placeholder="YYYY-MM-DD" value={draft().toText} onInput={(event) => edit({ toText: event.currentTarget.value })} /></label>
        </Show>
        <Show when={invalid()}><p class="field__hint usage-filter-sheet__error" role="alert">Enter valid UTC dates with From before To.</p></Show>
      </div>
      <div class="usage-filter-sheet__actions">
        <button type="button" class="button button--secondary" onClick={() => { setInvalid(false); setDraft(usageFilterDraft(defaultUsageGroup, defaultUsageFilters)) }}><Icon name="reset" />Reset</button>
        <button type="submit" class="button button--primary"><Icon name="check" />Apply filters</button>
      </div>
    </form>
  </Modal>
}
