import type { SessionAutonomyView } from "@ycoding-ai/client"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useToast } from "../ui/toast"
import {
  allAutonomyChange,
  autonomyModeWord,
  autonomyRows,
  cycleAutonomyMode,
  type AutonomyCategory,
  type AutonomyChange,
  type AutonomyDefaults,
  type AutonomyDefaultsChange,
  type AutonomyDefaultsServer,
} from "../util/session-autonomy"

type PendingYolo = { type: "session"; change: AutonomyChange } | { type: "default"; category: AutonomyCategory }

export function DialogAutonomous(props: {
  autonomy: () => SessionAutonomyView | undefined
  save: (change: AutonomyChange) => Promise<unknown>
  defaults: AutonomyDefaultsServer
}) {
  const toast = useToast()
  const { theme } = useTheme().contextual("elevated")
  const shortcuts = Keymap.useShortcuts()
  const [focused, setFocused] = createSignal<AutonomyCategory>("permissions")
  const [saving, setSaving] = createSignal(false)
  const [pending, setPending] = createSignal<PendingYolo>()
  const [defaults, setDefaults] = createSignal<AutonomyDefaults>()
  const rows = createMemo(() => autonomyRows(props.autonomy()))
  let defaultsVersion = 0

  onMount(async () => {
    const version = defaultsVersion
    try {
      const loaded = await props.defaults.get()
      if (version === defaultsVersion) setDefaults(loaded)
    } catch (error) {
      toast.error(error)
    }
  })

  const persistDefault = async (change: AutonomyDefaultsChange) => {
    if (saving()) return
    setSaving(true)
    try {
      const saved = await props.defaults.set(change)
      defaultsVersion += 1
      setDefaults(saved)
    } catch (error) {
      toast.error(error)
    } finally {
      setSaving(false)
    }
  }

  const saveDefault = () => {
    if (saving() || pending()) return
    const row = rows().find((item) => item.category === focused())
    if (!row?.local) return
    if (row.local === "yolo") {
      setPending({ type: "default", category: row.category })
      return
    }
    void persistDefault({ [row.category]: row.local })
  }

  const resetDefault = () => {
    if (saving() || pending()) return
    void persistDefault({ [focused()]: "manual" })
  }

  const persist = async (change: AutonomyChange) => {
    if (saving()) return
    setSaving(true)
    try {
      await props.save(change)
    } catch (error) {
      toast.error(error)
    } finally {
      setSaving(false)
    }
  }

  const save = (change: AutonomyChange) => {
    if (saving() || pending()) return
    if (rows().some((row) => change[row.category] === "yolo" && row.local !== "yolo")) {
      setPending({ type: "session", change })
      return
    }
    void persist(change)
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
        ...(defaults() ? { description: `Default: ${autonomyModeWord(defaults()![row.category])}` } : {}),
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
    <Show when={pending()} fallback={<DialogSelect
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
        { id: "dialog.autonomous.default_save", title: "Save as default", group: "Dialog", run: saveDefault },
        { id: "dialog.autonomous.default_reset", title: "Reset default", group: "Dialog", run: resetDefault },
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
          <text fg={theme.text.subdued}>
            {key("dialog.autonomous.default_save")} save as default · {key("dialog.autonomous.default_reset")} reset default
          </text>
        </box>
      }
    />}>
      {(request) => <DialogConfirm
        title={request().type === "default" ? "Save YOLO default" : "Enable YOLO"}
        message="Each YOLO category disables its blockers. With all categories in YOLO, all blockers are disabled: hard, catastrophic and destructive guardrails, permission blocks, and all questions, including free-text and open questions. Progression is aggressive. You accept full responsibility for its actions."
        label={request().type === "default" ? "Accept risk & save YOLO default" : "Accept risk & enable YOLO"}
        preserveLabel
        keepOpen
        onConfirm={() => {
          const selected = request()
          setPending(undefined)
          if (selected.type === "default") void persistDefault({ [selected.category]: "yolo", acceptYolo: true })
          else void persist(selected.change)
        }}
        onCancel={() => setPending(undefined)}
      />}
    </Show>
  )
}
