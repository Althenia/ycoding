import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  MouseEvent,
  PasteEvent,
  decodePasteBytes,
  type KeyEvent,
} from "@opentui/core"
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, Show, Switch, Match } from "solid-js"
import { registerYCodingSpinner } from "../register-spinner"
import path from "path"
import { fileURLToPath } from "url"
import { useLocal } from "../../context/local"
import { useTheme } from "../../context/theme"
import { tint } from "../../theme/color"
import { EmptyBorder, SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { useClipboard } from "../../context/clipboard"
import { Spinner } from "../spinner"
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
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { Locale } from "../../util/locale"
import { errorMessage } from "../../util/error"
import { createColors, createFrames } from "../../ui/spinner"
import { useDialog } from "../../ui/dialog"
import { DialogIntegration } from "../dialog-integration"
import { DialogModel } from "../dialog-model"
import { useConnected } from "../use-connected"
import { useToast } from "../../ui/toast"
import { createFadeIn } from "../../util/signal"
import { DialogSkill } from "../dialog-skill"
import { useArgs } from "../../context/args"
import { useConfig } from "../../config"
import { usePromptMove } from "./move"
import { readLocalAttachment } from "./local-attachment"
import { useData } from "../../context/data"
import { useLocation } from "../../context/location"
import { Keymap, type KeymapCommand } from "../../context/keymap"
import { abbreviateHome } from "../../runtime"
import { activeSubagentSessionIDs } from "../../util/subagent"
import {
  activateGoal,
  confirmSessionCreation,
  parseGoalCommand,
  restoreSessionSubmission,
  retainSessionSubmission,
  submitSessionPrompt,
  type SessionSubmissionRetry,
} from "../../util/session-autonomy"
import { groupSessionShells, openBtwSession, steerBtwConclusion } from "../../util/session"
import { DialogSessionGoal } from "../dialog-session-goal"
import { ModeChips } from "./mode-chips"
import type { SessionAutonomyState } from "@ycoding-ai/client"

registerYCodingSpinner()

export type PromptProps = {
  sessionID?: string
  autonomy?: SessionAutonomyState
  onAutonomyUpdated?: (sessionID: string, state: SessionAutonomyState) => void
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

type PromptSubmissionPayload = {
  inputText: string
  goal: ReturnType<typeof parseGoalCommand>
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

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

function fadeColor(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
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

let stashed: { prompt: PromptInfo; cursor: number } | undefined

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
  const parentSessionID = createMemo(() => {
    const sessionID = props.sessionID
    if (!sessionID) return
    return data.session.get(sessionID)?.parentID ?? sessionID
  })
  const activeSubagents = createMemo(() => {
    const parentID = parentSessionID()
    if (!parentID) return 0
    return activeSubagentSessionIDs(
      data.session.subagent.list(parentID),
      data.session.family(parentID),
      parentID,
      (sessionID) => data.session.status(sessionID) === "running",
    ).length
  })
  createEffect(() => {
    const parentID = parentSessionID()
    if (!parentID || !connected()) return
    void data.session.subagent
      .sync(parentID)
      .catch((error) => console.error("Failed to load durable subagent tasks", error))
  })
  const runningShells = createMemo(() => {
    const sessionID = props.sessionID
    if (!sessionID) return 0
    return groupSessionShells(data.shell.list(), data.session.list(), sessionID).reduce(
      (count, group) => count + group.shells.length,
      0,
    )
  })
  const history = usePromptHistory()
  const stash = usePromptStash()
  const keymap = Keymap.use()
  const agentShortcut = Keymap.useShortcut("agent.cycle")
  const paletteShortcut = Keymap.useShortcut("command.palette.show")
  const liveWorkShortcut = Keymap.useShortcut("session.child.first")
  const renderer = useRenderer()
  const exit = useExit()
  const dimensions = useTerminalDimensions()
  const { themeV2, syntax } = useTheme()
  const animationsEnabled = createMemo(() => config.animations ?? true)
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const fileContextEnabled = createMemo(() => config.prompt?.editor ?? true)
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const editorPath = createMemo(() => editorContext()?.filePath)
  const editorSelectionLabel = createMemo(() => {
    const ranges = editorContext()?.ranges
    if (!ranges) return
    const first = ranges.find(hasEditorRangeSelection) ?? ranges[0]
    if (!first) return
    return [getEditorRangeLabel(first), ranges.length > 1 ? `+${ranges.length - 1}` : undefined]
      .filter(Boolean)
      .join(" ")
  })
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })
  const editorContextLabelState = createMemo(() => editor.labelState())
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const [retry, setRetry] = createSignal<SessionSubmissionRetry<PromptSubmissionPayload>>()
  const [retryRestored, setRetryRestored] = createSignal(false)
  const move = usePromptMove({
    projectID: () =>
      (props.sessionID ? data.session.get(props.sessionID)?.projectID : undefined) ?? data.location.info()?.project.id,
    sessionID: () => props.sessionID,
  })
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
  const currentProviderLabel = createMemo(() => local.model.parsed().provider)
  const hasRightContent = createMemo(() => Boolean(props.right))

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

  const subagentStatusLabel = createMemo(() => {
    const agents = activeSubagents()
    if (!agents) return undefined
    return `${agents} subagent${agents === 1 ? "" : "s"}`
  })
  const shellStatusLabel = createMemo(() => {
    const shells = runningShells()
    if (!shells) return undefined
    return `${shells} shell${shells === 1 ? "" : "s"}`
  })
  const liveWorkStatusVisible = createMemo(() => Boolean(subagentStatusLabel() || shellStatusLabel()))

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
    const agent = session.agent && agents.find((agent) => agent.id === session.agent)
    if (agent && !args.agent) local.agent.set(agent.id)
    if (session.model) {
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
          const content = await clipboard.read?.()
          if (content?.mime.startsWith("image/")) {
            await pasteAttachment({
              filename: "clipboard",
              uri: `data:${content.mime};base64,${content.data}`,
            })
            return
          }
          if (content?.mime === "text/plain") {
            await pasteInputText(content.data)
          }
        },
      },
      {
        title: "Interrupt session",
        name: "session.interrupt",
        category: "Session",
        palette: undefined,
        enabled: status() === "running",
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
                  (error) => toast.show({ title: "Failed to open BTW", message: errorMessage(error), variant: "error" }),
                )
              }}
            />
          ))
        },
      },
      {
        title: "Send to parent",
        name: "session.btw.send",
        category: "Session",
        enabled: data.session.get(props.sessionID ?? "")?.agent === "btw",
        palette: data.session.get(props.sessionID ?? "")?.agent === "btw",
        slash: { name: "btw-send", arguments: true as const },
        run: async (text: string | undefined) => {
          const session = data.session.get(props.sessionID ?? "")
          if (session?.agent !== "btw" || !session.parentID) return
          if (!text?.trim()) {
            toast.show({ message: "A conclusion is required", variant: "error" })
            return
          }
          const error = await steerBtwConclusion({ api: client.api.session, parentID: session.parentID, text }).then(
            () => undefined,
            (error) => error,
          )
          if (error) {
            toast.show({ title: "Failed to send to parent", message: errorMessage(error), variant: "error" })
            return
          }
          toast.show({ message: "Sent to parent session", variant: "success", duration: 3000 })
        },
      },
      {
        title: "Set autonomous goal",
        name: "session.autonomy.goal",
        category: "Session",
        palette: props.sessionID !== undefined,
        slash: { name: "goal", arguments: true as const },
        run: () => {
          const sessionID = props.sessionID
          if (!sessionID) return
          dialog.replace(() => (
            <DialogSessionGoal
              sessionID={sessionID}
              currentGoal={props.autonomy?.goal?.text}
              onUpdated={(state) => props.onAutonomyUpdated?.(sessionID, state)}
            />
          ))
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
    const saved = stashed
    stashed = undefined
    if (store.prompt.text) return
    if (saved && saved.prompt.text) {
      input.setText(saved.prompt.text)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromPrompt(saved.prompt)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    if (store.prompt.text) {
      stashed = { prompt: unwrap(store.prompt), cursor: input.cursorOffset }
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

  function syncExtmarksWithPromptParts() {
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
                setRetryRestored(true)
                dialog.clear()
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
    if (submitting) return false
    submitting = true
    try {
      return await submitInner()
    } finally {
      submitting = false
    }
  }

  async function submitInner() {
    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.text) {
      setStore("prompt", "text", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (props.disabled) return false
    if (move.creating()) return false
    if (auto()?.visible) return false
    if (!store.prompt.text) return false
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
    const retained = retry()
    if (retained && JSON.stringify(currentHistory) !== JSON.stringify(retained.payload.history)) {
      toast.show({
        message: "Run Retry previous submission; current draft will be preserved in stash",
        variant: "error",
        duration: 5000,
      })
      return false
    }
    const goal = parseGoalCommand(inputText)
    if (goal && !goal.goal) {
      toast.show({ message: "A goal is required", variant: "error" })
      return false
    }
    const slash = argumentSlash(inputText, keymapCommands())
    if (slash && !goal) {
      if (slash.command.id !== "session.btw") clearPrompt()
      await slash.command.run(slash.input)
      return true
    }
    const agent = local.agent.current()
    if (!agent) return false
    const selectedModel = local.model.current()
    if (!selectedModel) {
      void promptModelWarning()
      return false
    }

    const variant = local.model.variant.current()
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
      goal,
      files: promptFiles,
      agents: promptAgents,
      metadata,
      mode: store.mode,
      agentID: agent.id,
      model: {
        providerID: selectedModel.providerID,
        id: selectedModel.modelID,
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
    const key = JSON.stringify({
      sessionID: props.sessionID,
      text: payload.inputText,
      files: payload.files ?? [],
      agents: payload.agents ?? [],
      skills: payload.metadata?.skills ?? [],
      mode: payload.mode,
      agent: payload.agentID,
      model: payload.model,
      editor: payload.editor?.key,
    })
    const restoredRetry =
      retryRestored() && retained && JSON.stringify(payload.history) === JSON.stringify(retained.payload.history)
    const submission = restoredRetry
      ? retained
      : retainSessionSubmission(retained, key, metadata?.skills.length ?? 0, payload, props.sessionID)
    if (!restoredRetry && submission.key !== key) {
      toast.show({
        message: "Run Retry previous submission; current draft will be preserved in stash",
        variant: "error",
        duration: 5000,
      })
      return false
    }
    setRetry(submission)
    const sessionID = submission.sessionID
    let session = data.session.get(sessionID)
    let finishMoveProgress = false
    if (!submission.creationConfirmed) {
      const directory = await move.getDirectory()
      if (move.pending() && !directory) return false
      finishMoveProgress = Boolean(move.progress())
      const location = data.location.default()

      const created = await confirmSessionCreation(submission, (id) =>
        client.api.session.create({
          id,
          location: directory ? { directory } : location,
          agent: submission.payload.agentID,
          model: submission.payload.model,
        }),
      ).catch(() => undefined)

      if (!created) {
        if (finishMoveProgress) move.finishSubmit()
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

    if (submission.payload.goal) {
      move.startSubmit()
      const result = await activateGoal({
        sessionID,
        id: submission.promptID,
        goal: submission.payload.goal.goal,
        get: () => client.api.session.autonomy.get({ sessionID }),
        set: (payload) => client.api.session.autonomy.set({ sessionID, payload }),
        prompt: (input) => client.api.session.prompt(input),
      }).then(
        (state) => ({ state }),
        (error) => ({ error }),
      )
      if ("error" in result) {
        toast.show({
          title: "Failed to set goal",
          message: errorMessage(result.error),
          variant: "error",
        })
        return false
      }
      props.onAutonomyUpdated?.(sessionID, result.state)
      toast.show({
        message: "Goal mode activated",
        variant: "success",
        duration: 3000,
      })
    } else if (submission.payload.mode === "shell") {
      move.startSubmit()
      void client.api.session.shell({
        sessionID,
        command: submission.payload.inputText,
      })
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

      void client.api.session
        .command({
          sessionID,
          command: command.slice(1),
          arguments: args,
          agent: submission.payload.agentID,
          model: submission.payload.model,
          files: submission.payload.files,
          agents: submission.payload.agents,
        })
        .catch((error) => {
          toast.show({
            title: "Failed to run command",
            message: errorMessage(error),
            variant: "error",
          })
        })
    } else if (
      submission.payload.inputText.startsWith("/") &&
      (data.location.skill.list(currentLocation.current) ?? []).some(
        (skill) =>
          skill.slash === true && skill.id === submission.payload.inputText.split("\n")[0].split(" ")[0].slice(1),
      )
    ) {
      move.startSubmit()
      void client.api.session.skill({
        sessionID,
        skill: submission.payload.inputText.split("\n")[0].split(" ")[0].slice(1),
      })
    } else {
      move.startSubmit()
      if (!session) {
        await data.session.sync(sessionID)
        session = data.session.get(sessionID)
      }
      if (session?.agent !== submission.payload.agentID) {
        await client.api.session.switchAgent({
          sessionID,
          agent: submission.payload.agentID,
        })
      }
      if (
        session?.model?.providerID !== submission.payload.model.providerID ||
        session.model.id !== submission.payload.model.id ||
        (session.model.variant ?? "default") !== (submission.payload.model.variant ?? "default")
      ) {
        await client.api.session.switchModel({
          sessionID,
          model: submission.payload.model,
        })
      }
      if (session?.revert) {
        const error = await client.api.session.revert.commit({ sessionID }).then(
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
        const error = await client.api.session
          .synthetic({
            id: submission.syntheticID,
            sessionID,
            text: pendingEditorSelection.text,
            resume: false,
          })
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
      const prompt = (resume: boolean) =>
        client.api.session.prompt({
          id: submission.promptID,
          sessionID,
          text: submission.payload.inputText,
          files: submission.payload.files,
          agents: submission.payload.agents,
          metadata: submission.payload.metadata,
          resume,
        })
      const error = await submitSessionPrompt({
        prompt,
        skills: (submission.payload.metadata?.skills ?? []).map(
          (skill, index) => () =>
            client.api.session.skill({
              id: submission.skillIDs[index],
              sessionID,
              skill: skill.id,
              resume: false,
            }),
        ),
      }).then(
        () => undefined,
        (error) => error,
      )
      if (error) {
        toast.show({
          title: "Failed to send prompt or activate skill",
          message: errorMessage(error),
          variant: "error",
        })
        return false
      }
      if (pendingEditorSelection) editor.markSelectionSent()
    }
    history.append({
      ...submission.payload.history,
      mode: currentMode,
    })
    setRetry(undefined)
    setRetryRestored(false)
    input.extmarks.clear()
    setStore("prompt", emptyPrompt())
    setStore("extmarkToPart", new Map())
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
    input.clear()
    if (finishMoveProgress) move.finishSubmit()
    return true
  }

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + promptOffsetWidth(virtualText)

    input.insertText(virtualText + " ")

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
    const filepath = pastedFilepath(pastedContent, terminalEnvironment.platform)
    const isUrl = /^(https?):\/\//.test(filepath)
    if (!isUrl) {
      const attachment = await readLocalAttachment(filepath)
      const filename = path.basename(filepath)
      if (attachment?.type === "text") {
        pasteText(attachment.content, `[SVG: ${filename ?? "image"}]`)
        return
      }
      if (attachment?.type === "binary") {
        await pasteAttachment({
          filename,
          uri: `data:${attachment.mime};base64,${Buffer.from(attachment.content).toString("base64")}`,
        })
        return
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

  async function pasteAttachment(file: { filename?: string; uri: string }) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const pdf = file.uri.startsWith("data:application/pdf;")
    const prefix = pdf ? "data:application/pdf;" : "data:image/"
    const count = store.prompt.files?.filter((attachment) => attachment.uri.startsWith(prefix)).length ?? 0
    const virtualText = pdf ? `[PDF ${count + 1}]` : `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

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
    return
  }

  function clearPrompt() {
    if (
      store.prompt.text.trim().length >= DRAFT_RETENTION_MIN_CHARS ||
      store.prompt.pasted.length > 0 ||
      (store.prompt.files?.length ?? 0) > 0 ||
      (store.prompt.agents?.length ?? 0) > 0
    ) {
      history.append({
        ...store.prompt,
        mode: store.mode,
      })
    }
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
    return local.agent.color(agent.id)
  })

  const showVariant = createMemo(() => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return false
    const current = local.model.variant.current()
    return !!current
  })

  const agentMetaAlpha = createFadeIn(() => !!local.agent.current(), animationsEnabled)
  const modelMetaAlpha = createFadeIn(() => !!local.agent.current() && store.mode === "normal", animationsEnabled)
  const variantMetaAlpha = createFadeIn(
    () => !!local.agent.current() && store.mode === "normal" && showVariant(),
    animationsEnabled,
  )
  const borderHighlight = createMemo(() => tint(themeV2.border.default, highlight(), agentMetaAlpha()))

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false) return undefined
    if (store.mode === "shell") {
      if (!shell().length) return undefined
      const example = shell()[store.placeholder % shell().length]
      return `Run a command... "${example}"`
    }
    if (!list().length) return undefined
    return `Ask anything... "${list()[store.placeholder % list().length]}"`
  })
  const locationLabel = createMemo(() => {
    if (!props.sessionID || status() !== "idle") return
    const directory = data.session.get(props.sessionID)?.location.directory
    return directory ? abbreviateHome(directory, paths.home) : undefined
  })

  const spinnerDef = createMemo(() => {
    const agent = status() === "running" ? local.agent.current() : local.agent.current()
    const color = agent ? local.agent.color(agent.id) : themeV2.border.default
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })
  const maxHeight = createMemo(() => Math.max(6, Math.floor(dimensions().height / 3)))

  const promptBg = createMemo(() => themeV2.raise(themeV2.background.surface.offset))

  return (
    <>
      <box ref={(r: BoxRenderable) => (anchor = r)} visible={props.visible !== false} width="100%">
        <box
          width="100%"
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={promptBg()}
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
              maxHeight={maxHeight()}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "text", value)
                auto()?.onInput(value)
                syncExtmarksWithPromptParts()
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
                // hangul) is flushed to plainText before we read it for submission.
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
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <Show when={local.agent.current()} fallback={<box height={1} />}>
                  {(agent) => (
                    <>
                      <text fg={fadeColor(highlight(), agentMetaAlpha())}>
                        {store.mode === "shell" ? "Shell" : Locale.titlecase(agent().id)}
                      </text>
                      <Show when={store.mode === "normal" && local.permission.mode === "auto"}>
                        <text fg={fadeColor(themeV2.text.subdued, agentMetaAlpha())}>auto</text>
                      </Show>
                      <Show when={store.mode === "normal"}>
                        <box flexDirection="row" gap={1}>
                          <text fg={fadeColor(themeV2.text.subdued, modelMetaAlpha())}>·</text>
                          <text
                            flexShrink={0}
                            fg={fadeColor(leader() ? themeV2.text.subdued : themeV2.text.default, modelMetaAlpha())}
                          >
                            {local.model.parsed().model}
                          </text>
                          <text fg={fadeColor(themeV2.text.subdued, modelMetaAlpha())}>{currentProviderLabel()}</text>
                          <Show when={showVariant()}>
                            <text fg={fadeColor(themeV2.text.subdued, variantMetaAlpha())}>·</text>
                            <text>
                              <span
                                style={{
                                  fg: fadeColor(themeV2.text.feedback.warning.default, variantMetaAlpha()),
                                  bold: true,
                                }}
                              >
                                {local.model.variant.current()}
                              </span>
                            </text>
                          </Show>
                        </box>
                      </Show>
                    </>
                  )}
                </Show>
              </box>
              <Show when={hasRightContent()}>
                <box flexDirection="row" gap={1} alignItems="center">
                  {props.right}
                </box>
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: promptBg().a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={promptBg()}
            customBorderChars={
              promptBg().a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
          <box flexGrow={1} flexShrink={1} minWidth={0}>
            <Switch>
              <Match when={status() === "running"}>
                <box flexDirection="row" gap={1} flexGrow={1} justifyContent="flex-start">
                  <box marginLeft={1}>
                    <Show when={config.animations ?? true} fallback={<text fg={themeV2.text.subdued}>[⋯]</text>}>
                      <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                    </Show>
                  </box>
                  <text
                    fg={store.interrupt > 0 ? themeV2.background.action.primary.default : themeV2.text.default}
                    wrapMode="none"
                    truncate
                    flexShrink={1}
                  >
                    esc{" "}
                    <span
                      style={{
                        fg: store.interrupt > 0 ? themeV2.background.action.primary.default : themeV2.text.subdued,
                      }}
                    >
                      {store.interrupt > 0 ? "again to interrupt" : "interrupt"}
                    </span>
                  </text>
                </box>
              </Match>
              <Match when={move.progress()}>
                {(progress) => (
                  <box paddingLeft={3} height={1} minHeight={0} flexShrink={1}>
                    <Spinner color={themeV2.hue.accent[500]}>
                      {progress()}
                      <span style={{ fg: themeV2.text.subdued }}>{".".repeat(move.creatingDots())}</span>
                    </Spinner>
                  </box>
                )}
              </Match>
              <Match when={move.pendingNew()}>
                <box paddingLeft={3} height={1} minHeight={0} flexShrink={1}>
                  <text fg={themeV2.hue.accent[500]} wrapMode="none" truncate>
                    (new working copy)
                  </text>
                </box>
              </Match>
              <Match when={true}>
                <Show when={!props.hint && locationLabel()} fallback={props.hint ?? <text />}>
                  {(location) => (
                    <text fg={themeV2.text.subdued} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
                      {location()}
                    </text>
                  )}
                </Show>
              </Match>
            </Switch>
          </box>
          <Show when={editorContextLabelState() !== "none" ? editorFileLabelDisplay() : undefined}>
            {(file) => (
              <text
                wrapMode="none"
                truncate
                flexShrink={1}
                fg={editorContextLabelState() === "pending" ? themeV2.hue.accent[500] : themeV2.text.subdued}
              >
                {file()}
              </text>
            )}
          </Show>
          <Switch>
            <Match when={store.mode === "normal"}>
              <ModeChips autonomy={props.autonomy} />
              <Switch>
                <Match when={liveWorkStatusVisible()}>
                  <text fg={themeV2.text.subdued} wrapMode="none" truncate flexShrink={1}>
                    <Show when={liveWorkStatusVisible() && liveWorkShortcut()}>
                      {(shortcut) => <span style={{ fg: themeV2.text.default }}>{shortcut()} </span>}
                    </Show>
                    <Show when={subagentStatusLabel()}>
                      {(label) => <span style={{ fg: themeV2.text.subdued }}>{label()}</span>}
                    </Show>
                    <Show when={subagentStatusLabel() && shellStatusLabel()}>
                      <span style={{ fg: themeV2.text.subdued }}> · </span>
                    </Show>
                    <Show when={shellStatusLabel()}>
                      {(label) => <span style={{ fg: themeV2.text.subdued }}>{label()}</span>}
                    </Show>
                  </text>
                </Match>
                <Match when={true}>
                  <text fg={themeV2.text.default} flexShrink={0}>
                    {agentShortcut()} <span style={{ fg: themeV2.text.subdued }}>agents</span>
                  </text>
                </Match>
              </Switch>
              <text fg={themeV2.text.default} flexShrink={0}>
                {paletteShortcut()} <span style={{ fg: themeV2.text.subdued }}>commands</span>
              </text>
            </Match>
            <Match when={store.mode === "shell"}>
              <text fg={themeV2.text.default} flexShrink={0}>
                esc <span style={{ fg: themeV2.text.subdued }}>exit shell mode</span>
              </text>
            </Match>
          </Switch>
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
