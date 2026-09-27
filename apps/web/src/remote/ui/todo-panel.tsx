import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import type { TodoView } from "../store"
import "./todo-panel.css"

const storageKey = "ycoding.remote.todo.expanded"

export function todoSummary(todos: readonly TodoView[]) {
  return {
    progress: `${todos.filter((todo) => todo.status === "completed").length}/${todos.length}`,
    active: todos.find((todo) => todo.status === "in_progress")?.content ?? "",
  }
}

export function TodoPanel(props: { readonly todos?: readonly TodoView[] }): JSX.Element {
  const [expanded, setExpanded] = createSignal((() => {
    try { return localStorage.getItem(storageKey) === "true" } catch { return false }
  })())
  const summary = createMemo(() => todoSummary(props.todos ?? []))
  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    try { localStorage.setItem(storageKey, String(next)) } catch {}
  }
  const marker = (status: TodoView["status"]) => status === "completed" ? "✓" : status === "in_progress" ? "●" : status === "cancelled" ? "–" : "○"

  return <Show when={props.todos?.length}>
    <section class="todo-panel" aria-label="Session todo list">
      <div class="todo-panel__inner">
        <button class="todo-panel__toggle" type="button" aria-expanded={expanded()} aria-controls="session-todo-items" onClick={toggle}>
          <span class="todo-panel__heading">Todo list</span>
          <span class="todo-panel__progress">{summary().progress}</span>
          <Show when={!expanded() && summary().active}><span class="todo-panel__active">{summary().active}</span></Show>
          <span class="todo-panel__chevron" aria-hidden="true"><Icon name="chevron-down" size={16} /></span>
        </button>
        <div class={`todo-panel__drawer${expanded() ? " todo-panel__drawer--open" : ""}`} id="session-todo-items" aria-hidden={!expanded()} inert={!expanded()}>
          <ul class="todo-panel__list">
            <For each={props.todos}>{(todo) => <li class={`todo-panel__item todo-panel__item--${todo.status}`}>
              <span class="todo-panel__marker" aria-hidden="true">{marker(todo.status)}</span>
              <span class="todo-panel__text">{todo.content}</span>
            </li>}</For>
          </ul>
        </div>
      </div>
    </section>
  </Show>
}
