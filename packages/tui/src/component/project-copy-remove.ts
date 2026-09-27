import type { YCodingClient } from "@ycoding-ai/client"
import type { DialogContext } from "../ui/dialog"
import type { ToastContext } from "../ui/toast"
import { errorMessage } from "../util/error"
import { isRecord } from "../util/record"
import { DialogWorkspaceFileChanges } from "./dialog-workspace-file-changes"

export async function removeProjectCopy(input: {
  client: YCodingClient
  dialog: DialogContext
  toast: ToastContext
  projectID: string
  location: string
  directory: string
  onForce: () => void
}) {
  const error = await remove(input, false)
  if (!error) return { removed: true, prompted: false }
  if (!(isRecord(error) && isRecord(error.data) && error.data.forceRequired === true)) {
    failed(input.toast, error)
    return { removed: false, prompted: false }
  }
  const status = await input.client.vcs.status({ location: { directory: input.directory } }).catch(() => undefined)
  const choice = await DialogWorkspaceFileChanges.show(input.dialog, status?.data ?? [], {
    title: "Delete working copy?",
    message: "This working copy has file changes. Do you want to delete it anyway?",
  })
  if (choice !== "yes") return { removed: false, prompted: true }
  input.onForce()
  const forcedError = await remove(input, true)
  if (!forcedError) return { removed: true, prompted: true }
  failed(input.toast, forcedError)
  return { removed: false, prompted: true }
}

function remove(
  input: { client: YCodingClient; projectID: string; location: string; directory: string },
  force: boolean,
) {
  return input.client.projectCopy
    .remove({
      projectID: input.projectID,
      location: { directory: input.location },
      directory: input.directory,
      force,
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    )
}

function failed(toast: ToastContext, error: unknown) {
  toast.show({
    variant: "error",
    title: "Failed to delete project copy",
    message: errorMessage(error),
  })
}
