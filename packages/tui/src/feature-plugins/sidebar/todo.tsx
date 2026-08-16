import { Plugin } from "@ycoding-ai/plugin/tui"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { TodoItem } from "../../component/todo-item"
import { useTheme } from "../../context/theme"

function View(props: { context: Plugin.Context; sessionID: string }) {
  const [open, setOpen] = createSignal(true)
  const { themeV2 } = useTheme()
  const list = createMemo(() => props.context.data.session.todo.get(props.sessionID))
  const visible = createMemo(() => list().some((item) => item.status !== "completed"))
  createEffect(() => void props.context.data.session.todo.sync(props.sessionID))
  return (
    <Show when={visible()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((value) => !value)}>
          <Show when={list().length > 2}>
            <text fg={themeV2.text.default}>{open() ? "v" : ">"}</text>
          </Show>
          <text fg={themeV2.text.default}>
            <b>Todo</b>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>{(item) => <TodoItem {...item} />}</For>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "internal:sidebar-todo",
  setup(context) {
    context.ui.slot("sidebar.content", (props) => <View context={context} sessionID={props.sessionID} />)
  },
})
