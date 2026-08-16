import { Plugin } from "@ycoding-ai/plugin/tui"
import type { SessionTodoInfo } from "@ycoding-ai/client"
import { createEffect, createMemo, For, Show } from "solid-js"
import { TodoItem } from "../../component/todo-item"
import { RailSection, useRail } from "../../routes/session/rail-section"

function View(props: { context: Plugin.Context; sessionID: string }) {
  const rail = useRail()
  const list = createMemo(() => props.context.data.session.todo.get(props.sessionID))
  const visible = createMemo(() => list().some((item) => item.status !== "completed"))
  const remaining = createMemo(() => list().filter((item) => item.status !== "completed").length)
  createEffect(() => void props.context.data.session.todo.sync(props.sessionID))
  return <TodoRailContent list={list()} visible={(rail?.showTodo() ?? true) && visible()} summary={`${remaining()} open`} />
}

export function TodoRailContent(props: { list: ReadonlyArray<SessionTodoInfo>; visible?: boolean; summary?: string }) {
  return (
    <Show when={props.visible ?? true}>
      <RailSection section="todo" title="TODO LIST" summary={props.summary}>
        <box flexDirection="column" gap={1} paddingBottom={2}>
          <For each={props.list}>{(item) => <TodoItem {...item} />}</For>
        </box>
      </RailSection>
    </Show>
  )
}

export default Plugin.define({
  id: "internal:sidebar-todo",
  setup(context) {
    context.ui.slot("sidebar.content", (props) => <View context={context} sessionID={props.sessionID} />)
  },
})
