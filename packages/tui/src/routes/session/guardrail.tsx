import type { GuardrailRequestListOutput, SessionAutonomyDecisionMode } from "@ycoding-ai/client"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { useClient } from "../../context/client"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { Prompt } from "./permission"
import { GuardrailEscalation } from "../../guardrail-escalation"
import { ProjectEscalation } from "./project-escalation"

export type GuardrailRequest = GuardrailRequestListOutput[number]

export function activeGuardrail<T extends { id: string }>(
  requests: readonly T[],
  reviewID: string | undefined,
): T | undefined {
  return requests.find((request) => request.id === reviewID) ?? requests[0]
}

export function guardrailPresentation(request: GuardrailRequest) {
  return {
    title: "Guardrail blocked",
    actor:
      request.sessionID === request.rootSessionID
        ? `Session ${request.sessionID}`
        : `Subagent ${request.sessionID} in ${request.rootSessionID}`,
    action: request.action,
    reason: request.reason,
    resources: request.resources,
  }
}

export function guardrailWait(created: number, now: number) {
  const elapsed = Math.max(0, now - created)
  const seconds = Math.floor(elapsed / 1000)
  const waited =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return { waited, stale: elapsed >= Guardrail.staleAfterMs }
}

export function guardrailClosedNotice(reason: "cancelled" | "expired" | undefined) {
  if (reason === undefined) return undefined
  return `Guardrail review ${reason}. The action did not run.`
}

function isRequestGone(error: unknown) {
  const tag = typeof error === "object" && error !== null ? Reflect.get(error, "_tag") : undefined
  return tag === "GuardrailRequestNotFoundError" || tag === "SessionNotFoundError"
}

export function GuardrailPrompt(props: {
  request: GuardrailRequest
  guardrailsMode?: SessionAutonomyDecisionMode
  onClosed?: () => void
  onRetried?: () => void
}) {
  const client = useClient()
  const toast = useToast()
  const { theme } = useTheme().contextual("elevated")
  const [submitting, setSubmitting] = createSignal(false)
  const presentation = () => guardrailPresentation(props.request)
  const resource = () => presentation().resources[0] ?? presentation().action
  const needsContext = () =>
    props.request.sessionID !== props.request.rootSessionID || presentation().resources.length > 1

  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  const wait = () => (props.request.created === undefined ? undefined : guardrailWait(props.request.created, now()))

  const act = (run: () => Promise<unknown>, done?: () => void) => {
    if (submitting()) return
    setSubmitting(true)
    void run()
      .then(done)
      .catch((error) => {
        if (!isRequestGone(error)) return toast.error(error)
        props.onClosed?.()
        toast.show({ message: "This guardrail review was already settled elsewhere.", variant: "info" })
      })
      .finally(() => setSubmitting(false))
  }
  const target = () => ({ sessionID: props.request.rootSessionID, requestID: props.request.id })
  const reply = (value: "once" | "always" | "reject") =>
    act(() => client.api.guardrail.request.reply({ ...target(), reply: value }))
  const cancel = () => act(() => client.api.guardrail.request.cancel(target()), props.onClosed)
  const retry = () => act(() => client.api.guardrail.request.retry(target()), props.onRetried)

  return (
    <Prompt
      kind="guardrail"
      hardReview={props.request.hardReview}
      guardrailsMode={props.guardrailsMode}
      title={presentation().title}
      headerNote={
        <Show when={wait()}>
          {(waited) => (
            <>
              <text flexShrink={0} fg={waited().stale ? theme.text.feedback.warning.default : theme.text.subdued}>
                {` · waited ${waited().waited}`}
              </text>
              <Show when={waited().stale}>
                <text flexShrink={0} fg={theme.text.feedback.warning.default}>{" · Stale"}</text>
              </Show>
            </>
          )}
        </Show>
      }
      semanticLabel={`guardrail · ${presentation().reason}`}
      instance={props.request.id}
      escapeKey="reject"
      defaultOption="reject"
      options={
        props.request.hardReview
          ? { reject: "Deny", once: "Allow once", retry: "Retry (show again)", cancel: "Cancel (action will not run)" }
          : {
              reject: "Deny",
              once: "Allow once",
              always: "Allow for this session",
              retry: "Retry (show again)",
              cancel: "Cancel (action will not run)",
            }
      }
      onSelect={(option) => {
        if (option === "once" || option === "always" || option === "reject") return reply(option)
        if (option === "retry") return retry()
        if (option === "cancel") cancel()
      }}
      body={
        <box flexDirection="column">
          <box paddingLeft={3} paddingRight={3}><ProjectEscalation value={props.request.coordinationEscalation} /></box>
          <Show when={props.request.escalation}>{(escalation) => <box paddingLeft={3} paddingRight={3}><text fg={theme.text.feedback.warning.default} wrapMode="word">{GuardrailEscalation.text(escalation())} — your decision is required.</text></box>}</Show>
          <box paddingLeft={3} paddingRight={3}>
            <text fg={theme.text.feedback.info.default}>{presentation().reason}</text>
          </box>
          <box paddingLeft={3} paddingRight={3} flexDirection="row" flexShrink={0}>
            <text fg={theme.text.feedback.warning.default}>!</text>
            <box width={2} flexShrink={0} />
            <text flexGrow={1} flexShrink={1} fg={theme.text.feedback.warning.default}>
              {resource()}
            </text>
            <box flexGrow={1} />
            <text flexShrink={0} fg={theme.text.feedback.warning.default}>Blocked</text>
          </box>
          <box paddingLeft={3} paddingRight={3}>
            <text flexGrow={1} flexShrink={1} wrapMode="word" fg={theme.text.subdued}>
              {`Session ${props.request.sessionID} · Request ${props.request.id}`}
            </text>
          </box>
          <Show when={needsContext()}>
            <box paddingLeft={6} paddingRight={3} flexDirection="column">
              <text fg={theme.text.subdued}>Actor: {presentation().actor}</text>
              <text fg={theme.text.subdued}>Action: {presentation().action}</text>
              <For each={presentation().resources.slice(1, 8)}>
                {(value) => <text fg={theme.text.subdued}>Resource: {value}</text>}
              </For>
              <Show when={presentation().resources.length > 8}>
                <text fg={theme.text.subdued}>+{presentation().resources.length - 8} more</text>
              </Show>
            </box>
          </Show>
        </box>
      }
    />
  )
}
