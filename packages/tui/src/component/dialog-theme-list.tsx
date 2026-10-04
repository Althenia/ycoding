import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { onCleanup } from "solid-js"

export function DialogThemeList(props: { themes?: string[]; current?: string; defaultTheme?: string } = {}) {
  const themeContext = useTheme()
  const { theme } = themeContext.contextual("elevated")
  const options = (props.themes ?? Object.keys(themeContext.all()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))).map((value) => ({
      title: value,
      description: value === (props.defaultTheme ?? "ycoding") ? "default" : undefined,
      value: value,
    }))
  const dialog = useDialog()
  let confirmed = false
  let ref: DialogSelectRef<string>
  const initial = props.current ?? themeContext.selected

  onCleanup(() => {
    if (!confirmed) themeContext.set(initial)
  })

  return (
    <DialogSelect
      title="Select theme"
      options={options}
      current={initial}
      onMove={(opt) => {
        themeContext.set(opt.value)
      }}
      onSelect={(opt) => {
        themeContext.set(opt.value)
        confirmed = true
        dialog.clear()
      }}
      ref={(r) => {
        ref = r
      }}
      onFilter={(query) => {
        if (query.length === 0) {
          themeContext.set(initial)
          return
        }

        const first = ref.filtered[0]
        if (first) themeContext.set(first.value)
      }}
      footer={
        <box position="relative" top={-1}>
          <text fg={theme.text.subdued}>←/→ preview</text>
        </box>
      }
    />
  )
}
