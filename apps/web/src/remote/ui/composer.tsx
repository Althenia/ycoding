import { For, Show, createSignal, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { useRemote } from "../context"

/**
 * Sticky prompt composer.
 *
 * The draft lives in this component, so a reconnect that reloads session history never
 * clears what the user is typing. An in-flight mutation that never settled stays visible
 * and is only resent when the user asks for it. The composer keeps its row while output
 * streams, because it is the last row of the working column and not part of the scroll.
 */
export function Composer(props: { readonly sessionID?: string; readonly running: boolean; readonly canSend: boolean }): JSX.Element {
  const remote = useRemote()
  const [drafts, setDrafts] = createSignal<Record<string, string>>({})
  const [delivery, setDelivery] = createSignal<"steer" | "queue">("steer")

  const draft = () => props.sessionID === undefined ? "" : drafts()[props.sessionID] ?? ""
  const setDraft = (text: string) => {
    const sessionID = props.sessionID
    if (sessionID === undefined) return
    setDrafts((current) => ({ ...current, [sessionID]: text }))
  }
  const disabled = () => !props.canSend || props.sessionID === undefined
  const send = () => {
    const text = draft().trim()
    if (text.length === 0 || disabled()) return
    setDraft("")
    void remote.store.sendPrompt({ text, delivery: delivery() })
  }

  return (
    <div class="composer">
      <For each={remote.state().mutations.filter((mutation) => mutation.sessionID === props.sessionID)}>
        {(mutation) => (
          <div class={`mutation mutation--${mutation.state}`} role="status">
            <span class="mutation__label">{mutation.label}</span>
            <span class="mutation__detail">{mutation.detail ?? "Sending…"}</span>
            <Show when={mutation.kind === "prompt" && mutation.state !== "sending"}>
              <button type="button" class="button button--secondary button--small" onClick={() => void remote.store.retryMutation(mutation.id)}>
                Send again
              </button>
            </Show>
            <Show when={mutation.state !== "sending"}>
              <button type="button" class="button button--ghost button--small" onClick={() => remote.store.dismissMutation(mutation.id)}>
                Dismiss
              </button>
            </Show>
          </div>
        )}
      </For>
      <Show when={disabled()}>
        <p class="composer__note">
          <Icon name="alert" size={14} />
          {props.sessionID === undefined
            ? "Select a session from a connected device to send a prompt."
            : "Sending is unavailable on this connection."}
        </p>
      </Show>
      <div class="composer__row">
        <label class="field composer__field" style={{ flex: "1" }}>
          <span class="visually-hidden">Message your agent</span>
          <textarea
            class="textarea composer__input"
            rows={2}
            placeholder={disabled() ? "No session selected" : "Message your agent…"}
            disabled={disabled()}
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
          />
        </label>
        <div class="composer__controls">
          <div class="composer__delivery" role="group" aria-label="Delivery">
            <button
              type="button"
              class={`composer__delivery-option${delivery() === "steer" ? " composer__delivery-option--active" : ""}`}
              aria-pressed={delivery() === "steer"}
              onClick={() => setDelivery("steer")}
            >
              Steer
            </button>
            <button
              type="button"
              class={`composer__delivery-option${delivery() === "queue" ? " composer__delivery-option--active" : ""}`}
              aria-pressed={delivery() === "queue"}
              onClick={() => setDelivery("queue")}
            >
              Queue
            </button>
          </div>
          <Show when={props.running}>
            <button
              type="button"
              class="button button--danger button--icon"
              aria-label="Interrupt the running step"
              title="Interrupt"
              onClick={() => void remote.store.interrupt()}
            >
              <Icon name="stop" />
            </button>
          </Show>
          <button
            type="button"
            class="button button--primary button--icon"
            aria-label="Send prompt"
            title="Send"
            disabled={disabled() || draft().trim().length === 0}
            onClick={send}
          >
            <Icon name="send" />
          </button>
        </div>
      </div>
      <p class="composer__note">Steering applies at the next safe boundary; queueing waits until the session is idle.</p>
    </div>
  )
}
