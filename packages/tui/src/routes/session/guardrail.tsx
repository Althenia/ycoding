import type { GuardrailRequestListOutput } from "@ycoding-ai/client"
import { createSignal, For, Show } from "solid-js"
import { useClient } from "../../context/client"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { Prompt } from "./permission"

export type GuardrailRequest = GuardrailRequestListOutput[number]

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

export function GuardrailPrompt(props: { request: GuardrailRequest }) {
  const client = useClient()
  const toast = useToast()
  const { themeV2 } = useTheme().contextual("elevated")
  const [submitting, setSubmitting] = createSignal(false)
  const presentation = () => guardrailPresentation(props.request)
  const resource = () => presentation().resources[0] ?? presentation().action
  const needsContext = () => props.request.sessionID !== props.request.rootSessionID || presentation().resources.length > 1

  const reply = (value: "once" | "always" | "reject") => {
    if (submitting()) return
    setSubmitting(true)
    void client.api.guardrail.request
      .reply({
        sessionID: props.request.rootSessionID,
        requestID: props.request.id,
        reply: value,
      })
      .catch((error) => toast.error(error))
      .finally(() => setSubmitting(false))
  }

  return (
    <Prompt
      kind="guardrail"
      title={presentation().title}
      semanticLabel={`guardrail · ${presentation().reason}`}
      instance={props.request.id}
      escapeKey="reject"
      defaultOption="reject"
      options={{ reject: "Deny", once: "Allow once", always: "Allow for this session" }}
      onSelect={(option) => reply(option)}
      body={
        <box flexDirection="column">
          <box paddingLeft={3} paddingRight={3}>
            <text fg={themeV2.text.feedback.info.default}>{presentation().reason}</text>
          </box>
          <box paddingLeft={3} paddingRight={3} flexDirection="row">
            <text fg={themeV2.text.feedback.warning.default}>!</text>
            <box width={2} flexShrink={0} />
            <text fg={themeV2.text.feedback.warning.default}>{resource()}</text>
            <box flexGrow={1} />
            <text fg={themeV2.text.feedback.warning.default}>Blocked</text>
          </box>
          <Show when={needsContext()}>
            <box paddingLeft={6} paddingRight={3} flexDirection="column">
              <text fg={themeV2.text.subdued}>Actor: {presentation().actor}</text>
              <text fg={themeV2.text.subdued}>Action: {presentation().action}</text>
              <For each={presentation().resources.slice(1, 8)}>
                {(value) => <text fg={themeV2.text.subdued}>Resource: {value}</text>}
              </For>
              <Show when={presentation().resources.length > 8}>
                <text fg={themeV2.text.subdued}>+{presentation().resources.length - 8} more</text>
              </Show>
            </box>
          </Show>
        </box>
      }
    />
  )
}
