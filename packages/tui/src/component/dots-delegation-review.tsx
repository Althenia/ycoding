import type { Dots } from "@ycoding-ai/schema/dots"
import { For } from "solid-js"
import { escapeDisplayText } from "@ycoding-ai/client/tool-display"
import { useTheme } from "../context/theme"

export function DotsDelegationReview(props: { value: Dots.DelegationReview }) {
  const { theme } = useTheme()
  const lines = () => [
    "OAuth client — not a verified Dot or person",
    `Owner: ${props.value.principal.ownerID}`,
    `Device: ${props.value.principal.deviceID}`,
    `OAuth client: ${props.value.principal.clientID}`,
    `OAuth epoch: ${props.value.principal.epoch}`,
    `OAuth grant: ${props.value.principal.grantID}`,
    `Source exchange: ${props.value.sourceExchangeID}`,
    `Target Session: ${props.value.targetSessionID}`,
    `Native task: ${props.value.taskInputID}`,
    ...props.value.task.split("\n"),
    `Allowed operations: ${props.value.scope.operations.join(", ")}`,
    `Allowed formats: ${props.value.scope.format?.join(", ") ?? "unchanged"}`,
    `Allowed detail: ${props.value.scope.detail?.join(", ") ?? "unchanged"}`,
    `Expires: ${delegationExpiry(props.value.expiresAt)}`,
    `Profile: ${props.value.expectedAttachment.profile}`,
    `Dot: ${props.value.expectedAttachment.dotID}`,
    `Conversation: ${props.value.expectedAttachment.threadID}`,
    `Binding generation: ${props.value.expectedAttachment.generation}`,
    `Proposal: ${props.value.proposalID}`,
    `Fingerprint: ${props.value.fingerprint}`,
    "Current binding only. Restart, a new task, owner change, revoke or Unbind/rebind invalidates future admissions and unpromoted delegated inputs.",
    "Already executing native work continues. No new tasks, approval authority or human answers.",
  ]
  return (
    <box paddingLeft={3} paddingRight={3} flexShrink={0}>
      <For each={lines()}>
        {(line) => (
          <text fg={theme.text.default} wrapMode="word">
            {escapeDisplayText(line) || " "}
          </text>
        )}
      </For>
    </box>
  )
}

export function DotsSessionDelegationReview(props: { value: Dots.SessionDelegationReview }) {
  const { theme } = useTheme()
  const lines = () => [
    "OAuth client — not a verified Dot or person",
    `Owner: ${props.value.principal.ownerID}`,
    `Device: ${props.value.principal.deviceID}`,
    `OAuth client: ${props.value.principal.clientID}`,
    `OAuth epoch: ${props.value.principal.epoch}`,
    `OAuth grant: ${props.value.principal.grantID}`,
    `Source exchange: ${props.value.sourceExchangeID}`,
    `Target Session: ${props.value.targetSessionID}`,
    `Allowed operations: ${props.value.scope.operations.join(", ")}`,
    `Expires: ${delegationExpiry(props.value.expiresAt)}`,
    `Profile: ${props.value.expectedAttachment.profile}`,
    `Dot: ${props.value.expectedAttachment.dotID}`,
    `Conversation: ${props.value.expectedAttachment.threadID}`,
    `Binding generation: ${props.value.expectedAttachment.generation}`,
    `Proposal: ${props.value.proposalID}`,
    `Fingerprint: ${props.value.fingerprint}`,
    "Current binding only. Restart, owner change, revoke or Unbind/rebind invalidates future admissions and unpromoted delegated inputs.",
    "Client-delegated, not human. Tasks, and ordinary decisions only when allowed, within the approved scope; already executing native work continues.",
  ]
  return (
    <box paddingLeft={3} paddingRight={3} flexShrink={0}>
      <For each={lines()}>
        {(line) => (
          <text fg={theme.text.default} wrapMode="word">
            {escapeDisplayText(line) || " "}
          </text>
        )}
      </For>
    </box>
  )
}

function delegationExpiry(time: number) {
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? date.toISOString() : "unavailable"
}
