import {
  BoxRenderable,
  TextareaRenderable,
  MouseEvent,
  PasteEvent,
  decodePasteBytes,
  type KeyEvent,
} from "@opentui/core"
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, Show } from "solid-js"
import { registerYCodingSpinner } from "../register-spinner"
import { fileURLToPath } from "url"
import { useLocal } from "../../context/local"
import { useTheme } from "../../context/theme"
import { tint } from "../../theme/color"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { useClipboard } from "../../context/clipboard"
import type { ClipboardReadOptions, ClipboardTemporary } from "../../clipboard"
import { useClient } from "../../context/client"
import { useRoute } from "../../context/route"
import { useEvent } from "../../context/event"
import { editorSelectionKey, useEditorContext, type EditorSelection } from "../../context/editor"
import { normalizePromptContent, openEditor } from "../../editor"
import { useExit } from "../../context/exit"
import { promptCommandPalette, promptOffsetWidth } from "../../prompt/display"
import { expandPromptInputPastedText, realignPromptInputMentions } from "../../prompt/mention"
import { parseSlashHead } from "../../prompt/parse"
import { stringWidth } from "../../util/string-width"
import { createStore, produce, unwrap } from "solid-js/store"
import { emptyPrompt, usePromptHistory, type PromptInfo, type PromptPartRef } from "../../prompt/history"
import { computePromptTraits } from "../../prompt/traits"
import { expandPastedTextPlaceholders, expandTrackedPastedText } from "../../prompt/part"
import { promptSkillMentions, promptSkillMetadata } from "../../prompt/skill"
import { usePromptStash } from "../../prompt/stash"
import { projectedPromptInput } from "../../prompt/codec"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useRenderer, type JSX } from "@opentui/solid"
import { errorMessage } from "../../util/error"
import { normalizeModelVariant } from "../../model-preference"
import { useDialog } from "../../ui/dialog"
import { DialogIntegration } from "../dialog-integration"
import { DialogModel } from "../dialog-model"
import { useConnected } from "../use-connected"
import { useToast } from "../../ui/toast"
import { createFadeIn } from "../../util/signal"
import { DialogSkill } from "../dialog-skill"
import { DialogBtwExport } from "../dialog-btw-export"
import { useArgs } from "../../context/args"
import { useConfig } from "../../config"
import { usePromptMove } from "./move"
import { readLocalAttachment } from "./local-attachment"
import { submitPromptWithSkills } from "./skill-submission"
import { useData } from "../../context/data"
import { useLocation } from "../../context/location"
import { Keymap, type KeymapCommand } from "../../context/keymap"
import {
  confirmSessionCreation,
  restoreSessionSubmission,
  retainSessionSubmission,
  yoloLevel,
  type SessionSubmissionRetry,
} from "../../util/session-autonomy"
import { openBtwSession, steerBtwConclusion } from "../../util/session"
import type { SessionAutonomyState } from "@ycoding-ai/client"

registerYCodingSpinner()

export type PromptProps = {
  sessionID?: string
  branch?: string
  landing?: boolean
  onOverlayChange?: (open: boolean) => void
  autonomy?: SessionAutonomyState
  onAutonomyUpdated?: (sessionID: string, state: SessionAutonomyState) => void
  onLandingYoloToggle?: (next: boolean) => void
  onLandingGoalToggle?: (next: string | null) => void
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  inset?: {
    left: number
    right: number
  }
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export function PromptFooterIdentity(props: { branch?: string; sessionID?: string }) {
  const { themeV2 } = useTheme()
  return (
    <>
      <Show when={props.branch}>
        {(branch) => (
          <text fg={themeV2.text.subdued} wrapMode="none" truncate flexShrink={1}>
            {branch()}
          </text>
        )}
      </Show>
      <Show when={props.sessionID}>
        {(sessionID) => (
          <text fg={themeV2.text.subdued} wrapMode="none" truncate flexShrink={1}>
            {sessionID().length > 13 ? `${sessionID().slice(0, 13)}…` : sessionID()}
          </text>
        )}
      </Show>
    </>
  )
}

export function PromptYoloHint() {
  const { themeV2 } = useTheme()
  const interruptShortcut = Keymap.useShortcut("session.interrupt")
  const disableYoloShortcut = Keymap.useShortcut("session.autonomy.normal")
  return (
    <>
      <Show when={interruptShortcut()}>
        {(shortcut) => <text fg={themeV2.text.subdued}>{formatShortcut(shortcut())} interrupt</text>}
      </Show>
      <Show when={disableYoloShortcut()}>
        {(shortcut) => <text fg={themeV2.text.subdued}>{formatShortcut(shortcut())} disable YOLO</text>}
      </Show>
    </>
  )
}

type PromptSubmissionPayload = {
  inputText: string
  files: PromptInfo["files"]
  agents: PromptInfo["agents"]
  metadata: ReturnType<typeof promptSkillMetadata>
  mode: NonNullable<PromptInfo["mode"]>
  agentID: string
  model: {
    providerID: string
    id: string
    variant?: string
  }
  editor?: {
    key: string
    text: string
  }
  history: PromptInfo
  cursor: number
}

type PromptOperation = {
  id: string
  kind: "clipboard" | "submit"
  phase: string
  startedAt: number
  controller: AbortController
}

type PromptFeedback = { message: string; error?: boolean }

function submissionKey(sessionID: string | undefined, payload: PromptSubmissionPayload) {
  return JSON.stringify({
    sessionID,
    text: payload.inputText,
    files: payload.files ?? [],
    agents: payload.agents ?? [],
    skills: payload.metadata?.skills ?? [],
    mode: payload.mode,
    agent: payload.agentID,
    model: payload.model,
    editor: payload.editor?.key,
  })
}

function pastedFilepath(value: string, platform: string) {
  const raw = value.replace(/^['"]+|['"]+$/g, "")
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw)
    } catch {}
  }
  if (platform === "win32") return raw
  return raw.replace(/\\(.)/g, "$1")
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const DRAFT_RETENTION_MIN_CHARS = 20
const MAX_VISIBLE_INPUT_ROWS = 6
const defaultPlaceholders = ["Message YCoding…"]

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

function formatShortcut(value: string) {
  return value
    .replaceAll("ctrl+", "⌃")
    .replaceAll("shift+", "Shift+")
    .replaceAll("return", "Enter")
    .replaceAll("enter", "Enter")
    .replaceAll("escape", "Esc")
}

function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter(hasEditorRangeSelection)
  if (selected.length === 0)
    return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`

  const ranges = selected.map((range, index) => {
    const prefix = selected.length > 1 ? `Selection ${index + 1}: ` : ""
    return `Note: The user selected ${prefix}${getEditorRangeLabel(range)} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })

  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}

const stashed = new WeakMap<
  object,
  { prompt: PromptInfo; cursor: number; temporaryAttachments?: Map<string, ClipboardTemporary> }
>()

function argumentSlash(input: string, commands: readonly KeymapCommand[]) {
  const head = parseSlashHead(input, /\s/)
  if (!head) return
  const command = commands.find(
    (command) =>
      command.slash?.arguments &&
      (command.slash.name === head.name || command.slash.aliases?.includes(head.name) === true),
  )
  if (!command) return
  return { command, input: head.arguments }
}

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()

  const leader = Keymap.useLeaderActive()
  const local = useLocal()
  const args = useArgs()
  const paths = useTuiPaths()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const clipboard = useClipboard()
  const client = useClient()
  const editor = useEditorContext()
  const route = useRoute()
  const data = useData()
  const keymapCommands = Keymap.useCommands()
  const currentLocation = useLocation()
  const config = useConfig().data
  const dialog = useDialog()
  const toast = useToast()
  const connected = useConnected()
  const status = createMemo(() => data.session.status(props.sessionID ?? ""))
  const btwSession = createMemo(() => {
    const session = data.session.get(props.sessionID ?? "")
    if (session?.parentID && session.agent === "btw") return session
  })
  const parentSessionID = createMemo(() => {
    const sessionID = props.sessionID
    if (!sessionID) return
    return data.session.get(sessionID)?.parentID ?? sessionID
  })
  createEffect(() => {
    const parentID = parentSessionID()
    if (!parentID || !connected()) return
    void data.session.subagent
      .sync(parentID)
      .catch((error) => console.error("Failed to load durable subagent tasks", error))
  })
  const history = usePromptHistory()
  const stash = usePromptStash()
  const keymap = Keymap.use()
  const yoloGoalActive = createMemo(
    () =>
      yoloLevel(props.autonomy ?? ({ yolo: 0 } as unknown as SessionAutonomyState)) > 0 ||
      props.autonomy?.goal?.status === "active",
  )
  const renderer = useRenderer()
  const exit = useExit()
  const { themeV2, syntax } = useTheme()
  const animationsEnabled = createMemo(() => config.animations ?? true)
  const list = createMemo(() => props.placeholders?.normal ?? defaultPlaceholders)
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const fileContextEnabled = createMemo(() => config.prompt?.editor ?? true)
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const [retry, setRetry] = createSignal<SessionSubmissionRetry<PromptSubmissionPayload>>()
  const [retryMode, setRetryMode] = createSignal<"exact" | "replaceable">()
  const [operation, setOperation] = createSignal<PromptOperation>()
  const [feedback, setFeedback] = createSignal<PromptFeedback>()
  const [missingTemporaryAttachments, setMissingTemporaryAttachments] = createSignal<string[]>([])
  const [now, setNow] = createSignal(Date.now())
  let disposed = false
  let draftRevision = 0

  createEffect(() => {
    if (!operation()) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const operationText = createMemo(() => {
    const current = operation()
    if (!current) return feedback()?.message
    const elapsed = Math.floor((now() - current.startedAt) / 1_000)
    return elapsed >= 10 ? `${current.phase} · ${elapsed}s` : current.phase
  })

  function beginOperation(kind: PromptOperation["kind"], phase: string): PromptOperation | undefined {
    if (operation()) return undefined
    const next = {
      id: crypto.randomUUID(),
      kind,
      phase,
      startedAt: Date.now(),
      controller: new AbortController(),
    }
    setNow(next.startedAt)
    setFeedback(undefined)
    setOperation(next)
    return next
  }

  function updateOperation(id: string, phase: string) {
    setOperation((current) => (current?.id === id ? { ...current, phase } : current))
  }

  function finishOperation(id: string, next?: PromptFeedback) {
    if (operation()?.id !== id) return
    setOperation(undefined)
    if (next) setFeedback(next)
  }

  function cancelOperation() {
    const current = operation()
    if (!current) return
    current.controller.abort(new Error("Cancelled"))
    finishOperation(current.id, { message: "Cancelled · draft retained" })
  }

  function requestOptions(current: PromptOperation) {
    return {
      signal: AbortSignal.any([current.controller.signal, AbortSignal.timeout(60_000)]),
    }
  }
  const move = usePromptMove({
    projectID: () =>
      (props.sessionID ? data.session.get(props.sessionID)?.projectID : undefined) ?? data.location.info()?.project.id,
    sessionID: () => props.sessionID,
  })
  const overlayOpen = createMemo(() => dialog.stack.length > 0 || Boolean(auto()?.visible))
  createEffect(() => props.onOverlayChange?.(overlayOpen()))
  onCleanup(() => props.onOverlayChange?.(false))
  Keymap.createLayer(() => ({
    mode: "global",
    enabled: props.sessionID !== undefined,
    commands: [
      {
        id: "session.cd",
        title: "Change working directory",
        slash: { name: "cd", arguments: true },
        run: async (input) => {
          const sessionID = props.sessionID
          if (!sessionID) return
          if (!input?.trim()) {
            toast.show({ message: "Directory is required", variant: "error" })
            return
          }
          await client.api.session.move({ sessionID, directory: input }).catch((error) =>
            toast.show({
              title: "Failed to change directory",
              message: errorMessage(error),
              variant: "error",
            }),
          )
        },
      },
    ],
  }))
  const [cursorVersion, setCursorVersion] = createSignal(0)

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (!connected()) {
      dialog.replace(() => <DialogIntegration />)
    }
  }

  function dismissEditorContext() {
    setDismissedEditorSelectionKey(editorSelectionKey(editorContext()))
    editor.clearSelection()
  }
  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const skillStyleId = syntax().getStyleId("extmark.skill")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  const event = useEvent()

  event.on("tui.prompt.append", (evt, { workspace }) => {
    if (workspace !== (currentLocation.current?.workspaceID ?? data.location.default().workspaceID)) return
    if (!input || input.isDestroyed) return
    input.insertText(evt.data.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.disabled) input.cursorColor = themeV2.background.surface.offset
    if (!props.disabled) input.cursorColor = themeV2.text.default
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPart: Map<number, PromptPartRef>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: emptyPrompt(),
    mode: "normal",
    extmarkToPart: new Map(),
    interrupt: 0,
  })
  const temporaryAttachments = new Map<string, ClipboardTemporary>()
  let addingAttachment = 0

  async function releaseTemporaryAttachment(uri: string) {
    const temporary = temporaryAttachments.get(uri)
    if (!temporary) return
    temporaryAttachments.delete(uri)
    setMissingTemporaryAttachments((current) => current.filter((missing) => missing !== uri))
    await temporary.cleanup().catch(() => {})
  }

  async function releaseTemporaryAttachments() {
    for (const uri of temporaryAttachments.keys()) await releaseTemporaryAttachment(uri)
  }

  async function retainManagedAttachments(
    submission: SessionSubmissionRetry<PromptSubmissionPayload>,
    files: PromptInfo["files"],
  ) {
    const original = submission.payload.files ?? []
    const retainedFiles = files?.map((file, index) => ({
      ...file,
      mention: original[index]?.mention,
    }))
    const replacements = new Map(
      original.flatMap((file, index) => {
        const managed = retainedFiles?.[index]
        return managed ? [[file.uri, managed] as const] : []
      }),
    )
    setStore("prompt", "files", (current) =>
      current?.map((file) => {
        const managed = replacements.get(file.uri)
        return managed ? { ...managed, mention: file.mention } : file
      }),
    )
    submission.payload.files = retainedFiles
    submission.payload.history.files = retainedFiles
    submission.key = submissionKey(props.sessionID, submission.payload)
    for (const uri of replacements.keys()) await releaseTemporaryAttachment(uri)
  }

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  // Initialize agent/model/variant from the durable V2 Session state.
  let syncedSessionID: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID || sessionID === syncedSessionID || !local.model.ready) return
    const session = data.session.get(sessionID)
    if (!session) return
    const agents = data.location.agent.list(session.location)
    const models = data.location.model.list(session.location)
    if (!agents || !models) return
    const agent = session.agent && agents.find((agent) => agent!.id === session.agent)
    if (agent && session.agent !== "btw" && !args.agent) local.agent.set(agent!.id)
    if (session.model && session.agent !== "btw") {
      local.model.set({
        providerID: session.model.providerID,
        modelID: session.model.id,
      })
      local.model.variant.set(session.model.variant)
    }
    syncedSessionID = sessionID
  })

  const promptCommands = createMemo(() =>
    [
      {
        title: "Clear prompt",
        name: "prompt.clear",
        category: "Prompt",
        palette: undefined,
        run: () => {
          clearPrompt()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        name: "prompt.submit",
        category: "Prompt",
        palette: undefined,
        run: async (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Remove editor context",
        name: "prompt.editor_context.clear",
        category: "Prompt",
        enabled: Boolean(editorContext()),
        run: () => {
          dismissEditorContext()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        name: "prompt.paste",
        category: "Prompt",
        palette: undefined,
        run: async (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          const current = beginOperation("clipboard", "Reading clipboard…")
          if (!current) return
          const read = clipboard?.read as
            | ((options?: ClipboardReadOptions) => ReturnType<NonNullable<typeof clipboard.read>>)
            | undefined
          const result = await read?.({
            signal: current.controller.signal,
            timeoutMs: 60_000,
          }).then(
            (content) => ({ content }),
            (error) => ({ error }),
          )
          if (!result || "error" in result) {
            if (operation()?.id === current.id) {
              const cancelled = current.controller.signal.aborted
              finishOperation(current.id, {
                message: cancelled ? "Cancelled · draft retained" : "Clipboard read failed · draft retained",
                error: !cancelled,
              })
              if (!cancelled)
                toast.show({
                  title: "Clipboard unavailable",
                  message: "Could not read clipboard image or text.",
                  variant: "error",
                })
            }
            return
          }
          const content = result.content
          if (disposed || operation()?.id !== current.id) {
            if (content?.type === "file") await content.temporary.cleanup().catch(() => {})
            return
          }
          if (content?.type === "file") {
            if (missingTemporaryAttachments().length > 0) await removeMissingTemporaryAttachments()
            const error = await pasteAttachment({
              filename: content.name,
              uri: content.uri,
              mime: content.mime,
              temporary: content.temporary,
            }).then(
              () => undefined,
              async (error) => {
                await content.temporary.cleanup()
                return error
              },
            )
            if (error) {
              finishOperation(current.id, {
                message: "Clipboard image preparation failed · draft retained",
                error: true,
              })
              toast.show({
                title: "Clipboard image unavailable",
                message: "The clipboard image could not be prepared. Re-copy it and try again.",
                variant: "error",
              })
              return
            }
            finishOperation(current.id)
            return
          }
          if (content?.type === "text") {
            await pasteInputText(content.text)
          }
          finishOperation(current.id)
        },
      },
      {
        title: "Cancel pending action",
        name: "prompt.pending.cancel",
        category: "Prompt",
        enabled: Boolean(operation()),
        palette: true,
        run: cancelOperation,
      },
      {
        title: "Interrupt session",
        name: "session.interrupt",
        category: "Session",
        palette: undefined,
        enabled: status() === "running" || yoloGoalActive(),
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            void client.api.session.interrupt({
              sessionID: props.sessionID,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "Background blocking tools",
        name: "session.background",
        category: "Session",
        palette: undefined,
        enabled: status() === "running",
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          if (!props.sessionID) return

          void client.api.session.background({
            sessionID: props.sessionID,
          })
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        name: "prompt.editor",
        slash: { name: "editor" },
        run: async () => {
          dialog.clear()

          const editorPrompt = expandPromptInputPastedText(store.prompt, store.prompt.pasted)
          const value = editorPrompt.text
          const content = await openEditor({
            renderer,
            value,
            cwd:
              (data.location.info()?.project.directory === "/" ? undefined : data.location.info()?.project.directory) ||
              data.location.default().directory ||
              paths.cwd,
          })
          if (!content) return
          const normalized = normalizePromptContent(content)

          input.setText(normalized)

          setStore("prompt", {
            ...realignPromptInputMentions(normalized, editorPrompt),
            pasted: [],
          })
          restoreExtmarksFromPrompt(store.prompt)
          input.cursorOffset = stringWidth(normalized)
        },
      },
      {
        title: "Skills",
        name: "prompt.skills",
        category: "Prompt",
        slash: { name: "skills" },
        run: () => {
          dialog.replace(() => (
            <DialogSkill
              location={currentLocation.current}
              onSelect={(skill) => {
                input.setText(`/${skill} `)
                setStore("prompt", {
                  ...emptyPrompt(),
                  text: `/${skill} `,
                })
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
      {
        title: "Open BTW side chat",
        name: "session.btw",
        category: "Session",
        palette: props.sessionID !== undefined,
        slash: { name: "btw", arguments: true as const },
        run: (text: string | undefined) => {
          const sessionID = props.sessionID
          if (!sessionID) return
          const current = data.session.get(sessionID)
          const parentID = current?.parentID ?? sessionID
          dialog.replace(() => (
            <DialogModel
              onComplete={(result) => {
                if (result.type === "cancelled") return
                const model = result.selection
                clearPrompt()
                void openBtwSession({
                  api: client.api.session,
                  parentID,
                  messages: data.session.message.list(parentID),
                  text,
                  model: {
                    providerID: model.providerID,
                    id: model.modelID,
                    variant: model.variant,
                  },
                }).then(
                  (session) => route.navigate({ type: "session", sessionID: session.id }),
                  (error) =>
                    toast.show({ title: "Failed to open BTW", message: errorMessage(error), variant: "error" }),
                )
              }}
            />
          ))
        },
      },
      {
        title: "Send to main chat",
        name: "session.btw.send",
        category: "Session",
        enabled: data.session.get(props.sessionID ?? "")?.agent === "btw",
        palette: data.session.get(props.sessionID ?? "")?.agent === "btw",
        slash: { name: "btw-send", arguments: true as const },
        run: (text: string | undefined) => {
          const session = data.session.get(props.sessionID ?? "")
          if (session?.agent !== "btw" || !session.parentID) return
          const parent = data.session.get(session.parentID)
          if (!parent) {
            toast.show({ message: "The immediate parent session is unavailable", variant: "error" })
            return
          }
          const slashDraft = store.prompt.text.trimStart().startsWith("/btw-send")
          dialog.replace(() => (
            <DialogBtwExport
              parentTitle={parent.title}
              sourceTitle={session.title}
              value={text ?? (slashDraft ? "" : store.prompt.text)}
              send={(exported) =>
                steerBtwConclusion({
                  api: client.api.session,
                  id: exported.id,
                  parentID: parent.id,
                  text: exported.text,
                })
              }
            />
          ))
        },
      },
      {
        title: "Set autonomous goal",
        name: "session.autonomy.goal",
        category: "Session",
        palette: true,
        slash: { name: "goal" },
        run: async () => {
          const isActive = props.autonomy?.goal?.status === "active"
          const sessionID = props.sessionID
          if (sessionID) {
            try {
              const newGoal = isActive
                ? null
                : store.prompt.text.trim() || props.autonomy?.goal?.text || "Autonomous goal"
              const result = await client.api.session.autonomy.set({ sessionID, payload: { goal: newGoal } })
              const state =
                (result as unknown as { data: SessionAutonomyState }).data ??
                (result as unknown as SessionAutonomyState)
              props.onAutonomyUpdated?.(sessionID, state as SessionAutonomyState)
              toast.show({
                message: isActive ? "Goal deactivated" : "Goal activated",
                variant: "success",
                duration: 3000,
              })
            } catch (error) {
              toast.show({ title: "Failed to toggle goal", message: errorMessage(error), variant: "error" })
            }
            return
          }
          // landing: goal follows prompt adaptively – do not push goal into composer
          if (isActive) {
            props.onLandingGoalToggle?.(null)
            toast.show({ message: "Goal deactivated (landing)", variant: "success", duration: 2000 })
          } else {
            const text = store.prompt.text.trim() || props.autonomy?.goal?.text || "Autonomous goal"
            props.onLandingGoalToggle?.(text)
            toast.show({ message: "Goal activated (landing)", variant: "success", duration: 2000 })
          }
        },
      },
      {
        title: "Toggle YOLO",
        name: "session.autonomy.yolo.toggle",
        category: "Session",
        palette: true,
        slash: { name: "yolo" },
        run: async (input?: string) => {
          const token = input?.trim().split(/\s+/)[0]
          const parsed = token ? Number.parseInt(token, 10) : Number.NaN
          const explicit =
            Number.isInteger(parsed) && parsed >= 0 && parsed <= 3 ? (parsed as 0 | 1 | 2 | 3) : undefined
          const currentLevel = yoloLevel(props.autonomy ?? ({ yolo: 0 } as unknown as SessionAutonomyState))
          const nextLevel = explicit ?? (((currentLevel + 1) % 4) as 0 | 1 | 2 | 3)
          const sessionID = props.sessionID
          if (sessionID) {
            try {
              const result = await client.api.session.autonomy.set({ sessionID, payload: { yolo: nextLevel } })
              const state =
                (result as unknown as { data: SessionAutonomyState }).data ??
                (result as unknown as SessionAutonomyState)
              props.onAutonomyUpdated?.(sessionID, state as SessionAutonomyState)
              toast.show({
                message: nextLevel > 0 ? `YOLO ${nextLevel} enabled` : "YOLO disabled",
                variant: "success",
                duration: 3000,
              })
            } catch (error) {
              toast.show({ title: "Failed to toggle YOLO", message: errorMessage(error), variant: "error" })
            }
            return
          }
          props.onLandingYoloToggle?.(nextLevel > 0)
          toast.show({
            message: nextLevel > 0 ? `YOLO ${nextLevel} enabled (landing)` : "YOLO disabled (landing)",
            variant: "success",
            duration: 2000,
          })
        },
      },
      {
        title: "Move session",
        desc: "Move to another project dir",
        name: "session.move",
        category: "Session",
        slash: { name: "move" },
        run: () => {
          move.open()
        },
      },
    ].map((item) => {
      const { name, category, ...command } = item
      return {
        id: name,
        group: category,
        bind: false,
        ...command,
        palette: promptCommandPalette(item),
      } satisfies KeymapCommand
    }),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    commands: promptCommands(),
  }))

  Keymap.createLayer(() => ({
    bindings: [
      "prompt.submit",
      "prompt.editor",
      "prompt.editor_context.clear",
      "prompt.stash",
      "prompt.stash.pop",
      "prompt.stash.list",
      "prompt.skills",
      "session.interrupt",
      "session.background",
      "session.move",
    ],
  }))

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.text)
      setStore("prompt", prompt)
      restoreExtmarksFromPrompt(prompt)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", emptyPrompt())
      setStore("extmarkToPart", new Map())
    },
    submit() {
      void submit()
    },
  }

  onMount(() => {
    const saved = stashed.get(client)
    stashed.delete(client)
    if (store.prompt.text) return
    if (saved && (saved.prompt.text || (saved.prompt.files?.length ?? 0) > 0)) {
      for (const [uri, temporary] of saved.temporaryAttachments ?? []) temporaryAttachments.set(uri, temporary)
      input.setText(saved.prompt.text)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromPrompt(saved.prompt)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    disposed = true
    operation()?.controller.abort(new Error("Prompt owner disposed"))
    if (store.prompt.text || (store.prompt.files?.length ?? 0) > 0) {
      stashed.set(client, {
        prompt: unwrap(store.prompt),
        cursor: input.cursorOffset,
        temporaryAttachments: new Map(temporaryAttachments),
      })
      temporaryAttachments.clear()
    } else {
      void releaseTemporaryAttachments()
    }
    setInputTarget(undefined)
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || props.disabled || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      return
    }

    // Slot/plugin updates can remount the background prompt while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = {
      ...input.traits,
      ...computePromptTraits({
        mode: store.mode,
        autocompleteVisible: !!auto()?.visible,
      }),
    }
  })

  function restoreExtmarksFromPrompt(prompt: PromptInfo) {
    input.extmarks.clear()
    setStore("extmarkToPart", new Map())

    const parts = [
      ...(prompt.files ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "file" as const, index },
        styleId: fileStyleId,
      })),
      ...(prompt.agents ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "agent" as const, index },
        styleId: agentStyleId,
      })),
      ...(prompt.skills ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "skill" as const, index },
        styleId: skillStyleId,
      })),
      ...prompt.pasted.map((part, index) => ({
        mention: part.source,
        ref: { type: "pasted" as const, index },
        styleId: pasteStyleId,
      })),
    ]

    parts.forEach(({ mention, ref, styleId }) => {
      if (mention?.text) {
        const extmarkId = input.extmarks.create({
          start: mention.start,
          end: mention.end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPart", (map: Map<number, PromptPartRef>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, ref)
          return newMap
        })
      }
    })
  }

  async function syncExtmarksWithPromptParts() {
    // `TextareaRenderable.insertText` synchronously emits onContentChange. During
    // clipboard attachment insertion the extmark is created before the prompt
    // part is registered, so reconciling here would treat the new attachment as
    // removed and clean up its backing file.
    if (addingAttachment > 0) return
    const beforeFiles = new Map(
      (store.prompt.files ?? [])
        .filter((file) => temporaryAttachments.has(file.uri) && file.mention?.text)
        .map((file) => [file.uri, file.mention!.text] as const),
    )
    const beforeUris = new Set(beforeFiles.keys())
    const allExtmarks = input.extmarks
      .getAllForTypeId(promptPartTypeId)
      .slice()
      .sort((left, right) => left.start - right.start)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, PromptPartRef>()
        const files: NonNullable<PromptInfo["files"]> = []
        const agents: NonNullable<PromptInfo["agents"]> = []
        const skills: NonNullable<PromptInfo["skills"]> = []
        const pasted: PromptInfo["pasted"] = []

        for (const extmark of allExtmarks) {
          const ref = draft.extmarkToPart.get(extmark.id)
          if (!ref) continue
          if (ref.type === "file") {
            const part = draft.prompt.files?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            const index = files.length
            files.push(part)
            newMap.set(extmark.id, { type: "file", index })
            continue
          }
          if (ref.type === "agent") {
            const part = draft.prompt.agents?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            const index = agents.length
            agents.push(part)
            newMap.set(extmark.id, { type: "agent", index })
            continue
          }
          if (ref.type === "skill") {
            const part = draft.prompt.skills?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            const index = skills.length
            skills.push(part)
            newMap.set(extmark.id, { type: "skill", index })
            continue
          }
          const part = draft.prompt.pasted[ref.index]
          if (!part) continue
          part.source.start = extmark.start
          part.source.end = extmark.end
          const index = pasted.length
          pasted.push(part)
          newMap.set(extmark.id, { type: "pasted", index })
        }

        draft.extmarkToPart = newMap
        draft.prompt.files = files
        draft.prompt.agents = agents
        draft.prompt.skills = skills
        draft.prompt.pasted = pasted
      }),
    )
    const retained = new Set(store.prompt.files?.map((file) => file.uri))
    for (const uri of beforeUris) {
      if (retained.has(uri)) continue
      const mentionText = beforeFiles.get(uri)
      if (mentionText && input.plainText.includes(mentionText)) continue
      await releaseTemporaryAttachment(uri)
    }
  }

  async function discardMissingTemporaryAttachments() {
    if (missingTemporaryAttachments().length > 0) {
      await removeMissingTemporaryAttachments()
      return false
    }
    const missing = new Set<string>()
    for (const [uri, temporary] of temporaryAttachments) {
      try {
        const { stat } = await import("node:fs/promises")
        await stat(temporary.path)
      } catch {
        missing.add(uri)
      }
    }
    if (missing.size === 0) return false

    setMissingTemporaryAttachments([...missing])
    const message = "Attachment unavailable · Re-paste or press Enter again to remove and send"
    setFeedback({ message, error: true })
    toast.show({
      title: "Clipboard attachment unavailable",
      message: "Re-paste the image, or press Enter again to remove it and send your retained text.",
      variant: "error",
      duration: 6000,
    })
    return true
  }

  async function removeMissingTemporaryAttachments() {
    const removed = new Set(missingTemporaryAttachments())
    if (removed.size === 0) return
    const staleRanges = input.extmarks
      .getAllForTypeId(promptPartTypeId)
      .flatMap((mark) => {
        const ref = store.extmarkToPart.get(mark.id)
        if (ref?.type !== "file" || !removed.has(store.prompt.files?.[ref.index]?.uri ?? "")) return []
        input.extmarks.delete(mark.id)
        return [{ start: mark.start, end: mark.end + (input.plainText[mark.end] === " " ? 1 : 0) }]
      })
      .sort((left, right) => right.start - left.start)
    if (staleRanges.length > 0) {
      addingAttachment++
      try {
        let text = input.plainText
        for (const range of staleRanges) text = text.slice(0, range.start) + text.slice(range.end)
        input.setText(text)
      } finally {
        addingAttachment--
      }
    }
    setStore(
      produce((draft) => {
        const oldFiles = draft.prompt.files ?? []
        const files = oldFiles.filter((file) => !removed.has(file.uri))
        const fileIndexes = new Map(files.map((file, index) => [file.uri, index]))
        draft.prompt.files = files
        draft.extmarkToPart = new Map(
          [...draft.extmarkToPart].flatMap(([id, ref]) => {
            if (ref.type !== "file") return [[id, ref] as const]
            const uri = oldFiles[ref.index]?.uri
            const index = uri === undefined ? undefined : fileIndexes.get(uri)
            return index === undefined ? [] : [[id, { type: "file", index }] as const]
          }),
        )
      }),
    )
    for (const uri of removed) await releaseTemporaryAttachment(uri)
    setMissingTemporaryAttachments([])
  }

  const stashCommands = createMemo(() =>
    [
      ...(retry()
        ? [
            {
              title: "Retry previous submission",
              name: "prompt.retry",
              category: "Prompt",
              enabled: true,
              run: () => {
                const submission = retry()
                if (!submission) return
                const restored = restoreSessionSubmission(
                  submission,
                  {
                    ...structuredClone(unwrap(store.prompt)),
                    mode: store.mode,
                  },
                  (prompt) => stash.push({ prompt }),
                  (prompt) =>
                    !prompt.text.trim() &&
                    prompt.pasted.length === 0 &&
                    (prompt.files?.length ?? 0) === 0 &&
                    (prompt.agents?.length ?? 0) === 0 &&
                    (prompt.skills?.length ?? 0) === 0,
                )
                input.setText(restored.prompt.text)
                setStore("prompt", restored.prompt)
                setStore("mode", submission.payload.mode)
                restoreExtmarksFromPrompt(restored.prompt)
                input.cursorOffset = restored.cursor
                dialog.clear()
              },
            },
            {
              title: "Discard previous submission recovery",
              name: "prompt.retry.discard",
              category: "Prompt",
              enabled: true,
              run: () => {
                setRetry(undefined)
                setRetryMode(undefined)
                setFeedback({ message: "Previous submission recovery discarded" })
                dialog.clear()
              },
            },
          ]
        : []),
      ...(missingTemporaryAttachments().length > 0
        ? [
            {
              title: "Remove unavailable attachment and send",
              name: "prompt.attachment.remove-and-send",
              category: "Prompt",
              enabled: true,
              run: async () => {
                await removeMissingTemporaryAttachments()
                dialog.clear()
                await submit()
              },
            },
          ]
        : []),
      {
        title: "Stash prompt",
        name: "prompt.stash",
        category: "Prompt",
        enabled: !!store.prompt.text,
        run: () => {
          if (!store.prompt.text) return
          stash.push({ prompt: store.prompt })
          input.extmarks.clear()
          input.clear()
          setStore("prompt", emptyPrompt())
          setStore("extmarkToPart", new Map())
          dialog.clear()
        },
      },
      {
        title: "Stash pop",
        name: "prompt.stash.pop",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          const entry = stash.pop()
          if (entry) {
            input.setText(entry.prompt.text)
            setStore("prompt", entry.prompt)
            restoreExtmarksFromPrompt(entry.prompt)
            input.gotoBufferEnd()
          }
          dialog.clear()
        },
      },
      {
        title: "Stash list",
        name: "prompt.stash.list",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          dialog.replace(() => (
            <DialogStash
              onSelect={(entry) => {
                input.setText(entry.prompt.text)
                setStore("prompt", entry.prompt)
                restoreExtmarksFromPrompt(entry.prompt)
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
    ].map(
      ({ name, category, ...command }) =>
        ({
          id: name,
          group: category,
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    commands: stashCommands(),
  }))

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled,
      bindings: ["prompt.paste"],
    }
  })

  Keymap.createLayer(() => ({
    priority: 2,
    target: inputTarget,
    enabled: inputTarget() !== undefined && !props.disabled && Boolean(operation()) && !auto()?.visible,
    commands: [
      {
        bind: "escape",
        title: "Cancel pending action",
        group: "Prompt",
        run: cancelOperation,
      },
    ],
  }))

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled && store.prompt.text !== "",
      bindings: ["prompt.clear"],
    }
  })

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return (
          inputTarget() !== undefined &&
          !props.disabled &&
          store.mode === "normal" &&
          !auto()?.visible &&
          input?.visualCursor.offset === 0
        )
      })(),
      commands: [
        {
          bind: "!",
          title: "Shell mode",
          group: "Prompt",
          run: () => {
            setStore("placeholder", randomIndex(shell().length))
            setStore("mode", "shell")
          },
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && store.mode === "shell",
      commands: [
        {
          bind: "escape",
          title: "Exit shell mode",
          group: "Prompt",
          run: () => setStore("mode", "normal"),
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && store.mode === "shell" && input?.visualCursor.offset === 0
      })(),
      commands: [
        {
          bind: "backspace",
          title: "Exit shell mode",
          group: "Prompt",
          run: () => setStore("mode", "normal"),
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          id: "prompt.history.previous",
          title: "Previous prompt history",
          group: "Prompt",
          run() {
            if (input.cursorOffset !== 0) {
              if (input.scrollY + input.visualCursor.visualRow === 0) {
                input.cursorOffset = 0
                return
              }
              input.moveCursorUp()
              return
            }

            const item = history.move(-1, input.plainText)
            if (!item) return false
            input.setText(item.text)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromPrompt(item)
            input.cursorOffset = 0
          },
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          id: "prompt.history.next",
          title: "Next prompt history",
          group: "Prompt",
          run() {
            if (input.cursorOffset !== input.plainText.length) {
              if (
                input.scrollY + input.visualCursor.visualRow ===
                Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
              ) {
                input.cursorOffset = input.plainText.length
                return
              }
              input.moveCursorDown()
              return
            }

            const item = history.move(1, input.plainText)
            if (!item) return false
            input.setText(item.text)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromPrompt(item)
            input.cursorOffset = input.plainText.length
          },
        },
      ],
    }
  })

  let submitting = false
  async function submit() {
    // Prevent overlapping invocations (e.g. a double-pressed Enter, or the
    // input's native onSubmit racing another dispatch). Without this guard,
    // a second call slips past the empty-input check before the first call
    // clears `store.prompt.text`, then awaits its own `session.create` and
    // ultimately reads the now-empty store — sending a phantom empty prompt
    // to a freshly created session.
    if (submitting || operation()) return false
    submitting = true
    const current = beginOperation("submit", "Preparing prompt…")
    if (!current) {
      submitting = false
      return false
    }
    try {
      return await submitInner(current)
    } finally {
      finishOperation(current.id)
      submitting = false
    }
  }

  async function submitInner(currentOperation: PromptOperation) {
    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.text) {
      setStore("prompt", "text", input.plainText)
      await syncExtmarksWithPromptParts()
    }
    // Inventory: previous harness blocked prompt when disabled (permissions/forms), during session creation/move, when autocomplete visible, or when empty.
    // Removed: prompt is now always sendable harness-style; empty is allowed to pass through as no-op downstream.
    if (
      !store.prompt.text &&
      (store.prompt.files?.length ?? 0) === 0 &&
      store.prompt.pasted.length === 0 &&
      (store.prompt.agents?.length ?? 0) === 0 &&
      (store.prompt.skills?.length ?? 0) === 0
    )
      return false
    if (await discardMissingTemporaryAttachments()) return false
    const trimmed = store.prompt.text.trim()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      void exit()
      return true
    }
    const inputText = expandTrackedPastedText(
      store.prompt.text,
      input.extmarks.getAllForTypeId(promptPartTypeId).flatMap((extmark) => {
        const ref = store.extmarkToPart.get(extmark.id)
        if (ref?.type !== "pasted") return []
        const part = store.prompt.pasted[ref.index]
        if (!part) return []
        return [{ start: extmark.start, end: extmark.end, text: part.text }]
      }),
    )
    const currentHistory = {
      ...structuredClone(unwrap(store.prompt)),
      mode: store.mode,
    }
    // /goal and /yolo are toggles with no arguments – handle before generic slash dispatch
    const normalized = inputText.trim()
    if (normalized === "/goal" || normalized.startsWith("/goal ") || normalized.startsWith("/goal\n")) {
      clearPrompt()
      const isActive = props.autonomy?.goal?.status === "active"
      const sessionID = props.sessionID
      if (sessionID) {
        try {
          const candidate = normalized.slice(5).trim()
          // Agent owns goal text: candidate is hint for SessionGoal synthesis, not verbatim final text.
          // Do not echo hint into composer (bug fix) – clearPrompt already called.
          const hint = candidate || props.autonomy?.goal?.text || "Autonomous goal"
          const newGoal = isActive ? null : hint
          const result = await client.api.session.autonomy.set({ sessionID, payload: { goal: newGoal } })
          const state =
            (result as unknown as { data: SessionAutonomyState }).data ?? (result as unknown as SessionAutonomyState)
          props.onAutonomyUpdated?.(sessionID, state as SessionAutonomyState)
          toast.show({ message: isActive ? "Goal deactivated" : "Goal activated", variant: "success", duration: 3000 })
        } catch (error) {
          toast.show({ title: "Failed to toggle goal", message: errorMessage(error), variant: "error" })
        }
      } else {
        if (isActive) {
          props.onLandingGoalToggle?.(null)
          toast.show({ message: "Goal deactivated (landing)", variant: "success", duration: 2000 })
        } else {
          const text = normalized.slice(5).trim() || props.autonomy?.goal?.text || "Autonomous goal"
          // Landing has no session; keep hint for next session creation but do not pollute composer.
          // Store hint via onLandingGoalToggle only; composer stays cleared (bug fix).
          props.onLandingGoalToggle?.(text)
          toast.show({ message: "Goal activated (landing)", variant: "success", duration: 2000 })
        }
      }
      return true
    }
    if (normalized === "/yolo" || normalized.startsWith("/yolo ") || normalized.startsWith("/yolo\n")) {
      clearPrompt()
      const arg = normalized.slice(5).trim()
      const parsed = arg ? Number.parseInt(arg, 10) : NaN
      const explicit = Number.isInteger(parsed) && parsed >= 0 && parsed <= 3 ? (parsed as 0 | 1 | 2 | 3) : undefined
      const currentLevel = yoloLevel(props.autonomy ?? ({ yolo: 0 } as unknown as SessionAutonomyState))
      const nextLevel = explicit ?? (((currentLevel + 1) % 4) as 0 | 1 | 2 | 3)
      const sessionID = props.sessionID
      if (sessionID) {
        try {
          const result = await client.api.session.autonomy.set({ sessionID, payload: { yolo: nextLevel } })
          const state =
            (result as unknown as { data: SessionAutonomyState }).data ?? (result as unknown as SessionAutonomyState)
          props.onAutonomyUpdated?.(sessionID, state as SessionAutonomyState)
          toast.show({
            message: nextLevel > 0 ? `YOLO ${nextLevel} enabled` : "YOLO disabled",
            variant: "success",
            duration: 3000,
          })
        } catch (error) {
          toast.show({ title: "Failed to toggle YOLO", message: errorMessage(error), variant: "error" })
        }
      } else {
        props.onLandingYoloToggle?.(nextLevel > 0)
        toast.show({
          message: nextLevel > 0 ? `YOLO ${nextLevel} enabled (landing)` : "YOLO disabled (landing)",
          variant: "success",
          duration: 2000,
        })
      }
      return true
    }
    const slash = argumentSlash(inputText, keymapCommands())
    if (slash) {
      if (slash.command.id !== "session.btw" && slash.command.id !== "session.btw.send") clearPrompt()
      await slash.command.run(slash.input)
      return true
    }
    // Deadlock removal: never block prompt on missing agent/model — fallback to session or first available, warn but still send.
    let agentID = btwSession()?.agent ?? local.agent.current()?.id
    if (!agentID) {
      const sessionAgent = props.sessionID ? data.session.get(props.sessionID)?.agent : undefined
      const fallbackAgent = sessionAgent
        ? data.location.agent
            .list(data.session.get(props.sessionID!)?.location ?? currentLocation.current)
            ?.find((agent) => agent.id === sessionAgent)?.id
        : undefined
      agentID = fallbackAgent ?? data.location.agent.list(currentLocation.current)?.[0]?.id
      if (!agentID) {
        void promptModelWarning()
        // still allow send with fallback; if truly no agent, let server error rather than deadlock
        agentID = "default"
      }
    }
    const fixedModel = btwSession()?.model
    let selectedModel = fixedModel
      ? { providerID: fixedModel.providerID, modelID: fixedModel.id }
      : local.model.current()
    if (!selectedModel) {
      const sessionModel = props.sessionID ? data.session.get(props.sessionID)?.model : undefined
      if (sessionModel) {
        selectedModel = { providerID: sessionModel.providerID, modelID: sessionModel.id }
        local.model.variant.set(sessionModel.variant)
      } else {
        const firstModel = data.location.model.list(currentLocation.current)?.[0]
        if (firstModel) selectedModel = { providerID: firstModel.providerID, modelID: firstModel.id }
        else {
          void promptModelWarning()
          selectedModel = { providerID: "openai", modelID: "gpt-5-mini" } as unknown as typeof selectedModel
        }
      }
    }

    const variant = fixedModel ? fixedModel.variant : local.model.variant.current()
    const promptFiles = store.prompt.files?.map((file) => ({
      ...file,
      mention: file.mention ? { ...file.mention } : undefined,
    }))
    const promptAgents = store.prompt.agents?.map((agent) => ({
      ...agent,
      mention: agent.mention ? { ...agent.mention } : undefined,
    }))
    // Typed and pasted `$id` mentions activate their skill too, not only menu-selected ones.
    const metadata = promptSkillMetadata(
      promptSkillMentions(
        inputText,
        data.location.skill.list(currentLocation.current) ?? [],
        store.prompt.skills ?? [],
      ),
    )
    const editorSelection = editorContext()
    const candidateEditorSelection = editorSelection && editor.labelState() === "pending" ? editorSelection : undefined
    const payload: PromptSubmissionPayload = {
      inputText,
      files: promptFiles,
      agents: promptAgents,
      metadata,
      mode: store.mode,
      agentID,
      model: {
        providerID: selectedModel!.providerID,
        id: selectedModel!.modelID,
        variant,
      },
      editor: candidateEditorSelection
        ? {
            key: editorSelectionKey(candidateEditorSelection),
            text: formatEditorContext(candidateEditorSelection),
          }
        : undefined,
      history: currentHistory,
      cursor: input.cursorOffset,
    }
    const key = submissionKey(props.sessionID, payload)
    let retained = retry()
    if (retained && retained.key !== key) {
      if (retryMode() !== "replaceable") {
        setFeedback({
          message: "Previous send is unresolved · Retry or discard it before sending this draft",
          error: true,
        })
        toast.show({
          message: "Retry the previous submission with its stable ID, or explicitly discard its recovery state.",
          variant: "error",
          duration: 5000,
        })
        return false
      }
      const old = retained.payload.history
      if (
        old.text.trim() ||
        old.pasted.length > 0 ||
        (old.files?.length ?? 0) > 0 ||
        (old.agents?.length ?? 0) > 0 ||
        (old.skills?.length ?? 0) > 0
      )
        stash.push({ prompt: old })
      setRetry(undefined)
      setRetryMode(undefined)
      retained = undefined
    }
    const submission = retainSessionSubmission(retained, key, metadata?.skills.length ?? 0, payload, props.sessionID)
    setRetry(submission)
    setRetryMode("exact")
    const submittedRevision = draftRevision
    const sessionID = submission.sessionID
    let session = data.session.get(sessionID)
    let finishMoveProgress = false
    if (!submission.creationConfirmed) {
      const directory = await move.getDirectory()
      if (move.pending() && !directory) {
        /* deadlock removed: no longer blocks prompt */
      }
      finishMoveProgress = Boolean(move.progress())
      const location = data.location.default()

      updateOperation(currentOperation.id, "Creating session…")
      const created = await confirmSessionCreation(submission, (id) =>
        client.api.session.create(
          {
            id,
            location: (directory ? { directory } : location) as never,
            agent: submission.payload.agentID,
            model: submission.payload.model,
          },
          requestOptions(currentOperation),
        ),
      ).catch(() => undefined)

      if (!created) {
        if (finishMoveProgress) move.finishSubmit()
        finishOperation(currentOperation.id, {
          message: "Session creation is unresolved · retry keeps the same session ID",
          error: true,
        })
        toast.show({
          message: "Creating a session failed. Open console for more details.",
          variant: "error",
        })

        return true
      }

      session = created
    }

    const currentMode = submission.payload.mode
    const pendingEditorSelection = submission.payload.editor

    if (submission.payload.mode === "shell") {
      move.startSubmit()
      await client.api.session.shell(
        {
          sessionID,
          command: submission.payload.inputText,
        },
        requestOptions(currentOperation),
      )
      setStore("mode", "normal")
    } else if (
      submission.payload.inputText.startsWith("/") &&
      (data.location.command.list(currentLocation.current) ?? []).some(
        (command) => command.name === submission.payload.inputText.split("\n")[0].split(" ")[0].slice(1),
      )
    ) {
      move.startSubmit()
      // Parse command from first line, preserve multi-line content in arguments
      const firstLineEnd = submission.payload.inputText.indexOf("\n")
      const firstLine =
        firstLineEnd === -1 ? submission.payload.inputText : submission.payload.inputText.slice(0, firstLineEnd)
      const [command, ...firstLineArgs] = firstLine.split(" ")
      const restOfInput = firstLineEnd === -1 ? "" : submission.payload.inputText.slice(firstLineEnd + 1)
      const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

      const result = await client.api.session
        .command(
          {
            sessionID,
            command: command.slice(1),
            arguments: args,
            agent: submission.payload.agentID,
            model: submission.payload.model,
            files: submission.payload.files,
            agents: submission.payload.agents,
          },
          requestOptions(currentOperation),
        )
        .then(
          (admitted) => ({ admitted }),
          (error) => ({ error }),
        )
      if ("error" in result) {
        toast.show({
          title: "Failed to run command",
          message: errorMessage(result.error),
          variant: "error",
        })
        return false
      }
      const files = projectedPromptInput(result.admitted.data).files
      await retainManagedAttachments(submission, files)
    } else if (
      submission.payload.inputText.startsWith("/") &&
      (data.location.skill.list(currentLocation.current) ?? []).some(
        (skill) =>
          skill.slash === true && skill.id === submission.payload.inputText.split("\n")[0].split(" ")[0].slice(1),
      )
    ) {
      move.startSubmit()
      await client.api.session.skill(
        {
          id: submission.skillIDs[0],
          sessionID,
          skill: submission.payload.inputText.split("\n")[0].split(" ")[0].slice(1),
        },
        requestOptions(currentOperation),
      )
    } else {
      move.startSubmit()
      if (!session) {
        await data.session.sync(sessionID)
        session = data.session.get(sessionID)
      }
      if (session?.agent !== submission.payload.agentID) {
        updateOperation(currentOperation.id, "Selecting agent…")
        const error = await client.api.session
          .switchAgent(
            {
              sessionID,
              agent: submission.payload.agentID,
            },
            requestOptions(currentOperation),
          )
          .then(
            () => undefined,
            (error) => error,
          )
        if (error) {
          finishOperation(currentOperation.id, {
            message: "Agent selection failed · draft retained",
            error: true,
          })
          return false
        }
      }
      const switchRequired =
        session?.model?.providerID !== submission.payload.model.providerID ||
        session?.model?.id !== submission.payload.model.id ||
        normalizeModelVariant(session?.model?.variant) !== normalizeModelVariant(submission.payload.model.variant)
      if (session?.revert) {
        updateOperation(currentOperation.id, "Committing revert…")
        const error = await client.api.session.revert.commit({ sessionID }, requestOptions(currentOperation)).then(
          () => undefined,
          (error) => error,
        )
        if (error) {
          toast.show({
            title: "Failed to commit revert",
            message: errorMessage(error),
            variant: "error",
          })
          return false
        }
      }
      if (pendingEditorSelection) {
        // Keep editor context hidden while admitting it before the corresponding user prompt.
        updateOperation(currentOperation.id, "Sending editor context…")
        const error = await client.api.session
          .synthetic(
            {
              id: submission.syntheticID,
              sessionID,
              text: pendingEditorSelection.text,
              resume: false,
            },
            requestOptions(currentOperation),
          )
          .then(
            () => undefined,
            (error) => error,
          )
        if (error) {
          toast.show({
            title: "Failed to send editor context",
            message: errorMessage(error),
            variant: "error",
          })
          return false
        }
      }
      let phase: "skill" | "admission" | "wake" = "admission"
      let switched = false
      let switchWarning: unknown
      const result = await submitPromptWithSkills({
        prompt: async (resume) => {
          if (resume && switchRequired && !switched) {
            switched = true
            const switchError = await client.api.session
              .switchModel(
                {
                  sessionID,
                  model: submission.payload.model,
                },
                requestOptions(currentOperation),
              )
              .then(
                () => undefined,
                (error) => error,
              )
            if (switchError) switchWarning = switchError
          }
          return client.api.session.prompt(
            {
              id: submission.promptID,
              sessionID,
              text: submission.payload.inputText,
              files: submission.payload.files,
              agents: submission.payload.agents,
              metadata: submission.payload.metadata,
              resume,
            },
            requestOptions(currentOperation),
          )
        },
        skills: (submission.payload.metadata?.skills ?? []).map(
          (skill, index) => () =>
            client.api.session.skill(
              {
                id: submission.skillIDs[index],
                sessionID,
                skill: skill.id,
                resume: false,
              },
              requestOptions(currentOperation),
            ),
        ),
        onPhase: (next) => {
          phase = next.type
          updateOperation(
            currentOperation.id,
            next.type === "skill"
              ? `Loading skill ${next.index}/${next.total}…`
              : next.type === "admission"
                ? "Preparing attachments / sending…"
                : "Prompt admitted · waking session…",
          )
        },
        onAdmitted: async (admitted) => {
          await retainManagedAttachments(submission, projectedPromptInput(admitted.data).files)
        },
      }).then(
        (result) => ({ result }) as const,
        (error) => ({ error, phase }) as const,
      )
      if ("error" in result) {
        setRetryMode(result.phase === "skill" ? "replaceable" : "exact")
        const hasAttachments = (submission.payload.files?.length ?? 0) > 0
        const message =
          result.phase === "skill"
            ? "Skill activation failed · draft retained"
            : result.phase === "admission"
              ? "Checking whether sent · retry keeps the same prompt ID"
              : "Prompt admitted but the wake failed · retry keeps the same prompt ID"
        finishOperation(currentOperation.id, { message, error: true })
        toast.show({
          title: "Failed to send prompt or activate skill",
          message: hasAttachments
            ? "An attachment could not be prepared or admitted. Remove it or re-paste, then retry."
            : errorMessage(result.error),
          variant: "error",
        })
        return false
      }
      if (result.result.wakeError !== undefined) {
        setRetryMode("exact")
        finishOperation(currentOperation.id, {
          message: "Prompt admitted but the wake failed · retry keeps the same prompt ID",
          error: true,
        })
        toast.show({
          title: "Prompt admitted; wake needs attention",
          message: "Retry uses the same prompt ID and managed attachments.",
          variant: "error",
        })
        return false
      }
      if (switchWarning) {
        toast.show({
          title: "Model switch needs attention",
          message: errorMessage(switchWarning),
          variant: "warning",
        })
      }
      if (pendingEditorSelection) editor.markSelectionSent()
    }
    history.append({
      ...submission.payload.history,
      mode: currentMode,
    })
    setRetry(undefined)
    setRetryMode(undefined)
    setFeedback(undefined)
    if (draftRevision === submittedRevision) {
      input.extmarks.clear()
      setStore("prompt", emptyPrompt())
      setStore("extmarkToPart", new Map())
      await releaseTemporaryAttachments()
      input.clear()
    }
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!props.sessionID) {
      if (pendingEditorSelection) editor.preserveSelectionFromNewSession()
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
        })
      }, 50)
    }
    if (finishMoveProgress) move.finishSubmit()
    return true
  }

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + promptOffsetWidth(virtualText)

    input.insertText(virtualText)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const index = draft.prompt.pasted.length
        draft.prompt.pasted.push({
          text,
          source: { start: extmarkStart, end: extmarkEnd, text: virtualText },
        })
        draft.extmarkToPart.set(extmarkId, { type: "pasted", index })
      }),
    )
  }

  async function pasteInputText(text: string) {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const pastedContent = normalizedText.trim()
    // Handle multiple newline-separated file paths (e.g. Finder multi-select copy of several images).
    // Previously only the first path was considered, causing "several images" paste to attach only one.
    const candidates = pastedContent
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => pastedFilepath(line, terminalEnvironment.platform))
    if (candidates.length > 1) {
      const attachments = await Promise.all(candidates.map((filepath) => readLocalAttachment(filepath)))
      const valid = attachments.filter(Boolean) as Awaited<ReturnType<typeof readLocalAttachment>>[]
      if (valid.length > 0 && valid.length === candidates.length) {
        for (const attachment of valid) {
          if (!attachment) continue
          await pasteAttachment({
            filename: attachment.name,
            uri: attachment.uri,
            mime: attachment.mime,
          })
        }
        return
      }
      // If not all candidates are valid files, fall through to text handling.
    } else {
      const filepath = pastedFilepath(pastedContent, terminalEnvironment.platform)
      const isUrl = /^(https?):\/\//.test(filepath)
      if (!isUrl) {
        const attachment = await readLocalAttachment(filepath)
        if (attachment) {
          await pasteAttachment({
            filename: attachment.name,
            uri: attachment.uri,
            mime: attachment.mime,
          })
          return
        }
      }
    }

    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if ((lineCount >= 3 || pastedContent.length > 150) && config.prompt?.paste !== "full") {
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)

    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      renderer.requestRender()
    }, 0)
  }

  async function pasteAttachment(file: {
    filename?: string
    uri: string
    mime: string
    temporary?: ClipboardTemporary
  }) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const label =
      file.mime === "application/pdf"
        ? "PDF"
        : file.mime.includes("excel") || file.mime.includes("spreadsheet")
          ? "Excel"
          : "Image"
    const count =
      store.prompt.files?.filter((attachment) => attachment.mention?.text.startsWith(`[${label} `)).length ?? 0
    const virtualText = `[${label} ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    addingAttachment++
    try {
      input.insertText(textToInsert)

      const extmarkId = input.extmarks.create({
        start: extmarkStart,
        end: extmarkEnd,
        virtual: true,
        styleId: pasteStyleId,
        typeId: promptPartTypeId,
      })

      const part: NonNullable<PromptInfo["files"]>[number] = {
        uri: file.uri,
        name: file.filename,
        mention: {
          start: extmarkStart,
          end: extmarkEnd,
          text: virtualText,
        },
      }
      setStore(
        produce((draft) => {
          const files = (draft.prompt.files ??= [])
          const index = files.length
          files.push(part)
          draft.extmarkToPart.set(extmarkId, { type: "file", index })
        }),
      )
      if (file.temporary) temporaryAttachments.set(file.uri, file.temporary)
    } finally {
      addingAttachment--
    }
    await syncExtmarksWithPromptParts()
    return
  }

  function clearPrompt() {
    if (
      store.prompt.text.trim().length >= DRAFT_RETENTION_MIN_CHARS ||
      store.prompt.pasted.length > 0 ||
      (store.prompt.files?.length ?? 0) > 0 ||
      (store.prompt.agents?.length ?? 0) > 0
    ) {
      if (![...(store.prompt.files ?? [])].some((file) => temporaryAttachments.has(file.uri)))
        history.append({
          ...store.prompt,
          mode: store.mode,
        })
    }
    void releaseTemporaryAttachments()
    input.clear()
    input.extmarks.clear()
    setStore("prompt", emptyPrompt())
    setStore("extmarkToPart", new Map())
  }

  const highlight = createMemo(() => {
    if (leader()) return themeV2.border.default
    if (store.mode === "shell") return themeV2.background.action.primary.default
    const agent = local.agent.current()
    if (!agent) return themeV2.border.default
    return local.agent.color(agent!.id)
  })

  const agentMetaAlpha = createFadeIn(() => !!local.agent.current(), animationsEnabled)
  const borderHighlight = createMemo(() => tint(themeV2.border.default, highlight(), agentMetaAlpha()))

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false) return undefined
    if (store.mode === "shell") {
      if (!shell().length) return undefined
      const example = shell()[store.placeholder % shell().length]
      return `Run a command... "${example}"`
    }
    if (!list().length) return undefined
    // The caller's placeholder is the placeholder. Wrapping it produced
    // `Ask anything... "Message YCoding…"` on the landing screen.
    return list()[store.placeholder % list().length]
  })
  const promptBg = themeV2.background.default

  return (
    <>
      <box
        ref={(r: BoxRenderable) => (anchor = r)}
        visible={props.visible !== false}
        width="100%"
        minHeight={props.landing ? 1 : 2}
        flexShrink={0}
      >
        <box
          width="100%"
          minHeight={props.landing ? 1 : 2}
          flexShrink={0}
          flexDirection="column"
          border={props.landing ? [] : ["top"]}
          borderColor={
            props.landing
              ? borderHighlight()
              : yoloLevel(props.autonomy ?? ({ yolo: 0 } as unknown as SessionAutonomyState)) > 0
                ? themeV2.text.feedback.error.default
                : themeV2.text.feedback.success.default
          }
        >
          <box
            paddingLeft={props.inset?.left ?? (props.landing ? 3 : 1)}
            paddingRight={props.inset?.right ?? 2}
            paddingTop={props.landing ? 1 : 2}
            minHeight={1}
            flexShrink={0}
            backgroundColor={promptBg}
            flexGrow={1}
            width="100%"
          >
            <textarea
              width="100%"
              placeholder={placeholderText()}
              placeholderColor={themeV2.text.subdued}
              textColor={leader() ? themeV2.text.subdued : themeV2.text.default}
              focusedTextColor={leader() ? themeV2.text.subdued : themeV2.text.default}
              minHeight={1}
              maxHeight={MAX_VISIBLE_INPUT_ROWS}
              onContentChange={() => {
                const value = input.plainText
                draftRevision += 1
                setStore("prompt", "text", value)
                auto()?.onInput(value)
                void syncExtmarksWithPromptParts()
                setCursorVersion((value) => value + 1)
              }}
              onCursorChange={() => {
                setCursorVersion((value) => value + 1)
                auto()?.onInput(input.plainText)
              }}
              onKeyDown={(e: { preventDefault(): void }) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
              }}
              onSubmit={() => {
                // IME: double-defer so the last composed character (e.g. Korean
                // hangul) is flushed to plainText before we read it for submission!.
                setTimeout(() => setTimeout(() => submit(), 0), 0)
              }}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const pastedContent = normalizedText.trim()

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (!pastedContent) {
                  keymap.dispatch("prompt.paste")
                  return
                }

                // Once we cross an async boundary below, the terminal may perform its
                // default paste unless we suppress it first and handle insertion ourselves.
                event.preventDefault()

                await pasteInputText(normalizedText)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                Object.assign(r, {
                  getClipboardText: (text: string) => expandPastedTextPlaceholders(text, store.prompt.pasted),
                })
                setInputTarget(r)
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.cursorColor = themeV2.text.default
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => {
                if (props.disabled) return
                r.target?.focus()
              }}
              focusedBackgroundColor="transparent"
              cursorColor={props.disabled ? themeV2.background.surface.offset : themeV2.text.default}
              syntaxStyle={syntax()}
            />
          </box>
          <Show when={operationText()}>
            {(message) => (
              <box
                paddingLeft={props.inset?.left ?? (props.landing ? 3 : 1)}
                paddingRight={props.inset?.right ?? 2}
                flexShrink={0}
              >
                <text
                  fg={feedback()?.error ? themeV2.text.feedback.error.default : themeV2.text.subdued}
                  wrapMode="none"
                  truncate
                >
                  {message()}
                </text>
              </box>
            )}
          </Show>
        </box>
      </box>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => {
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(part, extmarkId) => {
          setStore("extmarkToPart", (map: Map<number, PromptPartRef>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, part)
            return newMap
          })
        }}
        value={store.prompt.text}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        skillStyleId={skillStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
    </>
  )
}
