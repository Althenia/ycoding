import type { SessionInfo } from "@ycoding-ai/client"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useClient } from "../../../context/client"
import { useData } from "../../../context/data"
import { Keymap } from "../../../context/keymap"
import { useRoute } from "../../../context/route"
import { useTheme } from "../../../context/theme"
import { errorMessage } from "../../../util/error"
import { openBtwSession } from "../../../util/session"
import { useToast } from "../../../ui/toast"
import { useComposerTab } from "./index"

export type SideChatEntry = {
  sessionID: string
  title: string
  current: boolean
}

export function entriesFromBtwSessions(
  sessions: ReadonlyArray<SessionInfo>,
  parentID: string,
  currentSessionID: string,
): SideChatEntry[] {
  return sessions
    .filter((session) => session.parentID === parentID && session.agent === "btw")
    .toSorted((left, right) => {
      const created = left.time.created - right.time.created
      if (created !== 0) return created
      return left.id.localeCompare(right.id)
    })
    .map((session) => ({ sessionID: session.id, title: session.title, current: session.id === currentSessionID }))
}

export function SideChatsTab(props: { sessionID: string }) {
  const composer = useComposerTab()
  onMount(() => {
    const cleanup = composer.register({
      id: "side-chats",
      label: "Side chats",
      hints: () => [
        { label: "Enter", shortcut: "open", gapAfter: 3 },
        { label: "↑↓", shortcut: "move", gapAfter: 3 },
        { label: "n", shortcut: "new side chat", gapAfter: 3 },
        { label: "Esc", shortcut: "close" },
      ],
    })
    onCleanup(cleanup)
  })
  return (
    <Show when={composer.active("side-chats")}>
      <SideChatsTabContent sessionID={props.sessionID} />
    </Show>
  )
}

function SideChatsTabContent(props: { sessionID: string }) {
  const client = useClient()
  const data = useData()
  const navigation = useRoute()
  const { themeV2 } = useTheme()
  const toast = useToast()
  const composer = useComposerTab()
  const session = createMemo(() => data.session.get(props.sessionID))
  const parentID = createMemo(() => session()?.parentID ?? props.sessionID)
  const [sessions, setSessions] = createSignal<SessionInfo[]>([])
  const [cursor, setCursor] = createSignal<string>()
  const [selectedID, setSelectedID] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [creating, setCreating] = createSignal(false)
  const entries = createMemo(() => entriesFromBtwSessions(sessions(), parentID(), props.sessionID))
  const selectedEntry = createMemo(() => entries().find((entry) => entry.sessionID === selectedID()))
  let request = 0
  let disposed = false

  const load = (input: { cursor?: string; reset?: boolean } = {}) => {
    const currentRequest = ++request
    const currentParentID = parentID()
    setLoading(true)
    setError(undefined)
    return client.api.session
      .list({ parentID: currentParentID, limit: 50, order: "desc", cursor: input.cursor })
      .then((response) => {
        if (disposed || currentRequest !== request || currentParentID !== parentID()) return
        setSessions((current) => {
          const merged = input.reset ? response.data : [...current, ...response.data]
          return [...new Map(merged.map((session) => [session.id, session])).values()]
        })
        setCursor(response.cursor.next ?? undefined)
      })
      .catch((cause) => {
        if (disposed || currentRequest !== request || currentParentID !== parentID()) return
        const message = errorMessage(cause)
        setError(message)
        toast.show({ title: "Failed to load side chats", message, variant: "error" })
      })
      .finally(() => {
        if (!disposed && currentRequest === request) setLoading(false)
      })
  }

  createEffect(() => {
    if (!composer.active("side-chats")) return
    void load({ reset: true })
  })

  createEffect(() => {
    const selected = selectedID()
    if (selected && entries().some((entry) => entry.sessionID === selected)) return
    setSelectedID(entries().find((entry) => entry.current)?.sessionID ?? entries()[0]?.sessionID)
  })

  onMount(() =>
    client.event.on("server.connected", () => {
      if (composer.active("side-chats")) void load({ reset: true })
    }),
  )
  onCleanup(() => {
    disposed = true
    request++
  })

  function openNew() {
    if (creating()) return
    setCreating(true)
    void openBtwSession({
      api: client.api.session,
      parentID: parentID(),
      messages: data.session.message.list(parentID()),
    }).then(
      (created) => {
        if (disposed) return
        setSessions((current) => [...current, created])
        setCreating(false)
        navigation.navigate({ type: "session", sessionID: created.id })
      },
      (cause) => {
        if (disposed) return
        setCreating(false)
        toast.show({ title: "Failed to open BTW", message: errorMessage(cause), variant: "error" })
      },
    )
  }

  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => composer.active("side-chats"),
    commands: [
      {
        id: "composer.side-chat.up",
        title: "Previous side chat",
        group: "Composer",
        bind: "up",
        run() {
          const index = entries().findIndex((entry) => entry.sessionID === selectedID())
          if (index <= 0) {
            composer.close()
            return
          }
          setSelectedID(entries()[index - 1]?.sessionID)
        },
      },
      {
        id: "composer.side-chat.down",
        title: "Next side chat",
        group: "Composer",
        bind: "down",
        run() {
          if (entries().length === 0) return
          const index = entries().findIndex((entry) => entry.sessionID === selectedID())
          setSelectedID(entries()[(index + 1) % entries().length]?.sessionID)
        },
      },
      {
        id: "composer.side-chat.open",
        title: "Open side chat",
        group: "Composer",
        bind: "return",
        run() {
          const entry = selectedEntry()
          if (entry) navigation.navigate({ type: "session", sessionID: entry.sessionID })
        },
      },
      {
        id: "composer.side-chat.new",
        title: "New side chat",
        group: "Composer",
        bind: "n",
        run: openNew,
      },
      {
        id: "composer.side-chat.more",
        title: "Load older side chats",
        group: "Composer",
        bind: "ctrl+n",
        run() {
          const next = cursor()
          if (next && !loading()) void load({ cursor: next })
        },
      },
      {
        id: "composer.side-chat.retry",
        title: "Retry side chats",
        group: "Composer",
        bind: "r",
        run() {
          if (error()) void load({ reset: true })
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" paddingTop={2}>
      <text fg={themeV2.text.default} onMouseUp={openNew}>
        {creating() ? " Opening side chat…" : "+ New side chat"}
      </text>
      <Show when={error()}>
        {(message) => (
          <box flexDirection="row" gap={1}>
            <text fg={themeV2.text.feedback.error.default}> Unable to load side chats: {message()}</text>
            <text fg={themeV2.text.action.primary.default} onMouseUp={() => void load({ reset: true })}>
              Retry
            </text>
          </box>
        )}
      </Show>
      <Show when={loading() && entries().length === 0}>
        <text fg={themeV2.text.subdued}> Loading side chats…</text>
      </Show>
      <Show when={!loading() && !error() && entries().length === 0}>
        <text fg={themeV2.text.subdued}> No side chats</text>
      </Show>
      <Show when={entries().length > 0}>
        <For each={entries()}>
          {(entry) => {
            const active = createMemo(() => entry.sessionID === selectedID())
            return (
              <box
                paddingRight={1}
                backgroundColor={active() ? themeV2.background.surface.offset : undefined}
                onMouseOver={() => setSelectedID(entry.sessionID)}
                onMouseUp={() => navigation.navigate({ type: "session", sessionID: entry.sessionID })}
              >
                <text
                  fg={active() || entry.current ? themeV2.text.feedback.info.default : themeV2.text.default}
                  truncate
                  wrapMode="none"
                >
                  {active() ? "> " : "  "}{entry.title}
                </text>
              </box>
            )
          }}
        </For>
      </Show>
      <Show when={cursor()}>
        <text fg={themeV2.text.action.primary.default} onMouseUp={() => void load({ cursor: cursor() })}>
          {loading() ? " Loading older side chats…" : " + More side chats"}
        </text>
      </Show>
    </box>
  )
}
