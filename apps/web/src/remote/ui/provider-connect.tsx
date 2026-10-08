import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { Modal } from "../../ui/modal"
import { CustomSelect } from "../../ui/custom-select"
import { useRemote } from "../context"
import type { CatalogTarget } from "../catalog"
import { createProviderAuth, providerAuthPrompts, type ProviderAuthState } from "../provider-auth"
import "./provider-connect.css"

export function ProviderConnect(props: { readonly target: CatalogTarget; readonly returnFocus: HTMLElement; readonly onClose: () => void; readonly onConnected?: (providerID: string) => void }) {
  const remote = useRemote()
  const scope = remote.scope()
  const [state, setState] = createSignal<ProviderAuthState>({ phase: "loading", integrations: [] })
  const [integrationID, setIntegrationID] = createSignal("")
  const [methodID, setMethodID] = createSignal("")
  const [label, setLabel] = createSignal("default")
  const [secret, setSecret] = createSignal("")
  const [code, setCode] = createSignal("")
  const [inputs, setInputs] = createSignal<Readonly<Record<string, string>>>({})
  const current = () => scope !== undefined && remote.scope()?.deviceID === scope.deviceID && remote.scope()?.generation === scope.generation && remote.state().transport.kind === "open"
  const auth = scope === undefined ? undefined : createProviderAuth({ scope, target: props.target, current,
    request: (operation, input) => remote.store.link.request(scope, operation, { input }), changed: setState })
  const integration = createMemo(() => state().integrations.find((item) => item.id === integrationID()))
  const methods = () => integration()?.methods ?? []
  const method = createMemo(() => methods().find((item) => (item.id ?? "key") === methodID()))
  const prompts = () => providerAuthPrompts(method()?.prompts ?? [], inputs())
  const busy = () => state().phase === "sending" || state().phase === "loading"
  const attemptActive = () => state().attempt !== undefined && ["pending", "unknown", "sending"].includes(state().phase)
  const canConnect = () => current() && !busy() && !attemptActive() && method()?.available === true && label().trim().length > 0 && label().length <= 128 && (method()?.type !== "key" || secret().trim().length > 0) && prompts().every((prompt) => inputs()[prompt.key]?.trim())
  let timer: ReturnType<typeof setTimeout> | undefined
  let notified = false
  const submit = () => {
    if (!auth || !canConnect()) return
    notified = false
    if (method()?.type === "key") { const key = secret(); setSecret(""); void auth.key(integrationID(), label().trim(), key); return }
    const visible = Object.fromEntries(prompts().map((prompt) => [prompt.key, inputs()[prompt.key] ?? ""]))
    void auth.begin(integrationID(), methodID(), label().trim(), visible)
  }
  createEffect(() => {
    if (timer) clearTimeout(timer)
    const value = state()
    if (value.phase === "pending" && value.attempt?.mode !== "code") timer = setTimeout(() => { if (current()) void auth?.check() }, 1500)
    if (value.phase === "complete" && !notified && value.integrationID) {
      notified = true
      props.onConnected?.(integration()?.providers[0] ?? value.integrationID)
    }
  })
  onMount(() => { if (auth) void auth.load() })
  onCleanup(() => { if (timer) clearTimeout(timer); setSecret(""); setCode(""); auth?.dispose() })
  return <Portal><Modal label="Connect provider" class="overlay--dialog overlay--provider-connect" returnFocus={props.returnFocus} onClose={props.onClose} onDismiss={() => auth?.dispose()}>
    <div class="stack" aria-busy={busy()}>
      <p class="field__hint">Keys and authorization codes pass through the authenticated relay to this machine. Connecting adds or replaces the named profile and makes it the machine’s provider default. Session profile selection remains separate.</p>
      <Show when={!current()}><p role="alert" class="field__hint">This machine is no longer connected. Close this dialog and reconnect before signing in.</p></Show>
      <Show when={state().phase === "loading"}><p role="status">Loading provider integrations…</p></Show>
      <Show when={state().integrations.length > 0}>
        <CustomSelect label="Provider" value={integrationID()} placeholder="Choose a provider" disabled={!current() || busy() || attemptActive()} options={state().integrations.map((item) => ({ value: item.id, label: item.name }))} onChange={(id) => {
          setIntegrationID(id); setMethodID(""); setInputs({}); setSecret("")
          const taken = new Set(state().integrations.find((item) => item.id === id)?.profiles.map((profile) => profile.name))
          const next = Array.from({ length: taken.size + 2 }, (_, index) => index === 0 ? "default" : `profile-${index + 1}`).find((name) => !taken.has(name))
          setLabel(next ?? "default")
        }} />
        <Show when={integration()}>{(item) => <>
          <Show when={item().profiles.length}><p class="field__hint">Existing profiles: {item().profiles.map((profile) => `${profile.name}${profile.active ? " (provider default)" : ""}`).join(", ")}</p></Show>
          <Show when={methods().length > 0} fallback={<p role="status" class="field__hint">This provider requires machine-local configuration. Configure its environment or credentials on the backend machine, then refresh provider profiles.</p>}><CustomSelect label="Authentication method" value={methodID()} placeholder="Choose a method" disabled={!current() || busy() || attemptActive()} options={methods().map((entry) => ({ value: entry.id ?? "key", label: entry.label }))} onChange={(id) => { setMethodID(id); setInputs({}); setSecret("") }} /></Show>
          <Show when={method()}>{(selected) => <>
            <Show when={!selected().available}><p role="status" class="field__hint">{selected().reason}</p></Show>
            <Show when={selected().type === "command"}><p class="field__hint">Runs the registered authentication command on this machine. Any browser interaction that command requires may need to be completed on the machine.</p></Show>
            <div class="field"><label class="field__label" for="provider-profile-name">Profile name</label><input id="provider-profile-name" class="input" autocomplete="off" maxlength="128" value={label()} disabled={busy() || attemptActive()} onInput={(event) => setLabel(event.currentTarget.value)} /><Show when={integration()?.profiles.some((profile) => profile.name === label().trim())}><p class="field__hint">Connecting replaces this existing profile and makes it provider default.</p></Show></div>
            <Show when={selected().type === "key"}><div class="field"><label class="field__label" for="provider-api-key">API key</label><input id="provider-api-key" class="input" type="password" autocomplete="off" spellcheck={false} maxlength="8192" value={secret()} disabled={busy()} onInput={(event) => setSecret(event.currentTarget.value)} /></div></Show>
            <For each={prompts()}>{(prompt) => <Show when={prompt.type === "select"} fallback={<div class="field"><label class="field__label" for={`provider-input-${prompt.key}`}>{prompt.message}</label><input id={`provider-input-${prompt.key}`} class="input" autocomplete="off" maxlength="2048" value={inputs()[prompt.key] ?? ""} disabled={busy() || attemptActive()} onInput={(event) => setInputs({ ...inputs(), [prompt.key]: event.currentTarget.value })} /></div>}>
              <CustomSelect label={prompt.message} value={inputs()[prompt.key]} placeholder="Choose an option" disabled={busy() || attemptActive()} options={prompt.type === "select" ? prompt.options.map((option) => ({ value: option.value, label: option.label })) : []} onChange={(value) => setInputs({ ...inputs(), [prompt.key]: value })} />
            </Show>}</For>
            <Show when={!attemptActive() && state().phase !== "complete"}><button type="button" class="button button--primary" disabled={!canConnect()} onClick={submit}>{busy() ? "Connecting…" : "Connect profile"}</button></Show>
          </>}</Show>
        </>}</Show>
      </Show>
      <Show when={state().attempt}>{(attempt) => <div class="stack">
        <Show when={attempt().url}><a class="button button--secondary" href={attempt().url} target="_blank" rel="noopener noreferrer">Open provider authorization</a></Show>
        <Show when={attempt().instructions}><p class="field__hint">{attempt().instructions}</p></Show>
        <Show when={attempt().manualCode || attempt().mode === "code"}><div class="field"><label class="field__label" for="provider-authorization-code">Authorization code</label><input id="provider-authorization-code" class="input" type="password" autocomplete="off" spellcheck={false} maxlength="2048" value={code()} disabled={busy() || !current() || state().phase !== "pending"} onInput={(event) => setCode(event.currentTarget.value)} /><button type="button" class="button button--secondary" disabled={!code().trim() || busy() || !current() || state().phase !== "pending"} onClick={() => { const value = code(); setCode(""); void auth?.complete(value).then(() => auth?.check()) }}>Submit authorization code</button></div></Show>
        <Show when={state().phase !== "complete"}><button type="button" class="button button--secondary" disabled={busy() || !current()} onClick={() => void auth?.check()}>Check authentication status</button><button type="button" class="button button--ghost" disabled={busy() || !current()} onClick={() => void auth?.cancel()}>Cancel authentication</button></Show>
      </div>}</Show>
      <Show when={state().phase === "pending"}><p role="status">Waiting for provider authorization…</p></Show>
      <Show when={state().phase === "complete"}><p role="status">Provider profile connected.</p><button type="button" class="button button--secondary" disabled={!current()} onClick={() => { notified = false; void auth?.load() }}>Connect another profile</button></Show>
      <Show when={state().message}><p role={state().phase === "failed" ? "alert" : "status"} class="field__hint">{state().message}</p></Show>
      <Show when={["failed", "unknown", "unsupported"].includes(state().phase)}><button type="button" class="button button--secondary" disabled={busy() || !current()} onClick={() => void auth?.load()}>Refresh provider profiles</button></Show>
      <Show when={state().phase === "ready" && !state().integrations.length}><p role="status">No provider integrations are available at this Location.</p></Show>
    </div>
  </Modal></Portal>
}
