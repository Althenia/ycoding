import { DialogSelect } from "../../ui/dialog-select"
import { useRoute } from "../../context/route"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { createEffect, createMemo, createSignal } from "solid-js"

export function DialogSubagent(props: { sessionID: string }) {
  const route = useRoute()
  const client = useClient()
  const data = useData()
  const [selected, setSelected] = createSignal<string>()
  createEffect(() => void data.session.subagent.sync(props.sessionID))
  const tasks = createMemo(() => data.session.subagent.page(props.sessionID)?.data ?? [])

  return (
    <DialogSelect
      title="Subagents"
      options={tasks().map((task) => ({
        title: task.sessionID,
        description: task.description,
        category: ["starting", "running", "waiting", "cancelling"].includes(task.state) ? "Active" : "Inactive",
        state:
          task.state === "waiting"
            ? ("failed" as const)
            : task.state === "starting" || task.state === "running" || task.state === "cancelling"
              ? ("connecting" as const)
              : task.state === "completed"
                ? ("connected" as const)
                : ("disabled" as const),
        footer:
          task.state === "waiting"
            ? "Awaiting input"
            : task.state === "running"
              ? task.progress?.text
              : task.state === "completed"
                ? `Done · ${Math.max(0, Math.round((task.time.updated - task.time.created) / 1000))}s`
                : task.state === "cancelled"
                  ? "Cancelled"
                  : task.state,
        value: task.sessionID,
      }))}
      onSelect={(option) => {
        route.navigate({ type: "session", sessionID: option.value })
      }}
      onMove={(option) => setSelected(option.value)}
      footer={<text>r answer · ⌃x k cancel</text>}
      bindings={[
        {
          bind: "r",
          title: "Answer subagent",
          group: "Dialog",
          run: () => {
            const task = tasks().find((item) => item.sessionID === (selected() ?? tasks()[0]?.sessionID))
            if (task?.state === "waiting") route.navigate({ type: "session", sessionID: task.sessionID })
          },
        },
        {
          bind: "ctrl+x k",
          title: "Cancel subagent",
          group: "Dialog",
          run: () => {
            const task = tasks().find((item) => item.sessionID === (selected() ?? tasks()[0]?.sessionID))
            if (!task || !["starting", "running", "waiting"].includes(task.state)) return
            void client.api.session.subagent
              .cancel({ parentID: props.sessionID, childID: task.sessionID })
              .then(() => data.session.subagent.sync(props.sessionID))
          },
        },
      ]}
    />
  )
}
