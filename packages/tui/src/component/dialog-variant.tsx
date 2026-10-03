import { createMemo, onCleanup, Show } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { Keymap } from "../context/keymap"

export function DialogVariant(props: {
  variants?: string[]
  current?: string
  sessionID?: string
  onSelect?: (variant: string) => void
  onClear?: () => void
  onCancel?: () => void
}) {
  const local = useLocal()
  const dialog = useDialog()
  const theme = useTheme()

  const variants = createMemo(() => props.variants ?? local.model.variant.list())
  const current = createMemo(() => ("current" in props ? props.current : local.model.variant.current()))
  const canClear = createMemo(() => Boolean(props.onClear || (current() !== undefined && !props.onSelect)))
  let selected = false
  onCleanup(() => {
    if (!selected) props.onCancel?.()
  })
  const options = createMemo(() =>
    variants().map((variant) => ({
      value: variant,
      title: variant,
      state: current() === variant ? ("connected" as const) : undefined,
      onSelect: () => {
        if (props.onSelect) {
          selected = true
          props.onSelect(variant)
          return
        }
        const model = local.model.current()
        if (!model) return
        selected = true
        dialog.clear()
        void local.model.select({ ...model, variant }, { sessionID: props.sessionID })
      },
    })),
  )

  function clear() {
    selected = true
    if (props.onClear) return props.onClear()
    const model = local.model.current()
    if (!model) return
    dialog.clear()
    void local.model.select({ ...model, variant: undefined }, { sessionID: props.sessionID })
  }

  Keymap.createLayer(() => ({
    mode: "dialog",
    enabled: canClear,
    commands: [{ id: "variant.clear", title: "Clear selection", bind: "ctrl+u", run: clear }],
  }))

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select variant"}
      footer={
        <Show when={current() !== undefined && !variants().includes(current()!)}>
          <text fg={theme.themeV2.text.feedback.warning.default}>{current()} · unavailable</text>
        </Show>
      }
      actions={
        canClear() ? [{ command: "variant.clear", title: "Clear selection", selection: "none", onTrigger: clear }] : []
      }
      footerHints={[{ title: "cycle", label: "⌃t" }]}
      flat={true}
    />
  )
}
