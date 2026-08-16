import { createContext, useContext, type ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { railPlacement, railWidth } from "../routes/session/rail"
import { useRoute } from "../context/route"
import { errorMessage } from "../util/error"
export type ToastOptions = {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration: number
}
type ToastInput = Omit<ToastOptions, "duration"> & { duration?: number }

export function Toast() {
  const toast = useToast()
  const { themeV2 } = useTheme().contextual("overlay")
  const dimensions = useTerminalDimensions()
  const route = useRoute()
  // Only the session route renders the docked rail. Reserving the rail's width on any other route
  // floats the toast away from the right margin by a rail that is not on screen.
  const right = () =>
    route.data.type === "session" && railPlacement(dimensions().width) === "docked"
      ? railWidth(dimensions().width) + 2
      : 2
  const width = () => Math.max(1, Math.min(92, dimensions().width - right()))
  const label = () => {
    const variant = toast.currentToast?.variant
    if (variant === "success") return "Success"
    if (variant === "warning") return "Warning"
    if (variant === "error") return "Error"
    return "Info"
  }
  const glyph = () => {
    const variant = toast.currentToast?.variant
    if (variant === "success") return "✓"
    if (variant === "warning") return "!"
    if (variant === "error") return "✗"
    return "⋯"
  }

  return (
    <Show when={toast.currentToast}>
      {(current) => (
        <box
          position="absolute"
          justifyContent="center"
          alignItems="flex-start"
          top={3}
          right={right()}
          width={width()}
          border={["left", "right"]}
          borderColor={themeV2.text.feedback[current().variant].default}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={2}
          paddingBottom={2}
          backgroundColor={themeV2.background.surface.overlay}
          flexDirection="column"
          gap={1}
        >
          <text attributes={TextAttributes.BOLD} fg={themeV2.text.feedback[current().variant].default}>
            {glyph()} {label()}
            <Show when={current().title}> · {current().title}</Show>
          </text>
          <text fg={themeV2.text.default} wrapMode="word">
            {current().message}
          </text>
        </box>
      )}
    </Show>
  )
}

function init() {
  const [store, setStore] = createStore({
    currentToast: null as ToastOptions | null,
  })

  let timeoutHandle: NodeJS.Timeout | null = null

  const toast = {
    show(options: ToastInput) {
      const toastOptions = { ...options, duration: options.duration ?? 5000 }
      setStore("currentToast", toastOptions)
      if (timeoutHandle) clearTimeout(timeoutHandle)
      timeoutHandle = setTimeout(() => {
        setStore("currentToast", null)
      }, toastOptions.duration).unref()
    },
    error: (err: unknown) =>
      toast.show({
        variant: "error",
        message: errorMessage(err),
      }),
    get currentToast(): ToastOptions | null {
      return store.currentToast
    },
  }
  return toast
}

export type ToastContext = ReturnType<typeof init>

const ctx = createContext<ToastContext>()

export function ToastProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useToast() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return value
}
