import { For, Show, createMemo, createSignal, createUniqueId, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { filePathParts, parseUnifiedPatch, summarizeFileChanges, type DiffCell, type DiffLine } from "../file-change-diff"
import type { RemoteCapturedChangesPage } from "@ycoding-ai/remote"
import "./file-change-card.css"

type CapturedFile = RemoteCapturedChangesPage["data"][number]

export function FileChangeCard(props: { readonly files: () => readonly CapturedFile[] }): JSX.Element {
  const [showAll, setShowAll] = createSignal(false)
  const filesID = createUniqueId()
  const totals = createMemo(() => summarizeFileChanges(props.files()))
  const shown = () => showAll() ? props.files() : props.files().slice(0, 3)
  const remaining = () => Math.max(0, props.files().length - 3)
  return (
    <section class="file-change-card" aria-label="Captured file changes">
      <header class="file-change-card__header">
        <span class="file-change-card__icon" aria-hidden="true"><Icon name="file" size={16} /></span>
        <strong class="file-change-card__title">Edited {totals().files} {totals().files === 1 ? "file" : "files"}</strong>
        <span class="file-change-card__totals" aria-label={`${totals().additions} additions, ${totals().deletions} deletions`}>
          <span class="file-change-card__added">+{totals().additions}</span>{" "}<span class="file-change-card__removed">−{totals().deletions}</span>
        </span>
      </header>
      <ul class="file-change-card__files" id={filesID}><For each={shown()}>{(file) => <FileChangeRow file={file} />}</For></ul>
      <Show when={remaining() > 0}>
        <button type="button" class="file-change-card__more" aria-expanded={showAll()} aria-controls={filesID} onClick={() => setShowAll(!showAll())}>
          {showAll() ? "Show fewer files" : `Show ${remaining()} more ${remaining() === 1 ? "file" : "files"}`}
          <Icon name="chevron-down" size={14} />
        </button>
      </Show>
    </section>
  )
}

function FileChangeRow(props: { readonly file: CapturedFile }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false)
  const id = createUniqueId()
  const path = filePathParts(props.file.path)
  return (
    <li class="file-change-card__file">
      <button type="button" class="file-change-card__file-toggle" aria-expanded={expanded()} aria-controls={id} onClick={() => setExpanded(!expanded())}>
        <span class="file-change-card__path" title={props.file.path}><span class="file-change-card__directory">{path.directory}</span><span class="file-change-card__basename">{path.basename}</span></span>
        <span class="file-change-card__file-counts"><span class="file-change-card__added">+{props.file.additions}</span><span class="file-change-card__removed">−{props.file.deletions}</span></span>
        <span class="file-change-card__chevron" aria-hidden="true"><Icon name="chevron-down" size={14} /></span>
      </button>
      <div class="file-change-card__diff" id={id} role="region" aria-label={`${props.file.files.length === 1 ? "Latest change" : "Recorded changes"} in ${props.file.path}`} hidden={!expanded()} tabindex="0">
        <Show when={expanded()}>
          <For each={props.file.files}>{(patch, index) => <div class="file-change-card__patch">
            <div class="file-change-card__diff-label">{props.file.files.length === 1 ? "Latest change" : `Change ${index() + 1}`}</div>
            <Show when={!patch.unavailable && parseUnifiedPatch(patch.diff)} fallback={<p class="file-change-card__unavailable">Diff unavailable for this file.</p>}>
              {(diff) => <>
              <div class="file-change-card__split" aria-label="Side-by-side diff">
                <div class="file-change-card__pane-heading">Old</div><div class="file-change-card__pane-heading">New</div>
                <For each={diff().split}>{(row) => row.kind === "hunk"
                  ? <div class="file-change-card__hunk">{row.text}</div>
                  : <>
                      <DiffCellView cell={row.old} />
                      <DiffCellView cell={row.new} />
                    </>}</For>
              </div>
              <div class="file-change-card__unified" aria-label="Unified diff">
                <For each={diff().unified}>{(line) => line.kind === "hunk"
                  ? <div class="file-change-card__hunk">{line.text}</div>
                  : <UnifiedLine line={line} />}</For>
              </div>
              </>}
            </Show>
          </div>}</For>
        </Show>
      </div>
    </li>
  )
}

function DiffCellView(props: { readonly cell?: DiffCell }): JSX.Element {
  return (
    <div class={`file-change-card__line${props.cell ? ` file-change-card__line--${props.cell.kind}` : " file-change-card__line--empty"}`}>
      <span class="file-change-card__number">{props.cell?.number ?? ""}</span><span class="file-change-card__code">{props.cell?.text ?? ""}</span>
    </div>
  )
}

function UnifiedLine(props: { readonly line: Exclude<DiffLine, { readonly kind: "hunk" }> }): JSX.Element {
  return (
    <div class={`file-change-card__line file-change-card__line--${props.line.kind}`}>
      <span class="file-change-card__number">{props.line.oldNumber ?? props.line.newNumber}</span>
      <span class="file-change-card__prefix" aria-hidden="true">{props.line.kind === "added" ? "+" : props.line.kind === "removed" ? "−" : " "}</span>
      <span class="file-change-card__code">{props.line.text}</span>
    </div>
  )
}
