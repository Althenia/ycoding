import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { Modal } from "../../ui/modal"
import { useRemote } from "../context"
import { dotsClient } from "../dots"
import { describeOutcome } from "../outcome"
import { remoteKeys } from "../queries"
import { createRemoteQuery } from "../query"
import { dotsConnectionView } from "../view-model"
import type { RemoteDotsComputerTarget } from "@ycoding-ai/remote"
import "./dots-connection.css"

export function DotsConnection(props: { readonly returnFocus: HTMLElement; readonly onClose: () => void }) {
  const remote = useRemote()
  const [visible, setVisible] = createSignal(true)
  const [mutation, setMutation] = createSignal<{ readonly key: string; readonly pending: boolean; readonly message?: string }>()
  const scope = () => remote.state().transport.kind === "open" ? remote.scope() : undefined
  const key = () => scope() ? remoteKeys.dots(scope()!) : ["remote", "dots", "idle"] as const
  const query = createRemoteQuery(remote.store.queryClient, () => {
    const owner = scope()
    return {
      queryKey: key(),
      enabled: visible() && owner !== undefined,
      staleTime: 0,
      retry: false,
      refetchOnMount: "always" as const,
      refetchInterval: visible() && owner !== undefined ? 5000 : false as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => dotsClient(remote.store.link, owner!).get(signal),
    }
  })
  const [confirmingAttach, setConfirmingAttach] = createSignal(false)
  let attachTarget: RemoteDotsComputerTarget | undefined
  createEffect(() => {
    if (!view().canAttach) setConfirmingAttach(false)
  })
  createEffect(() => {
    if (mutation()?.key !== JSON.stringify(key())) setMutation(undefined)
  })
  onCleanup(() => setVisible(false))
  const view = () => {
    const result = query()
    return dotsConnectionView({
      status: result.data,
      computer: remote.state().devices.find((device) => device.id === remote.state().activeDeviceID)?.name,
      online: scope() !== undefined,
      loading: result.isFetching || result.isPending,
      pending: mutation()?.pending === true,
      error: result.isError ? result.error.message : undefined,
    })
  }
  const refresh = () => { if (visible() && scope()) void query().refetch() }
  const run = (call: (client: ReturnType<typeof dotsClient>) => ReturnType<ReturnType<typeof dotsClient>["set"]>, subject: string) => {
    const owner = scope()
    if (!owner || !visible()) return
    const pending = { key: JSON.stringify(key()), pending: true }
    setMutation(pending)
    const owns = () => visible() && mutation() === pending && pending.key === JSON.stringify(key())
    void call(dotsClient(remote.store.link, owner)).then(async (outcome) => {
      if (!owns()) return
      if (outcome.status !== "ok") {
        setMutation({ key: pending.key, pending: false, message: describeOutcome(outcome, subject) })
        refresh()
        return
      }
      await remote.store.queryClient.invalidateQueries({ queryKey: key(), exact: true })
      if (owns()) setMutation(undefined)
    }, () => {
      if (!owns()) return
      setMutation({ key: pending.key, pending: false, message: `${subject} outcome is unknown. Refresh to check; the change was not replayed.` })
      refresh()
    })
  }
  const change = () => {
    const status = query().data
    if (!status || !view().canChange) return
    run((client) => client.set(!status.access.enabled, status.access.revision), "Dots access")
  }
  const attach = () => {
    setConfirmingAttach(false)
    if (view().canAttach) run((client) => client.attach(attachTarget), "Dots computer")
  }
  return <Portal><Modal label="Dots connection" class="overlay--dialog overlay--dots" returnFocus={props.returnFocus} onDismiss={() => setVisible(false)} onClose={props.onClose}>
    <div class="stack dots-connection" aria-busy={mutation()?.pending === true}>
      <p class="field__hint">Access covers every existing and future eligible Session on this backend. Disconnect closes the native connection without interrupting admitted work.</p>
      <dl class="stack dots-connection__facts">
        <For each={[
          { label: "Computer", value: view().computer },
          ...(view().name ? [{ label: "Name", value: view().name }] : []),
          ...(view().executor?.name ? [{ label: "Executor name", value: view().executor!.name }] : []),
          { label: "Profile", value: view().profile },
          { label: "Configuration", value: view().configuration, message: view().configurationMessage },
          { label: "Access", value: view().access },
          { label: "Transport", value: view().transport, message: view().connectionMessage },
          ...(view().executor ? [{ label: "Executor", value: view().executor!.label, message: view().executor!.message }] : []),
        ]}>{(row) => <div><dt class="field__label">{row.label}</dt><dd>{row.value}<Show when={row.message}><p class="field__hint">{row.message}</p></Show></dd></div>}</For>
      </dl>
      <Show when={view().notice}><p class="field__hint" role={query().isError ? "alert" : "status"}>{view().notice}</p></Show>
      <Show when={mutation()?.message}><p class="field__hint" role="alert">{mutation()?.message}</p></Show>
      <div class="dots-connection__actions">
        <button type="button" class="button button--primary" disabled={!view().canChange} onClick={change}>{view().action}</button>
        <button type="button" class="button button--secondary" disabled={!scope() || query().isFetching || mutation()?.pending} onClick={refresh}>Refresh</button>
      </div>
      <Show when={view().executor?.label === "Not attached"}>
        <Show when={confirmingAttach()} fallback={<div><button type="button" class="button button--secondary" disabled={!view().canAttach} onClick={() => { attachTarget = query().data?.computer?.target; setConfirmingAttach(true) }}>{view().attachAction}</button></div>}>
          <div class="stack" role="group" aria-label="Confirm computer change">
            <p class="field__hint">{view().attachConfirmation}</p>
            <div class="dots-connection__actions">
              <button type="button" class="button button--primary" disabled={!view().canAttach} onClick={attach}>Detach others and use this computer</button>
              <button type="button" class="button button--secondary" onClick={() => setConfirmingAttach(false)}>Cancel</button>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  </Modal></Portal>
}
