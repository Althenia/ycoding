import { DialogSelect } from "../../ui/dialog-select"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { useDialog } from "../../ui/dialog"

export const usageGroupOptions = [
  { value: "model", title: "Model (recorded selection)" },
  { value: "provider", title: "Provider" },
  { value: "provider-profile-model", title: "Provider / profile / model" },
  { value: "provider-model", title: "Provider / model" },
  { value: "model-id", title: "Model ID" },
  { value: "profile", title: "Provider / profile" },
  { value: "session", title: "Sessions" },
  { value: "project", title: "Projects" },
  { value: "agent", title: "Agents" },
  { value: "prompt", title: "Prompts" },
  { value: "task", title: "Tasks (inclusive)" },
] as const
export type UsageGroupPresentation = (typeof usageGroupOptions)[number]["value"]

export function UsageGroupDialog(props: { current: UsageGroupPresentation; onSelect: (group: UsageGroupPresentation) => void }) {
  const dialog = useDialog()
  return <DialogSelect title="Usage group" current={props.current} options={[...usageGroupOptions]} onSelect={(option) => { props.onSelect(option.value); dialog.clear() }} />
}

export function UsageFilterDialog(props: { label: string; value?: string; onSelect: (value: string | undefined) => void }) {
  const dialog = useDialog()
  return <DialogPrompt title={props.label} value={props.value} placeholder="Leave empty for all" onConfirm={(value) => { props.onSelect(value.trim() || undefined); dialog.clear() }} />
}
