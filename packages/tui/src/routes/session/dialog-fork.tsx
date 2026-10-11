import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"
import { useClient } from "../../context/client"
import { Spinner } from "../../component/spinner"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { Locale } from "../../util/locale"
import { projectedPromptInput } from "../../prompt/codec"

export function DialogFork(props: {
  sessionID: string
  messageID?: string
  boundary?: { messageID: string; index: number; total: number }
  onMove?: (messageID?: string) => void
}) {
  const data = useData()
  const dialog = useDialog()
  const client = useClient()
  const route = useRoute()
  const toast = useToast()
  const [pending, setPending] = createSignal(false)

  const fork = async (messageID?: string) => {
    setPending(true)
    const result = await client.api.session.fork({ sessionID: props.sessionID, messageID }).catch((error) => {
      toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
      return undefined
    })
    if (!result) return dialog.clear()
    const message = messageID ? data.session.message.get(props.sessionID, messageID) : undefined
    const prompt = message?.type === "user" ? projectedPromptInput(message) : undefined
    route.navigate({
      sessionID: result.id,
      type: "session",
      prompt:
        prompt
          ? {
              ...prompt,
              agents: prompt.agents ?? [],
              pasted: [],
            }
          : undefined,
    })
    dialog.clear()
    toast.show({ message: "Forked session", variant: "success", duration: 4000 })
  }

  onMount(() => {
    dialog.setSize("large")
    if (props.messageID) void fork(props.messageID)
  })

  const options = createMemo((): DialogSelectOption<string | undefined>[] => {
    const messages = data.session.message
      .list(props.sessionID)
      .filter((message) => message.type === "user")
      .toReversed()
      .map((message) => ({
        title: message.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: () => fork(message.id),
      }))
    const history = data.session.message.history(props.sessionID)
    const older: DialogSelectOption<string | undefined>[] = history?.before ? [{
      title: history.status === "error" ? "Retry older history" : "Load older history",
      value: "history:older", description: "Fork points list loaded prompts",
      disabled: history.status === "paging" || history.status === "loading",
      onSelect: () => { void data.session.message.loadOlder(props.sessionID).catch(toast.error) },
    }] : []
    if (!props.boundary)
      return [
        { title: "From latest", value: undefined, onSelect: () => fork() },
        ...messages,
        ...older,
      ]
    return [
      {
        title: "From this message",
        value: props.boundary.messageID,
        category: "Fork point",
        description: `loaded message ${props.boundary.index} of ${props.boundary.total}`,
        onSelect: () => fork(props.boundary?.messageID),
      },
      {
        title: "From latest",
        value: undefined,
        category: "Fork point",
        description: `message ${props.boundary.total} of ${props.boundary.total}`,
        onSelect: () => fork(),
      },
      ...messages.filter((message) => message.value !== props.boundary?.messageID),
      ...older,
    ]
  })

  return (
    <Show
      when={!pending()}
      fallback={
        <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
          <Spinner>Forking session...</Spinner>
        </box>
      }
    >
      <DialogSelect
        onMove={(option) => option.value !== "history:older" && props.onMove?.(option.value)}
        title="Fork session · loaded history"
        preserveSelection
        options={options()}
      />
    </Show>
  )
}
