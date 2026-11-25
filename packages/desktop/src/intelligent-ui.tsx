import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { IntelligentUi } from "../../schema/src/intelligent-ui"

export type TableSortState = { readonly key: string; readonly direction: "asc" | "desc" } | undefined

const TONE_LABELS: Readonly<Record<IntelligentUi.Tone, string>> = {
  default: "Neutral",
  positive: "Positive",
  warning: "Warning",
  danger: "Critical",
}

export function nextTableSort(current: TableSortState, key: string): TableSortState {
  if (!current || current.key !== key) return { key, direction: "asc" }
  if (current.direction === "asc") return { key, direction: "desc" }
  return undefined
}

function compareCellValues(left: IntelligentUi.TableCellValue | undefined, right: IntelligentUi.TableCellValue | undefined): number {
  if (left === right) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  if (typeof left === "number" && typeof right === "number") return left - right
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right)
  const leftText = String(left)
  const rightText = String(right)
  const leftNumeric = /^-?\d+(?:\.\d+)?/.exec(leftText)
  const rightNumeric = /^-?\d+(?:\.\d+)?/.exec(rightText)
  if (leftNumeric && rightNumeric && leftText.slice(leftNumeric[0].length) === rightText.slice(rightNumeric[0].length)) {
    const diff = Number(leftNumeric[0]) - Number(rightNumeric[0])
    if (diff !== 0) return diff
  }
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: "base" })
}

export function sortTableRows(
  rows: readonly IntelligentUi.TableRow[],
  sort: TableSortState,
): readonly IntelligentUi.TableRow[] {
  if (!sort) return rows
  const factor = sort.direction === "asc" ? 1 : -1
  return [...rows].sort((a, b) => compareCellValues(a.cells[sort.key], b.cells[sort.key]) * factor)
}

export function assistantUiCards(parts: readonly unknown[]): readonly IntelligentUi.UiCardEntry[] {
  return parts.flatMap((part) => IntelligentUi.extractUiCardEntries(part))
}

function formatCellText(value: IntelligentUi.TableCellValue | undefined): string {
  if (value === undefined) return "—"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return IntelligentUi.escapeDisplayText(String(value))
}

function MetricsSection(props: { readonly block: IntelligentUi.MetricsBlock }): JSX.Element {
  return (
    <section class="iui-block iui-metrics" data-ui-block="metrics" aria-label={props.block.title ? IntelligentUi.escapeDisplayText(props.block.title) : "Metrics"}>
      <Show when={props.block.title}>
        {(title) => <h4 class="iui-block__title">{IntelligentUi.escapeDisplayText(title())}</h4>}
      </Show>
      <div class="iui-metrics__grid">
        <For each={props.block.items}>
          {(item) => {
            const tone = () => item.tone ?? "default"
            return (
              <div class="iui-metric" data-ui-metric={item.label} data-tone={tone()}>
                <div class="iui-metric__top">
                  <span class="iui-metric__label">{IntelligentUi.escapeDisplayText(item.label)}</span>
                  <Show when={tone() !== "default"}>
                    <span class="iui-tone-badge" data-tone={tone()}>{TONE_LABELS[tone()]}</span>
                  </Show>
                </div>
                <strong class="iui-metric__value">{IntelligentUi.escapeDisplayText(item.value)}</strong>
                <Show when={item.detail}>
                  {(detail) => <span class="iui-metric__detail">{IntelligentUi.escapeDisplayText(detail())}</span>}
                </Show>
              </div>
            )
          }}
        </For>
      </div>
    </section>
  )
}

function CalloutSection(props: { readonly block: IntelligentUi.CalloutBlock }): JSX.Element {
  const tone = () => props.block.tone ?? "default"
  return (
    <section class="iui-block iui-callout" data-ui-block="callout" data-tone={tone()}>
      <div class="iui-callout__head">
        <Show when={props.block.title}>
          {(title) => <h4 class="iui-callout__title">{IntelligentUi.escapeDisplayText(title())}</h4>}
        </Show>
        <span class="iui-tone-badge" data-tone={tone()}>{TONE_LABELS[tone()]}</span>
      </div>
      <p class="iui-callout__body">{IntelligentUi.escapeDisplayText(props.block.body)}</p>
    </section>
  )
}

function TableSection(props: { readonly block: IntelligentUi.TableBlock }): JSX.Element {
  const [sort, setSort] = createSignal<TableSortState>(undefined)
  const rows = createMemo(() => sortTableRows(props.block.rows, sort()))

  return (
    <section class="iui-block iui-table-block" data-ui-block="table">
      <Show when={props.block.title}>
        {(title) => <h4 class="iui-block__title">{IntelligentUi.escapeDisplayText(title())}</h4>}
      </Show>
      <div class="iui-table__viewport" tabindex={0} role="region" aria-label={props.block.title ? IntelligentUi.escapeDisplayText(props.block.title) : "Comparison table"}>
        <table class="iui-table">
          <thead>
            <tr>
              <For each={props.block.columns}>
                {(column) => {
                  const direction = () => (sort()?.key === column.key ? sort()!.direction : undefined)
                  const ariaSort = () =>
                    direction() === "asc" ? "ascending" : direction() === "desc" ? "descending" : "none"
                  return (
                    <th
                      scope="col"
                      class="iui-table__th"
                      data-align={column.align ?? "left"}
                      aria-sort={column.sortable ? ariaSort() : undefined}
                    >
                      <Show
                        when={column.sortable}
                        fallback={<span class="iui-table__label">{IntelligentUi.escapeDisplayText(column.label)}</span>}
                      >
                        <button
                          type="button"
                          class="iui-table__sort"
                          data-sort-key={column.key}
                          onClick={() => setSort((current) => nextTableSort(current, column.key))}
                        >
                          <span>{IntelligentUi.escapeDisplayText(column.label)}</span>
                          <span class="iui-table__sort-indicator" aria-hidden="true">
                            {direction() === "asc" ? "↑" : direction() === "desc" ? "↓" : "↕"}
                          </span>
                        </button>
                      </Show>
                    </th>
                  )
                }}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={rows()} fallback={<tr><td class="iui-table__empty" colSpan={props.block.columns.length}>No rows</td></tr>}>
              {(row) => (
                <tr class="iui-table__row">
                  <For each={props.block.columns}>
                    {(column) => (
                      <td class="iui-table__td" data-align={column.align ?? "left"}>
                        {formatCellText(row.cells[column.key])}
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ReadyCard(props: { readonly entry: Extract<IntelligentUi.UiCardEntry, { readonly status: "ready" }> }): JSX.Element {
  const resolved = createMemo(() => IntelligentUi.resolveVariant(props.entry.spec))
  return (
    <article
      class="iui-card"
      data-intelligent-ui="ready"
      data-ui-card-id={props.entry.id}
      style={{ "min-block-size": `${props.entry.reservedHeight}px` }}
    >
      <Show when={props.entry.spec.title || resolved().summary}>
        <header class="iui-card__head">
          <Show when={props.entry.spec.title}>
            {(title) => <h3 class="iui-card__title">{IntelligentUi.escapeDisplayText(title())}</h3>}
          </Show>
          <Show when={resolved().summary}>
            {(summary) => <p class="iui-card__summary">{IntelligentUi.escapeDisplayText(summary())}</p>}
          </Show>
        </header>
      </Show>
      <div class="iui-card__blocks">
        <For each={resolved().blocks}>
          {(block) => (
            <>
              <Show when={block.kind === "metrics" ? block : undefined}>
                {(metrics) => <MetricsSection block={metrics()} />}
              </Show>
              <Show when={block.kind === "callout" ? block : undefined}>
                {(callout) => <CalloutSection block={callout()} />}
              </Show>
              <Show when={block.kind === "table" ? block : undefined}>
                {(table) => <TableSection block={table()} />}
              </Show>
              <Show when={block.kind === "chart" ? block : undefined}>
                {(chart) => (
                  <section class="iui-block iui-callout" data-ui-block="chart-fallback" data-tone="default">
                    <div class="iui-callout__head">
                      <h4 class="iui-callout__title">{IntelligentUi.escapeDisplayText(chart().title ?? "Chart")}</h4>
                      <span class="iui-tone-badge" data-tone="default">Text fallback</span>
                    </div>
                    <p class="iui-callout__body">{IntelligentUi.escapeDisplayText(props.entry.spec.fallback)}</p>
                  </section>
                )}
              </Show>
            </>
          )}
        </For>
      </div>
    </article>
  )
}

function StreamingCard(props: { readonly entry: Extract<IntelligentUi.UiCardEntry, { readonly status: "streaming" }> }): JSX.Element {
  return (
    <section
      class="iui-card iui-card--streaming"
      data-intelligent-ui="streaming"
      data-ui-card-id={props.entry.id}
      role="status"
      aria-busy="true"
      aria-label="Loading structured card"
      style={{ "min-block-size": `${props.entry.reservedHeight}px` }}
    >
      <header class="iui-card__head">
        <span class="iui-tone-badge" data-tone="default">Loading card</span>
      </header>
      <div class="iui-skeleton" aria-hidden="true">
        <div class="iui-skeleton__bar iui-skeleton__bar--title" />
        <div class="iui-skeleton__row">
          <div class="iui-skeleton__tile" />
          <div class="iui-skeleton__tile" />
          <div class="iui-skeleton__tile" />
        </div>
        <div class="iui-skeleton__bar iui-skeleton__bar--body" />
      </div>
    </section>
  )
}

function FallbackCard(props: { readonly entry: Extract<IntelligentUi.UiCardEntry, { readonly status: "fallback" }> }): JSX.Element {
  return (
    <section
      class="iui-card iui-card--fallback"
      data-intelligent-ui="fallback"
      data-ui-card-id={props.entry.id}
      data-fallback-reason={props.entry.reason}
      aria-label="Structured card fallback"
    >
      <header class="iui-card__head iui-card__head--inline">
        <span class="iui-tone-badge" data-tone={props.entry.reason === "error" ? "danger" : "warning"}>
          {props.entry.reason === "error" ? "Card failed" : "Fallback"}
        </span>
      </header>
      <pre class="iui-fallback__text"><code>{IntelligentUi.escapeDisplayText(props.entry.fallback)}</code></pre>
    </section>
  )
}

export function IntelligentUiTurnCards(props: { readonly parts: readonly unknown[] }): JSX.Element {
  const cards = createMemo(() => assistantUiCards(props.parts))
  return (
    <Show when={cards().length > 0}>
      <div class="iui-stack">
        <For each={cards()}>
          {(entry) => (
            <>
              <Show when={entry.status === "ready" ? entry : undefined}>
                {(ready) => <ReadyCard entry={ready()} />}
              </Show>
              <Show when={entry.status === "streaming" ? entry : undefined}>
                {(streaming) => <StreamingCard entry={streaming()} />}
              </Show>
              <Show when={entry.status === "fallback" ? entry : undefined}>
                {(fallback) => <FallbackCard entry={fallback()} />}
              </Show>
            </>
          )}
        </For>
      </div>
    </Show>
  )
}
