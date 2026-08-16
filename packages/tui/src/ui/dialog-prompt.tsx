import { TextareaRenderable } from "@opentui/core"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogSearchRow, DialogTitle, useDialog, type DialogContext } from "./dialog"
import { Show, createEffect, createSignal, onMount, type JSX } from "solid-js"
import { Spinner } from "../component/spinner"
import { Locale } from "../util/locale"

export type DialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { themeV2 } = useTheme().contextual("elevated")
  const shortcuts = Keymap.useShortcuts()
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  let textarea: TextareaRenderable

  function confirm() {
    if (props.busy) return
    props.onConfirm?.(textarea.plainText)
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    target: textareaTarget,
    enabled: textareaTarget() !== undefined && !props.busy,
    // Dialog form semantics must win over the global managed textarea input layer.
    priority: 1,
    commands: [
      {
        id: "dialog.prompt.submit",
        title: "Submit dialog prompt",
        bind: "return",
        group: "Dialog",
        run: confirm,
      },
    ],
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      if (props.busy) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    const traits = props.busy
      ? {
          suspend: true,
          status: "BUSY",
        }
      : {}
    textarea.traits = traits
    if (props.busy) {
      textarea.blur()
      return
    }
    textarea.focus()
  })

  return (
    <box paddingTop={1} paddingBottom={1}>
      <DialogHeader title={<DialogTitle>{props.title}</DialogTitle>} />
      <DialogSearchRow />
      <box minHeight={3} paddingTop={1} paddingLeft={6} paddingRight={4}>
        {props.description?.()}
        <textarea
          height={1}
          ref={(val: TextareaRenderable) => {
            textarea = val
            setTextareaTarget(val)
          }}
          initialValue={props.value}
          placeholder={props.placeholder ?? "Search"}
          placeholderColor={themeV2.text.subdued}
          textColor={props.busy ? themeV2.text.formfield.disabled : themeV2.text.formfield.default}
          focusedTextColor={props.busy ? themeV2.text.formfield.disabled : themeV2.text.formfield.default}
          cursorColor={props.busy ? themeV2.text.subdued : themeV2.text.feedback.info.default}
        />
        <Show when={props.busy}>
          <Spinner color={themeV2.text.subdued}>{props.busyText ?? "Working..."}</Spinner>
        </Show>
      </box>
      <box paddingTop={1} paddingLeft={6} paddingRight={4} flexDirection="row">
        <Show when={!props.busy} fallback={<text fg={themeV2.text.subdued}>processing...</text>}>
          <Show when={shortcuts.get("dialog.prompt.submit")}>
            {(shortcut) => (
              <text fg={themeV2.text.default}>
                {Locale.titlecase(shortcut())} <span style={{ fg: themeV2.text.subdued }}>confirm</span>
              </text>
            )}
          </Show>
        </Show>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}
