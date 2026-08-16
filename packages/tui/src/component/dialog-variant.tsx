import { createMemo, onCleanup } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export function DialogVariant(props: {
  variants?: string[]
  current?: string
  onSelect?: (variant: string) => void
  onCancel?: () => void
}) {
  const local = useLocal()
  const dialog = useDialog()

  const variants = createMemo(() => props.variants ?? local.model.variant.list())
  let selected = false
  onCleanup(() => {
    if (!selected) props.onCancel?.()
  })
  const options = createMemo(() =>
    variants().map((variant) => ({
      value: variant,
      title: variant,
      description:
        variant === "max"
          ? "deep reasoning · highest cost"
          : variant === "balanced"
            ? "default"
            : variant === "fast"
              ? "lower latency"
              : undefined,
      state: (props.current ?? local.model.variant.current()) === variant ? ("connected" as const) : undefined,
      onSelect: () => {
        if (props.onSelect) {
          selected = true
          props.onSelect(variant)
          return
        }
        dialog.clear()
        local.model.variant.set(variant)
      },
    })),
  )

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select variant"}
      footerHints={[{ title: "cycle", label: "⌃t" }]}
      flat={true}
    />
  )
}
