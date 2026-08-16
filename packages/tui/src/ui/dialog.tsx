import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { batch, createContext, createEffect, onCleanup, Show, useContext, type JSX, type ParentProps } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { MouseButton, Renderable, RGBA, TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useToast } from "./toast"
import { useClipboard } from "../context/clipboard"
import { useConfig } from "../config"

export const DIALOG_PANEL_WIDTH = 98

export function dialogPanelWidth(viewportWidth: number) {
  return Math.max(0, Math.min(DIALOG_PANEL_WIDTH, viewportWidth))
}

export function dialogContentWidth(viewportWidth: number) {
  return Math.max(0, dialogPanelWidth(viewportWidth) - 1)
}

export const DIALOG_INSET_RIGHT = 3

export function Dialog(
  props: ParentProps<{
    size?: "medium" | "large" | "xlarge" | "command-palette"
    centered?: boolean
    onClose: () => void
  }>,
) {
  const dimensions = useTerminalDimensions()
  const { themeV2 } = useTheme().contextual("elevated")
  const renderer = useRenderer()

  let dismiss = false
  const width = () => {
    if (dimensions().width < 100) return dimensions().width
    return DIALOG_PANEL_WIDTH
  }

  return (
    <box
      onMouseDown={() => {
        dismiss = !!renderer.getSelection()
      }}
      onMouseUp={() => {
        if (dismiss) {
          dismiss = false
          return
        }
        props.onClose?.()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      justifyContent={props.centered ? "center" : undefined}
      position="absolute"
      zIndex={3000}
      paddingTop={props.centered ? 0 : dimensions().height / 4}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        onMouseUp={(e: { stopPropagation(): void }) => {
          // A selection release must bubble up to the copy-on-select handler in
          // DialogProvider; the backdrop's dismiss flag keeps it from closing the dialog.
          if (renderer.getSelection()?.getSelectedText()) return
          dismiss = false
          e.stopPropagation()
        }}
        width={width()}
        height={props.size === "command-palette" ? Math.min(34, dimensions().height) : undefined}
        maxWidth={dimensions().width < 100 ? dimensions().width : dimensions().width - 2}
        backgroundColor={themeV2.background.surface.offset}
        paddingTop={1}
      >
        {props.children}
      </box>
    </box>
  )
}

export function DialogHeader(props: { title: JSX.Element }) {
  const dimensions = useTerminalDimensions()
  const { themeV2 } = useTheme().contextual("elevated")
  const dialog = useDialog()

  return (
    <box
      width={dialogContentWidth(dimensions().width)}
      paddingLeft={3}
      paddingRight={DIALOG_INSET_RIGHT}
      flexDirection="row"
      justifyContent="space-between"
      flexShrink={0}
    >
      {props.title}
      <text fg={themeV2.text.subdued} onMouseUp={() => dialog.clear()}>
        esc
      </text>
    </box>
  )
}

export function DialogTitle(props: { children: JSX.Element }) {
  const { themeV2 } = useTheme().contextual("elevated")
  return (
    <text attributes={TextAttributes.BOLD} fg={themeV2.text.default}>
      {props.children}
    </text>
  )
}

export function DialogSearchRow(props: ParentProps) {
  const dimensions = useTerminalDimensions()
  const { themeV2 } = useTheme().contextual("elevated")
  if (props.children)
    return (
      <box
        width={dialogPanelWidth(dimensions().width)}
        paddingTop={2}
        paddingLeft={6}
        paddingRight={3}
        position="relative"
        flexShrink={0}
      >
        {props.children}
      </box>
    )
  return (
    <box width={dialogPanelWidth(dimensions().width)} paddingTop={2} paddingLeft={6} paddingRight={3} flexDirection="row" flexShrink={0}>
      <box width={1} backgroundColor={themeV2.background.action.primary.focused}>
        <text fg={themeV2.text.action.primary.focused}>S</text>
      </box>
      <text fg={themeV2.text.subdued}>earch</text>
    </box>
  )
}

export function dialogMessageLines(message: string, maxWidth = 52) {
  const value = message.trim()
  if (!value) return []
  return value.split(/(?<=[.!?])\s+/).flatMap((sentence) =>
    sentence.split(/\s+/).reduce<string[]>((lines, word) => {
      const current = lines.at(-1)
      if (!current || current.length + word.length + 1 > maxWidth) return [...lines, word]
      return [...lines.slice(0, -1), `${current} ${word}`]
    }, []),
  )
}

function init() {
  const [store, setStore] = createStore({
    stack: [] as {
      element: JSX.Element
      onClose?: () => void
    }[],
    size: "large" as "medium" | "large" | "xlarge" | "command-palette",
    centered: false,
  })

  const renderer = useRenderer()
  const keymap = Keymap.use()

  createEffect(() => {
    if (store.stack.length === 0) return
    const popMode = keymap.mode.push("modal")
    onCleanup(popMode)
  })

  let focus: Renderable | null
  function refocus() {
    setTimeout(() => {
      if (store.stack.length > 0) return
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable) {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const found = find(renderer.root)
      if (!found) return
      focus.focus()
    }, 1)
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    enabled: store.stack.length > 0 && !renderer.getSelection()?.getSelectedText(),
    commands: [
      {
        bind: "escape",
        title: "Close dialog",
        group: "Dialog",
        run: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
          }
          const current = store.stack.at(-1)
          current?.onClose?.()
          setStore("stack", store.stack.slice(0, -1))
          refocus()
        },
      },
      {
        bind: "ctrl+c",
        title: "Close dialog",
        group: "Dialog",
        run: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
          }
          const current = store.stack.at(-1)
          current?.onClose?.()
          setStore("stack", store.stack.slice(0, -1))
          refocus()
        },
      },
    ],
  }))

  return {
    clear() {
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      batch(() => {
        setStore("size", "large")
        setStore("centered", false)
        setStore("stack", [])
      })
      refocus()
    },
    replace(input: any, onClose?: () => void) {
      if (store.stack.length === 0) {
        focus = renderer.currentFocusedRenderable
        focus?.blur()
      }
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      setStore("size", "large")
      setStore("centered", false)
      setStore("stack", [
        {
          element: input,
          onClose,
        },
      ])
    },
    get stack() {
      return store.stack
    },
    get size() {
      return store.size
    },
    get centered() {
      return store.centered
    },
    setSize(size: "medium" | "large" | "xlarge" | "command-palette") {
      setStore("size", size)
    },
    setCentered(centered: boolean) {
      setStore("centered", centered)
    },
  }
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps) {
  const value = init()
  const renderer = useRenderer()
  const toast = useToast()
  const clipboard = useClipboard()
  const config = useConfig()
  const copyOnSelectEnabled = () => config.data.terminal?.copy_on_select ?? process.platform !== "win32"

  function copySelection() {
    const text = renderer.getSelection()?.getSelectedText()
    if (!text || !clipboard.write) return false
    void clipboard.write(text).then(
      () => toast.show({ message: "Copied to clipboard", variant: "info" }),
      (error) => toast.error(error),
    )
    renderer.clearSelection()
    return true
  }

  return (
    <ctx.Provider value={value}>
      {props.children}
      <box
        position="absolute"
        zIndex={3000}
        onMouseDown={(evt: { button: MouseButton; preventDefault(): void; stopPropagation(): void }) => {
          if (copyOnSelectEnabled()) return
          if (evt.button !== MouseButton.RIGHT) return

          if (!copySelection()) return
          evt.preventDefault()
          evt.stopPropagation()
        }}
        onMouseUp={copyOnSelectEnabled() ? copySelection : undefined}
      >
        <Show when={value.stack.length}>
          <Dialog onClose={() => value.clear()} size={value.size} centered={value.centered}>
            {value.stack.at(-1)!.element}
          </Dialog>
        </Show>
      </box>
    </ctx.Provider>
  )
}

export function useDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}
