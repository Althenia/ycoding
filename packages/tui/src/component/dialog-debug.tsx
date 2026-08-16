import { createMemo, createSignal } from "solid-js"
import { InstallationChannel, InstallationVersion } from "@ycoding-ai/core/installation/version"
import { useDialog } from "../ui/dialog"
import { useRoute } from "../context/route"
import { useLocal } from "../context/local"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { describeOS, describeTerminal } from "../util/system"
import { DialogSelect } from "../ui/dialog-select"
import { useRenderer } from "@opentui/solid"
import { writeHeapSnapshot } from "node:v8"

export function DialogDebug() {
  const dialog = useDialog()
  const renderer = useRenderer()
  const route = useRoute()
  const local = useLocal()
  const clipboard = useClipboard()
  const toast = useToast()
  const [copied, setCopied] = createSignal(false)

  dialog.setSize("large")

  const entries = createMemo(() => {
    const model = local.model.current()
    return [
      { label: "Version", value: `${InstallationVersion} (${InstallationChannel})` },
      { label: "Date", value: new Date().toISOString() },
      { label: "OS", value: describeOS() },
      { label: "Terminal", value: describeTerminal() },
      { label: "Session ID", value: route.data.type === "session" ? route.data.sessionID : "n/a" },
      { label: "Model", value: model ? `${model.providerID}/${model.modelID}` : "n/a" },
    ]
  })

  const copy = () => {
    const text = entries()
      .map((entry) => `${entry.label}: ${entry.value}`)
      .join("\n")
    void clipboard
      .write?.(text)
      .then(() => {
        setCopied(true)
        toast.show({ message: "Debug info copied to clipboard", variant: "info" })
      })
      .catch(toast.error)
  }

  return (
    <DialogSelect
      title="Debug"
      options={[
        {
          title: "Renderer stats",
          category: "Panels",
          value: "renderer",
          onSelect: () => {
            renderer.toggleDebugOverlay()
            dialog.clear()
          },
        },
        {
          title: "Event log",
          category: "Panels",
          value: "events",
          onSelect: () => {
            renderer.console.toggle()
            dialog.clear()
          },
        },
        {
          title: "Heap snapshot",
          category: "Panels",
          value: "heap",
          onSelect: () => {
            const file = writeHeapSnapshot()
            toast.show({ message: `TUI heap snapshot written to ${file}`, variant: "info", duration: 5000 })
            dialog.clear()
          },
        },
        {
          title: "Console",
          category: "Panels",
          value: "console",
          onSelect: () => {
            renderer.console.toggle()
            dialog.clear()
          },
        },
        ...entries().map((entry) => ({
          title: entry.label,
          description: entry.value,
          category: "Information",
          value: `info:${entry.label}`,
        })),
        {
          title: copied() ? "Copied debug info" : "Copy debug info",
          category: "Information",
          value: "copy",
          onSelect: copy,
        },
      ]}
    />
  )
}
