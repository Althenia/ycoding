import { createMemo, onCleanup } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

export function DialogVariant(props: {
  variants?: string[]
  current?: string
  sessionID?: string
  onSelect?: (variant: string) => void
  onCancel?: () => void
}) {
  const local = useLocal()
  const dialog = useDialog()
  const toast = useToast()

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
        const model = local.model.current()
        if (!model) return
        selected = true
        dialog.clear()
        // Explicit variant selection is a real switch for an existing Session.
        void local.model
          .select({ ...model, variant }, { sessionID: props.sessionID })
          .catch((error: unknown) =>
            toast.show({ title: "Model switch needs attention", message: errorMessage(error), variant: "warning" }),
          )
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
