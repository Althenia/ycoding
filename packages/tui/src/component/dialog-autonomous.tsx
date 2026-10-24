import type { SessionAutonomyView } from "@ycoding-ai/client"
import { createMemo, createSignal } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import {
  allAutonomyChange,
  autonomyModeWord,
  autonomyRows,
  cycleAutonomyMode,
  type AutonomyCategory,
  type AutonomyChange,
} from "../util/session-autonomy"

export function DialogAutonomous(props: {
  autonomy: () => SessionAutonomyView | undefined
  save: (change: AutonomyChange) => Promise<unknown>
}) {
  const toast = useToast()
  const { theme } = useTheme().contextual("elevated")
  const shortcuts = Keymap.useShortcuts()
  const [focused, setFocused] = createSignal<AutonomyCategory>("permissions")
  const [saving, setSaving] = createSignal(false)
  const rows = createMemo(() => autonomyRows(props.autonomy()))

  const save = (change: AutonomyChange) => {
    if (saving()) return
    setSaving(true)
    void props
      .save(change)
      .catch(toast.error)
      .finally(() => setSaving(false))
  }

  const cycle = (direction: 1 | -1) => {
    const row = rows().find((item) => item.category === focused())
    if (row?.local) save({ [row.category]: cycleAutonomyMode(row.local, direction) })
  }

  const setAll = (mode: "manual" | "yolo" | "auto") => {
    if (rows().every((row) => row.local)) save(allAutonomyChange(mode))
  }

  const options = createMemo(() =>
    rows().map((row) => {
      const mode = row.effective ?? row.local
      const selected = focused() === row.category
      const ink = !mode
        ? theme.text.subdued
        : mode === "manual"
          ? theme.text.feedback.success.default
          : theme.text.feedback.warning.default
      return {
        value: row.category,
        title: row.title,
        footer: (
          <span style={{ fg: selected ? theme.text.action.primary.focused : ink }}>
            {mode ? autonomyModeWord(mode) : "unknown"}
            {row.inherited ? " · inherited" : ""}
          </span>
        ),
        ...(row.inherited
          ? {
              details: [
                `Inherited from ${row.inherited} · this Session: ${row.local ? autonomyModeWord(row.local) : "unknown"}`,
              ],
              detailsWrap: true,
              detailsColor: theme.text.feedback.warning.default,
            }
          : {}),
      }
    }),
  )

  const key = (id: string) => shortcuts.get(id) ?? ""

  return (
    <DialogSelect
      title="Autonomous"
      options={options()}
      current={focused()}
      renderFilter={false}
      skipFilter
      preserveSelection
      onMove={(option) => setFocused(option.value)}
      bindings={[
        { id: "dialog.autonomous.mode_previous", title: "Cycle backward", group: "Dialog", run: () => cycle(-1) },
        { id: "dialog.autonomous.mode_next", title: "Cycle forward", group: "Dialog", run: () => cycle(1) },
        { id: "dialog.autonomous.all_manual", title: "All Manual", group: "Dialog", run: () => setAll("manual") },
        { id: "dialog.autonomous.all_yolo", title: "All YOLO", group: "Dialog", run: () => setAll("yolo") },
        { id: "dialog.autonomous.all_auto", title: "All Auto", group: "Dialog", run: () => setAll("auto") },
      ]}
      footer={
        <box flexDirection="column">
          <text fg={theme.text.subdued}>
            ↑/↓ select · {key("dialog.autonomous.mode_previous")}/{key("dialog.autonomous.mode_next")} cycle
          </text>
          <text fg={theme.text.subdued}>
            {key("dialog.autonomous.all_manual")} all Manual · {key("dialog.autonomous.all_yolo")} all YOLO ·{" "}
            {key("dialog.autonomous.all_auto")} all Auto
          </text>
        </box>
      }
    />
  )
}
