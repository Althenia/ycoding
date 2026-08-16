import type { SessionAutonomyState } from "@ycoding-ai/client"
import { useClient } from "../context/client"
import { type DialogContext, useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { activateGoal, retainSessionSubmission, type SessionSubmissionRetry } from "../util/session-autonomy"

export function DialogSessionGoal(props: {
  sessionID: string
  currentGoal?: string
  onUpdated?: (state: SessionAutonomyState) => void
}) {
  const dialog = useDialog()
  const client = useClient()
  const toast = useToast()
  let retry: SessionSubmissionRetry<{ sessionID: string; goal: string }> | undefined

  return (
    <DialogPrompt
      title="Set autonomous goal"
      placeholder="Describe the outcome YCoding should achieve"
      value={props.currentGoal}
      onConfirm={(value) => {
        const goal = value.trim()
        if (!goal) return
        const key = JSON.stringify({ sessionID: props.sessionID, goal })
        const submission = retainSessionSubmission(retry, key, 0, {
          sessionID: props.sessionID,
          goal,
        })
        if (submission.key !== key) {
          toast.show({
            message: "Retry the previous goal before submitting changed content",
            variant: "error",
            duration: 5000,
          })
          return
        }
        retry = submission
        void activateGoal({
          sessionID: submission.payload.sessionID,
          id: retry.promptID,
          goal: submission.payload.goal,
          get: () => client.api.session.autonomy.get({ sessionID: submission.payload.sessionID }),
          set: (payload) => client.api.session.autonomy.set({ sessionID: submission.payload.sessionID, payload }),
          prompt: (input) => client.api.session.prompt(input),
        })
          .then((state) => {
            retry = undefined
            props.onUpdated?.(state)
            toast.show({ message: "Goal mode activated", variant: "success", duration: 3000 })
            dialog.clear()
          })
          .catch((error) =>
            toast.show({
              message: `Failed to set goal: ${errorMessage(error)}`,
              variant: "error",
              duration: 5000,
            }),
          )
      }}
      onCancel={() => dialog.clear()}
    />
  )
}

DialogSessionGoal.show = (
  dialog: DialogContext,
  sessionID: string,
  currentGoal?: string,
  onUpdated?: (state: SessionAutonomyState) => void,
) => dialog.replace(() => <DialogSessionGoal sessionID={sessionID} currentGoal={currentGoal} onUpdated={onUpdated} />)
