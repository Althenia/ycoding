import type { GuardrailRequestListOutput } from "@ycoding-ai/client"
import { createSignal, For, Show } from "solid-js"
import { useClient } from "../../context/client"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { Prompt } from "./permission"

export type GuardrailRequest = GuardrailRequestListOutput[number]

export function guardrailPresentation(request: GuardrailRequest) {
  return {
    title: "Session guardrail review",
    actor:
      request.sessionID === request.rootSessionID
        ? `Session ${request.sessionID}`
        : `Subagent ${request.sessionID} in ${request.rootSessionID}`,
    action: request.action,
    reason: request.reason,
    resources: request.resources,
    rules: request.ruleIDs,
  }
}

export function GuardrailPrompt(props: { request: GuardrailRequest }) {
  const client = useClient()
  const toast = useToast()
  const { themeV2 } = useTheme().contextual("elevated")
  const [submitting, setSubmitting] = createSignal(false)
  const presentation = () => guardrailPresentation(props.request)

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
      semanticLabel={`${presentation().title}: ${presentation().action}`}
      instance={props.request.id}
      escapeKey="reject"
      options={{ once: "Approve once", always: "Always", reject: "Reject" }}
      onSelect={(option) => reply(option)}
      body={
        <box paddingLeft={1} gap={1}>
          <text fg={themeV2.text.default}>{presentation().reason}</text>
          <text fg={themeV2.text.subdued}>Actor: {presentation().actor}</text>
          <text fg={themeV2.text.subdued}>Action: {presentation().action}</text>
          <Show when={presentation().resources.length > 0}>
            <box>
              <text fg={themeV2.text.subdued}>Resources</text>
              <For each={presentation().resources.slice(0, 8)}>
                {(resource) => <text fg={themeV2.text.default}>{resource}</text>}
              </For>
              <Show when={presentation().resources.length > 8}>
                <text fg={themeV2.text.subdued}>+{presentation().resources.length - 8} more</text>
              </Show>
            </box>
          </Show>
          <Show when={presentation().rules.length > 0}>
            <text fg={themeV2.text.subdued}>Matched: {presentation().rules.join(", ")}</text>
          </Show>
        </box>
      }
    />
  )
}
