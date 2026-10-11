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
type Mode = "start" | "steer" | "queue" | "goal"

const modeChoices = [
  { value: "start", title: "Start a task", session: false },
  { value: "steer", title: "Steer", session: true },
  { value: "queue", title: "Queue follow-up", session: true },
  { value: "goal", title: "Goal objective", session: false },
] as const satisfies ReadonlyArray<{ value: Mode; title: string; session: boolean }>

export type PromptGenerateChoice = {
  mode: Mode
  memory: Scope[]
}

export function DialogPromptGenerate(props: {
  session: boolean
  onConfirm?: (choice: PromptGenerateChoice) => void
  onCancel?: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme().contextual("elevated")
  const dimensions = useTerminalDimensions()
  const modes = modeChoices.filter((mode) => props.session || !mode.session)
  const rows = [
    ...modes.map((mode) => ({ kind: "mode" as const, value: mode.value, title: mode.title })),
    ...scopes.map((scope) => ({ kind: "memory" as const, value: scope.value, title: scope.title })),
  ]
  const [store, setStore] = createStore({
    repository: false,
    knowledge: false,
    active: 0,
    mode: "start" as Mode,
  })

  function move(delta: number) {
    const active = (store.active + delta + rows.length) % rows.length
    const row = rows[active]
    if (!row) return
    setStore("active", active)
    if (row.kind === "mode") setStore("mode", row.value)
  }

  function toggleMemory() {
    const row = rows[store.active]
    if (!row || row.kind !== "memory") return
    setStore(row.value, !store[row.value])
  }

  function confirm() {
    props.onConfirm?.({
      mode: store.mode,
      memory: scopes.flatMap((scope) => (store[scope.value] ? [scope.value] : [])),
    })
    dialog.clear()
  }

  function cancel() {
    props.onCancel?.()
    dialog.clear()
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "up", title: "Previous prompt option", group: "Dialog", run: () => move(-1) },
      { bind: "down", title: "Next prompt option", group: "Dialog", run: () => move(1) },
      { bind: "space", title: "Toggle memory", group: "Dialog", run: toggleMemory },
      { bind: "return", title: "Generate", group: "Dialog", run: confirm },
    ],
  }))

  return (
    <box paddingTop={1} paddingBottom={1}>
      <DialogHeader title={<DialogTitle>Generate prompt</DialogTitle>} />
      <box paddingTop={1}>
        <For each={rows}>
          {(row, index) => (
            <box
              height={1}
              width={dialogPanelWidth(dimensions().width)}
              paddingLeft={3}
              paddingRight={3}
              backgroundColor={store.active === index() ? theme.background.action.primary.focused : undefined}
              onMouseUp={() => {
                setStore("active", index())
                if (row.kind === "mode") setStore("mode", row.value)
                if (row.kind === "memory") setStore(row.value, !store[row.value])
              }}
            >
              <text fg={store.active === index() ? theme.text.action.primary.focused : theme.text.default}>
                {row.kind === "mode"
                  ? `${store.mode === row.value ? "●" : "○"} ${row.title}`
                  : `${store[row.value] ? "[x]" : "[ ]"} ${row.title}`}
              </text>
            </box>
          )}
        </For>
      </box>
      <box paddingTop={1} paddingRight={3} flexDirection="row" justifyContent="flex-end" gap={1}>
        <box paddingLeft={1} paddingRight={1} onMouseUp={cancel}>
          <text fg={theme.text.subdued}>Cancel</text>
        </box>
        <text fg={theme.text.subdued}>enter</text>
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.background.action.primary.default}
          onMouseUp={confirm}
        >
          <text fg={theme.text.action.primary.default}>Generate</text>
        </box>
      </box>
    </box>
  )
}

DialogPromptGenerate.show = (dialog: DialogContext, input: { session: boolean }) => {
  return new Promise<PromptGenerateChoice | null>((resolve) => {
    let settled = false
    const finish = (choice: PromptGenerateChoice | null) => {
      if (settled) return
      settled = true
      resolve(choice)
    }
    dialog.replace(
      () => <DialogPromptGenerate session={input.session} onConfirm={finish} onCancel={() => finish(null)} />,
      () => finish(null),
    )
  })
}
