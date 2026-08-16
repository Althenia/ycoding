import type { GuardrailStatusOutput } from "@ycoding-ai/client"
import { Plugin } from "@ycoding-ai/plugin/tui"
import { createResource, Show, type Accessor } from "solid-js"
import { useTheme } from "../../context/theme"
import { RailSection } from "../../routes/session/rail-section"

export function guardrailSummary(status: GuardrailStatusOutput) {
  const counter = (id: string) => status.counters.find((item) => item.id === id)
  const format = (label: string, id: string) => {
    const value = counter(id)
    return value ? `${label} ${value.current} / ${value.limit}` : undefined
  }
  return {
    profile: `${title(status.profile)}${status.customRules ? ` + ${status.customRules} custom` : ""}`,
    decisions: `${status.approvals} approval${status.approvals === 1 ? "" : "s"} · ${status.blocked} blocked`,
    shells: format("Shells", "shell"),
    subagents: format("Subagents", "subagent"),
    reviews: format("Reviews", "review"),
    invalid:
      status.invalidFiles.length === 0
        ? undefined
        : `${status.invalidFiles.length} invalid guardrail file${status.invalidFiles.length === 1 ? "" : "s"}`,
  }
}

export function GuardrailContent(props: { status: Accessor<GuardrailStatusOutput | undefined> }) {
  const { themeV2 } = useTheme()
  return (
    <Show when={props.status()}>
      {(value) => {
        const summary = () => guardrailSummary(value())
        return (
          <RailSection
            section="guardrails"
            title="GUARDRAILS"
            summary={summary().profile}
            attention={Boolean(summary().invalid)}
          >
            <text fg={themeV2.text.default}>{summary().profile}</text>
            <text fg={themeV2.text.subdued}>{summary().decisions}</text>
            <Show when={summary().shells}>{(line) => <text fg={themeV2.text.subdued}>{line()}</text>}</Show>
            <Show when={summary().subagents}>{(line) => <text fg={themeV2.text.subdued}>{line()}</text>}</Show>
            <Show when={summary().reviews}>{(line) => <text fg={themeV2.text.subdued}>{line()}</text>}</Show>
            <Show when={summary().invalid}>
              {(line) => <text fg={themeV2.text.feedback.warning.default}>{line()}</text>}
            </Show>
          </RailSection>
        )
      }}
    </Show>
  )
}

function View(props: { context: Plugin.Context; sessionID: string }) {
  const [status] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      try {
        return await props.context.client.guardrail.status({ sessionID })
      } catch {
        return undefined
      }
    },
  )
  return <GuardrailContent status={status} />
}

export default Plugin.define({
  id: "internal:sidebar-guardrails",
  setup(context) {
    context.ui.slot("sidebar.content", (props) => <View context={context} sessionID={props.sessionID} />)
  },
})

function title(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Standard"
}
