import { createEffect, createMemo, For, Show } from "solid-js"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"
import { TodoItem } from "../../component/todo-item"
import { useToast } from "../../ui/toast"

export function SubagentTodos(props: { sessionID: string }) {
  const data = useData()
  const client = useClient()
  const toast = useToast()
  const { themeV2 } = useTheme()
  const todos = createMemo(() => data.session.todo.get(props.sessionID))
  const open = createMemo(
    () => todos().filter((todo) => todo.status === "pending" || todo.status === "in_progress").length,
  )
  createEffect(() => {
    if (client.connection.status() !== "connected") return
    void data.session.todo.sync(props.sessionID).catch(toast.error)
  })
  return (
    <Show when={todos().length > 0}>
      <box
        marginTop={1}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        border={["top"]}
        borderColor={themeV2.border.default}
        flexShrink={0}
      >
        <text fg={themeV2.text.label}>
          <b>TODO LIST</b>{" "}
          <span style={{ fg: themeV2.text.subdued }}>
            {" "}
            · {open()}/{todos().length} open
          </span>
        </text>
        <For each={todos()}>{(todo) => <TodoItem {...todo} />}</For>
      </box>
    </Show>
  )
}
