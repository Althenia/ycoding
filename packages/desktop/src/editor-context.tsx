import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { DesktopAPI } from "./contract"
import type { EditorSelection } from "./editor-integration"
import { editorSelectionKey, formatEditorContext } from "./editor-format"

export type EditorAdmission = { key: string; promptID: string; text: string }

export function createEditorContext(input: { api: DesktopAPI; directory: () => string | undefined; revision: () => number | undefined; enabled: () => boolean }) {
  const [selection, setSelection] = createSignal<EditorSelection>()
  const [notice, setNotice] = createSignal<string>()
  const [excluded, setExcluded] = createSignal<string>()
  const [sent, setSent] = createSignal<string>()
  const directoryValue = createMemo(input.directory)
  const revisionValue = createMemo(input.revision)
  const enabled = createMemo(input.enabled)
  createEffect(() => {
    const directory = directoryValue()
    const revision = revisionValue()
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setSelection(undefined)
    setNotice(undefined)
    setExcluded(undefined)
    setSent(undefined)
    if (!directory || revision === undefined || !enabled() || typeof input.api.editorSelection !== "function") return
    const read = async () => {
      try {
        const value = await input.api.editorSelection({ directory, revision })
        if (disposed || revision !== input.revision() || directory !== input.directory()) return
        setSelection(value.selection)
        setNotice(value.notice)
      } catch {
        if (!disposed) setNotice("IDE context could not be read. The draft remains available.")
      } finally { if (!disposed) timer = setTimeout(() => void read(), 1_000) }
    }
    void read()
    onCleanup(() => { disposed = true; if (timer) clearTimeout(timer) })
  })
  const key = () => { const value = selection(); return value ? editorSelectionKey(value) : undefined }
  return {
    selection, notice,
    excluded: () => key() !== undefined && key() === excluded(),
    dismiss: () => setExcluded(key()),
    include: () => setExcluded(undefined),
    markSent: (key: string) => setSent(key),
    capture: (): EditorAdmission | undefined => {
      const value = selection()
      if (!value || key() === excluded() || key() === sent()) return
      return { key: editorSelectionKey(value), promptID: `msg_${crypto.randomUUID()}`, text: formatEditorContext(value) }
    },
  }
}

export function EditorContextControl(props: { context: ReturnType<typeof createEditorContext>; disabled: boolean }) {
  return <><Show when={props.context.selection()}>{(selection) => <div class="composer-attachments" aria-label="IDE context"><span class="composer-attachments__chip"><span>IDE · {selection().filePath.split(/[\\/]/).at(-1)} · {props.context.excluded() ? "excluded" : "included"}</span><button type="button" class="rl-btn" disabled={props.disabled} onClick={() => props.context.excluded() ? props.context.include() : props.context.dismiss()}>{props.context.excluded() ? "Include IDE selection" : "Exclude IDE selection"}</button></span></div>}</Show><Show when={props.context.notice()}>{(notice) => <p class="desktop__muted" role="status">{notice()}</p>}</Show></>
}
