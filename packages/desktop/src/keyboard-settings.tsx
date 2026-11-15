import { createSignal, For, Show } from "solid-js"
import { CustomSelect } from "../../../apps/web/src/ui/custom-select"
import { KEYBOARD_ACTIONS, applyKeyboardBinding, bindingFromEvent, keyboardBindings, shortcutLabel, type KeyboardBinding, type KeyboardOverrides } from "./keyboard"

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

export function KeyboardSettings(props: { value: KeyboardOverrides; onChange: (value: KeyboardOverrides) => void }) {
  const [action, setAction] = createSignal(KEYBOARD_ACTIONS[0]!.id)
  const [error, setError] = createSignal<string>()
  const actionLabel = (id: string) => KEYBOARD_ACTIONS.find((item) => item.id === id)?.label ?? id
  const current = () => keyboardBindings(props.value).filter((entry) => entry.action === action()).map((entry) => shortcutLabel(entry.binding, mac)).join(", ")
  const apply = (binding: KeyboardBinding | null | undefined) => {
    const result = applyKeyboardBinding(props.value, action(), binding)
    if ("error" in result) { setError(result.error); return }
    setError(undefined)
    props.onChange(result.value)
  }
  const capture = (event: KeyboardEvent) => {
    if (event.key === "Tab" || event.key === "Escape") return
    event.preventDefault()
    event.stopPropagation()
    const captured = bindingFromEvent(event, mac)
    if (!captured) return
    if ("error" in captured) setError(captured.error)
    else apply(captured.binding)
  }
  return <div class="st-stack">
    <CustomSelect label="Command" sheetTitle="Command shortcut" placeholder="Choose a command" value={action()} options={KEYBOARD_ACTIONS.map((item) => ({ value: item.id, label: item.id === "palette" ? item.label : `/${item.id} · ${item.label}` }))} onChange={(value) => { setAction(value); setError(undefined) }} />
    <label class="rl-field" data-invalid={error() ? "true" : undefined}><span>Shortcut</span>
      <input readOnly value={current()} placeholder="Unassigned. Focus here and press a shortcut." aria-invalid={error() ? "true" : undefined} onKeyDown={capture} />
      <small>Focus the field and press {mac ? "⌘ or Ctrl" : "Ctrl"} with a key. Text editing and app menu shortcuts stay reserved.</small>
    </label>
    <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
    <div class="desktop-dialog__actions">
      <button type="button" class="rl-btn" disabled={!current()} onClick={() => apply(null)}>Unbind</button>
      <button type="button" class="rl-btn" disabled={!Object.hasOwn(props.value, action())} onClick={() => apply(undefined)}>Use default</button>
      <button type="button" class="rl-btn" disabled={Object.keys(props.value).length === 0} onClick={() => { setError(undefined); props.onChange({}) }}>Reset all shortcuts</button>
    </div>
    <div class="st-rows" aria-label="Assigned shortcuts">
      <For each={keyboardBindings(props.value)}>{(entry) =>
        <button type="button" class="rl-btn" aria-pressed={entry.action === action()} onClick={() => { setAction(entry.action); setError(undefined) }}>
          {shortcutLabel(entry.binding, mac)} · {actionLabel(entry.action)}
        </button>}
      </For>
    </div>
  </div>
}
