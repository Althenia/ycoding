import { RGBA, TextAttributes } from "@opentui/core"
import open from "open"
import { createSignal } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { Link } from "../ui/link"
import { DialogSelect } from "../ui/dialog-select"

const PAD_X = 3

export type DialogRetryActionProps = {
  title: string
  message: string
  label: string
  link?: string
  onClose?: (dontShowAgain?: boolean) => void
  request?: {
    provider: string
    error: string
    retryAfter?: string
    onRetry?: () => void
    onRetryDifferentModel?: () => void
    onCancelTurn?: () => void
  }
}

function runAction(props: DialogRetryActionProps, dialog: ReturnType<typeof useDialog>) {
  if (props.link) open(props.link).catch(() => {})
  props.onClose?.()
  dialog.clear()
}

function dismiss(props: DialogRetryActionProps, dialog: ReturnType<typeof useDialog>) {
  props.onClose?.(true)
  dialog.clear()
}

export function DialogRetryAction(props: DialogRetryActionProps) {
  const dialog = useDialog()
  const { theme } = useTheme().contextual("elevated")
  const [selected, setSelected] = createSignal<"dismiss" | "action">("action")

  if (props.request)
    return (
      <DialogSelect
        title="Request failed"
        options={[
          {
            title: props.request.error,
            description: props.request.retryAfter,
            footer: "Failed",
            state: "error",
            category: props.request.provider,
            value: "error",
          },
          {
            title: "Retry now",
            titleView: <>{"\nRetry now"}</>,
            category: "Choose",
            value: "retry",
            onSelect: (dialog) => {
              props.request?.onRetry?.()
              dialog.clear()
            },
          },
          {
            title: "Retry with a different model",
            category: "Choose",
            value: "model",
            onSelect: (dialog) => {
              props.request?.onRetryDifferentModel?.()
              dialog.clear()
            },
          },
          {
            title: "Cancel the turn",
            category: "Choose",
            value: "cancel",
            onSelect: (dialog) => {
              props.request?.onCancelTurn?.()
              dialog.clear()
            },
          },
          {
            title: props.label,
            value: "legacy-action",
            onSelect: () => runAction(props, dialog),
          },
        ]}
      />
    )

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "left",
        title: "Previous retry option",
        group: "Dialog",
        run: () => setSelected((value) => (value === "action" ? "dismiss" : "action")),
      },
      {
        bind: "right",
        title: "Next retry option",
        group: "Dialog",
        run: () => setSelected((value) => (value === "action" ? "dismiss" : "action")),
      },
      {
        bind: "tab",
        title: "Next retry option",
        group: "Dialog",
        run: () => setSelected((value) => (value === "action" ? "dismiss" : "action")),
      },
      {
        bind: "return",
        title: "Confirm retry option",
        group: "Dialog",
        run: () => {
          if (selected() === "action") runAction(props, dialog)
          else dismiss(props, dialog)
        },
      },
    ],
  }))

  return (
    <box>
      <box zIndex={1} paddingLeft={PAD_X} paddingRight={PAD_X} paddingBottom={1} gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={TextAttributes.BOLD} fg={theme.text.default}>
            {props.title}
          </text>
          <text fg={theme.text.subdued} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
        <box gap={0}>
          <text fg={theme.text.subdued}>{props.message}</text>
        </box>
        {props.link ? (
          <box width="100%" flexDirection="row" justifyContent="center" paddingBottom={1}>
            <Link href={props.link} fg={theme.markdown.link} wrapMode="none" />
          </box>
        ) : (
          <box paddingBottom={1} />
        )}
        <box flexDirection="row" justifyContent="space-between">
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={
              selected() === "dismiss" ? theme.background.action.primary.focused : RGBA.fromInts(0, 0, 0, 0)
            }
            onMouseOver={() => setSelected("dismiss")}
            onMouseUp={() => dismiss(props, dialog)}
          >
            <text
              fg={selected() === "dismiss" ? theme.text.action.primary.focused : theme.text.subdued}
              attributes={selected() === "dismiss" ? TextAttributes.BOLD : undefined}
            >
              don't show again
            </text>
          </box>
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={
              selected() === "action" ? theme.background.action.primary.focused : RGBA.fromInts(0, 0, 0, 0)
            }
            onMouseOver={() => setSelected("action")}
            onMouseUp={() => runAction(props, dialog)}
          >
            <text
              fg={selected() === "action" ? theme.text.action.primary.focused : theme.text.default}
              attributes={selected() === "action" ? TextAttributes.BOLD : undefined}
            >
              {props.label}
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}

DialogRetryAction.show = (
  dialog: DialogContext,
  props: Pick<DialogRetryActionProps, "title" | "message" | "label" | "link">,
) => {
  return new Promise<boolean>((resolve) => {
    dialog.replace(
      () => <DialogRetryAction {...props} onClose={(dontShow) => resolve(dontShow ?? false)} />,
      () => resolve(false),
    )
  })
}
