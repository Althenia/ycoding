import { Plugin } from "@ycoding-ai/plugin/tui"
import { createEffect, createMemo, For, Show } from "solid-js"
import { TodoItem } from "../../component/todo-item"
import { RailSection } from "../../routes/session/rail-section"

function View(props: { context: Plugin.Context; sessionID: string }) {
  const list = createMemo(() => props.context.data.session.todo.get(props.sessionID))
  const visible = createMemo(() => list().some((item) => item.status !== "completed"))
  const remaining = createMemo(() => list().filter((item) => item.status !== "completed").length)
  createEffect(() => void props.context.data.session.todo.sync(props.sessionID))
  return (
    <Show when={visible()}>
      <RailSection section="todo" title="TODO" summary={`${remaining()} open`}>
        <For each={list()}>{(item) => <TodoItem {...item} />}</For>
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
