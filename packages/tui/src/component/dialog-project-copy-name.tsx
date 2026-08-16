import { InputRenderable } from "@opentui/core"
import { Slug } from "@ycoding-ai/core/util/slug"
import { createSignal, onMount } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogSearchRow, DialogTitle, useDialog, type DialogContext } from "../ui/dialog"

export function DialogProjectCopyName(props: { value?: string; onConfirm: (name: string) => void }) {
  const dialog = useDialog()
  const { themeV2 } = useTheme().contextual("elevated")
  const [inputTarget, setInputTarget] = createSignal<InputRenderable>()
  let input: InputRenderable

  function generate() {
    input.value = Slug.create()
    input.gotoLineEnd()
  }

  function confirm() {
    props.onConfirm(slugify(input.value) || Slug.create())
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    target: inputTarget,
    enabled: inputTarget() !== undefined,
    priority: 1,
    commands: [
      {
        id: "dialog.project_copy.generate",
        title: "Generate project copy name",
        group: "Dialog",
        run: generate,
      },
    ],
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.focus()
    }, 1)
  })

  return (
    <box paddingTop={1} paddingBottom={1}>
      <DialogHeader title={<DialogTitle>Name the copy</DialogTitle>} />
      <DialogSearchRow />
      <box paddingTop={1} paddingLeft={6} paddingRight={4}>
        <input
          ref={(value: InputRenderable) => {
            input = value
            input.value = props.value ?? ""
            setInputTarget(value)
          }}
          onSubmit={confirm}
          placeholder="Project copy name"
          placeholderColor={themeV2.text.subdued}
          textColor={themeV2.text.formfield.default}
          focusedTextColor={themeV2.text.formfield.default}
          cursorColor={themeV2.text.formfield.default}
        />
      </box>
      <box paddingTop={2} paddingLeft={6} paddingRight={4}>
        <text fg={themeV2.text.default}>Enter <span style={{ fg: themeV2.text.subdued }}>create</span></text>
      </box>
    </box>
  )
}

DialogProjectCopyName.show = (dialog: DialogContext, value?: string) =>
  new Promise<string | null>((resolve) => {
    dialog.replace(
      () => <DialogProjectCopyName value={value} onConfirm={resolve} />,
      () => resolve(null),
    )
  })

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}
