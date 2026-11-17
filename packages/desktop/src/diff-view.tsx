import { createEffect, createMemo, createSignal, For, on, onMount, Show, type ComponentProps, type JSX } from "solid-js"
import type { SharedChangesSurface } from "../../../apps/web/src/remote/ui/shared-workspace"
import { SharedRadioGroup } from "../../../apps/web/src/remote/ui/shared-workspace"
import { CustomSelect } from "../../../apps/web/src/ui/custom-select"
import { parseUnifiedPatch } from "../../../apps/web/src/remote/file-change-diff"
import { defaultDiffPreferences, diffFileTree, parseDiffPreferences, type DiffFileNode, type DiffPreferences } from "./diff-preferences"
import "./diff-view.css"
import { createCompactInspector, useCompact } from "./responsive-layer"

const [preferences, setPreferences] = createSignal(defaultDiffPreferences)
let hydrated = false

export function DesktopDiffView(props: ComponentProps<typeof SharedChangesSurface> & { readonly variant?: "session" | "git" }) {
  let surface!: HTMLElement
  const compact = useCompact()
  const inspector = createCompactInspector()
  const [localPath, setLocalPath] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  onMount(() => {
    if (hydrated) return
    hydrated = true
    try { setPreferences(parseDiffPreferences(localStorage.getItem("ycoding.desktop.diffs"))) }
    catch { setError("Saved diff preferences could not be read.") }
  })
  const change = (patch: Partial<DiffPreferences>) => {
    const next = { ...preferences(), ...patch }
    setPreferences(next)
    try { localStorage.setItem("ycoding.desktop.diffs", JSON.stringify(next)); setError(undefined) }
    catch { setError("Diff preferences apply to this window but could not be saved.") }
  }
  const files = createMemo(() => props.selectedTurnID === undefined ? props.files : props.turns?.find((turn) => turn.id === props.selectedTurnID)?.files ?? [])
  const [reviewed, setReviewed] = createSignal<ReadonlySet<string>>(new Set())
  createEffect(on(() => JSON.stringify([props.scopeLabel, props.selectedTurnID, files().map((file) => [file.path, file.patch, file.additions, file.deletions])]), () => setReviewed(new Set<string>())))
  const selected = () => files().find((file) => file.path === (props.selectedPath ?? localPath())) ?? files()[0]
  const visible = () => preferences().single || compact() ? files().filter((file) => file === selected()) : files()
  const select = (path: string) => {
    inspector.show()
    setLocalPath(path)
    props.onSelectFile?.(path)
    queueMicrotask(() => {
      surface.querySelector(`#${CSS.escape(`desktop-diff-${encodeURIComponent(path)}`)}`)?.scrollIntoView({ block: "start" })
      if (compact()) surface.querySelector<HTMLButtonElement>('.compact-inspector-back')?.focus({ preventScroll: true })
    })
  }
  const tree = createMemo(() => diffFileTree(files().map((file) => file.path)))
  const FileChoice = (input: { readonly path: string; readonly label: string }): JSX.Element => {
    const file = () => files().find((file) => file.path === input.path)
    const directory = () => input.path.includes("/") ? input.path.slice(0, input.path.lastIndexOf("/")) : "."
    return <button type="button" class="rl-btn desktop-diff__choice" aria-label={input.path} aria-current={selected()?.path === input.path ? "true" : undefined} onClick={() => select(input.path)}><span class="desktop-diff__path"><span>{props.variant === "git" ? input.path.split("/").at(-1) : input.label}</span><Show when={props.variant === "git"}><small>{directory()}</small></Show></span><span class="desktop-diff__counts" aria-hidden="true"><span class="ws-add">+{file()?.additions}</span><span class="ws-del">−{file()?.deletions}</span></span></button>
  }
  const Tree = (input: { readonly nodes: readonly DiffFileNode[] }): JSX.Element => <ul class="desktop-diff__tree"><For each={input.nodes}>{(node) => <li><Show when={node.path} fallback={<span>{node.name}/</span>}>{(path) => <FileChoice path={path()} label={node.name} />}</Show><Show when={node.children.length}><Tree nodes={node.children} /></Show></li>}</For></ul>
  const DisplayControls = () => <div class="desktop-diff__controls" role="group" aria-label="Diff display controls">
      <SharedRadioGroup label="Diff view" value={preferences().view} options={[{ value: "auto", label: "Automatic" }, { value: "split", label: "Split" }, { value: "unified", label: "Unified" }]} onChange={(view) => { if (view === "auto" || view === "split" || view === "unified") change({ view }) }} />
      <label class="request__choice"><input type="checkbox" checked={preferences().wrap === "word"} onChange={(event) => change({ wrap: event.currentTarget.checked ? "word" : "none" })} /><span>Wrap diff lines</span></label>
      <label class="request__choice"><input type="checkbox" checked={preferences().tree} onChange={(event) => change({ tree: event.currentTarget.checked })} /><span>Show file tree</span></label>
      <label class="request__choice"><input type="checkbox" checked={preferences().single} onChange={(event) => change({ single: event.currentTarget.checked })} /><span>Show selected file only</span></label>
    </div>
  const Reviewed = () => <><p class="desktop-diff__reviewed" role="status" aria-label="Reviewed files">{reviewed().size} reviewed</p><span class="desktop__sr">Review marks stay in this view and reset when the diff or scope changes or closes. They do not change files.</span></>
  return <section ref={surface} class="desktop-diff" data-variant={props.variant ?? "session"} data-view={preferences().view} data-wrap={preferences().wrap} data-inspecting={inspector.open() ? "true" : undefined} aria-label="File changes" onKeyDown={event => { if (event.key === "Escape" && compact() && inspector.open()) { event.preventDefault(); event.stopPropagation(); inspector.close() } }}>
    <Show when={props.variant !== "git"}><header class="desktop-diff__toolbar">
      <DisplayControls />
      <div class="desktop-diff__controls"><strong>{props.scopeLabel ?? "Session changes"}</strong><span>{files().length} files · +{files().reduce((total, file) => total + file.additions, 0)} / −{files().reduce((total, file) => total + file.deletions, 0)}</span><Reviewed /><Show when={props.onRefresh}><button type="button" class="rl-btn" disabled={props.refreshing} onClick={props.onRefresh}>Refresh</button></Show><Show when={props.onOpenFullChanges}><button type="button" class="rl-btn" onClick={props.onOpenFullChanges}>{props.fullChangesLabel ?? "Open full changes page"}</button></Show>
      <Show when={props.turns?.length || props.selectedTurnID !== undefined}><CustomSelect label="Change scope" sheetTitle="Change scope" placeholder="Turn unavailable" value={props.selectedTurnID ?? "all-session-changes"} options={[{ value: "all-session-changes", label: "All Session changes" }, ...(props.turns ?? []).map((turn) => ({ value: turn.id, label: turn.label, detail: `${turn.files.length} files` }))]} onChange={(value) => props.onSelectTurn?.(value === "all-session-changes" ? undefined : value)} /></Show></div>
      <Show when={props.scopeTruth}><p>{props.scopeTruth}</p></Show><Show when={props.turnsNotice}><p class="st-muted">{props.turnsNotice}</p></Show>
      <Show when={props.revert}>{(revert) => <div class="rl-revert"><Show when={revert().staged} fallback={<button type="button" class="rl-btn" disabled={revert().busy} onClick={revert().onStage}>Revert changes…</button>}><Show when={revert().summary}><p>{revert().summary}</p></Show><button type="button" class="rl-btn" disabled={revert().busy} onClick={revert().onCommit}>Confirm revert</button><button type="button" class="rl-btn" disabled={revert().busy} onClick={revert().onClear}>Cancel</button></Show><Show when={revert().error}><p role="alert">{revert().error}</p></Show></div>}</Show>
    </header></Show>
    <Show when={error()}>{(message) => <p class="desktop-diff__error" role="alert">{message()}</p>}</Show>
    <nav aria-label="Changed files">
      <div class="desktop-diff__nav-head"><h3 class="desktop-diff__heading">Changed files</h3><span>{files().length} total</span></div>
      <Show when={compact() && props.variant === "git"}><Reviewed /></Show>
      <Show when={files().length} fallback={<p>{props.selectedTurnID === undefined ? "No captured file changes for this Session." : props.turns?.some((turn) => turn.id === props.selectedTurnID) ? "No captured file changes in this turn." : "This turn is no longer available."}</p>}>
        <Show when={preferences().tree} fallback={<div class="desktop-diff__choices"><For each={files()}>{(file) => <FileChoice path={file.path} label={file.path} />}</For></div>}><Tree nodes={tree()} /></Show>
      </Show>
    </nav>
    <div class="desktop-diff__files" role="region" aria-label="File patches">
      <button type="button" class="rl-btn compact-inspector-back" aria-label="Back to changed files" onClick={inspector.close}>Back to changed files</button>
      <Show when={props.variant === "git"}><div class="desktop-diff__patch-tools"><DisplayControls /><Reviewed /></div></Show>
      <For each={visible()}>{(file) => {
        const parsed = createMemo(() => parseUnifiedPatch(file.patch))
        const basename = () => file.path.split("/").at(-1)
        const directory = () => file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : ""
        return <article class="desktop-diff__file" id={`desktop-diff-${encodeURIComponent(file.path)}`} aria-label={file.path}><header class="desktop-diff__file-head"><h3><span>{directory()}</span>{basename()}</h3><span class="desktop-diff__counts"><span class="ws-add">+{file.additions}</span><span class="ws-del">−{file.deletions}</span></span>
          <button type="button" class="rl-btn desktop-diff__review" aria-label={`${reviewed().has(file.path) ? "Mark unreviewed" : "Mark reviewed"}: ${file.path}`} aria-pressed={reviewed().has(file.path)} onClick={() => setReviewed((current) => { const next = new Set(current); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next })}><span aria-hidden="true" />{reviewed().has(file.path) ? "Reviewed" : "Mark reviewed"}</button></header>
          <Show when={parsed()} fallback={<pre>{file.patch || "No text patch is available for this file."}</pre>}>{(diff) => <>
            <table class="desktop-diff__unified"><caption>Unified diff · {file.path}</caption><thead><tr><th scope="col">Before</th><th scope="col">After</th><th scope="col">Code</th></tr></thead><tbody><For each={diff().unified}>{(line) => line.kind === "hunk" ? <tr><td colSpan={3} class="desktop-diff__hunk"><code>{line.text}</code></td></tr> : <tr data-kind={line.kind}><td class="desktop-diff__number">{line.oldNumber}</td><td class="desktop-diff__number">{line.newNumber}</td><td><code>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}{line.text}</code></td></tr>}</For></tbody></table>
            <table class="desktop-diff__split"><caption>Split diff · {file.path}</caption><colgroup><col class="desktop-diff__number" /><col /><col class="desktop-diff__number" /><col /></colgroup><thead><tr><th scope="col" colSpan={2}>ORIGINAL</th><th scope="col" colSpan={2}>MODIFIED</th></tr></thead><tbody><For each={diff().split}>{(line) => line.kind === "hunk" ? <tr><td colSpan={4} class="desktop-diff__hunk"><code>{line.text}</code></td></tr> : <tr><td class="desktop-diff__number">{line.old?.number}</td><td data-kind={line.old?.kind}><code>{line.old?.text}</code></td><td class="desktop-diff__number">{line.new?.number}</td><td data-kind={line.new?.kind}><code>{line.new?.text}</code></td></tr>}</For></tbody></table>
          </>}</Show>
        </article>
      }}</For>
    </div>
  </section>
}
