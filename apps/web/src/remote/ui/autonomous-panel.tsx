import { For, Show } from "solid-js"
import { Icon } from "../../ui/icon"
import { autonomyKeyIntent, autonomyModeLabel, autonomyModes, autonomyRows, type AutonomyIntent } from "../autonomy"
import type { SessionAutonomyView } from "../projection"
import "./autonomous-panel.css"

export function AutonomousPanel(props: {
  readonly autonomy: SessionAutonomyView
  readonly selected: number
  readonly busy: boolean
  readonly reachable: boolean
  readonly failure?: string
  readonly announcement?: string
  readonly onIntent: (intent: AutonomyIntent) => void
}) {
  const rows = () => autonomyRows(props.autonomy)
  const locked = () => props.busy || !props.reachable
  return <div class="autonomous" aria-busy={props.busy ? "true" : undefined} onKeyDown={(event) => {
    const intent = autonomyKeyIntent(event, props.selected)
    if (intent === undefined || intent.type !== "select" && locked()) return
    event.preventDefault()
    props.onIntent(intent)
  }}>
    <p class="autonomous__note">Denies and permission ceilings always apply; hard and custom-rule reviews always need you.</p>
    <div class="autonomous__rows" role="listbox" aria-label="Autonomous settings" tabindex="0" autofocus aria-activedescendant={`autonomous-row-${rows()[props.selected]?.category}`}>
      <For each={rows()}>{(row, index) => <div
        id={`autonomous-row-${row.category}`}
        class="autonomous__row"
        role="option"
        aria-selected={props.selected === index() ? "true" : "false"}
        aria-label={`${row.title}: ${row.label}${row.inheritedFrom === undefined ? "" : `, inherited from ${row.inheritedFrom}`}`}
        data-category={row.category}
        data-mode={row.mode}
        onClick={() => props.onIntent({ type: "select", index: index() })}
      >
        <span class="autonomous__text">
          <span class="autonomous__title">{row.title}</span>
          <span class="autonomous__decider">{row.decider}</span>
          <Show when={row.inheritedFrom}>{(source) => <span class="autonomous__source">Inherited from {source()}</span>}</Show>
          <Show when={row.inheritedFrom}><span class="autonomous__source">This Session: {autonomyModeLabel(row.own)}</span></Show>
        </span>
        <span class="autonomous__stepper">
          <button type="button" tabindex="-1" class="button button--ghost button--icon autonomous__arrow" aria-label={`Previous ${row.title} mode`} disabled={locked()} onClick={() => props.onIntent({ type: "cycle", category: row.category, step: -1 })}><Icon name="arrow-left" /></button>
          <span class="autonomous__value" data-mode={row.mode}>{row.label}</span>
          <button type="button" tabindex="-1" class="button button--ghost button--icon autonomous__arrow" aria-label={`Next ${row.title} mode`} disabled={locked()} onClick={() => props.onIntent({ type: "cycle", category: row.category, step: 1 })}><Icon name="arrow-right" /></button>
        </span>
      </div>}</For>
    </div>
    <div class="autonomous__all" role="group" aria-label="Set all categories">
      <For each={autonomyModes}>{(mode, index) => <button type="button" class="button button--secondary button--small autonomous__all-button" aria-label={`Set all to ${autonomyModeLabel(mode)}`} aria-keyshortcuts={String(index() + 1)} disabled={locked()} onClick={() => props.onIntent({ type: "all", mode })}>{autonomyModeLabel(mode)}<span class="autonomous__key" aria-hidden="true">{index() + 1}</span></button>}</For>
    </div>
    <Show when={!props.reachable}><p class="autonomous__offline">Reconnect to change autonomy.</p></Show>
    <Show when={props.failure}>{(message) => <p class="autonomous__failure" role="alert">{message()}</p>}</Show>
    <p class="visually-hidden" role="status">{props.announcement ?? ""}</p>
  </div>
}
