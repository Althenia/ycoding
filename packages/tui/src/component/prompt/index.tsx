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
import { usePromptRef } from "../../context/prompt"
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
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useRenderer, type JSX } from "@opentui/solid"
import { errorMessage } from "../../util/error"
import { useDialog } from "../../ui/dialog"
import { SplitBorder } from "../../ui/border"
import { DialogIntegration } from "../dialog-integration"
import { DialogModel } from "../dialog-model"
import { useConnected } from "../use-connected"
import { useToast } from "../../ui/toast"
import { createFadeIn } from "../../util/signal"
import { DialogSkill } from "../dialog-skill"
import { DialogBtwExport } from "../dialog-btw-export"
import { DialogSuggest } from "../dialog-suggest"
import { DialogPromptGenerate } from "../dialog-prompt-generate"
import { DialogAutonomous } from "../dialog-autonomous"
import { DialogSessionGoal } from "../dialog-session-goal"
import { useConfig } from "../../config"
import { usePromptMove } from "./move"
import { readLocalAttachment } from "./local-attachment"
import type { PromptSubmissionPayload } from "../../prompt/submission"
import { useData } from "../../context/data"
import { useLocation } from "../../context/location"
import { Keymap, type KeymapCommand } from "../../context/keymap"
import {
  confirmSessionCreation,
  createSessionID,
  goalToggleAction,
  autonomyAutomated,
  isAsleep,
  parseGoalCommand,
  restoreSessionSubmission,
  retainSessionSubmission,
  type AutonomyChange,
  type AutonomyState,
  type SessionSubmissionRetry,
} from "../../util/session-autonomy"
import { useKeepAwake } from "../../keep-awake"
import { daybreakPlan, daybreakSuccessLabel, daybreakTitle, modelDaybreak } from "../../util/session-daybreak"
import { modelVariantIDs } from "../../util/model"
import { openBtwSession, steerBtwConclusion } from "../../util/session"
import { establishLandingSession, landingAutonomyOf, landingAutonomyPayloads } from "../../util/landing-session"
import type { ModelDaybreak, ModelRef, SessionAutonomyView } from "@ycoding-ai/client"

registerYCodingSpinner()

export type PromptProps = {
  sessionID?: string
  branch?: string
  landing?: boolean
  onOverlayChange?: (open: boolean) => void
  autonomy?: SessionAutonomyView
  onAutonomyUpdated?: (sessionID: string, state: SessionAutonomyView) => void
  onLandingAutonomyChange?: (change: AutonomyChange) => void
  onLandingGoalToggle?: (next: string | null) => void
  landingDaybreak?: ModelDaybreak
  onLandingDaybreakChange?: (next: ModelDaybreak | undefined) => void
  visible?: boolean
  focusBlocked?: boolean
  projectMember?: boolean
  disabled?: boolean
  submitDisabled?: boolean
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
  const { theme } = useTheme()
  return (
    <>
      <Show when={props.branch}>
        {(branch) => (
          <text fg={theme.text.subdued} wrapMode="none" truncate flexShrink={1}>
            {branch()}
          </text>
        )}
      </Show>
      <Show when={props.sessionID}>
        {(sessionID) => (
          <text fg={theme.text.subdued} wrapMode="none" truncate flexShrink={1}>
            {sessionID().length > 13 ? `${sessionID().slice(0, 13)}…` : sessionID()}
          </text>
        )}
      </Show>
    </>
  )
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
    modelSelectionPending: payload.modelSelectionPending,
    daybreak: payload.daybreak,
    autonomy: payload.autonomy,
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
const activePrompts = new WeakMap<object, { clear: (sessionID: string | undefined, prompt: PromptInfo) => void }>()
const fillEmptyPrompt = new WeakMap<PromptRef, (text: string, delivery?: "queue") => boolean>()
function goalComposerText(text: string) {
  const trimmed = text.trim()
  if (trimmed === "/goal" || trimmed.startsWith("/goal ") || trimmed.startsWith("/goal\n")) return trimmed
  return `/goal ${trimmed}`
}

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
  const paths = useTuiPaths()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const clipboard = useClipboard()
  const client = useClient()
  const keepAwake = useKeepAwake()
  const editor = useEditorContext()
  const route = useRoute()
  const promptRef = usePromptRef()
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
  const automationOrGoalActive = createMemo(
    () =>
      props.autonomy?.goal?.status === "active" ||
      (["permissions", "guardrails", "answers"] as const).some((category) => props.autonomy?.effective?.[category] === "yolo"),
  )
  const saveAutonomy = async (change: AutonomyChange) => {
    const sessionID = props.sessionID
    if (!sessionID) {
      if (!landingTransferred) props.onLandingAutonomyChange?.(change)
      return
    }
    const payload = change.permissions !== undefined
      ? { permissions: change.permissions, guardrails: change.guardrails, answers: change.answers }
      : change.guardrails !== undefined
        ? { guardrails: change.guardrails, answers: change.answers }
        : change.answers !== undefined ? { answers: change.answers } : undefined
    if (!payload) return
    const result = await client.api.session.autonomy.set({ sessionID, payload })
    props.onAutonomyUpdated?.(sessionID, result)
  }
  const renderer = useRenderer()
  const exit = useExit()
  const { theme, syntax } = useTheme()
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
  const [landingSubmissionSessionID, setLandingSubmissionSessionID] = createSignal<string>()
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
    if (!current) return feedback()?.message ?? data.session.submissions.list(props.sessionID ?? landingSubmissionSessionID() ?? "").find((entry) => entry.skillOnly)?.phase
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
    if (props.disabled) input.cursorColor = theme.background.surface.offset
    if (!props.disabled) input.cursorColor = theme.text.default
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
  const predictionShortcut = Keymap.useShortcut("prompt.prediction.accept")
  const predictionEligible = createMemo(() => {
    const sessionID = props.sessionID
    return !!sessionID && store.prompt.text === "" && store.mode === "normal" && !props.disabled && !props.submitDisabled &&
      client.connection.status() === "connected" && status() === "idle" && data.session.pending.list(sessionID).length === 0 &&
      props.autonomy?.goal?.status !== "active" && !operation() && !auto()?.visible && dialog.stack.length === 0
  })
  const prediction = createMemo(() => {
    const sessionID = props.sessionID
    if (!sessionID || !predictionEligible()) return
    const value = data.session.prediction.get(sessionID)
    if (data.session.message.list(sessionID).findLast(message => message.type === "assistant")?.id !== value?.sourceMessageID) return
    return value
  })
  const dismissPrediction = () => { if (props.sessionID) data.session.prediction.dismiss(props.sessionID) }
  const acceptPrediction = () => {
    const value = prediction()
    if (!value || input.plainText !== "") return
    dismissPrediction()
    input.setText(value.text)
    input.gotoBufferEnd()
  }
  createEffect(() => {
    if (props.sessionID) data.session.prediction.get(props.sessionID)
    if (store.prompt.text !== "" || props.autonomy?.goal?.status === "active") dismissPrediction()
  })
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

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

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
        title: "Send and steer now",
        name: "prompt.steer",
        category: "Prompt",
        palette: true,
        enabled: status() === "running",
        run: async (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          if (event && !input.focused) return
          const handled = await submit({ steerNow: true })
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
        enabled: status() === "running" || automationOrGoalActive(),
        run: (_input: string | undefined, event?: KeyEvent) => {
          if (!event && props.sessionID) {
            void client.api.session
              .interrupt({ sessionID: props.sessionID })
              .catch((error) => toast.show({ title: "Failed to interrupt", message: errorMessage(error), variant: "error" }))
            dialog.clear()
            return
          }
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
        enabled: status() === "running",
        run: (_input: string | undefined, event?: KeyEvent) => {
          if (auto()?.visible) return
          if (event && !input.focused) return
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
                void client.api.session.snapshot({ sessionID: parentID, limit: 100 }).then((snapshot) => openBtwSession({
                  api: client.api.session,
                  parentID,
                  messages: snapshot.messages,
                  text,
                  model: {
                    providerID: model.providerID,
                    id: model.modelID,
                    variant: model.variant,
                    ...(model.profile === undefined ? {} : { profile: model.profile }),
                  },
                })).then(
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
        title: "Suggest next message",
        name: "session.suggest",
        category: "Session",
        palette: props.sessionID !== undefined,
        slash: { name: "suggest", arguments: true as const },
        run: async (text: string | undefined) => {
          const sessionID = props.sessionID
          if (!sessionID) return
          clearPrompt()
          const hint = text?.trim()
          const memory = await DialogSuggest.show(dialog)
          if (!memory) return
          toast.show({ message: "Generating suggestion…", variant: "info" })
          const result = await data.session.prediction
            .request(sessionID, hint ? { memory, hint } : { memory })
            .catch((error: unknown) => {
              toast.error(error)
            })
          if (result?.status !== "unavailable") return
          toast.show({ message: "No suggestion available for the latest reply", variant: "info" })
        },
      },
      {
        title: "Generate prompt",
        description: "Draft a prompt from a rough intent",
        name: "session.prompt.generate",
        category: "Session",
        palette: true,
        slash: { name: "prompt", arguments: true as const },
        run: (text: string | undefined) => generatePrompt(text),
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
          const parsed = parseGoalCommand(store.prompt.text)
          await applyGoalCommand(parsed?.goal || undefined)
        },
      },
      {
        title: "Autonomous",
        description: "permissions, guardrails, and answers",
        name: "session.autonomy.dialog",
        category: "Session",
        palette: true,
        slash: { name: "autonomous" },
        run: async () => {
          dialog.replace(() => <DialogAutonomous autonomy={() => props.autonomy} save={saveAutonomy} />)
        },
      },
      {
        title: "Sleep (configured automation, rest to review box)",
        name: "session.autonomy.sleep",
        category: "Session",
        palette: true,
        slash: { name: "sleep" },
        run: async () => {
          const sessionID = props.sessionID
          if (!sessionID) {
            toast.show({ message: "Open a session to sleep", variant: "warning", duration: 3000 })
            return
          }
          if (props.autonomy && isAsleep(props.autonomy)) {
            toast.show({
              message: "Already asleep; /wake or any prompt wakes the session",
              variant: "info",
              duration: 3000,
            })
            return
          }
          try {
            const result = await client.api.session.autonomy.set({ sessionID, payload: { sleep: true } })
            props.onAutonomyUpdated?.(sessionID, result)
            await keepAwake.refresh()
            const awake = keepAwake.status()
            toast.show({
              title: "Sleep on",
              message:
                awake?.state === "on"
                  ? `Configured automation applies; rest go to review box. Idle sleep held off; display ${awake.display ?? "unreported"}; activity ${awake.activity ?? "unreported"}; lid ${awake.lid ?? "unreported"}${awake.system === "on" ? "; system sleep disabled" : awake.system === "setup" ? "; system sleep not disabled, run ycoding keep-awake setup" : awake.system === "held" ? "; system sleep held by another YCoding process" : awake.system === "error" ? "; system sleep change failed" : ""}. Deliberate locks and managed policy apply. On battery this drains the battery and a closed lid traps heat.`
                  : "Configured automation applies; rest go to review box. Keep-awake is not holding this machine; it may sleep.",
              variant: "success",
              duration: 6000,
            })
          } catch (error) {
            toast.show({ title: "Failed to sleep", message: errorMessage(error), variant: "error" })
          }
        },
      },
      {
        title: "Wake",
        name: "session.autonomy.wake",
        category: "Session",
        palette: true,
        slash: { name: "wake" },
        run: async () => {
          const sessionID = props.sessionID
          if (!sessionID) {
            toast.show({ message: "Open a session to wake", variant: "warning", duration: 3000 })
            return
          }
          try {
            const result = await client.api.session.autonomy.set({ sessionID, payload: { sleep: false } })
            props.onAutonomyUpdated?.(sessionID, result)
            await keepAwake.refresh()
            toast.show({ message: "Awake; sleep mode is off", variant: "success", duration: 3000 })
          } catch (error) {
            toast.show({ title: "Failed to wake", message: errorMessage(error), variant: "error" })
          }
        },
      },
      {
        title: daybreakTitle(props.sessionID ? data.session.get(props.sessionID)?.daybreak : props.landingDaybreak),
        name: "session.daybreak.toggle",
        category: "Session",
        enabled: !!props.sessionID || !!props.onLandingDaybreakChange,
        palette: true,
        slash: { name: "daybreak", arguments: true as const },
        run: async (input?: string) => {
          const sessionID = props.sessionID
          const selected = (sessionID ? local.model.pendingTarget(sessionID) : undefined) ?? local.model.current()
          const info = selected
            ? data.location.model.list(currentLocation.current)?.find(
                (item) => item.providerID === selected.providerID && item.id === selected.modelID,
              )
            : undefined
          const advertised = modelDaybreak({ model: info, selection: selected })
          const plan = daybreakPlan({
            current: sessionID ? data.session.get(sessionID)?.daybreak : props.landingDaybreak,
            advertised,
            argument: input,
          })
          if (plan.type === "reject") {
            toast.show({ message: plan.message, variant: "error", duration: 3000 })
            return
          }
          if (!sessionID) {
            props.onLandingDaybreakChange?.(plan.daybreak ?? undefined)
            toast.show({ message: daybreakSuccessLabel(plan.daybreak), variant: "success", duration: 3000 })
            return
          }
          try {
            await client.api.session.daybreak.set({ sessionID, daybreak: plan.daybreak })
            toast.show({ message: daybreakSuccessLabel(plan.daybreak), variant: "success", duration: 3000 })
          } catch (error) {
            toast.show({ title: "Failed to change Daybreak", message: errorMessage(error), variant: "error" })
          }
        },
      },
      {
        title: "Move session",
        description: "Move to another project dir",
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

  fillEmptyPrompt.set(ref, (text, delivery) => {
    if (store.prompt.text !== "" || (!input.isDestroyed && input.plainText !== "")) return false
    input.setText(text)
    setStore("prompt", {
      ...emptyPrompt(),
      text,
      ...(delivery === "queue" ? { delivery } : {}),
    })
    input.focus()
    input.gotoBufferEnd()
    return true
  })

  onMount(() => {
    const saved = stashed.get(client)
    stashed.delete(client)
    if (!store.prompt.text && saved && (saved.prompt.text || (saved.prompt.files?.length ?? 0) > 0)) {
      for (const [uri, temporary] of saved.temporaryAttachments ?? []) temporaryAttachments.set(uri, temporary)
      input.setText(saved.prompt.text)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromPrompt(saved.prompt)
      input.cursorOffset = saved.cursor
    }
    const owner = {
      clear(sessionID: string | undefined, prompt: PromptInfo) {
        if (
          props.sessionID === sessionID &&
          store.prompt.text === prompt.text &&
          (store.prompt.files?.length ?? 0) === (prompt.files?.length ?? 0) &&
          store.prompt.pasted.length === prompt.pasted.length
        ) clearPrompt(false)
      },
    }
    activePrompts.set(client, owner)
    onCleanup(() => {
      if (activePrompts.get(client) === owner) activePrompts.delete(client)
    })
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
    fillEmptyPrompt.delete(ref)
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
    if (props.focusBlocked) return
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
      ...data.session.submissions.list(props.sessionID ?? landingSubmissionSessionID() ?? "").filter((entry) => entry.state === "attention").flatMap((entry) => [{
        title: `Retry send: ${entry.input.payload.inputText.slice(0, 40)}`,
        description: entry.error,
        name: `prompt.send.retry.${entry.input.promptID}`,
        category: "Prompt",
        enabled: true,
        run: () => {
          data.session.submissions.retry(entry.input.sessionID, entry.input.promptID)
          dialog.clear()
        },
      }, {
        title: `Discard previous submission recovery: ${entry.input.payload.inputText.slice(0, 40)}`,
        description: "Remove local retry state only; this does not undo backend input.",
        name: `prompt.send.discard.${entry.input.promptID}`,
        category: "Prompt",
        enabled: true,
        run: () => {
          data.session.submissions.discard(entry.input.sessionID, entry.input.promptID)
          toast.show({ message: "Local recovery discarded · backend input is unchanged", variant: "warning" })
          dialog.clear()
        },
      }]),
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
    priority: 3,
    target: inputTarget,
    enabled: inputTarget() !== undefined && predictionEligible() &&
      data.session.message.list(props.sessionID!).some(message => message.type === "assistant"),
    commands: [
      { id: "prompt.prediction.accept", title: "Use suggestion", enabled: prediction() !== undefined, run: acceptPrediction },
      { bind: "tab", title: "Use suggestion", enabled: prediction() !== undefined, run: acceptPrediction },
      { bind: "escape", title: "Dismiss suggestion", run: dismissPrediction },
    ],
  }))

  Keymap.createLayer(() => {
    cursorVersion()
    return {
      priority: 4,
      target: inputTarget,
      enabled: props.projectMember === true && inputTarget() !== undefined && !props.disabled && !auto()?.visible && input?.plainText === "",
      bindings: ["session.parent", "session.child.previous", "session.child.next"],
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
  let landingTransferred = false

  function landingPromptTarget() {
    const submissionLocation = currentLocation.current
    const agents = data.location.agent.list(submissionLocation)
    const models = data.location.model.list(submissionLocation)
    if (!agents || !models) {
      toast.show({
        title: "Model selection needs attention",
        message: "The agent and model catalog is not available yet. Refresh models and providers or retry; draft retained.",
        variant: "warning",
      })
      return
    }
    const agentID = local.agent.current()?.id
    if (!agentID) {
      promptModelWarning()
      return
    }
    const selectedModel = local.model.current()
    const variant = local.model.variant.current()
    const info =
      selectedModel && models.find((item) => item.providerID === selectedModel.providerID && item.id === selectedModel.modelID)
    const profileUnavailable =
      selectedModel?.profile !== undefined && !info?.profiles?.some((item) => item.name === selectedModel.profile)
    const modelUnavailable = selectedModel?.profile === undefined && info?.enabled === false
    const variants = modelVariantIDs({ model: info, profile: selectedModel?.profile })
    if (!selectedModel || !info || profileUnavailable || modelUnavailable || (variant !== undefined && !variants.includes(variant))) {
      toast.show({
        title: "Model selection needs attention",
        message: profileUnavailable
          ? `Profile ${selectedModel?.profile} is unavailable for ${info?.name ?? selectedModel?.modelID}. Choose another profile or Use provider default; draft retained.`
          : modelUnavailable
            ? `Model ${info?.name ?? selectedModel?.modelID} is unavailable for the provider default; choose an available profile or model; draft retained.`
            : "The selected model or effort is unavailable in the current catalog. Refresh the catalog or choose an available model and effort; draft retained.",
        variant: "warning",
      })
      return
    }
    return {
      agentID,
      model: {
        providerID: selectedModel.providerID,
        id: selectedModel.modelID,
        variant,
        ...(selectedModel.profile === undefined ? {} : { profile: selectedModel.profile }),
      },
      autonomy: landingAutonomyOf(props.autonomy, true),
      daybreak: props.landingDaybreak,
    }
  }

  async function openGeneratedSession() {
    if (landingTransferred) return
    const target = landingPromptTarget()
    if (!target) return
    const directory = await move.getDirectory()
    const base = data.location.default()
    const created = await establishLandingSession({
      api: client.api,
      id: createSessionID(),
      location: directory ? { ...base, directory } : base,
      agent: target.agentID,
      model: target.model,
      autonomy: target.autonomy,
      daybreak: target.daybreak,
    }).catch((error: unknown) => {
      toast.error(error)
    })
    if (!created) return
    await data.session.sync(created.id).catch((error: unknown) => {
      toast.error(error)
    })
    if (!data.session.get(created.id)) return
    const previous = promptRef.current
    landingTransferred = true
    route.navigate({ type: "session", sessionID: created.id })
    return { id: created.id, previous }
  }

  async function generatedComposer(sessionID: string, previous?: PromptRef) {
    if (props.sessionID === sessionID) return promptRef.current
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const current = promptRef.current
      if (route.data.type === "session" && route.data.sessionID === sessionID && current && current !== previous) return current
      await new Promise((resolve) => setTimeout(resolve, 16))
    }
  }

  async function generatePrompt(text: string | undefined) {
    if (text === undefined) {
      const draft = "/prompt "
      input.setText(draft)
      setStore("prompt", { ...emptyPrompt(), text: draft })
      input.gotoBufferEnd()
      return
    }
    const intent = text.trim()
    if (!intent) {
      toast.show({ message: "Add what you want after /prompt", variant: "info" })
      return
    }
    const choice = await DialogPromptGenerate.show(dialog, { session: props.sessionID !== undefined })
    if (!choice) return
    const opened = props.sessionID ? undefined : await openGeneratedSession()
    const sessionID = props.sessionID ?? opened?.id
    if (!sessionID) return
    const composer = await generatedComposer(sessionID, opened?.previous)
    if (!composer) {
      toast.show({ message: "Could not open the new Session", variant: "error" })
      return
    }
    toast.show({ message: "Generating prompt…", variant: "info" })
    const result = await data.session.promptGenerate
      .request(sessionID, { mode: choice.mode, intent, memory: choice.memory })
      .catch((error: unknown) => {
        toast.error(error)
      })
    if (!result) return
    if (result.status === "unavailable") {
      toast.show({ message: "No prompt could be generated", variant: "info" })
      return
    }
    const draft = choice.mode === "goal" ? goalComposerText(result.text) : result.text
    const current = promptRef.current
    const delivery = choice.mode === "queue" ? "queue" : undefined
    if (
      route.data.type === "session" &&
      route.data.sessionID === sessionID &&
      current &&
      fillEmptyPrompt.get(current)?.(draft, delivery)
    )
      return
    toast.show({ message: "Draft not empty; generated prompt discarded", variant: "info" })
  }

  createEffect(() => {
    const sessionID = landingSubmissionSessionID()
    if (props.sessionID || !sessionID || !data.session.get(sessionID)) return
    route.navigate({ type: "session", sessionID })
  })
  async function submit(options?: { steerNow?: boolean }) {
    if (props.disabled || props.submitDisabled || client.connection.status() !== "connected") return false
    // Prevent overlapping invocations (e.g. a double-pressed Enter, or the
    // input's native onSubmit racing another dispatch). Without this guard,
    // a second call slips past the empty-input check before the first call
    // clears `store.prompt.text`, then awaits its own `session.create` and
    // ultimately reads the now-empty store — sending a phantom empty prompt
    // to a freshly created session.
    if (submitting || operation() || (landingTransferred && !props.sessionID && !landingSubmissionSessionID())) return false
    submitting = true
    const current = beginOperation("submit", options?.steerNow ? "Preparing steer…" : "Preparing prompt…")
    if (!current) {
      submitting = false
      return false
    }
    try {
      return await submitInner(current, options)
    } finally {
      finishOperation(current.id)
      submitting = false
    }
  }

  async function submitInner(currentOperation: PromptOperation, options?: { steerNow?: boolean }) {
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
    // /goal is a toggle without arguments and an explicit objective with text. Text always replaces
    // the objective, active or not; the bare form stops, resumes the retained objective, or asks for
    // one. Only tracked-paste expansion happens before parsing, so multiline and Unicode survive.
    const normalized = inputText.trim()
    if (normalized === "/goal" || normalized.startsWith("/goal ") || normalized.startsWith("/goal\n")) {
      await applyGoalCommand(normalized.slice(5).trim() || undefined)
      return true
    }
    const autonomySlash = (["sleep", "wake", "autonomous"] as const).find((name) => normalized === `/${name}`)
    if (autonomySlash) {
      clearPrompt()
      const command = keymapCommands().find((item) => item.slash?.name === autonomySlash)
      if (command) await command.run(undefined)
      return true
    }
    if (normalized === "/keep-awake") {
      clearPrompt()
      await keepAwake.toggle()
      return true
    }
    const slash = argumentSlash(inputText, keymapCommands())
    if (slash) {
      if (slash.command.id !== "session.btw" && slash.command.id !== "session.btw.send") clearPrompt()
      await slash.command.run(slash.input)
      return true
    }
    const resumedSession = props.sessionID ? data.session.get(props.sessionID) : undefined
    if (props.sessionID && !resumedSession) return false
    const submissionLocation = resumedSession?.location ?? currentLocation.current
    const agents = data.location.agent.list(submissionLocation)
    const models = data.location.model.list(submissionLocation)
    if (!agents || !models) {
      toast.show({
        title: "Model selection needs attention",
        message: "The agent and model catalog is not available yet. Refresh models and providers or retry; draft retained.",
        variant: "warning",
      })
      return false
    }
    const agentID = btwSession()?.agent ?? local.agent.current()?.id
    if (!agentID) {
      if (!resumedSession) {
        promptModelWarning()
        return false
      }
      toast.show({
        title: "Agent selection needs attention",
        message: `Agent ${resumedSession.agent ?? "selection"} is unavailable in this Session's Location; choose an available agent; draft retained.`,
        variant: "warning",
      })
      return false
    }
    const fixedModel = btwSession()?.model
    const selectedModel = fixedModel
      ? { providerID: fixedModel.providerID, modelID: fixedModel.id, ...(fixedModel.profile === undefined ? {} : { profile: fixedModel.profile }) }
      : local.model.current()
    const variant = fixedModel ? fixedModel.variant : local.model.variant.current()
    const info = selectedModel && models.find((item) => item.providerID === selectedModel.providerID && item.id === selectedModel.modelID)
    const profileUnavailable = selectedModel?.profile !== undefined && !info?.profiles?.some((item) => item.name === selectedModel.profile)
    const modelUnavailable = selectedModel?.profile === undefined && info?.enabled === false
    const variants = modelVariantIDs({ model: info, profile: selectedModel?.profile })
    if (!selectedModel || !info || profileUnavailable || modelUnavailable || variant !== undefined && !variants.includes(variant)) {
      toast.show({
        title: "Model selection needs attention",
        message: profileUnavailable
          ? `Profile ${selectedModel?.profile} is unavailable for ${info?.name ?? selectedModel?.modelID}. Choose another profile or Use provider default; draft retained.`
          : modelUnavailable
            ? `Model ${info?.name ?? selectedModel?.modelID} is unavailable for the provider default; choose an available profile or model; draft retained.`
            : "The selected model or effort is unavailable in the current catalog. Refresh the catalog or choose an available model and effort; draft retained.",
        variant: "warning",
      })
      return false
    }
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
      daybreak: props.sessionID ? undefined : props.landingDaybreak,
      autonomy: props.sessionID ? undefined : landingAutonomyOf(props.autonomy, true),
      model: {
        providerID: selectedModel.providerID,
        id: selectedModel.modelID,
        variant,
        ...(selectedModel.profile === undefined ? {} : { profile: selectedModel.profile }),
      } satisfies ModelRef,
      modelSelectionPending: !!local.model.pendingTarget(props.sessionID),
      editor: candidateEditorSelection
        ? {
            key: editorSelectionKey(candidateEditorSelection),
            text: formatEditorContext(candidateEditorSelection),
          }
        : undefined,
      history: currentHistory,
      cursor: input.cursorOffset,
      ...(store.prompt.delivery === "queue" ? { delivery: "queue" as const } : {}),
    }
    const targetSessionID = props.sessionID ?? landingSubmissionSessionID()
    const key = submissionKey(targetSessionID, payload)
    let retained = retry()
    if (retained && retained.key !== key) {
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
      retained = undefined
    }
    const slashSkill = store.mode === "normal" && inputText.startsWith("/")
      ? data.location.skill.list(currentLocation.current)?.find((skill) => skill.slash === true && skill.id === inputText.split(/\s/)[0].slice(1))?.id
      : undefined
    const submission = retainSessionSubmission(retained, key, slashSkill ? 1 : 0, payload, targetSessionID)
    if (targetSessionID) {
      submission.payload.autonomy = undefined
      submission.payload.daybreak = undefined
    }
    const command = inputText.startsWith("/") && data.location.command.list(currentLocation.current)?.some((command) => command.name === inputText.split(/\s/)[0].slice(1))
    if (payload.mode === "normal") {
      const directory = props.sessionID ? undefined : await move.getDirectory()
      const temporary = (payload.files ?? []).flatMap((file) => {
        const value = temporaryAttachments.get(file.uri)
        if (!value) return []
        temporaryAttachments.delete(file.uri)
        return [value]
      })
      const firstLineEnd = payload.inputText.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? payload.inputText : payload.inputText.slice(0, firstLineEnd)
      const [commandHead, ...firstLineArgs] = firstLine.split(" ")
      const restOfInput = firstLineEnd === -1 ? "" : payload.inputText.slice(firstLineEnd + 1)
      const reconcileHistory = history.append(submission.payload.history)
      data.session.submissions.dispatch(submission, {
        location: directory ? { directory } : data.location.default(),
        skillOnly: command ? undefined : slashSkill,
        command: command ? { name: commandHead.slice(1), arguments: firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "") } : undefined,
        steerNow: options?.steerNow,
        cleanup: async () => {
          for (const value of temporary) await value.cleanup()
        },
        onCommitted: slashSkill && !command ? undefined : () => local.model.commitPending(submission.sessionID, submission.payload.model),
        onAdmitted: async (updated) => { await reconcileHistory?.(updated) },
        onDiscarded: async () => { await reconcileHistory?.() },
      })
      setRetry(undefined)
      setFeedback(undefined)
      input.extmarks.clear()
      setStore("prompt", emptyPrompt())
      setStore("extmarkToPart", new Map())
      setMissingTemporaryAttachments([])
      input.clear()
      if (payload.editor && !command && !slashSkill) editor.markSelectionSent()
      props.onSubmit?.()
      if (!props.sessionID) {
        landingTransferred = true
        setLandingSubmissionSessionID(submission.sessionID)
      }
      return true
    }
    setRetry(submission)
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

    if (submission.payload.daybreak && session?.daybreak !== submission.payload.daybreak) {
      updateOperation(currentOperation.id, "Selecting Daybreak…")
      const result = await client.api.session.daybreak.set(
        { sessionID, daybreak: submission.payload.daybreak },
        requestOptions(currentOperation),
      ).then(
        (session) => ({ session }),
        (error) => ({ error }),
      )
      if ("error" in result) {
        finishOperation(currentOperation.id, { message: "Daybreak selection failed · draft retained", error: true })
        toast.show({ title: "Failed to enable Daybreak", message: errorMessage(result.error), variant: "error" })
        return false
      }
      session = result.session
    }

    const landingPayloads = landingAutonomyPayloads(submission.payload.autonomy)
    if (!props.sessionID && landingPayloads.length > 0) {
      updateOperation(currentOperation.id, "Setting autonomy…")
      const error = await (async () => {
        for (const payload of landingPayloads)
          await client.api.session.autonomy.set({ sessionID, payload }, requestOptions(currentOperation))
      })().then(() => undefined, (error) => error)
      if (error) {
        finishOperation(currentOperation.id, { message: "Autonomy selection failed · draft retained", error: true })
        toast.show({ title: "Failed to set autonomy", message: errorMessage(error), variant: "error" })
        return false
      }
    }

    const currentMode = submission.payload.mode
    const pendingEditorSelection = submission.payload.editor

    if (submission.payload.mode === "shell") {
      move.startSubmit()
      const result = await client.api.session.shell(
        {
          sessionID,
          command: submission.payload.inputText,
        },
        requestOptions(currentOperation),
      ).then(() => ({ success: true as const }), (error: unknown) => ({ error }))
      if (currentOperation.controller.signal.aborted) return false
      if ("error" in result) {
        finishOperation(currentOperation.id, { message: "Shell submission failed · draft retained", error: true })
        toast.show({
          title: "Shell submission failed",
          message: `${errorMessage(result.error)} · Check the Session before retrying`,
          variant: "error",
        })
        return false
      }
      setStore("mode", "normal")
    }
    history.append({
      ...submission.payload.history,
      mode: currentMode,
    })
    setRetry(undefined)
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
      landingTransferred = true
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
        local: true,
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

  function clearPrompt(recordHistory = true) {
    if (
      recordHistory && (
        store.prompt.text.trim().length >= DRAFT_RETENTION_MIN_CHARS ||
        store.prompt.pasted.length > 0 ||
        (store.prompt.files?.length ?? 0) > 0 ||
        (store.prompt.agents?.length ?? 0) > 0
      )
    ) {
      if (![...(store.prompt.files ?? [])].some((file) => temporaryAttachments.has(file.uri)))
        history.append({
          ...store.prompt,
          mode: store.mode,
        })
    }
    if (disposed) {
      const saved = stashed.get(client)
      if (saved?.prompt.text === store.prompt.text) {
        stashed.delete(client)
        for (const temporary of saved.temporaryAttachments?.values() ?? []) void temporary.cleanup().catch(() => {})
      }
      activePrompts.get(client)?.clear(props.sessionID, unwrap(store.prompt))
      setStore("prompt", emptyPrompt())
      return
    }
    void releaseTemporaryAttachments()
    input.clear()
    input.extmarks.clear()
    setStore("prompt", emptyPrompt())
    setStore("extmarkToPart", new Map())
  }

  /**
   * One `/goal` contract for both the composer and the palette command. Explicit text always
   * replaces the objective, even while one is active; the bare form stops, resumes the retained
   * objective without recalculation, or asks for one. A failed calculation keeps the draft and
   * attachments and performs no prompt admission.
   */
  async function applyGoalCommand(candidate?: string) {
    const sessionID = props.sessionID
    if (!sessionID && landingTransferred) return false
    if (!sessionID) {
      // Landing with explicit goal text: create a Session, set the goal, and continue in transcript.
      if (candidate) {
        const location = data.location.default()
        const agentID = local.agent.current()?.id ?? data.location.agent.list(location)?.[0]?.id ?? "default"
        const currentModel = local.model.current()
        if (!currentModel) {
          toast.show({ message: "Connect a provider and select a model before setting a goal", variant: "warning", duration: 3000 })
          return false
        }
        const modelRef = {
          id: currentModel.modelID,
          providerID: currentModel.providerID,
          variant: local.model.variant.current() || undefined,
          ...(currentModel.profile === undefined ? {} : { profile: currentModel.profile }),
        }
        const daybreak = props.landingDaybreak
        try {
          const created = await client.api.session.create({
            location: location as never,
            agent: agentID,
            model: modelRef,
          })
          for (const payload of landingAutonomyPayloads(landingAutonomyOf(props.autonomy, false)))
            await client.api.session.autonomy.set({ sessionID: created.id, payload })
          if (daybreak) await client.api.session.daybreak.set({ sessionID: created.id, daybreak })
          await client.api.session.autonomy.set({ sessionID: created.id, payload: { goal: candidate } })
          landingTransferred = true
          props.onLandingGoalToggle?.(candidate)
          clearPrompt()
          setTimeout(() => route.navigate({ type: "session", sessionID: created.id }), 50)
          return true
        } catch (error) {
          toast.show({ title: "Failed to create a session with the goal", message: errorMessage(error), variant: "error" })
          return false
        }
      }
      // Landing bare /goal: toggles the local hint for display only.
      const current = props.autonomy
      if (current?.goal?.status === "active") props.onLandingGoalToggle?.(null)
      else if (current?.goal?.text.trim()) props.onLandingGoalToggle?.(current.goal.text)
      else return false
      toast.show({
        message: current?.goal?.status === "active" ? "Goal deactivated (landing)" : "Goal activated (landing)",
        variant: "success",
        duration: 2000,
      })
      clearPrompt()
      return true
    }
    const action = candidate
      ? ({ type: "replace", text: candidate } as const)
      : goalToggleAction(props.autonomy ?? ({ mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual" } satisfies AutonomyState))
    if (action.type === "request-objective") {
      clearPrompt()
      DialogSessionGoal.show(dialog, sessionID, undefined, (state) => props.onAutonomyUpdated?.(sessionID, state))
      return true
    }
    if (action.type === "replace" || action.type === "resume") {
      const pending = local.model.pendingTarget(sessionID)
      if (pending) {
        const model = {
          providerID: pending.providerID,
          id: pending.modelID,
          variant: pending.variant,
          ...(pending.profile === undefined ? {} : { profile: pending.profile }),
        }
        try {
          await client.api.session.switchModel({ sessionID, model })
        } catch (error) {
          toast.show({ title: "Model switch needs attention", message: errorMessage(error), variant: "warning" })
          return false
        }
        local.model.commitPending(sessionID, model)
      }
    }
    try {
      const payload =
        action.type === "stop"
          ? ({ goal: null } as const)
          : action.type === "resume"
            ? ({ goal: true } as const)
            : ({ goal: action.text } as const)
      const result = await client.api.session.autonomy.set({ sessionID, payload })
      props.onAutonomyUpdated?.(sessionID, result)
      clearPrompt()
      toast.show({
        message:
          action.type === "stop" ? "Goal deactivated" : action.type === "resume" ? "Goal resumed" : "Goal activated",
        variant: "success",
        duration: 3000,
      })
      return true
    } catch (error) {
      // The draft and its attachments stay editable so the user can retry the exact same objective.
      toast.show({ title: "Failed to set goal", message: errorMessage(error), variant: "error" })
      return false
    }
  }

  const highlight = createMemo(() => {
    if (leader()) return theme.border.default
    if (store.mode === "shell") return theme.background.action.primary.default
    const agent = local.agent.current()
    if (!agent) return theme.border.default
    return local.agent.color(agent!.id)
  })

  const agentMetaAlpha = createFadeIn(() => !!local.agent.current(), animationsEnabled)
  const borderHighlight = createMemo(() => tint(theme.border.default, highlight(), agentMetaAlpha()))

  const placeholderText = createMemo(() => {
    if (prediction()) return `${prediction()!.text}  · tab${predictionShortcut() && predictionShortcut() !== "tab" ? ` / ${formatShortcut(predictionShortcut()!)}` : ""} use suggestion`
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
  const promptBg = theme.background.default

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
          border={props.landing ? [] : ["left"]}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={
            props.landing
              ? borderHighlight()
              : props.autonomy?.effective === undefined
                ? theme.text.subdued
                : autonomyAutomated(props.autonomy)
                  ? theme.text.feedback.error.default
                  : theme.text.feedback.success.default
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
            onMouseDown={() => { if (!props.disabled) input.focus() }}
          >
            <box width="100%" minHeight={1}>
            <textarea
              width="100%"
              position={prediction() ? "absolute" : "relative"}
              height={prediction() ? "100%" : "auto"}
              placeholder={prediction() ? undefined : placeholderText()}
              placeholderColor={theme.text.subdued}
              textColor={leader() ? theme.text.subdued : theme.text.default}
              focusedTextColor={leader() ? theme.text.subdued : theme.text.default}
              minHeight={1}
              maxHeight={MAX_VISIBLE_INPUT_ROWS}
              onContentChange={() => {
                const value = input.plainText
                if (value !== "") dismissPrediction()
                draftRevision += 1
                setStore("prompt", "text", value)
                if (value.trim() === "") setStore("prompt", "delivery", undefined)
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
                if (props.disabled || props.submitDisabled || client.connection.status() !== "connected") return
                if (submitting || operation()) return
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
                  input.cursorColor = theme.text.default
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => {
                if (props.disabled) return
                r.target?.focus()
              }}
              focusedBackgroundColor="transparent"
              cursorColor={props.disabled ? theme.background.surface.offset : theme.text.default}
              syntaxStyle={syntax()}
            />
            <Show when={prediction()}>
              <text width="100%" fg={theme.text.subdued} wrapMode="word" selectable={false} onMouseDown={() => input.focus()}>
                {placeholderText()}
              </text>
            </Show>
            </box>
          </box>
          <Show when={store.prompt.delivery === "queue" && store.prompt.text.trim() !== ""}>
            <box
              paddingLeft={props.inset?.left ?? (props.landing ? 3 : 1)}
              paddingRight={props.inset?.right ?? 2}
              flexShrink={0}
            >
              <text fg={theme.text.subdued} wrapMode="none">
                ⋯ will queue
              </text>
            </box>
          </Show>
          <Show when={operationText()}>
            {(message) => (
              <box
                paddingLeft={props.inset?.left ?? (props.landing ? 3 : 1)}
                paddingRight={props.inset?.right ?? 2}
                flexShrink={0}
              >
                <text
                  fg={feedback()?.error ? theme.text.feedback.error.default : theme.text.subdued}
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
