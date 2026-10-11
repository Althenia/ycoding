import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogTitle, dialogPanelWidth, useDialog, type DialogContext } from "../ui/dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"

const scopes = [
  { value: "repository", title: "Project memory (this repository)" },
  { value: "knowledge", title: "Global memory (shared knowledge)" },
] as const

type Scope = (typeof scopes)[number]["value"]

export function DialogSuggest(props: { onConfirm?: (memory: Scope[]) => void }) {
  const dialog = useDialog()
  const { theme } = useTheme().contextual("elevated")
  const dimensions = useTerminalDimensions()
  const [store, setStore] = createStore({
    repository: false,
    knowledge: false,
    active: "repository" as Scope,
  })

  function toggle(scope: Scope) {
    setStore("active", scope)
    setStore(scope, !store[scope])
  }

  function confirm() {
    props.onConfirm?.(scopes.flatMap((scope) => (store[scope.value] ? [scope.value] : [])))
    dialog.clear()
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "up",
        title: "Previous memory",
        group: "Dialog",
        run: () => setStore("active", store.active === "repository" ? "knowledge" : "repository"),
      },
      {
        bind: "down",
        title: "Next memory",
        group: "Dialog",
        run: () => setStore("active", store.active === "repository" ? "knowledge" : "repository"),
      },
      {
        bind: "space",
        title: "Toggle memory",
        group: "Dialog",
        run: () => setStore(store.active, !store[store.active]),
      },
      {
        bind: "return",
        title: "Suggest",
        group: "Dialog",
        run: confirm,
      },
    ],
  }))

  return (
    <box paddingTop={1} paddingBottom={1}>
      <DialogHeader title={<DialogTitle>Suggest next message</DialogTitle>} />
      <box paddingTop={1}>
        <For each={scopes}>
          {(scope) => (
            <box
              height={1}
              width={dialogPanelWidth(dimensions().width)}
              paddingLeft={3}
              paddingRight={3}
              backgroundColor={store.active === scope.value ? theme.background.action.primary.focused : undefined}
              onMouseUp={() => toggle(scope.value)}
            >
              <text fg={store.active === scope.value ? theme.text.action.primary.focused : theme.text.default}>
                {store[scope.value] ? "[x]" : "[ ]"} {scope.title}
              </text>
            </box>
          )}
        </For>
      </box>
      <box paddingTop={1} paddingRight={3} flexDirection="row" justifyContent="flex-end" gap={1}>
        <text fg={theme.text.subdued}>enter</text>
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme.background.action.primary.default} onMouseUp={confirm}>
          <text fg={theme.text.action.primary.default}>Suggest</text>
        </box>
      </box>
    </box>
  )
}

DialogSuggest.show = (dialog: DialogContext) => {
  return new Promise<Scope[] | null>((resolve) => {
    let settled = false
    const finish = (memory: Scope[] | null) => {
      if (settled) return
      settled = true
      resolve(memory)
    }
    dialog.replace(() => <DialogSuggest onConfirm={finish} />, () => finish(null))
  })
}
