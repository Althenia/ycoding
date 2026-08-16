import type { GuardrailRequestListOutput } from "@ycoding-ai/client"
import { createSignal, For, Show } from "solid-js"
import { useClient } from "../../context/client"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { GLYPHS } from "../../ui/glyph"
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
      options={{ once: "Allow once", always: "Allow for this session", reject: "Deny" }}
      onSelect={(option) => reply(option)}
      header={
        <box flexDirection="row" gap={1}>
          <text fg={themeV2.text.feedback.warning.default}>{GLYPHS.guardrailBlocked.glyph}</text>
          <text fg={themeV2.text.default}>{presentation().title}</text>
        </box>
      }
      body={
        <box paddingLeft={1} gap={1}>
          <text fg={themeV2.text.default}>
            guardrail · {presentation().reason} <span style={{ fg: themeV2.text.feedback.warning.default }}>needs approval</span>
          </text>
          <text fg={themeV2.text.feedback.warning.default}>Guardrails apply even in YOLO mode.</text>
          <text fg={themeV2.text.subdued}>Actor: {presentation().actor}</text>
          <text fg={themeV2.text.subdued}>Action: {presentation().action}</text>
          <Show when={presentation().resources.length > 0}>
            <box flexDirection="column">
              <For each={presentation().resources.slice(0, 8)}>
                {(resource) => <text fg={themeV2.text.default}>Resource: {resource}</text>}
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
