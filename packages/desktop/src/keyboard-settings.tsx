import { createSignal, For, Show } from "solid-js"
import { CustomSelect } from "../../../apps/web/src/ui/custom-select"
import { Icon } from "../../../apps/web/src/ui/icon"
import { KEYBOARD_ACTIONS, applyKeyboardBinding, bindingFromEvent, keyboardBindings, shortcutLabel, type KeyboardBinding, type KeyboardOverrides } from "./keyboard"

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

export function KeyboardSettings(props: { value: KeyboardOverrides; onChange: (value: KeyboardOverrides) => void }) {
  const [action, setAction] = createSignal(KEYBOARD_ACTIONS[0]!.id)
  const [error, setError] = createSignal<string>()
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
    <div class="desktop-keyboard-editor" role="group" aria-label="Shortcut editor">
    <CustomSelect label="Command" sheetTitle="Command shortcut" placeholder="Choose a command" value={action()} options={KEYBOARD_ACTIONS.map((item) => ({ value: item.id, label: item.id === "palette" ? item.label : `/${item.id} · ${item.label}` }))} onChange={(value) => { setAction(value); setError(undefined) }} />
    <label class="rl-field" data-invalid={error() ? "true" : undefined}><span>Shortcut</span>
      <input readOnly value={current()} placeholder="Unassigned. Focus here and press a shortcut." aria-invalid={error() ? "true" : undefined} onKeyDown={capture} />
    </label>
    <div class="desktop-dialog__actions">
      <button type="button" class="rl-icon-button" aria-label="Unbind" data-tooltip="Unbind" disabled={!current()} onClick={() => apply(null)}><Icon name="minus" /></button>
      <button type="button" class="rl-icon-button" aria-label="Use default" data-tooltip="Use default" disabled={!Object.hasOwn(props.value, action())} onClick={() => apply(undefined)}><Icon name="undo" /></button>
      <button type="button" class="rl-icon-button" aria-label="Reset all shortcuts" data-tooltip="Reset all shortcuts" disabled={Object.keys(props.value).length === 0} onClick={() => { setError(undefined); props.onChange({}) }}><Icon name="reset" /></button>
    </div></div>
    <p class="desktop-keyboard-hint">Focus Shortcut and press {mac ? "⌘ or Ctrl" : "Ctrl"} with a key. Text editing and app menu shortcuts stay reserved.</p>
    <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
    <div class="desktop-shortcut-list" aria-label="Assigned shortcuts">
      <For each={KEYBOARD_ACTIONS}>{(entry) =>
        <button type="button" class="rl-btn" aria-pressed={entry.id === action()} onClick={() => { setAction(entry.id); setError(undefined) }}>
          <span>{entry.label}</span><span class="desktop-shortcut-chords"><For each={keyboardBindings(props.value).filter(binding => binding.action === entry.id)} fallback={<small>Unassigned</small>}>{binding => <kbd>{shortcutLabel(binding.binding, mac)}</kbd>}</For></span>
        </button>}
      </For>
    </div>
  </div>
}
