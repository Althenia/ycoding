import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  useContext,
} from "solid-js"
import path from "node:path"
import { EOL, tmpdir } from "node:os"
import { mkdir, writeFile } from "node:fs/promises"
import { useRoute, useRouteData } from "../../context/route"
import { createStore } from "solid-js/store"
import {
  sessionMemoryLines,
  useData,
  type DataSessionCompactionLifecycle,
  type DataSessionMemoryEstimate,
} from "../../context/data"
import { SplitBorder } from "../../ui/border"
import { DialogSelect } from "../../ui/dialog-select"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { Spinner, SPINNER_FRAMES } from "../../component/spinner"
import { ThemeContext, useTheme } from "../../context/theme"
import { BoxRenderable, ScrollBoxRenderable, addDefaultParsers, TextAttributes, RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import type {
  ModelInfo,
  SessionEventFileChangeInfo,
  SessionMessageInfo,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageUser,
  SessionInfo,
  SessionAutonomyState,
} from "@ycoding-ai/client"
import { useLocal } from "../../context/local"
import { Locale } from "../../util/locale"
import { contextCompositionBar } from "../../util/provider-usage"
import { FilePath } from "../../ui/file-path"
import {
  canonicalToolName,
  finiteNumber,
  primitiveInputSummary,
  toolDisplayMetadata,
  webSearchProviderLabel,
} from "../../util/tool-display"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useClient } from "../../context/client"
import { useEditorContext } from "../../context/editor"
import { openEditor } from "../../editor"
import { useDialog } from "../../ui/dialog"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { DialogSessionSkills } from "../../component/dialog-session-skills"
import { DialogSessionTerminals } from "../../component/dialog-session-terminals"
import { SessionIsolatedBrowserCommand } from "../../component/dialog-session-browser"
import { DialogProjectArtifacts } from "../../component/dialog-project-artifacts"
import { DialogMessage } from "./dialog-message"
import { DialogFork } from "./dialog-fork"
import { DialogTimeline } from "./dialog-timeline"
import { Sidebar } from "./sidebar"
import { Composer } from "./composer"
import { Footer } from "./footer"
import { ProviderUsageCommand } from "./provider-usage"
import {
  hydrateSubagentPage,
  navigateSubagentSibling,
  subagentEconomics,
  subagentSiblingEconomics,
  SubagentFooter,
} from "./subagent-footer"
import { SubagentSiblingSwitcher } from "./subagent-sibling-switcher"
import { SubagentEconomicsSurface } from "./subagent-economics"
import { SubagentAnswerComposer, SubagentBlockedSurface } from "./subagent-blocked"
import { filetype } from "../../util/filetype"
import parsers from "../../parsers-config"
import { errorMessage } from "../../util/error"
import { useToast } from "../../ui/toast"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { projectedPromptInput } from "../../prompt/codec"
import { useEpilogue } from "../../context/epilogue"
import { normalizePath } from "../../util/path"
import { PermissionPrompt } from "./permission"
import { GuardrailPrompt } from "./guardrail"
import { FormPrompt } from "./form"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { DialogExportResult } from "../../ui/dialog-export-result"
import { sessionEpilogue } from "../../util/presentation"
import { useConfig } from "../../config"
import { useClipboard } from "../../context/clipboard"
import { nextThinkingMode, reasoningSummary, type ThinkingMode } from "../../context/thinking"
import { getScrollAcceleration } from "../../util/scroll"
import { collapseToolOutput, toolOutputBudget, toolOutputDisplay } from "../../util/collapse-tool-output"
import { usePluginRuntime } from "../../plugin/runtime"
import { PluginSlot } from "../../plugin/context"
import { Keymap, type KeymapCommand } from "../../context/keymap"
import { usePathFormatter } from "../../context/path-format"
import { useLocation } from "../../context/location"
import {
  compactionMessageTranscriptVisible,
  compactionTranscriptVisible,
  createSessionRows,
  messageBoundaryIDs,
  resolveMessageJump,
  resolvePart,
  type PartRef,
  type SessionRow,
} from "./rows"
import { switchLabel } from "../../util/model"
import { findMessageBoundary, messageNavigationSlack } from "./message-navigation"
import { noticeSummary } from "./notice-summary"
import { stringWidth } from "../../util/string-width"
import {
  autonomyModeLabel,
  createSessionAutonomyRefreshGuard,
  currentSessionAutonomy,
  type SessionAutonomyResponse,
  yoloLevel,
} from "../../util/session-autonomy"
import { promptSkillsFromMetadata, segmentPromptSkills } from "../../prompt/skill"
import { sessionSkillContent } from "../../util/session-skills"
import { Header, sessionRetryHeaderState, type SessionHeaderOperationalState, type SessionHeaderState } from "./header"
import { railPlacement, railWidth } from "./rail"
import { InlineDiff, inlineDiffGroups, parseInlineDiff, type InlineDiffFile, type InlineDiffGroup } from "./inline-diff"
import { parseInlineCommandResult, type InlineCommandResult } from "./inline-command"
import {
  SessionActivityRow,
  SessionActivitySpacer,
  SessionToolActivityRow,
  ToolLifecycleStatus,
  toolLifecyclePresentation,
  type ToolLifecycleInput,
} from "./activity-row"

addDefaultParsers(parsers.parsers)

// Exclude temporary bottom space when measuring the real transcript height.
const NAVIGATION_SLACK_ID = "session-navigation-slack"

function SessionLoading() {
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()
  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      position="absolute"
      top={0}
      left={0}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      backgroundColor={themeV2.background.default}
    >
      <box width={62} maxWidth="90%" flexDirection="column" alignItems="center" gap={1}>
        <Spinner color={themeV2.text.subdued}>Waiting for server...</Spinner>
        <text fg={themeV2.text.subdued}>Loading session...</text>
      </box>
    </box>
  )
}

const context = createContext<{
  width: number
  sessionID: string
  thinkingMode: () => ThinkingMode
  showThinking: () => boolean
  groupExploration: () => boolean
  diffWrapMode: () => "word" | "none"
  models: () => ModelInfo[]
  config: ReturnType<typeof useConfig>["data"]
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

export type SessionViewportState = {
  scrollTop: number
  follow: boolean
  navigationMessage?: string
  navigationSlack: number
}

export type SessionViewportStore = Map<string, SessionViewportState>

export function Session(props: { viewports?: SessionViewportStore } = {}) {
  const setEpilogue = useEpilogue()
  const clipboard = useClipboard()
  const writeExport = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  const pluginRuntime = usePluginRuntime()
  const route = useRouteData("session")
  const mountedSessionID = route.sessionID
  const { navigate } = useRoute()
  const data = useData()
  const local = useLocal()
  const paths = useTuiPaths()
  const configState = useConfig()
  const config = configState.data
  const { themeV2 } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => data.session.get(route.sessionID))
  const messages = () => data.session.message.list(route.sessionID)
  const [capturedChildIDs, setCapturedChildIDs] = createSignal<string[]>([])
  let capturedChangesGeneration = 0
  const capturedChanges = createMemo(() =>
    capturedChangeFiles([
      ...messages(),
      ...capturedChildIDs().flatMap((sessionID) => data.session.message.list(sessionID)),
    ]),
  )
  const durableCapturedChanges = createMemo(() => {
    const compacted = messages().some((message) => message.type === "compaction" && message.status === "completed")
    const completedAssistant = messages().some((message) => message.type === "assistant" && message.time.completed)
    if (!compacted || completedAssistant) return []
    return durableCapturedChangeFiles(data.session.fileChange.list(route.sessionID))
  })
  const location = createMemo(() => session()?.location)
  const currentLocation = useLocation()

  createEffect(() => currentLocation.set(location()))

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    setEpilogue(sessionEpilogue({ title, sessionID: session()?.id }))
  })
  onCleanup(() => setEpilogue())
  const descendantSessionIDs = createMemo(() => {
    if (session()?.parentID) return []
    return data.session.family(route.sessionID).filter((id) => id !== route.sessionID)
  })
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return [route.sessionID, ...descendantSessionIDs()].flatMap(
      (sessionID) => data.session.permission.list(sessionID) ?? [],
    )
  })
  const guardrails = createMemo(() => {
    if (session()?.parentID) return []
    return data.session.guardrail.list(route.sessionID)
  })
  const [guardrailReview, setGuardrailReview] = createSignal<string>()
  const reviewingGuardrail = createMemo(() => guardrails().find((request) => request.id === guardrailReview()))
  createEffect(() => {
    if (guardrailReview() && !reviewingGuardrail()) setGuardrailReview(undefined)
  })
  const forms = createMemo(() => {
    const global = data.session.form.list("global", location()) ?? []
    if (session()?.parentID) return global
    return [route.sessionID, ...descendantSessionIDs()]
      .flatMap((sessionID) => data.session.form.list(sessionID) ?? [])
      .concat(global)
  })
  const [composer, setComposer] = createStore({
    open: false,
    tab: undefined as string | undefined,
  })
  const disabled = createMemo(() => permissions().length > 0 || forms().length > 0)

  createEffect(() => {
    if (disabled() && composer.open) setComposer("open", false)
  })

  const blockedReason = createMemo(() => {
    if (reviewingGuardrail()) return "Composer paused: guardrail review"
    if (permissions().length > 0) return "Composer paused: permission review"
    if (forms().length > 0) return "Composer paused: form input"
    return undefined
  })
  const queuedPending = createMemo(() => data.session.pending.list(route.sessionID))
  const runningShells = createMemo(() => {
    const target = location()
    if (!target) return 0
    return data.shell.list(target).filter((shell) => shell.status === "running").length
  })
  const queuedNotice = createMemo(() => {
    const count = queuedPending().length
    if (count === 0) return undefined
    if (data.session.status(route.sessionID) !== "idle" && runningShells() === 0) return undefined
    return runningShells() > 0
      ? `Queued: ${count} prompt${count === 1 ? "" : "s"} waiting on running shell`
      : `Queued: ${count} prompt${count === 1 ? "" : "s"} waiting`
  })

  const pending = createMemo(() => {
    const completed = messages().findLast((x) => x.type === "assistant" && x.time.completed)?.id
    return messages().findLast((x) => x.type === "assistant" && !x.time.completed && (!completed || x.id > completed))
      ?.id
  })
  const dimensions = useTerminalDimensions()
  const sidebar = createMemo(() => config.session?.sidebar ?? "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const thinkingMode = createMemo<ThinkingMode>(() => config.session?.thinking ?? "show")
  const showThinking = createMemo(() => true)
  const showScrollbar = createMemo(() => config.session?.scrollbar ?? false)
  const diffWrapMode = createMemo(() => config.diffs?.wrap ?? "word")
  const groupExploration = createMemo(() => config.session?.grouping !== "none")

  const wide = createMemo(() => railPlacement(dimensions().width) === "docked")
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? railWidth(dimensions().width) : 0) - 4)
  const models = createMemo(() => data.location.model.list(location()) ?? [])

  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))
  const toast = useToast()
  const client = useClient()
  const [sessionMessagesSynced, setSessionMessagesSynced] = createSignal(false)
  createEffect(() => {
    const sid = route.sessionID
    const status = client.connection.status()
    if (status !== "connected") {
      setSessionMessagesSynced(false)
      return
    }
    setSessionMessagesSynced(false)
    void data.session.message.sync(sid)
      .then(() => {
        if (route.sessionID === sid && client.connection.status() === "connected") setSessionMessagesSynced(true)
      })
      .catch(() => undefined)
  })
  const sessionReady = createMemo(() => {
    const s = data.session.get(route.sessionID)
    if (!s) return false
    const msgs = data.session.message.list(route.sessionID)
    if (msgs === undefined) return false
    if (!sessionMessagesSynced()) return false
    const locReady = !!data.location.info(s.location)
    if (!locReady) return false
    if (client.connection.status() !== "connected") return false
    return true
  })
  const [branch, setBranch] = createSignal<string>()
  createEffect(
    on([location, () => client.connection.status()], ([target, status]) => {
      setBranch()
      if (!target || status !== "connected") return
      void client.api.vcs
        .branch({ location: target })
        .then((response) => {
          if (location() !== target) return
          setBranch(response.data.current)
        })
        .catch(() => undefined)
    }),
  )
  const [autonomyResponse, setAutonomyResponse] = createSignal<SessionAutonomyResponse>()
  const autonomyRefresh = createSessionAutonomyRefreshGuard()
  const autonomy = createMemo(() =>
    currentSessionAutonomy(route.sessionID, client.connection.status() === "connected", autonomyResponse()),
  )
  const acceptAutonomy = (sessionID: string, state: SessionAutonomyState) => {
    if (route.sessionID !== sessionID || client.connection.status() !== "connected") return false
    setAutonomyResponse({ sessionID, state })
    return true
  }
  const updateAutonomy = (input: { yolo?: number; goal?: string | null; maxNoProgress?: number }) => {
    const sessionID = route.sessionID
    autonomyRefresh.invalidate()
    const payload = (() => {
      if (input.yolo !== undefined && input.goal !== undefined)
        return { yolo: input.yolo, goal: input.goal, ...(input.maxNoProgress !== undefined ? { maxNoProgress: input.maxNoProgress } : {}) } as const
      if (input.yolo !== undefined) return { yolo: input.yolo } as const
      if (input.goal !== undefined) return { goal: input.goal, ...(input.maxNoProgress !== undefined ? { maxNoProgress: input.maxNoProgress } : {}) } as const
      return undefined
    })()
    if (!payload) return
    void client.api.session.autonomy
      .set({ sessionID, payload } as never)
      .then((state) => {
        if (!acceptAutonomy(sessionID, state)) return
        toast.show({ message: `${autonomyModeLabel(state)} mode activated`, variant: "success", duration: 3000 })
        dialog.clear()
      })
      .catch((error) =>
        toast.show({
          message: `Failed to change session mode: ${errorMessage(error)}`,
          variant: "error",
          duration: 5000,
        }),
      )
  }
  const refreshAutonomy = (sessionID: string) => {
    const request = autonomyRefresh.refresh()
    void client.api.session.autonomy
      .get({ sessionID })
      .then((state) => {
        if (!autonomyRefresh.accepts(request)) return
        acceptAutonomy(sessionID, state)
      })
      .catch(() => undefined)
  }
  createEffect(
    on([() => route.sessionID, () => client.connection.status()], ([sessionID, status]) => {
      setAutonomyResponse(undefined)
      if (status !== "connected") return
      refreshAutonomy(sessionID)
    }),
  )
  // Goal iteration, no-progress count, and status advance on the server when a turn settles, and no
  // event carries them. The server scores the turn just before it publishes the execution terminal,
  // so that terminal is the earliest point where a re-read sees the current iteration and the final
  // status; keying this off the assistant message instead reads the run one iteration stale and
  // leaves a finished goal reporting goal mode forever.
  const settledAutonomy = (event: { data: { sessionID: string } }) => {
    if (event.data.sessionID !== route.sessionID) return
    if (client.connection.status() !== "connected") return
    refreshAutonomy(route.sessionID)
  }
  const autonomySubscriptions = [
    data.on("session.execution.succeeded", settledAutonomy),
    data.on("session.execution.failed", settledAutonomy),
    data.on("session.execution.interrupted", settledAutonomy),
  ]
  onCleanup(() => autonomySubscriptions.forEach((unsubscribe) => unsubscribe()))
  const operationalHeaderState = createMemo<SessionHeaderOperationalState>(() => {
    const lastAssistant = messages().findLast((item): item is SessionMessageAssistant => item.type === "assistant")
    const retry = sessionRetryHeaderState(lastAssistant)
    if (retry) return retry
    const parentID = session()?.parentID
    const child = parentID
      ? data.session.subagent.page(parentID)?.data.find((task) => task.sessionID === route.sessionID)
      : undefined
    if (child?.state === "waiting" && child.question)
      return {
        type: "awaiting-input",
        count: 1,
        elapsed: session() ? (Date.now() - session()!.time.created) / 1000 : undefined,
      } as const
    const message = messages().findLast((item) => item.type === "assistant" && !item.time.completed)
    if (message?.type === "assistant") {
      const tool = message.content.find(
        (part) => part.type === "tool" && (part.state.status === "streaming" || part.state.status === "running"),
      )
      if (tool?.type === "tool") return { type: "tool-running", startedAt: tool.time.created } as const
      if (message.content.some((part) => part.type === "reasoning"))
        return { type: "thinking", startedAt: message.time.created } as const
      return { type: "working", startedAt: message.time.created } as const
    }
    // Durable execution status is the only truth about a running Session. Deriving readiness from
    // messages alone reported "ready" while a drain worked between steps, with no open assistant
    // message, so the header invited a prompt the Session could not take yet.
    if (data.session.status(route.sessionID) === "running") return { type: "working" } as const
    const latest = messages().findLast((item) => item.type === "assistant")
    if (latest?.type === "assistant" && latest.error?.type.startsWith("provider."))
      return { type: "provider-error", message: safeProviderErrorMessage(latest.error.message) } as const
    const waiting = data.session.subagent.summary(route.sessionID)?.active ?? 0
    if (waiting) return { type: "waiting", count: waiting } as const
    return { type: "ready" } as const
  })
  const headerState = createMemo<SessionHeaderState>(() => {
    const state = operationalHeaderState()
    const raw = (autonomy() as unknown as { yolo?: unknown }).yolo
    const level = typeof raw === "number" ? raw : raw === true ? 2 : 0
    const goalActive = autonomy().goal?.status === "active"
    if (level === 0 && !goalActive) return state
    return { type: "autonomy", yolo: level, goalActive, state }
  })
  const headerMessage = createMemo(() => {
    const message = messages().findLast((item) => item.type === "assistant")
    return message?.type === "assistant" ? message : undefined
  })
  const headerModel = createMemo(() => {
    const model = session()?.model ?? headerMessage()?.model
    if (!model) return
    const info = models().find((item) => item.providerID === model.providerID && item.id === model.id)
    const name = info?.name ?? Locale.titlecase(model.id.replaceAll("-", " "))
    return `${model.providerID}/${name}`
  })
  const headerVariant = createMemo(() => session()?.model?.variant ?? headerMessage()?.model.variant)
  const pendingHeaderModel = createMemo(() => {
    const selected = local.model.current()
    if (!selected) return undefined
    const info = models().find((item) => item.providerID === selected.providerID && item.id === selected.modelID)
    const name = info?.name ?? Locale.titlecase(selected.modelID.replaceAll("-", " "))
    return `${selected.providerID}/${name}`
  })
  const pendingHeaderVariant = createMemo(() => local.model.variant.current())
  const headerAgent = createMemo(() => {
    const agent = session()?.agent ?? headerMessage()?.agent
    return agent ? Locale.titlecase(agent) : undefined
  })
  const pendingHeaderAgent = createMemo(() => {
    const agent = local.agent.current()
    return agent?.name ?? (agent ? Locale.titlecase(agent.id) : undefined)
  })
  const parentID = createMemo(() => session()?.parentID)
  const btw = createMemo(() => Boolean(session()?.parentID && session()?.agent === "btw"))
  const parent = createMemo(() => (parentID() ? data.session.get(parentID()!) : undefined))
  const siblings = createMemo(() => {
    const parent = parentID()
    if (!parent) return []
    const tasks = data.session.subagent.page(parent)?.data ?? []
    if (session()?.agent === "btw") return tasks
    // include btw child sessions created via session.create for navigation
    const btw = data.session
      .list()
      .filter((s) => s.parentID === parent && s.agent === "btw")
      .map((s) => ({ sessionID: s.id, agent: s.agent, state: "running" as const, title: s.title })) as unknown as typeof tasks
    return [...tasks, ...btw]
  })
  const currentTask = createMemo(() => siblings().find((task) => task.sessionID === route.sessionID))
  createEffect(
    on([() => session()?.id, parentID, () => client.connection.status()], ([sessionID, parent, status]) => {
      if (!sessionID || !parent || status !== "connected") return
      void hydrateSubagentPage({
        pagination: data.session.subagent,
        parentID: parent,
        currentSessionID: sessionID,
      }).catch(() => undefined)
    }),
  )
  const navigateSibling = (direction: -1 | 1) => {
    const parent = parentID()
    if (!parent) return
    void navigateSubagentSibling({
      pagination: data.session.subagent,
      parentID: parent,
      currentSessionID: route.sessionID,
      direction,
    })
      .then((sibling) => {
        if (sibling) navigate({ type: "session", sessionID: sibling })
      })
      .catch(toast.error)
  }
  const assistantIdentity = createMemo(() => {
    if (!session()?.parentID) return { label: "YCODING", subagent: false }
    if (session()?.agent === "btw") return { label: "BTW SIDE CHAT", subagent: true }
    return {
      label: `${(currentTask()?.agent ?? session()?.title ?? "Subagent").toUpperCase()} SUBAGENT`,
      subagent: true,
    }
  })
  const economics = createMemo(() =>
    subagentEconomics(session(), data.session.diagnostics.get(route.sessionID), parent()?.title),
  )
  const blockedQuestion = createMemo(() =>
    currentTask()?.state === "waiting" ? currentTask()?.question?.text : undefined,
  )
  const blockedBody = createMemo(() => {
    const message = messages().findLast((item) => item.type === "assistant")
    if (message?.type !== "assistant") return undefined
    return message.content.find((part) => part.type === "text")?.text
  })
  const blockedActivity = createMemo(() => currentTask()?.description)
  const editor = useEditorContext()
  const rows = createSessionRows(
    () => route.sessionID,
    () => {
      const raw = (autonomy() as unknown as { yolo?: unknown }).yolo
      const lvl = typeof raw === "number" ? raw : raw === true ? 2 : 0
      return !session()?.parentID && lvl === 0
    },
  )
  createEffect(
    on(
      [() => route.sessionID, () => session()?.parentID, () => client.connection.status()],
      ([sessionID, parentID, status]) => {
        const generation = ++capturedChangesGeneration
        if (parentID || status !== "connected") {
          setCapturedChildIDs([])
          return
        }
        void (async () => {
          await data.session.subagent.sync(sessionID)
          const children = await data.session.subagent.completed(sessionID)
          await Promise.all(children.map((child) => data.session.message.sync(child.sessionID)))
          if (generation === capturedChangesGeneration) setCapturedChildIDs(children.map((child) => child.sessionID))
        })().catch(() => undefined)
      },
    ),
  )
  createEffect(
    on(
      [
        () => route.sessionID,
        () => messages().some((message) => message.type === "compaction" && message.status === "completed"),
        () => messages().some((message) => message.type === "assistant" && message.time.completed),
      ],
      ([sessionID, compacted, completedAssistant]) => {
        if (!compacted || completedAssistant) return
        void data.session.fileChange.sync(sessionID).catch(() => undefined)
      },
    ),
  )
  const boundaries = createMemo(() => messageBoundaryIDs(rows, messages()))
  const MAX_MOUNTED_ROWS = 400
  const mountedRows = createMemo(() =>
    rows.length > MAX_MOUNTED_ROWS ? rows.slice(rows.length - MAX_MOUNTED_ROWS) : rows.slice(),
  )
  const mountedBoundaries = createMemo(() => {
    const all = boundaries()
    const count = mountedRows().length
    return count >= all.length ? all.slice() : all.slice(all.length - count)
  })
  const hiddenCount = createMemo(() => rows.length - mountedRows().length)
  const [navigationMessage, setNavigationMessage] = createSignal<string>()
  const [navigationSlack, setNavigationSlack] = createSignal(0)
  const [restoringViewport, setRestoringViewport] = createSignal(props.viewports?.get(mountedSessionID)?.follow === false)

  const clearMessageNavigation = () => {
    setNavigationSlack(0)
    setNavigationMessage(undefined)
  }

  createEffect(
    on(
      () => [dimensions().width, dimensions().height] as const,
      (_, previous) => {
        if (previous) clearMessageNavigation()
      },
    ),
  )

  createEffect(
    on([descendantSessionIDs, () => client.connection.status()], ([sessionIDs, status]) => {
      if (status !== "connected") return
      void Promise.all(
        sessionIDs.flatMap((sessionID) => [data.session.permission.sync(sessionID), data.session.form.sync(sessionID)]),
      )
    }),
  )

  createEffect(() => {
    if (client.connection.status() !== "connected") return
    const sessionID = route.sessionID
    void (async () => {
      await Promise.all([
        data.session.sync(sessionID),
        data.session.message.sync(sessionID),
        data.session.permission.sync(sessionID),
        data.session.guardrail.sync(sessionID),
        data.session.form.sync(sessionID),
      ])
      const info = data.session.get(sessionID)
      if (!info) {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
          duration: 5000,
        })
        navigate({ type: "home" })
        return
      }
      editor.reconnect(info.location.directory)
      restoreViewport(sessionID)
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      navigate({ type: "home" })
    })
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
  const restoreViewport = (sessionID: string) => {
    const saved = props.viewports?.get(sessionID)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (route.sessionID !== sessionID || !scroll || scroll.isDestroyed || !rows.length) return
        if (saved && !saved.follow) {
          setNavigationSlack(saved.navigationSlack)
          setNavigationMessage(saved.navigationMessage)
          scroll.scrollTo(saved.scrollTop)
          setRestoringViewport(false)
          return
        }
        clearMessageNavigation()
        scroll.scrollTo(scroll.scrollHeight)
      })
    })
  }
  onCleanup(() => {
    if (!props.viewports || !scroll || scroll.isDestroyed) return
    props.viewports.set(mountedSessionID, {
      scrollTop: scroll.scrollTop,
      follow: !navigationMessage() && scroll.scrollTop >= Math.max(0, scroll.scrollHeight - scroll.viewport.height) - 1,
      navigationMessage: navigationMessage(),
      navigationSlack: navigationSlack(),
    })
  })
  let prompt: PromptRef | undefined
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const dialog = useDialog()
  const renderer = useRenderer()
  const unavailable = (feature: string) => {
    toast.show({ message: `${feature} is not implemented for sessions yet`, variant: "error", duration: 5000 })
    dialog.clear()
  }

  const alignMessage = (messageID: string, top: number) => {
    scroll.stickyScroll = false
    setNavigationMessage(messageID)
    setNavigationSlack(
      messageNavigationSlack({
        top,
        viewportHeight: scroll.viewport.height,
        scrollHeight: scroll.scrollHeight,
        currentSlack: scroll.getRenderable(NAVIGATION_SLACK_ID)?.height ?? 0,
      }),
    )
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (scroll.isDestroyed || navigationMessage() !== messageID) return
        scroll.scrollTo(top)
      })
    })
  }

  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>, userOnly = false) => {
    const target = findMessageBoundary({
      direction,
      children: scroll.getChildren(),
      messages: messages(),
      scrollTop: scroll.scrollTop,
      viewportY: scroll.viewport.y,
      currentID: navigationMessage(),
      userOnly,
    })

    if (!target) {
      dialog.clear()
      return
    }

    alignMessage(target.id, target.top)
    dialog.clear()
  }

  const jumpToResidentMessage = (messageID: string) => {
    const child = scroll.getRenderable(messageID)
    if (!child) return false
    const y = scroll.scrollTop + child.y - scroll.viewport.y
    const message = data.session.message.get(route.sessionID, messageID)
    alignMessage(messageID, Math.max(0, y - (message?.type === "assistant" ? 1 : 0)))
    return true
  }

  const jumpToMessage = (messageID: string) => {
    void resolveMessageJump({
      resident: () => Boolean(scroll.getRenderable(messageID)),
      load: () => data.session.message.find(route.sessionID, messageID),
      settled: () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }),
      jump: () => jumpToResidentMessage(messageID),
    })
      .then((result) => {
        if (result !== "missing") return
        toast.show({
          message: "Message is no longer available. Retry timeline after history reload.",
          variant: "error",
        })
      })
      .catch((error) => toast.error(error))
  }

  function toBottom() {
    clearMessageNavigation()
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed || !rows.length) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  const globalCommands = [
    {
      id: "session.page.up",
      title: "Page up",
      group: "Session",
      palette: undefined,
      run: () => {
        clearMessageNavigation()
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      id: "session.page.down",
      title: "Page down",
      group: "Session",
      palette: undefined,
      run: () => {
        clearMessageNavigation()
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      id: "session.line.up",
      title: "Line up",
      group: "Session",
      palette: undefined,
      run: () => {
        clearMessageNavigation()
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      id: "session.line.down",
      title: "Line down",
      group: "Session",
      palette: undefined,
      run: () => {
        clearMessageNavigation()
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      id: "session.half.page.up",
      title: "Half page up",
      group: "Session",
      palette: undefined,
      run: () => {
        clearMessageNavigation()
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      id: "session.half.page.down",
      title: "Half page down",
      group: "Session",
      palette: undefined,
      run: () => {
        clearMessageNavigation()
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
  ]

  const baseAndUnfocusedCommands = [
    {
      id: "session.first",
      title: "First message",
      group: "Session",
      palette: undefined,
      run: () => {
        clearMessageNavigation()
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      id: "session.last",
      title: "Last message",
      group: "Session",
      palette: undefined,
      run: () => {
        clearMessageNavigation()
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
  ]

  const baseCommands = createMemo(() => [
    {
      title: "Share session",
      id: "session.share",
      suggested: route.type === "session",
      group: "Session",
      slash: { name: "share" },
      run: () => unavailable("Sharing"),
    },
    {
      title: "Rename session",
      id: "session.rename",
      group: "Session",
      slash: { name: "rename" },
      run: () => DialogSessionRename.show(dialog, route.sessionID, session()?.title),
    },
    {
      title: "Jump to message",
      id: "session.timeline",
      group: "Session",
      slash: { name: "timeline" },
      run: () => {
        dialog.replace(() => (
          <DialogTimeline
            sessionID={route.sessionID}
            onMove={jumpToMessage}
            setPrompt={(value) => promptRef.current?.set(value)}
          />
        ))
      },
    },
    {
      title: "Session skills",
      id: "session.skills",
      group: "Session",
      run: () => {
        dialog.replace(() => <DialogSessionSkills sessionID={route.sessionID} location={location()} />)
      },
    },
    {
      title: "Project artifacts",
      id: "project.artifacts",
      group: "Session",
      slash: { name: "artifacts" },
      run: () => {
        dialog.replace(() => <DialogProjectArtifacts location={location()} />)
      },
    },
    {
      title: "Fork session",
      id: "session.fork",
      group: "Session",
      slash: { name: "fork" },
      run: () => {
        dialog.replace(() => (
          <DialogFork
            sessionID={route.sessionID}
            onMove={(messageID) => {
              if (!messageID) return
              jumpToMessage(messageID)
            }}
          />
        ))
      },
    },
    {
      title: (() => {
        const lvl = yoloLevel(autonomy() as unknown as { yolo?: unknown })
        return `YOLO: ${lvl > 0 ? `${lvl} on` : "off"} (cycle 0→1→2→3, /yolo 0|1|2|3)`
      })(),
      id: "session.autonomy.yolo.toggle",
      group: "Session",
      slash: { name: "yolo" },
      run: (input?: string) => {
        const token = input?.trim().split(/\s+/)[0]
        const parsed = token !== undefined && token !== "" ? Number.parseInt(token, 10) : Number.NaN
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 3) {
          updateAutonomy({ yolo: parsed as 0 | 1 | 2 | 3 })
          return
        }
        const lvl = yoloLevel(autonomy() as unknown as { yolo?: unknown })
        const next = ((lvl + 1) % 4) as 0 | 1 | 2 | 3
        updateAutonomy({ yolo: next })
      },
    },
    {
      title: autonomy().goal?.status === "active" ? "Goal: on (toggle off)" : "Goal: off (toggle on)",
      id: "session.autonomy.goal.toggle",
      group: "Session",
      run: () => {
        const isActive = autonomy().goal?.status === "active"
        if (isActive) {
          updateAutonomy({ goal: null })
        } else {
          const existing = autonomy().goal?.text
          const text = existing?.trim() || "Autonomous goal"
          updateAutonomy({ goal: text })
        }
      },
    },
    {
      title: "Compact session",
      id: "session.compact",
      group: "Session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      run: () => {
        void client.api.session.compact({ sessionID: route.sessionID }).catch(toast.error)
        dialog.clear()
      },
    },
    {
      title: "Unshare session",
      id: "session.unshare",
      group: "Session",
      enabled: false,
      slash: { name: "unshare" },
      run: () => unavailable("Unsharing"),
    },
    {
      title: "Undo previous message",
      id: "session.undo",
      group: "Session",
      slash: { name: "undo" },
      run: () => {
        const boundary = session()?.revert?.messageID
        const message = messages().findLast(
          (message): message is SessionMessageUser =>
            message.type === "user" && !!message.text.trim() && (!boundary || message.id < boundary),
        )
        if (!message) {
          toast.show({ message: "Nothing to undo", variant: "error", duration: 3000 })
          dialog.clear()
          return
        }
        void client.api.session.revert
          .stage({ sessionID: route.sessionID, messageID: message.id })
          .catch((error) => toast.show({ message: errorMessage(error), variant: "error", duration: 5000 }))
        prompt?.set({
          ...projectedPromptInput(message),
          pasted: [],
        })
        dialog.clear()
      },
    },
    {
      title: "Redo",
      id: "session.redo",
      group: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: { name: "redo" },
      run: () => {
        void (async () => {
          const error = await client.api.session.revert.clear({ sessionID: route.sessionID }).then(
            () => undefined,
            (error) => error,
          )
          if (error) toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
          dialog.clear()
        })()
      },
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      id: "session.sidebar.toggle",
      group: "Session",
      run: () => {
        batch(() => {
          const isVisible = sidebarVisible()
          void configState
            .update((draft) => {
              draft.session = { ...draft.session, sidebar: isVisible ? "hide" : "auto" }
            })
            .catch(toast.error)
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: (() => {
        const next = nextThinkingMode(thinkingMode())
        if (next === "hide") return "Collapse thinking"
        return "Expand thinking"
      })(),
      id: "session.toggle.thinking",
      group: "Session",
      palette: undefined,
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      run: () => {
        void configState
          .update((draft) => {
            draft.session = { ...draft.session, thinking: nextThinkingMode(thinkingMode()) }
          })
          .catch(toast.error)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      id: "session.toggle.scrollbar",
      group: "Session",
      palette: undefined,
      run: () => {
        void configState
          .update((draft) => {
            draft.session = { ...draft.session, scrollbar: !showScrollbar() }
          })
          .catch(toast.error)
        dialog.clear()
      },
    },
    {
      title: groupExploration() ? "Show tool calls individually" : "Group related tool calls",
      id: "session.toggle.exploration_grouping",
      group: "Session",
      palette: undefined,
      run: () => {
        void configState
          .update((draft) => {
            draft.session = { ...draft.session, grouping: groupExploration() ? "none" : "auto" }
          })
          .catch(toast.error)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      id: "session.messages_last_user",
      group: "Session",
      palette: undefined,
      run: () => {
        const messages = data.session.message.list(route.sessionID)
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.type !== "user" || !message.text.trim()) continue
          {
            jumpToMessage(message.id)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      id: "session.message.next",
      group: "Session",
      palette: undefined,
      run: () => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      id: "session.message.previous",
      group: "Session",
      palette: undefined,
      run: () => scrollToMessage("prev", dialog),
    },
    {
      title: "Next user message",
      id: "session.message.user.next",
      group: "Session",
      palette: undefined,
      run: () => scrollToMessage("next", dialog, true),
    },
    {
      title: "Previous user message",
      id: "session.message.user.previous",
      group: "Session",
      palette: undefined,
      run: () => scrollToMessage("prev", dialog, true),
    },
    {
      title: "Copy last assistant message",
      id: "messages.copy",
      group: "Session",
      run: () => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg): msg is SessionMessageAssistant => msg.type === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const textParts = lastAssistantMessage.content.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        clipboard
          .write?.(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      id: "session.copy",
      group: "Session",
      slash: {
        name: "copy",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const transcript = formatSessionTranscript(sessionData, messages(), showThinking())
          await clipboard.write?.(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      id: "session.export",
      group: "Session",
      slash: {
        name: "export",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return

          const options = await DialogExportOptions.show(dialog, showThinking())

          if (options === null) return

          const content =
            options.format === "markdown"
              ? formatSessionTranscript(sessionData, messages(), options.thinking)
              : await (async () => {
                  if (options.debug) {
                    const events: { readonly created: number }[] = []
                    for await (const event of client.api.session.log({ sessionID: sessionData.id, follow: false })) {
                      if (event.type !== "log.synced") events.push(event)
                    }
                    // Durable events stay in aggregate order even when their wall-clock timestamps differ.
                    client.connection.internal.history().forEach((event) => {
                      const index = events.findIndex((item) => item.created > event.created)
                      if (index === -1) {
                        events.push(event)
                        return
                      }
                      events.splice(index, 0, event)
                    })
                    return JSON.stringify({ info: sessionData, events }, null, 2) + EOL
                  }

                  const messages = await client.api.message.list({ sessionID: sessionData.id })
                  return JSON.stringify({ info: sessionData, messages }, null, 2) + EOL
                })()

          if (options.action === "copy") {
            await clipboard.write?.(content)
            dialog.clear()
            toast.show({ message: "Copied to clipboard", variant: "success" })
            return
          }

          const filepath = path.join(
            tmpdir(),
            `session-${crypto.randomUUID()}.${options.format === "markdown" ? "md" : "json"}`,
          )
          await writeExport(filepath, content)
          await DialogExportResult.show(dialog, filepath)
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Inspect Session terminal",
      id: "session.terminal.inspect",
      group: "Session",
      enabled: !!session(),
      run: () => {
        const owner = session()
        if (!owner) return
        dialog.replace(() => <DialogSessionTerminals sessionID={owner.id} location={owner.location} />)
      },
    },
    {
      title: "Background blocking tools",
      id: "session.background",
      group: "Session",
      palette: undefined,
      run: () => {
        void client.api.session.background({ sessionID: route.sessionID })
        dialog.clear()
      },
    },
    {
      title: "Toggle subagent picker",
      id: "session.child.first",
      group: "Session",
      run: () => {
        if (disabled() || composer.open || (session()?.parentID && !btw())) {
          setComposer("open", false)
        } else {
          setComposer({ open: true, tab: "subagents" })
        }
        dialog.clear()
      },
    },
    {
      title: "Go to parent session",
      id: "session.parent",
      group: "Session",
      palette: undefined,
      enabled: !!session()?.parentID,
      run: () => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      },
    },
    {
      title: "Next subagent",
      id: "session.child.next",
      group: "Session",
      palette: undefined,
      enabled: !!session()?.parentID,
      run: () => {
        navigateSibling(1)
      },
    },
    {
      title: "Previous subagent",
      id: "session.child.previous",
      group: "Session",
      palette: undefined,
      enabled: !!session()?.parentID,
      run: () => {
        navigateSibling(-1)
      },
    },
  ])

  const commands = createMemo(() =>
    [...globalCommands, ...baseAndUnfocusedCommands, ...baseCommands()].map(
      (command) =>
        ({
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    commands: commands(),
    bindings: globalCommands.map((command) => command.id),
  }))

  Keymap.createLayer(() => ({
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: baseAndUnfocusedCommands.map((command) => command.id),
  }))

  Keymap.createLayer(() => ({
    bindings: [...baseAndUnfocusedCommands, ...baseCommands()].map((command) => command.id),
  }))

  return (
    <Show when={sessionReady()} fallback={<SessionLoading />}>
      <context.Provider
        value={{
          get width() {
            return contentWidth()
          },
          sessionID: route.sessionID,
          thinkingMode,
          showThinking,
          groupExploration,
          diffWrapMode,
          models,
          config,
        }}
      >
        <SessionMemoryCommand sessionID={route.sessionID} />
        <Show when={location()}>
          {(ownerLocation) => <SessionIsolatedBrowserCommand sessionID={route.sessionID} location={ownerLocation()} />}
        </Show>
        <ProviderUsageCommand />
        <Header
        path={location()?.directory}
        branch={branch()}
        agent={headerAgent()}
        pendingAgent={pendingHeaderAgent()}
        model={headerModel()}
        variant={headerVariant()}
        pendingModel={pendingHeaderModel()}
        pendingVariant={pendingHeaderVariant()}
        state={headerState()}
        subagent={!!session()?.parentID}
      />
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box flexGrow={1} minHeight={0}>
          <Show when={session()}>
            <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} gap={1}>
              <Show when={session()?.parentID}>
                <SubagentSiblingSwitcher />
              </Show>
              <Show when={hiddenCount() > 0}>
                <box paddingLeft={1} flexShrink={0}>
                  <text fg={themeV2.text.subdued}>
                    {hiddenCount()} older rows hidden — scroll history is capped at {MAX_MOUNTED_ROWS} mounted rows
                  </text>
                </box>
              </Show>
              <scrollbox
                ref={(r) => {
                  scroll = r
                }}
                viewportOptions={{
                  paddingRight: showScrollbar() ? 1 : 0,
                }}
                verticalScrollbarOptions={{
                  paddingLeft: 1,
                  visible: showScrollbar(),
                  trackOptions: {
                    backgroundColor: themeV2.raise(themeV2.background.surface.offset),
                    foregroundColor: themeV2.border.default,
                  },
                }}
                stickyScroll={rows.length > 0 && !navigationMessage() && !restoringViewport()}
                stickyStart="bottom"
                marginTop={session()?.parentID ? 1 : 0}
                flexGrow={1}
                scrollAcceleration={scrollAcceleration()}
              >
                <Show when={blockedQuestion()}>
                  {(question) => (
                    <SubagentBlockedSurface
                      title={session()?.title ?? "Subagent"}
                      body={blockedBody()}
                      activity={blockedActivity()}
                      blockedAt={currentTask()?.question?.time}
                      question={question()}
                    />
                  )}
                </Show>
                <For each={mountedRows()}>
                  {(row, index) => (
                    <SessionRowView
                      row={row}
                      message={(messageID) => data.session.message.get(route.sessionID, messageID)}
                      compaction={(jobID) => data.session.compaction.get(route.sessionID, jobID)}
                      compactions={() => data.session.compaction.list(route.sessionID)}
                      assistantIdentity={assistantIdentity()}
                      boundaryID={mountedBoundaries()[index()]}
                      width={contentWidth()}
                      hidden={!!blockedQuestion()}
                      running={data.session.status(route.sessionID) === "running"}
                      guardrail={(requestID) => setGuardrailReview(requestID)}
                      subagent={(sessionID) => navigate({ type: "session", sessionID })}
                      capturedChanges={
                        row.type === "assistant-footer" &&
                        row.messageID ===
                          messages().findLast((message) => message.type === "assistant" && message.time.completed)?.id
                          ? capturedChanges()
                          : undefined
                      }
                      durableCapturedChanges={
                        row.type === "compaction" ||
                        (row.type === "message" && data.session.message.get(route.sessionID, row.messageID)?.type === "compaction")
                          ? durableCapturedChanges()
                          : undefined
                      }
                    />
                  )}
                </For>
                <BackgroundToolHint messages={messages()} />
                <Show when={session()?.revert?.messageID}>
                  <RevertMessage
                    count={
                      messages().filter(
                        (message) => message.id >= session()!.revert!.messageID && message.type === "user",
                      ).length
                    }
                    files={session()!.revert!.files ?? []}
                  />
                </Show>
                <Show when={navigationSlack()}>
                  {(height) => <box id={NAVIGATION_SLACK_ID} height={height()} flexShrink={0} />}
                </Show>
              </scrollbox>
            </box>
            <box
              flexShrink={0}
              paddingBottom={
                forms().length > 0 || permissions().length > 0 || reviewingGuardrail()
                  ? 0
                  : Math.max(1, Math.min(4, Math.floor(dimensions().height / 16)))
              }
            >
              <PluginSlot name="session.composer.top" input={{ sessionID: route.sessionID }} />
              <Show when={blockedReason()}>
                {(reason) => (
                  <box paddingLeft={1} flexShrink={0}>
                    <text fg={themeV2.text.subdued}>{reason()}</text>
                  </box>
                )}
              </Show>
              <Show when={!blockedReason() && queuedNotice()}>
                {(notice) => (
                  <box paddingLeft={1} flexShrink={0}>
                    <text fg={themeV2.text.subdued}>{notice()}</text>
                  </box>
                )}
              </Show>
              <Composer
                sessionID={route.sessionID}
                open={composer.open}
                defaultTab={composer.tab}
                onClose={() => setComposer("open", false)}
                prompt={composer.open && !disabled() ? sessionPrompt() : undefined}
              />
              <Switch>
                <Match when={blockedQuestion()}>
                  <SubagentAnswerComposer sessionID={route.sessionID} branch={branch()} />
                </Match>
                <Match when={reviewingGuardrail()}>{(request) => <GuardrailPrompt request={request()} />}</Match>
                <Match when={permissions().length > 0}>
                  <Show when={permissions()[0]?.id} keyed>
                    {(_) => {
                      const request = permissions()[0]
                      return request ? (
                        <PermissionPrompt request={request} directory={session()?.location.directory} />
                      ) : null
                    }}
                  </Show>
                </Match>
                <Match when={forms().length > 0}>
                  <Show when={forms()[0]?.id} keyed>
                    {(_) => {
                      const form = forms()[0]
                      return form ? <FormPrompt form={form} /> : null
                    }}
                  </Show>
                </Match>
                <Match when={session()?.parentID && !btw()}>{null}</Match>
                <Match when={!disabled() && !composer.open}>{sessionPrompt()}</Match>
              </Switch>
              <Show when={session()?.parentID && !blockedQuestion()}>
                <SubagentEconomicsSurface economics={economics()} />
              </Show>
            </box>
            </Show>
        </box>
        <Show when={sidebarVisible()}>
          <Switch>
            <Match when={wide()}>
              <Sidebar sessionID={route.sessionID} autonomy={autonomy()} shellSurface={composer.open} />
            </Match>
            <Match when={!wide()}>
              <box
                position="absolute"
                top={0}
                left={0}
                right={0}
                bottom={0}
                alignItems="flex-end"
                backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
              >
                <Sidebar sessionID={route.sessionID} autonomy={autonomy()} shellSurface={composer.open} />
              </box>
            </Match>
          </Switch>
        </Show>
      </box>
      <Show
        when={session()?.parentID}
        fallback={<Footer branch={branch()} sessionID={route.sessionID} autonomy={autonomy()} />}
      >
        <SubagentFooter />
      </Show>
      </context.Provider>
    </Show>
  )

  function sessionPrompt() {
    return (
      <pluginRuntime.Slot
        name="session_prompt"
        mode="replace"
        session_id={route.sessionID}
        visible={true}
        disabled={false}
        on_submit={toBottom}
        ref={bind}
      >
        <Prompt
          visible={true}
          ref={bind}
          disabled={false}
          onSubmit={toBottom}
          sessionID={route.sessionID}
          branch={branch()}
          autonomy={autonomy()}
          onAutonomyUpdated={acceptAutonomy}
          inset={{ left: 3, right: 4 }}
          placeholders={btw() ? { normal: ["Message BTW…"] } : undefined}
          right={<pluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
        />
      </pluginRuntime.Slot>
    )
  }
}

export function SessionMemoryCommand(props: { sessionID: string }) {
  const dialog = useDialog()
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        title: "Session memory",
        id: "session.memory",
        group: "Session",
        bind: false,
        palette: true,
        run: () => dialog.replace(() => <DialogSessionMemory sessionID={props.sessionID} />),
      },
    ],
  }))
  return null
}

export function DialogSessionMemory(props: { sessionID: string }) {
  const data = useData()
  const dialog = useDialog()
  const { themeV2 } = useTheme()
  const [memory, setMemory] = createSignal<DataSessionMemoryEstimate>()
  const refresh = () => setMemory(data.session.message.memory(props.sessionID))
  onMount(() => {
    dialog.setSize("large")
    refresh()
  })
  return (
    <DialogSelect
      title="Session memory"
      options={[]}
      renderFilter={false}
      locked
      bindings={[
        { bind: "r", title: "Refresh memory", group: "Dialog", run: refresh },
        { bind: "escape", title: "Close memory", group: "Dialog", run: () => dialog.clear() },
        { bind: "q", title: "Close memory", group: "Dialog", run: () => dialog.clear() },
      ]}
      emptyView={
        <box height={20} paddingLeft={4} paddingRight={4} paddingTop={1} flexDirection="column" flexShrink={0}>
          <For each={memory() ? sessionMemoryLines(memory()!) : []}>
            {(line, index) => (
              <text
                wrapMode="none"
                fg={index() === 0 || index() === 4 ? themeV2.text.default : themeV2.text.subdued}
                attributes={index() === 0 || index() === 4 ? TextAttributes.BOLD : undefined}
              >
                {line}
              </text>
            )}
          </For>
        </box>
      }
    />
  )
}

export function SessionRowView(props: {
  row: SessionRow
  message: (messageID: string) => SessionMessageInfo | undefined
  compaction?: (jobID: string) => DataSessionCompactionLifecycle | undefined
  compactions?: () => DataSessionCompactionLifecycle[]
  assistantIdentity?: { label: string; subagent: boolean }
  boundaryID?: string
  width?: number
  hidden?: boolean
  running?: boolean
  guardrail?: (requestID: string) => void
  subagent?: (sessionID: string) => void
  capturedChanges?: InlineDiffFile[]
  durableCapturedChanges?: InlineDiffFile[]
}) {
  // Rows can outlive a session eviction for one reactive frame. Resolve every message-backed row
  // before mounting its component so stale refs consume no space.
  const visible = createMemo(() => {
    const row = props.row
    if (row.type === "message") {
      const message = props.message(row.messageID)
      if (message?.type === "compaction") return compactionMessageTranscriptVisible(message)
      return message !== undefined
    }
    if (row.type === "compaction") {
      const lifecycle = props.compaction?.(row.jobID)
      return lifecycle !== undefined && compactionTranscriptVisible(lifecycle)
    }
    if (row.type === "assistant-footer") return props.message(row.messageID)?.type === "assistant"
    if (row.type === "part") {
      const message = props.message(row.ref.messageID)
      if (message?.type !== "assistant") return false
      const content = resolvePart(message, row.ref.partID)
      return (
        content !== undefined &&
        (content.type !== "tool" || transcriptToolPartVisible(content))
      )
    }
    if (row.type === "group") {
      const refs = row.kind === "exploration" ? [...row.refs, ...row.pending] : row.refs
      return refs.some((ref) => {
        const message = props.message(ref.messageID)
        if (message?.type !== "assistant") return false
        const part = resolvePart(message, ref.partID)
        if (row.kind === "reasoning") return part?.type === "reasoning" && Boolean(reasoningContent(part))
        return part?.type === "tool" && transcriptToolPartVisible(part)
      })
    }
    return true
  })
  return (
    <Show when={visible()}>
      <box id={props.boundaryID} width="100%" marginTop={1} flexShrink={0} visible={!props.hidden}>
        <Switch>
          <Match when={props.row.type === "message" ? props.row : undefined}>
            {(row) => (
              <Show when={props.message(row().messageID)}>
                {(message) => (
                  <>
                    <SessionMessageView message={message()} />
                    <Show when={message().type === "compaction" && props.durableCapturedChanges?.length}>
                      <FileChangeBlock files={props.durableCapturedChanges!} label="Captured changes" collapsed />
                    </Show>
                  </>
                )}
              </Show>
            )}
          </Match>
          <Match when={props.row.type === "compaction" ? props.row : undefined}>
            {(row) => (
              <Show when={props.compaction?.(row().jobID)}>
                {(item) => (
                  <>
                    <CompactionLifecycleMessage lifecycle={item()} compactions={props.compactions?.()} />
                    <Show when={props.durableCapturedChanges?.length}>
                      <FileChangeBlock files={props.durableCapturedChanges!} label="Captured changes" collapsed />
                    </Show>
                  </>
                )}
              </Show>
            )}
          </Match>
          <Match
            when={
              props.row.type === "guardrail" || props.row.type === "subagent" || props.row.type === "task"
                ? props.row
                : undefined
            }
          >
            {(row) => (
              <SessionActivityRow
                row={row()}
                running={props.running === true}
                width={props.width}
                onGuardrail={(requestID) => props.guardrail?.(requestID)}
                onSubagent={(sessionID) => props.subagent?.(sessionID)}
              />
            )}
          </Match>
          <Match when={props.row.type === "part" ? props.row : undefined}>
            {(row) => (
              <SessionPartView
                partRef={row().ref}
                message={props.message}
                assistantIdentity={props.assistantIdentity}
              />
            )}
          </Match>
          <Match when={props.row.type === "group" && props.row.kind === "reasoning" ? props.row : undefined}>
            {(row) => (
              <SessionReasoningGroupView
                refs={row().refs}
                completed={row().completed}
                message={props.message}
                subagent={props.assistantIdentity?.subagent}
              />
            )}
          </Match>
          <Match when={props.row.type === "group" && props.row.kind === "exploration" ? props.row : undefined}>
            {(row) => (
              <SessionGroupView
                refs={row().refs}
                pending={row().pending}
                completed={row().completed}
                message={props.message}
              />
            )}
          </Match>
          <Match when={props.row.type === "assistant-footer" ? props.row : undefined}>
            {(row) => (
              <Show when={props.message(row().messageID)}>
                {(message) => (
                  <Show when={message().type === "assistant"}>
                    <AssistantFooter message={message() as SessionMessageAssistant} />
                    <Show when={props.capturedChanges?.length}>
                      <FileChangeBlock files={props.capturedChanges!} label="Captured changes" collapsed />
                    </Show>
                  </Show>
                )}
              </Show>
            )}
          </Match>
        </Switch>
      </box>
    </Show>
  )
}

function BackgroundToolHint(props: { messages: SessionMessageInfo[] }) {
  const { themeV2 } = useTheme()
  const shortcut = Keymap.useShortcut("session.background")
  const visible = createMemo(() => {
    const current = props.messages.findLast(
      (message): message is SessionMessageAssistant => message.type === "assistant" && !message.time.completed,
    )
    return (
      current?.content.some((part) => {
        if (part.type !== "tool" || part.state.status !== "running") return false
        const display = toolDisplay(part.name)
        return display === "shell" || display === "subagent"
      }) ?? false
    )
  })
  return (
    <Show when={visible() && shortcut()}>
      {(value) => (
        <box marginTop={1} paddingLeft={3} flexShrink={0}>
          <text fg={themeV2.text.subdued}>
            Press <span style={{ fg: themeV2.text.default }}>{value()}</span> to move running work to the background
          </text>
        </box>
      )}
    </Show>
  )
}

function SessionMessageView(props: { message: SessionMessageInfo }) {
  return (
    <Switch>
      <Match when={props.message.type === "user"}>
        <UserMessage message={props.message as SessionMessageUser} />
      </Match>
      <Match when={props.message.type === "shell"}>
        <ShellMessage message={props.message as Extract<SessionMessageInfo, { type: "shell" }>} />
      </Match>
      <Match when={props.message.type === "agent-switched" || props.message.type === "model-switched"}>
        <SessionSwitchMessageV2 message={props.message} />
      </Match>
      <Match
        when={props.message.type === "system" || props.message.type === "synthetic" || props.message.type === "skill"}
      >
        <Show when={props.message.type === "skill"} fallback={<SessionNoticeMessageV2 message={props.message} />}>
          <SessionSkillMessage message={props.message as Extract<SessionMessageInfo, { type: "skill" }>} />
        </Show>
      </Match>
      <Match when={props.message.type === "compaction"}>
        <CompactionMessage message={props.message as Extract<SessionMessageInfo, { type: "compaction" }>} />
      </Match>
    </Switch>
  )
}

function SessionPartView(props: {
  partRef: PartRef
  message: (messageID: string) => SessionMessageInfo | undefined
  assistantIdentity?: { label: string; subagent: boolean }
}) {
  const message = createMemo(() => props.message(props.partRef.messageID))
  const part = createMemo(() => {
    const item = message()
    if (item?.type !== "assistant") return
    return resolvePart(item, props.partRef.partID)
  })
  const streaming = createMemo(() => {
    const item = message()
    return item?.type === "assistant" && item.time.completed === undefined
  })
  return (
    <Show when={part()}>
      {(item) => (
        <Switch>
          <Match when={item().type === "text"}>
            <TextPart
              part={item() as SessionMessageAssistantText}
              last={false}
              streaming={streaming()}
              identity={props.partRef.partID === "text:0" ? props.assistantIdentity : undefined}
              subagent={props.assistantIdentity?.subagent}
              index={Number(props.partRef.partID.split(":")[1])}
            />
          </Match>
          <Match when={item().type === "reasoning"}>
            <ReasoningPart
              part={item() as SessionMessageAssistantReasoning}
              message={message() as SessionMessageAssistant}
              last={false}
              subagent={props.assistantIdentity?.subagent}
            />
          </Match>
          <Match when={item().type === "tool"}>
            <ToolPart part={item() as SessionMessageAssistantTool} />
          </Match>
        </Switch>
      )}
    </Show>
  )
}

function SessionReasoningGroupView(props: {
  refs: PartRef[]
  completed: boolean
  message: (messageID: string) => SessionMessageInfo | undefined
  subagent?: boolean
}) {
  const ctx = use()
  const { themeV2, syntax } = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  const parts = createMemo(() =>
    props.refs.flatMap((ref) => {
      const message = props.message(ref.messageID)
      if (message?.type !== "assistant") return []
      const part = resolvePart(message, ref.partID)
      if (part?.type !== "reasoning" || !reasoningContent(part)) return []
      return [{ message, part }]
    }),
  )
  const latest = createMemo((previous: string | null) => {
    const item = parts().at(-1)
    if (!item) return previous
    const title = reasoningSummary(reasoningContent(item.part)).title
    if (title) return title
    if (item.part.time?.completed !== undefined || item.message.time.completed !== undefined) return null
    return previous
  }, null)
  const thought = createMemo(() => {
    if (props.subagent)
      return parts()
        .map((item) => reasoningContent(item.part))
        .join(" ")
    return latest()
  })
  const duration = createMemo(() =>
    parts().reduce((total, item) => {
      const start = item.part.time?.created
      const end = item.part.time?.completed
      return total + (start === undefined || end === undefined ? 0 : Math.max(0, end - start))
    }, 0),
  )

  return (
    <Show when={parts().length > 0}>
      <Show
        when={ctx.thinkingMode() === "hide"}
        fallback={<For each={props.refs}>{(ref) => <SessionPartView partRef={ref} message={props.message} />}</For>}
      >
        <box flexDirection="column" flexShrink={0}>
          <InlineToolRow
            icon={expanded() ? "-" : "+"}
            color={hover() || expanded() ? themeV2.text.default : themeV2.text.subdued}
            complete={props.completed}
            pending={latest() ? `Thinking: ${latest()}` : "Thinking"}
            spinner={!props.completed}
            status={
              props.completed && duration() ? (
                <text flexShrink={0} fg={themeV2.text.subdued}>
                  {Locale.duration(duration())}
                </text>
              ) : undefined
            }
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseUp={() => {
              if (renderer.getSelection()?.getSelectedText()) return
              setExpanded((value) => !value)
            }}
          >
            {props.completed ? "Thought" : latest() ? `Thinking: ${latest()}` : "Thinking"}
            <Show when={props.completed && !expanded() && thought()}>: {thought()}</Show>
            <Show when={props.completed && parts().length > 1}> · {parts().length} steps</Show>
          </InlineToolRow>
          <Show when={expanded()}>
            <box paddingLeft={8}>
              <For each={props.refs}>
                {(ref) => {
                  const message = createMemo(() => {
                    const item = props.message(ref.messageID)
                    return item?.type === "assistant" ? item : undefined
                  })
                  const part = createMemo(() => {
                    const item = message()
                    if (!item) return undefined
                    const part = resolvePart(item, ref.partID)
                    return part?.type === "reasoning" ? part : undefined
                  })
                  const content = createMemo(() => {
                    const item = part()
                    return item ? reasoningContent(item) : ""
                  })
                  return (
                    <Show when={content()}>
                      <box marginTop={1}>
                        <box
                          border={["left"]}
                          customBorderChars={SplitBorder.customBorderChars}
                          borderColor={themeV2.raise(themeV2.background.surface.offset)}
                          paddingLeft={1}
                        >
                          <code
                            filetype="markdown"
                            drawUnstyledText={false}
                            streaming={part()?.time?.completed === undefined && message()?.time.completed === undefined}
                            syntaxStyle={syntax()}
                            content={content()}
                            conceal={true}
                            fg={themeV2.text.subdued}
                          />
                        </box>
                      </box>
                    </Show>
                  )
                }}
              </For>
            </box>
          </Show>
        </box>
      </Show>
    </Show>
  )
}

function SessionGroupView(props: {
  refs: PartRef[]
  pending: PartRef[]
  completed: boolean
  message: (messageID: string) => SessionMessageInfo | undefined
}) {
  const { themeV2 } = useTheme()
  const ctx = use()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  const parts = (refs: PartRef[]) =>
    refs.flatMap((ref) => {
      const message = props.message(ref.messageID)
      if (message?.type !== "assistant") return []
      const part = resolvePart(message, ref.partID)
      if (part?.type !== "tool" || !transcriptToolPartVisible(part)) return []
      return [part]
    })
  const grouped = createMemo(() => parts(props.refs))
  const pending = createMemo(() => parts(props.pending))
  const lifecycle = createMemo(() => groupedToolLifecycle([...grouped(), ...pending()]))
  const lifecyclePresentation = createMemo(() => toolLifecyclePresentation(lifecycle()))
  const active = createMemo(() => lifecycle().status === "streaming" || lifecycle().status === "running")
  const singleGrep = createMemo(() => {
    const part = grouped().length === 1 && pending().length === 0 && props.completed ? grouped()[0] : undefined
    if (part?.name.toLowerCase() !== "grep" || part.state.status !== "completed") return undefined
    const input = typeof part.state.input === "string" ? {} : part.state.input
    const pattern = stringValue(input.pattern)
    const matches = finiteNumber(toolDisplayMetadata(part.state).matches)
    if (!pattern || matches === undefined) return undefined
    return { pattern, matches, part }
  })
  const label = createMemo(() => {
    const count = grouped().length + pending().length
    return `${active() ? "Exploring" : "Explored"} — ${count} ${count === 1 ? "search" : "searches"}`
  })
  return (
    <Show when={grouped().length > 0 || pending().length > 0}>
      <Show
        when={singleGrep()}
        fallback={
          <Show
            when={ctx.groupExploration()}
            fallback={<For each={[...grouped(), ...pending()]}>{(part) => <ToolPart part={part} />}</For>}
          >
            <Show when={grouped().length > 0}>
              <InlineToolRow
                icon={active() ? "✱" : "→"}
                color={hover() ? themeV2.text.default : themeV2.text.subdued}
                complete={!active()}
                pending={label()}
                spinner={active()}
                failed={lifecyclePresentation().variant === "error"}
                warning={lifecyclePresentation().variant === "warning"}
                status={<ToolLifecycleStatus lifecycle={lifecycle()} />}
                onMouseOver={() => setHover(true)}
                onMouseOut={() => setHover(false)}
                onMouseUp={() => {
                  if (renderer.getSelection()?.getSelectedText()) return
                  setExpanded((value) => !value)
                }}
              >
                {label()}
              </InlineToolRow>
            </Show>
            <Show when={expanded() && grouped().length > 0}>
              <For each={grouped()}>{(part) => <ToolPart part={part} nested />}</For>
            </Show>
            <For each={pending()}>{(part) => <ToolPart part={part} />}</For>
          </Show>
        }
      >
        {(grep) => (
          <SessionToolActivityRow
            tool="grep"
            detail={`"${grep().pattern}"`}
            lifecycle={toolLifecycle(grep().part, {
              summary: `${grep().matches} ${grep().matches === 1 ? "match" : "matches"}`,
            })}
            width={ctx.width}
          />
        )}
      </Show>
    </Show>
  )
}

function AssistantFooter(props: { message: SessionMessageAssistant }) {
  const ctx = use()
  const local = useLocal()
  const { themeV2 } = useTheme().contextual("elevated")
  const model = createMemo(
    () =>
      ctx
        .models()
        .find((model) => model.providerID === props.message.model.providerID && model.id === props.message.model.id)
        ?.name ?? `${props.message.model.providerID}/${props.message.model.id}`,
  )
  const duration = createMemo(() =>
    props.message.time.completed ? props.message.time.completed - props.message.time.created : 0,
  )
  const interrupted = createMemo(() => props.message.error?.message === "Step interrupted")
  const providerError = createMemo(() => Boolean(props.message.error && !interrupted()))
  return (
    <>
      <Show when={providerError()}>
        <box paddingLeft={3} flexDirection="column">
          <text fg={themeV2.text.feedback.error.default}>{Locale.titlecase(props.message.agent)}</text>
          <text fg={themeV2.text.feedback.error.default}>{safeProviderErrorMessage(props.message.error?.message ?? "")}</text>
        </box>
      </Show>
      <AssistantRetry retry={props.message.retry} />
      <box paddingLeft={3} marginTop={providerError() ? 1 : 0}>
        <text>
          <Show when={!providerError()}>
            <span style={{ fg: props.message.error ? themeV2.text.subdued : local.agent.color(props.message.agent) }}>
              {Locale.titlecase(props.message.agent)}
            </span>
          </Show>
          <Show when={providerError()}>
            <span style={{ fg: themeV2.text.subdued }}>{model()}</span>
          </Show>
          <Show when={!providerError()}>
            <span style={{ fg: themeV2.text.subdued }}> · {model()}</span>
          </Show>
          <Show when={duration()}>
            <span style={{ fg: themeV2.text.subdued }}> · {Locale.duration(duration())}</span>
          </Show>
          <Show when={interrupted()}>
            <span style={{ fg: themeV2.text.subdued }}> · interrupted</span>
          </Show>
        </text>
      </box>
    </>
  )
}

function SessionSwitchMessageV2(props: { message: SessionMessageInfo }) {
  const ctx = use()
  const { themeV2 } = useTheme()
  const text = () => {
    if (props.message.type === "agent-switched") return `Switched agent to ${props.message.agent}`
    if (props.message.type === "model-switched")
      return switchLabel(props.message.model, ctx.models(), props.message.previous)
    return ""
  }
  return (
    <box paddingLeft={3}>
      <text fg={themeV2.text.subdued}>{text()}</text>
    </box>
  )
}

function SessionNoticeMessageV2(props: { message: SessionMessageInfo }) {
  const ctx = use()
  const { themeV2 } = useTheme()
  const metadata = () => (props.message.type === "synthetic" ? props.message.metadata : undefined)
  const source = () => stringValue(metadata()?.source)
  const contextSource = () => stringValue(props.message.metadata?.contextSource)
  const subagentNotification = () => source() === "subagent_notification"
  const completion = () => source() === "subagent" || source() === "shell"
  const state = () => stringValue(metadata()?.state)
  const actor = () => (source() === "shell" ? "Shell" : Locale.titlecase(stringValue(metadata()?.agent) ?? "Subagent"))
  const text = () => {
    if (props.message.type === "system") return props.message.text
    if (props.message.type === "synthetic")
      return props.message.metadata?.contextSource === "team-view" ? props.message.text : props.message.description ?? ""
    return ""
  }
  const notice = createMemo(() => noticeSummary(contextSource(), text()))
  const description = () => (source() === "shell" ? text().replace(/\s+/g, " ").trim() : text())
  const status = () => {
    if (state() === "completed") return "finished"
    if (state() === "error") return "failed"
    return state() ?? "finished"
  }
  const notificationStatus = () => {
    const type = stringValue(metadata()?.type)
    if (type === "completed" || type === "failed" || type === "waiting") return type
    return "updated"
  }
  const heading = () => `${state() === "completed" ? "↳" : "!"} ${actor()} ${status()}`
  const suffix = () => Locale.truncateWidth(` · ${description()}`, Math.max(0, ctx.width - 3 - stringWidth(heading())))
  const color = () => {
    if (state() === "error") return themeV2.text.feedback.error.default
    if (state() === "cancelled") return themeV2.text.feedback.warning.default
    return themeV2.text.feedback.info.default
  }
  return (
    <Switch>
      <Match when={subagentNotification()}>
        <SessionToolActivityRow
          tool="subagent"
          detail=""
          status={notificationStatus()}
          variant="subagent"
          width={ctx.width}
        />
      </Match>
      <Match when={completion()}>
        <box marginLeft={3}>
          <text wrapMode="none">
            <span style={{ fg: color() }}>{heading()}</span>
            <span style={{ fg: themeV2.text.subdued }}>{suffix()}</span>
          </text>
        </box>
      </Match>
      <Match when={true}>
        <Show when={notice()} fallback={<RawNoticeMarkdown content={text()} />}>
          {(summary) => <SummaryNoticeMessage summary={summary()} />}
        </Show>
      </Match>
    </Switch>
  )
}

function SummaryNoticeMessage(props: { summary: string }) {
  const ctx = use()
  const { themeV2 } = useTheme()
  return (
    <box flexDirection="column">
      <InlineToolRow icon="◈" color={themeV2.text.subdued} pending="Notice" complete={true}>
        Notice
      </InlineToolRow>
      <box paddingLeft={3} paddingTop={1}>
        <text fg={themeV2.text.subdued}>{Locale.truncateWidth(props.summary, Math.max(0, ctx.width - 5))}</text>
      </box>
    </box>
  )
}

function RawNoticeMarkdown(props: { content: string }) {
  const { themeV2, syntax } = useTheme()
  return (
    <box flexDirection="column">
      <InlineToolRow icon="◈" color={themeV2.text.subdued} pending="Notice" complete={true}>
        Notice
      </InlineToolRow>
      <box paddingLeft={3} paddingTop={1}>
        <markdown
          syntaxStyle={syntax()}
          streaming={false}
          internalBlockMode="top-level"
          content={props.content}
          tableOptions={{ style: "grid" }}
          conceal={true}
          fg={themeV2.markdown.text}
        />
      </box>
    </box>
  )
}

function SessionSkillMessage(props: { message: Extract<SessionMessageInfo, { type: "skill" }> }) {
  const { themeV2, mode } = useTheme()
  const accent = () => themeV2.hue.accent[mode() === "light" ? 700 : 200]
  return (
    <>
      <InlineToolRow
        icon="✦"
        color={themeV2.text.default}
        pending="Loading skill..."
        complete={true}
        status={<StatusBadge color={accent()}>Loaded</StatusBadge>}
      >
        Skill "{props.message.name}"
      </InlineToolRow>
    </>
  )
}

function CompactionMessage(props: { message: Extract<SessionMessageInfo, { type: "compaction" }> }) {
  const message = () => legacyCompaction(props.message)
  const cancelled = () => {
    const current = message()
    return current?.status === "failed" && current.error.type === "aborted"
  }
  return (
    <Show when={message()}>
      {(item) => (
        <CompactionMarker message={item()} cancelled={cancelled()} />
      )}
    </Show>
  )
}

function legacyCompaction(message: Extract<SessionMessageInfo, { type: "compaction" }>) {
  if (!("reason" in message) || !compactionMessageTranscriptVisible(message)) return undefined
  return message
}

function compactTokenCount(tokens: number) {
  if (tokens < 1_000) return Locale.number(tokens)
  return `${Math.round(tokens / 1_000)}k`
}

function compactionLabel(lifecycle: {
  trigger?: string
  status: "pending" | "running" | "completed" | "failed"
  metrics?: { excludedMessages: number; inputTokens: number; retainedTokens: number }
  code?: string
}) {
  if (lifecycle.status === "pending") return "~ compaction pending"
  if (lifecycle.status === "running") {
    if (!lifecycle.trigger) return "~ compacting"
    return `~ compacting · ${lifecycle.trigger}`
  }
  if (lifecycle.status === "completed") {
    if (!lifecycle.metrics) return "~ compacted"
    return `~ compacted · ${lifecycle.metrics.excludedMessages} items excluded · ${compactTokenCount(lifecycle.metrics.inputTokens)} → ${compactTokenCount(lifecycle.metrics.retainedTokens)} tokens`
  }
  if (lifecycle.code === "cancelled") return "~ compaction cancelled"
  if (lifecycle.code === "superseded") return "~ compaction superseded"
  return ""
}

function CompactionLifecycleMessage(props: {
  lifecycle: DataSessionCompactionLifecycle
  compactions?: DataSessionCompactionLifecycle[]
}) {
  const { themeV2 } = useTheme()
  const color = () => themeV2.text.hint
  const completed = createMemo(() =>
    (props.compactions?.length ? props.compactions : [props.lifecycle]).filter(
      (lifecycle): lifecycle is DataSessionCompactionLifecycle & { metrics: NonNullable<DataSessionCompactionLifecycle["metrics"]> } =>
        lifecycle.status === "completed" && lifecycle.metrics !== undefined,
    ),
  )
  const compression = createMemo(() => completed().findIndex((lifecycle) => lifecycle.jobID === props.lifecycle.jobID))
  const saved = createMemo(() => completed().reduce((total, lifecycle) => total + lifecycle.metrics.inputTokens - lifecycle.metrics.retainedTokens, 0))
  const reduction = createMemo(() => {
    const metrics = props.lifecycle.metrics
    if (!metrics || metrics.inputTokens === 0) return 0
    return Math.round(((metrics.inputTokens - metrics.retainedTokens) / metrics.inputTokens) * 100)
  })
  const composition = createMemo(() => {
    const metrics = props.lifecycle.metrics
    if (!metrics) return { retained: "", removed: "" }
    return contextCompositionBar(metrics.inputTokens, metrics.retainedTokens)
  })
  return (
    <box paddingLeft={1} flexDirection="column">
      <box flexDirection="row" alignItems="center">
        <box border={["top"]} borderColor={color()} flexGrow={1} />
        <box paddingLeft={1} paddingRight={1}>
          <text fg={color()}>{compactionLabel(props.lifecycle)}</text>
        </box>
        <box border={["top"]} borderColor={color()} flexGrow={1} />
      </box>
      <Show when={props.lifecycle.status === "completed" && props.lifecycle.metrics}>
        {(metrics) => (
          <box paddingLeft={3} paddingTop={1} flexDirection="column">
            <text fg={themeV2.text.subdued}>~{compactTokenCount(saved())} tokens saved total</text>
            <box border width="100%" flexDirection="row" borderColor={themeV2.border.default}>
              <box flexGrow={Math.max(1, metrics().inputTokens - metrics().retainedTokens)} backgroundColor={themeV2.text.subdued}>
                <text fg={themeV2.background.default}>{composition().removed}</text>
              </box>
              <box flexGrow={Math.max(1, metrics().retainedTokens)} backgroundColor={themeV2.background.surface.offset}>
                <text fg={themeV2.text.subdued}>{composition().retained}</text>
              </box>
            </box>
            <text fg={themeV2.text.default}>
              Compression #{compression() + 1} (~{compactTokenCount(metrics().inputTokens - metrics().retainedTokens)} tokens removed, {reduction()}% reduction)
            </text>
            <text fg={themeV2.text.subdued}>Items: {metrics().excludedMessages} messages compressed · {Locale.todayTimeOrDateTime(props.lifecycle.time.created)}</text>
          </box>
        )}
      </Show>
    </box>
  )
}

function CompactionMarker(props: {
  message: Extract<SessionMessageInfo, { type: "compaction"; reason: "auto" | "manual" }>
  cancelled: boolean
}) {
  const { themeV2 } = useTheme()
  const tokenLabel = createMemo(() => {
    const tokens = props.message.status === "completed" && "tokens" in props.message ? props.message.tokens : undefined
    return tokens
      ? `${Locale.number(tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write)} tokens`
      : undefined
  })
  const messageLabel = createMemo(() => {
    const messages =
      props.message.status === "completed" && "messages" in props.message ? props.message.messages : undefined
    return messages === undefined ? undefined : `${messages} messages`
  })
  const color = () => themeV2.text.hint
  return (
    <box paddingLeft={1}>
      <box flexDirection="row" alignItems="center">
        <box border={["top"]} borderColor={color()} flexGrow={1} />
        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
          <Switch>
            <Match when={props.message.status === "running"}>
              <CompactionSpinner color={color()} />
            </Match>
          </Switch>
          <text fg={color()}>
            {props.message.status === "completed" ? "~ compacted" : "Compaction"}
            <Show when={messageLabel()}>{(value) => <span> · {value()}</span>}</Show>
            <Show when={tokenLabel()}>{(value) => <span> → {value()}</span>}</Show>
          </text>
          <Show when={props.cancelled}>
            <text fg={color()}>· cancelled</text>
          </Show>
        </box>
        <box border={["top"]} borderColor={color()} flexGrow={1} />
      </box>
    </box>
  )
}

function CompactionSpinner(props: { color: RGBA }) {
  const ctx = use()
  return (
    <Show when={ctx.config.animations ?? true} fallback={<text fg={props.color}>⋯</text>}>
      <spinner frames={SPINNER_FRAMES} interval={80} color={props.color} />
    </Show>
  )
}


function statusLabel(status: "added" | "modified" | "deleted") {
  if (status === "added") return "A"
  if (status === "deleted") return "D"
  return "M"
}

function RevertMessage(props: {
  count: number
  files: ReadonlyArray<{
    readonly file: string
    readonly status: "added" | "modified" | "deleted"
    readonly additions: number
    readonly deletions: number
  }>
}) {
  const ctx = use()
  const { themeV2 } = useTheme().contextual("elevated")
  const route = useRouteData("session")
  const client = useClient()
  const toast = useToast()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const redoKey = Keymap.useShortcut("session.redo")
  return (
    <box
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        void (async () => {
          const error = await client.api.session.revert.clear({ sessionID: route.sessionID }).then(
            () => undefined,
            (error) => error,
          )
          if (error) toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
        })()
      }}
      flexShrink={0}
      marginTop={1}
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={themeV2.background.default}
    >
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        backgroundColor={hover() ? themeV2.raise(themeV2.background.default) : themeV2.background.default}
      >
        <text fg={themeV2.text.subdued}>
          {props.count} message{props.count === 1 ? "" : "s"} reverted
        </text>
        <Show when={props.files.length > 0}>
          <box paddingTop={1} paddingBottom={1} flexDirection="column">
            <For each={props.files}>
              {(file) => (
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text fg={themeV2.text.subdued}>{statusLabel(file.status)}</text>
                  <FilePath
                    value={file.file}
                    maxWidth={Math.max(
                      2,
                      ctx.width -
                        5 -
                        (file.additions > 0 ? stringWidth(`+${file.additions}`) + 1 : 0) -
                        (file.deletions > 0 ? stringWidth(`-${file.deletions}`) + 1 : 0),
                    )}
                    fg={themeV2.text.default}
                  />
                  <Show when={file.additions > 0}>
                    <text fg={themeV2.diff.text.added}>+{file.additions}</text>
                  </Show>
                  <Show when={file.deletions > 0}>
                    <text fg={themeV2.diff.text.removed}>-{file.deletions}</text>
                  </Show>
                </box>
              )}
            </For>
          </box>
        </Show>
        <text fg={themeV2.text.subdued}>
          <span style={{ fg: themeV2.text.default }}>{redoKey()}</span> or /redo to restore
        </text>
      </box>
    </box>
  )
}

function ShellMessage(props: { message: Extract<SessionMessageInfo, { type: "shell" }> }) {
  const ctx = use()
  const { themeV2 } = useTheme().contextual("elevated")
  const output = createMemo(() => stripAnsi(props.message.output?.output.trim() ?? ""))
  const warnings = createMemo(() => {
    const value = props.message.metadata?.sandboxWarnings
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  })
  const lifecycle = createMemo<ToolLifecycleInput>(() => ({
    status: props.message.status === "running" ? "running" : props.message.status === "exited" ? "completed" : "error",
    time: props.message.time,
    failed: props.message.status === "exited" && props.message.exit !== undefined && props.message.exit !== 0,
    cancelled: props.message.status === "killed",
    summary:
      props.message.status === "exited" && props.message.exit !== undefined
        ? `exit ${props.message.exit}`
        : props.message.status === "running"
          ? undefined
          : props.message.status,
  }))

  return (
    <box flexDirection="column">
      <SessionToolActivityRow tool={`$ ${props.message.command}`} detail="" lifecycle={lifecycle()} width={ctx.width} />
      <For each={warnings()}>
        {(warning) => (
          <text paddingLeft={10} fg={themeV2.text.feedback.warning.default}>
            △ {warning}
          </text>
        )}
      </For>
      <ToolOutput
        output={output()}
        error={
          props.message.status === "timeout" ||
          props.message.status === "memory-limit" ||
          (props.message.status === "exited" && props.message.exit !== undefined && props.message.exit !== 0)
        }
      />
    </box>
  )
}

function UserMessage(props: { message: SessionMessageUser }) {
  const ctx = use()
  const data = useData()
  const files = createMemo(() =>
    (projectedPromptInput(props.message).files ?? []).map((file, index) => ({
      ...file,
      mime: props.message.files?.[index]?.mime,
    })),
  )
  const subagent = createMemo(() => Boolean(data.session.get(ctx.sessionID)?.parentID))
  const { themeV2, mode } = useTheme().contextual("elevated")
  const [hover, setHover] = createSignal(false)
  const dialog = useDialog()
  const renderer = useRenderer()
  const promptRef = usePromptRef()
  const skills = createMemo(() => promptSkillsFromMetadata(props.message.metadata))
  const maxChars = createMemo(() => 3 * Math.max(20, Math.floor(ctx.width * 0.515) - 2))
  const content = createMemo(() =>
    segmentPromptSkills(
      collapseToolOutput(props.message.text, 1, maxChars()).output,
      skills(),
    ),
  )
  const receipt = createMemo(() => {
    if (data.session.input.has(ctx.sessionID, props.message.id)) return { glyph: "◷", read: false }
    if (props.message.time.consumed !== undefined) return { glyph: "✓✓", read: true }
    return { glyph: "✓", read: false }
  })

  return (
    <Show when={props.message.text.trim() || files().length}>
      <box width="100%" alignItems="flex-end" flexDirection="column" marginBottom={subagent() ? 0 : 2}>
        <box
          onMouseOver={() => {
            setHover(true)
          }}
          onMouseOut={() => {
            setHover(false)
          }}
          onMouseUp={() => {
            if (renderer.getSelection()?.getSelectedText()) return
            dialog.replace(() => (
              <DialogMessage
                messageID={props.message.id}
                sessionID={ctx.sessionID}
                setPrompt={(value) => promptRef.current?.set(value)}
              />
            ))
          }}
          paddingTop={0}
          paddingBottom={0}
          paddingLeft={1}
          paddingRight={1}
          maxWidth="51.5%"
          border
          borderStyle="rounded"
          // The rounded border is drawn in the bubble's own fill colour, so it reads as a pill
          // silhouette rather than an outline around the message.
          borderColor={hover() ? themeV2.raise(themeV2.background.surface.offset) : themeV2.background.surface.offset}
          backgroundColor={
            hover() ? themeV2.raise(themeV2.background.surface.offset) : themeV2.background.surface.offset
          }
          flexDirection="column"
          flexShrink={0}
        >
          <text wrapMode="word" fg={themeV2.text.default}>
            <For each={content()}>
              {(part) => (
                <Show when={part.type === "skill"} fallback={part.value}>
                  <span style={{ fg: themeV2.hue.accent[mode() === "light" ? 700 : 200], bold: true }}>
                    {part.value}
                  </span>
                </Show>
              )}
            </For>
          </text>
          <Show when={files().length}>
            <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
              <For each={files()}>
                {(file) => {
                  const label = file.mime === "application/x-directory" ? "dir" : "file"
                  return (
                    <text fg={themeV2.text.default}>
                      <span
                        style={{
                          bg: themeV2.hue.accent[mode() === "light" ? 700 : 200],
                          fg: themeV2.background.default,
                          bold: true,
                        }}
                      >
                        {` ${label} `}
                      </span>
                      <span style={{ bg: themeV2.raise(themeV2.background.default), fg: themeV2.text.subdued }}>
                        {" "}
                        {file.name ?? file.uri}{" "}
                      </span>
                    </text>
                  )
                }}
              </For>
            </box>
          </Show>
        </box>
        <text
          id={`session.user-message.receipt.${props.message.id}`}
          wrapMode="none"
          fg={receipt().read ? themeV2.text.feedback.info.default : themeV2.text.subdued}
        >
          {receipt().glyph}
        </text>
      </box>
    </Show>
  )
}

function AssistantRetry(props: { retry: SessionMessageAssistant["retry"] }) {
  const { themeV2 } = useTheme()
  return (
    <Show when={props.retry}>
      {(retry) => (
        <box paddingLeft={3} marginTop={1}>
          <text fg={themeV2.text.subdued}>
            Retry attempt {retry().attempt} scheduled: {safeProviderErrorMessage(retry().error.message)}
          </text>
        </box>
      )}
    </Show>
  )
}

function ExplorationSummary(props: { parts: SessionMessageAssistantTool[]; active: boolean }) {
  const { themeV2 } = useTheme()
  const pathFormatter = usePathFormatter()
  const lifecycle = createMemo(() => groupedToolLifecycle(props.parts))
  const lifecyclePresentation = createMemo(() => toolLifecyclePresentation(lifecycle()))
  const active = createMemo(() => lifecycle().status === "streaming" || lifecycle().status === "running")
  const summary = () =>
    `${active() ? "Exploring" : "Explored"} — ${props.parts.length} ${props.parts.length === 1 ? "search" : "searches"}`
  const label = (part: SessionMessageAssistantTool) => {
    const input = typeof part.state.input === "string" ? {} : part.state.input
    const tool = toolDisplay(part.name)
    if (tool === "read") return `Read ${pathFormatter.format(stringValue(input.path))}`
    if (tool === "glob") return `Glob "${stringValue(input.pattern)}"`
    return `Grep "${stringValue(input.pattern)}"`
  }
  return (
    <box flexDirection="column">
      <InlineToolRow
        icon="✱"
        color={themeV2.text.subdued}
        complete={!active()}
        pending={summary()}
        spinner={active()}
        failed={lifecyclePresentation().variant === "error"}
        warning={lifecyclePresentation().variant === "warning"}
        status={<ToolLifecycleStatus lifecycle={lifecycle()} />}
      >
        {summary()}
      </InlineToolRow>
      <For each={props.parts}>
        {(part, index) => (
          <box paddingLeft={8} flexDirection="column">
            <box flexDirection="row" width="100%">
              <text
                flexShrink={1}
                truncate
                fg={part.state.status === "error" ? themeV2.text.feedback.error.default : themeV2.text.subdued}
              >
                {index() === props.parts.length - 1 ? "└" : "├"} {label(part)}
              </text>
              <box flexGrow={1} />
              <ToolLifecycleStatus lifecycle={toolLifecycle(part)} />
            </box>
            <ToolOutput
              output={
                part.state.status === "streaming"
                  ? undefined
                  : part.state.status === "error"
                    ? "Tool failed."
                    : part.state.content
                        .flatMap((content) =>
                          content.type === "text" ? [content.text] : [content.name ?? content.uri],
                        )
                        .join("\n")
              }
              error={part.state.status === "error"}
            />
          </box>
        )}
      </For>
    </box>
  )
}

function ReasoningPart(props: {
  last: boolean
  part: SessionMessageAssistantReasoning
  message: SessionMessageAssistant
  subagent?: boolean
}) {
  const { themeV2, syntax } = useTheme()
  const ctx = use()
  // Collapsed by default in hide mode: a single line throughout, so the
  // layout never shifts. Click to open the full markdown block, click to close.
  const [expanded, setExpanded] = createSignal(false)

  const content = createMemo(() => reasoningContent(props.part))
  const isDone = createMemo(
    () => props.part.time?.completed !== undefined || props.message.time.completed !== undefined,
  )
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")
  const duration = createMemo(() => {
    const end = props.part.time?.completed ?? props.message.time.completed
    const start = props.part.time?.created ?? props.message.time.created
    return end === undefined ? 0 : Math.max(0, end - start)
  })
  const summary = createMemo(() => reasoningSummary(content()))
  const toggle = () => {
    if (!inMinimal()) return
    setExpanded((prev) => !prev)
  }

  return (
    <Show when={content()}>
      <box flexDirection="column" flexShrink={0}>
        <InlineToolRow
          icon={inMinimal() && !expanded() ? "+" : "-"}
          color={themeV2.text.subdued}
          complete={isDone()}
          pending={summary().title ? `Thinking: ${summary().title}` : "Thinking"}
          spinner={!isDone()}
          status={
            isDone() && duration() ? (
              <text flexShrink={0} fg={themeV2.text.subdued}>
                {Locale.duration(duration())}
              </text>
            ) : undefined
          }
          onMouseUp={toggle}
        >
          {isDone() ? "Thought" : summary().title ? `Thinking: ${summary().title}` : "Thinking"}
          <Show when={isDone() && inMinimal() && !expanded() && summary().title}>: {summary().title}</Show>
        </InlineToolRow>
        <Show when={!inMinimal() || expanded()}>
          <box marginTop={1} paddingLeft={8}>
            <box
              border={["left"]}
              customBorderChars={SplitBorder.customBorderChars}
              borderColor={themeV2.raise(themeV2.background.default)}
              paddingLeft={1}
            >
              <code
                filetype="markdown"
                drawUnstyledText={false}
                streaming={true}
                syntaxStyle={syntax()}
                content={content()}
                conceal={true}
                fg={themeV2.text.subdued}
              />
            </box>
          </box>
        </Show>
      </box>
    </Show>
  )
}

function reasoningContent(part: SessionMessageAssistantReasoning) {
  // OpenRouter encrypts some reasoning blocks; drop the placeholder.
  return part.text.replace("[REDACTED]", "").trim()
}

function TextPart(props: {
  last: boolean
  part: SessionMessageAssistantText
  streaming: boolean
  identity?: { label: string; subagent: boolean }
  subagent?: boolean
  index?: number
}) {
  const ctx = use()
  const { themeV2, syntax } = useTheme()
  const text = createMemo(() => props.part.text)
  const imagePlaceholder = createMemo(() => /\[Image \d+\]/.test(text()))
  // OpenTUI 0.4.5 drops bare transcript image placeholders when finalized, so wrap only that
  // model-visible marker as inline code while retaining top-level rendering for its visual shape.
  const markdown = createMemo(() =>
    props.streaming ? text() : text().replace(/\[Image (\d+)\]/g, "`[Image $1]`"),
  )
  return (
    <Show when={text()}>
      <box
        paddingLeft={props.subagent ? (text().startsWith("$") ? 4 : 1) : 1}
        paddingTop={props.identity?.subagent ? 1 : 0}
        marginTop={props.subagent && text().startsWith("$") ? 2 : props.subagent && props.index === 2 ? 4 : 0}
        flexDirection="column"
        gap={props.identity?.subagent ? 2 : props.identity ? 1 : 0}
        flexShrink={0}
      >
        <Show when={props.identity}>
          {(identity) => (
            <text fg={identity().subagent ? themeV2.text.feedback.info.default : themeV2.text.feedback.success.default}>
              <b>{identity().label}</b>
            </text>
          )}
        </Show>
        <markdown
          syntaxStyle={syntax()}
          streaming={props.streaming}
          internalBlockMode={props.streaming || imagePlaceholder() ? "top-level" : "coalesced"}
          content={markdown()}
          tableOptions={{ style: "grid" }}
          conceal={true}
          fg={themeV2.markdown.text}
        />
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { part: SessionMessageAssistantTool; nested?: boolean }) {
  const ctx = use()
  const data = useData()
  const display = createMemo(() => toolDisplay(props.part.name))
  const hideParentSubagent = createMemo(() => display() === "subagent" && !data.session.get(ctx.sessionID)?.parentID)

  const toolprops = {
    get metadata() {
      return toolDisplayMetadata(props.part.state)
    },
    get input() {
      return typeof props.part.state.input === "string" ? {} : props.part.state.input
    },
    get output() {
      if (props.part.state.status === "streaming") return undefined
      if (props.part.state.status === "error") return props.part.state.error.message
      return props.part.state.content
        .flatMap((content) => (content.type === "text" ? [content.text] : [content.name ?? content.uri]))
        .join("\n")
    },
    get tool() {
      return props.part.name
    },
    get structured() {
      if (props.part.state.status === "streaming") return undefined
      return props.part.state.structured
    },
    get part() {
      return props.part
    },
    get nested() {
      return props.nested
    },
  }

  const rawOutput = createMemo(
    () => !["shell", "write", "edit", "patch", "question", "subagent", "skill", "todowrite"].includes(display()),
  )
  const presentation = createMemo(() =>
    props.part.state.status === "error"
      ? undefined
      : transcriptToolPresentation({
          tool: props.part.name,
          input: props.part.state.input,
          output: toolprops.output,
          structured: toolprops.structured,
        }),
  )
  const diffPresentation = createMemo(() => {
    const item = presentation()
    if (item?.type === "diff") return { files: [item] }
    if (item?.type === "diffs") return item
    return undefined
  })
  const commandPresentation = createMemo(() => {
    const item = presentation()
    return item?.type === "command" ? item : undefined
  })
  const activityPresentation = createMemo(() => {
    const state = props.part.state
    if (state.status !== "error" && !["generic", "shell", "subagent"].includes(display())) return
    const command = commandPresentation()
    const input = typeof state.input === "string" ? {} : state.input
    const publicInput = safeToolSummaryInput(input)
    const running = state.status === "streaming" || state.status === "running"
    // A command can complete successfully as a tool call while reporting failures in its output, so
    // the parsed result decides the marker. Board 13 shows `bun typecheck · 2 errors` as an error row.
    const commandFailed =
      command !== undefined && ("errors" in command.result ? command.result.errors > 0 : command.result.fail > 0)
    const shellID = stringValue(toolprops.metadata.shellID)
    const background =
      (display() === "subagent" && isBackgroundSubagent(toolprops.metadata, state.status)) ||
      (display() === "shell" && shellID !== undefined && data.shell.get(shellID) !== undefined)
    const tool =
      display() === "shell"
        ? (command?.command ?? safeToolDetailText(stringValue(input.command) ?? "shell"))
        : display() === "subagent"
          ? "subagent"
          : props.part.name
    const detail =
      display() === "shell"
        ? ""
        : display() === "subagent"
          ? [stringValue(input.agent) ?? stringValue(input.subagent_type), stringValue(input.description)]
              .filter(Boolean)
              .join(" · ")
          : primitiveInputSummary(publicInput)
    const response =
      state.status === "streaming"
        ? undefined
        : {
            content: state.content,
            structured: state.structured,
            ...((state.status === "completed" || state.status === "error") && state.result !== undefined
              ? { result: state.result }
              : {}),
          }
    return {
      tool,
      detail,
      variant:
        display() === "subagent" && !background && !running && state.status !== "error"
          ? ("subagent" as const)
          : undefined,
      lifecycle: toolLifecycle(props.part, {
        status: background ? "running" : state.status,
        failed: commandFailed,
        summary: background ? "background" : command ? commandStatus(command.result) : undefined,
      }),
      details: {
        request: boundedToolDetailLines(state.input),
        response: boundedToolDetailLines(response),
      },
    }
  })

  return (
    <Show when={!hideParentSubagent()}>
      <Switch>
        <Match when={diffPresentation()}>{(item) => <FileChangeBlock files={item().files} />}</Match>
        <Match when={activityPresentation()}>
          {(item) => (
            <SessionToolActivityRow
              tool={item().tool}
              detail={item().detail}
              variant={item().variant}
              lifecycle={item().lifecycle}
              details={item().details}
              width={ctx.width}
            />
          )}
        </Match>
        <Match when={commandPresentation()}>
          {(item) => {
            const result = item().result
            return (
              <SessionToolActivityRow
                tool={item().command}
                detail=""
                lifecycle={toolLifecycle(props.part, {
                  failed: "errors" in result ? result.errors > 0 : result.fail > 0,
                  summary: commandStatus(result),
                })}
                width={ctx.width}
              />
            )
          }}
        </Match>
        <Match when={display() === "shell"}>
          <Shell {...toolprops} />
        </Match>
        <Match when={display() === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={display() === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={display() === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={display() === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={display() === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={display() === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={display() === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={display() === "subagent"}>
          <Subagent {...toolprops} />
        </Match>
        <Match when={display() === "execute"}>
          <Execute {...toolprops} />
        </Match>
        <Match when={display() === "patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={display() === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={display() === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
      <Show when={rawOutput() && !presentation() && !activityPresentation()}>
        <ToolOutput
          output={display() === "execute" ? stripAnsi(toolprops.output ?? "") : toolprops.output}
          error={props.part.state.status === "error" || (display() === "execute" && toolprops.metadata.error === true)}
          nested={props.nested}
        />
      </Show>
    </Show>
  )
}

/**
 * File-editing tool results. A transcript is a conversation, so a change lands as a summary the
 * reader can scan — one header plus one row per file — and only opens into the full diff on the
 * transcript's usual expand interaction.
 */
function FileChangeBlock(props: { files: InlineDiffFile[]; label?: string; collapsed?: boolean }) {
  const { themeV2 } = useTheme()
  const renderer = useRenderer()
  const files = createMemo(() => inlineDiffGroups(props.files))
  const summary = createMemo(
    () => `${props.label ?? "Edited"} ${files().length} ${files().length === 1 ? "file" : "files"}`,
  )
  const [expanded, setExpanded] = createSignal(!props.collapsed)
  const counts = createMemo(() => {
    let created = 0
    let modified = 0
    let deleted = 0
    for (const file of files()) {
      if (file.status === "created") created++
      else if (file.status === "deleted") deleted++
      else modified++
    }
    return { created, modified, deleted }
  })
  const breakdown = createMemo(() => {
    const c = counts()
    const parts: string[] = []
    if (c.created) parts.push(`${c.created} created`)
    if (c.modified) parts.push(`${c.modified} modified`)
    if (c.deleted) parts.push(`${c.deleted} deleted`)
    return parts.join(" · ")
  })

  return (
    <box flexDirection="column">
      <box
        width="100%"
        flexDirection="row"
        paddingLeft={6}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          setExpanded((value) => !value)
        }}
      >
        <text width={2} flexShrink={0} fg={themeV2.text.subdued}>
          {expanded() ? "-" : "+"}
        </text>
        <text flexShrink={1} wrapMode="none" truncate={true} fg={themeV2.text.subdued}>
          {summary()}
        </text>
        <box flexGrow={1} />
        <Show when={breakdown()}>
          {(value) => (
            <text flexShrink={0} fg={themeV2.text.subdued} wrapMode="none" truncate={true}>
              {value()}
            </text>
          )}
        </Show>
      </box>
      <Show when={expanded()}>
        <For each={files()}>{(file) => <FileChangeRow file={file} />}</For>
      </Show>
    </box>
  )
}

function FileChangeRow(props: { file: InlineDiffGroup }) {
  const ctx = use()
  const { themeV2 } = useTheme()
  const pathFormatter = usePathFormatter()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  return (
    <>
      <box
        paddingLeft={8}
        flexDirection="row"
        width="100%"
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          setExpanded((value) => !value)
        }}
      >
        <text width={2} flexShrink={0} fg={themeV2.text.subdued}>
          {expanded() ? "-" : "+"}
        </text>
        <text flexShrink={1} wrapMode="none" truncate={true} fg={themeV2.text.default}>
          {pathFormatter.format(props.file.path)}
        </text>
        <box flexGrow={1} />
        <Show when={props.file.additions > 0}>
          <text flexShrink={0} fg={themeV2.diff.text.added} attributes={TextAttributes.BOLD}>
            +{props.file.additions}
          </text>
        </Show>
        <box width={3} flexShrink={0} />
        <Show when={props.file.deletions > 0}>
          <text flexShrink={0} fg={themeV2.diff.text.removed} attributes={TextAttributes.BOLD}>
            −{props.file.deletions}
          </text>
        </Show>
      </box>
      <Show when={expanded()}>
        <InlineDiff
          path={props.file.path}
          additions={props.file.additions}
          deletions={props.file.deletions}
          files={props.file.files}
          heading={false}
          wrapMode={ctx.diffWrapMode()}
        />
      </Show>
    </>
  )
}

type ToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: SessionMessageAssistantTool
  nested?: boolean
}

function toolLifecycle(
  part: SessionMessageAssistantTool,
  options: {
    status?: ToolLifecycleInput["status"]
    failed?: boolean
    cancelled?: boolean
    summary?: string
  } = {},
): ToolLifecycleInput {
  return {
    status: options.status ?? part.state.status,
    time: part.time,
    ...(part.state.status === "error" ? { error: part.state.error } : {}),
    ...(options.failed === undefined ? {} : { failed: options.failed }),
    ...(options.cancelled === undefined ? {} : { cancelled: options.cancelled }),
    ...(options.summary === undefined ? {} : { summary: options.summary }),
  }
}

function groupedToolLifecycle(parts: SessionMessageAssistantTool[]): ToolLifecycleInput {
  if (parts.length === 0) return { status: "streaming", time: {} }
  const running = parts.some((part) => part.state.status === "running")
  const streaming = parts.some((part) => part.state.status === "streaming")
  const errors = parts.filter((part) => part.state.status === "error")
  const status = running ? "running" : streaming ? "streaming" : errors.length > 0 ? "error" : "completed"
  const created = Math.min(...parts.map((part) => part.time.created))
  const ran = Math.min(...parts.map((part) => part.time.ran ?? part.time.created))
  const completions = parts.flatMap((part) => (part.time.completed === undefined ? [] : [part.time.completed]))
  const completed = completions.length === parts.length ? Math.max(...completions) : undefined
  const firstError = errors[0]
  return {
    status,
    time: { created, ran, ...(completed === undefined ? {} : { completed }) },
    ...(firstError?.state.status === "error" ? { error: firstError.state.error } : {}),
  }
}

type TranscriptToolPresentation =
  | { type: "diff"; diff: string; path?: string; additions?: number; deletions?: number }
  | {
      type: "diffs"
      files: Array<{ diff: string; path?: string; additions?: number; deletions?: number }>
    }
  | { type: "command"; command: string; result: InlineCommandResult }

export function transcriptToolPresentation(input: {
  tool: string
  input: unknown
  output?: string
  structured?: unknown
}): TranscriptToolPresentation | undefined {
  const files = recordValue(input.structured)?.files
  const diffs = Array.isArray(files)
    ? files.flatMap((value) => {
        const file = recordValue(value)
        const patch = stringValue(file?.patch)
        if (!patch || !parseInlineDiff(patch)) return []
        return [
          {
            diff: patch,
            path: stringValue(file?.file),
            additions: finiteNumber(file?.additions),
            deletions: finiteNumber(file?.deletions),
            status: stringValue(file?.status),
          },
        ]
      })
    : []
  if (diffs.length === 1) return { type: "diff", ...diffs[0] }
  if (diffs.length > 1) return { type: "diffs", files: diffs }
  if (input.output && parseInlineDiff(input.output)) return { type: "diff", diff: input.output }
  if (toolDisplay(input.tool) !== "shell") return undefined
  const command = stringValue(recordValue(input.input)?.command)
  const result = input.output ? parseInlineCommandResult(input.output) : undefined
  if (!command || !result) return undefined
  return { type: "command", command, result }
}

function capturedChangeFiles(messages: SessionMessageInfo[]): InlineDiffFile[] {
  return messages.flatMap((message) => {
    if (message.type !== "assistant") return []
    return message.content.flatMap((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return []
      if (!["edit", "patch"].includes(toolDisplay(part.name))) return []
      const presentation = transcriptToolPresentation({
        tool: part.name,
        input: part.state.input,
        structured: part.state.structured,
      })
      if (presentation?.type === "diff") return [presentation]
      if (presentation?.type === "diffs") return presentation.files
      return []
    })
  })
}

function durableCapturedChangeFiles(files: SessionEventFileChangeInfo[]): InlineDiffFile[] {
  return files.flatMap((file) => {
    if (!parseInlineDiff(file.patch)) return []
    return [{ diff: file.patch, path: file.path, additions: file.additions, deletions: file.deletions }]
  })
}

function commandStatus(result: InlineCommandResult) {
  if ("errors" in result) return `${result.errors} ${result.errors === 1 ? "error" : "errors"}`
  return `${result.pass} pass · ${result.fail} fail`
}

function safeToolSummaryInput(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      omitToolDetailField(key) || secretToolDetailField(key) ? [] : [[key, safeToolDetailText(String(value))]],
    ),
  )
}

function boundedToolDetailLines(value: unknown) {
  const lines = safeToolDetailLines(value)
  if (lines.length <= 80) return lines
  return [...lines.slice(0, 79), "… additional details omitted"]
}

function safeToolDetailLines(value: unknown, depth = 0): string[] {
  if (value === undefined || value === null) return []
  if (depth >= 5) return ["… nested details omitted"]
  if (typeof value === "string") return safeToolDetailText(value).split("\n").slice(0, 20)
  if (typeof value === "number" || typeof value === "boolean") return [String(value)]
  if (Array.isArray(value))
    return value.slice(0, 20).flatMap((item) => {
      const lines = safeToolDetailLines(item, depth + 1)
      if (lines.length === 0) return []
      if (lines.length === 1) return [`- ${lines[0]}`]
      return ["-", ...lines.map((line) => `  ${line}`)]
    })
  const record = recordValue(value)
  if (!record) return []
  return Object.entries(record)
    .slice(0, 30)
    .flatMap(([key, item]) => {
      if (omitToolDetailField(key)) return []
      if (secretToolDetailField(key)) return ["[sensitive field]: [redacted]"]
      const lines = safeToolDetailLines(item, depth + 1)
      if (lines.length === 0) return []
      if (lines.length === 1) return [`${key}: ${lines[0]}`]
      return [`${key}:`, ...lines.map((line) => `  ${line}`)]
    })
}

function toolDetailWords(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function omitToolDetailField(key: string) {
  const words = toolDetailWords(key)
  return (
    words.includes("headers") ||
    words.includes("header") ||
    words.includes("raw") ||
    (words.includes("request") && words.includes("id"))
  )
}

function secretToolDetailField(key: string) {
  const words = toolDetailWords(key)
  return ["key", "token", "secret", "password", "authorization", "cookie", "credential"].some((word) =>
    words.includes(word),
  )
}

function safeToolDetailText(value: string) {
  const text = stripAnsi(value).trim()
  if (!text) return ""
  if (
    /request[_ -]?id|invalid\s+x-api-key|bearer\s+\S+|authorization|api[_ -]?key|credential|password|cookie|secret/i.test(
      text,
    )
  )
    return "Sensitive response detail omitted."
  if (/^[\[{]/.test(text)) {
    try {
      const parsed = JSON.parse(text)
      const lines = safeToolDetailLines(parsed)
      if (lines.length > 0) return lines.slice(0, 20).join("\n")
    } catch {}
    return text.slice(0, 2000)
  }
  return text
}

function safeProviderErrorMessage(value: string) {
  return safeToolDetailText(value) || "Provider request failed."
}

function GenericTool(props: ToolProps) {
  const { themeV2, syntax } = useTheme()
  const args = createMemo(() => JSON.stringify(props.input, null, 2))
  const [expanded, setExpanded] = createSignal(false)
  const expandable = createMemo(() => Object.keys(props.input).length > 0)

  return (
    <BlockTool
      title={`◆ ${props.tool}`}
      part={props.part}
      spinner={props.part.state.status === "streaming" || props.part.state.status === "running"}
      onClick={expandable() ? () => setExpanded((value) => !value) : undefined}
    >
      <Show when={expanded()}>
        <box gap={1} paddingTop={1}>
          <Show when={Object.keys(props.input).length > 0}>
            <box gap={1}>
              <text>
                <span style={{ bg: themeV2.raise(themeV2.background.default), fg: themeV2.text.subdued }}> Input </span>
              </text>
              <box paddingLeft={1}>
                <code
                  content={args()}
                  filetype="json"
                  syntaxStyle={syntax()}
                  conceal={false}
                  drawUnstyledText={false}
                  fg={themeV2.text.default}
                />
              </box>
            </box>
          </Show>
        </box>
      </Show>
    </BlockTool>
  )
}

function ToolOutput(props: { output?: string; error: boolean; nested?: boolean }) {
  const ctx = use()
  const { themeV2 } = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const budget = createMemo(() => toolOutputBudget(ctx.width))
  const display = createMemo(() =>
    toolOutputDisplay(props.output ?? "", expanded(), budget().maxLines, budget().maxChars),
  )
  const toggle = () => {
    if (!display().expandable || renderer.getSelection()?.getSelectedText()) return
    setExpanded((value) => !value)
  }

  return (
    <Show when={display().visible}>
      <box
        paddingLeft={props.nested ? 5 : 3}
        flexDirection="column"
        flexShrink={0}
        onMouseUp={display().expandable ? toggle : undefined}
      >
        <text
          paddingLeft={3}
          fg={props.error ? themeV2.text.feedback.error.default : themeV2.text.subdued}
          wrapMode="word"
        >
          {prefixLines(display().output, display().expandable ? (expanded() ? "- " : "+ ") : "↳ ", "  ")}
        </text>
      </box>
    </Show>
  )
}

function SkillContent(props: { content: unknown }) {
  const ctx = use()
  const { themeV2 } = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [expanded, setExpanded] = createSignal(false)
  const budget = createMemo(() => toolOutputBudget(ctx.width))
  const height = createMemo(() => Math.max(3, Math.floor(dimensions().height / 3)))
  const display = createMemo(() =>
    toolOutputDisplay(sessionSkillContent(props.content), expanded(), budget().maxLines, budget().maxChars),
  )
  let content: BoxRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  const toggle = () => {
    if (!display().visible || renderer.getSelection()?.getSelectedText()) return
    setExpanded((value) => !value)
  }

  const onKeyDown = (key: { name: string }) => {
    if (key.name === "return" || key.name === "space") return toggle()
    if (!expanded()) return
    if (key.name === "up") return scroll?.scrollBy(-1)
    if (key.name === "down") return scroll?.scrollBy(1)
    if (key.name === "pageup") return scroll?.scrollBy(-height())
    if (key.name === "pagedown") return scroll?.scrollBy(height())
    if (key.name === "home") return scroll?.scrollTo(0)
    if (key.name === "end" && scroll) return scroll.scrollTo(scroll.scrollHeight)
  }

  return (
    <Show when={display().visible}>
      <box
        paddingLeft={6}
        flexDirection="column"
        flexShrink={0}
        focusable
        ref={(element: BoxRenderable) => (content = element)}
        onMouseDown={() => content?.focus()}
        onMouseUp={toggle}
        onKeyDown={onKeyDown}
      >
        <text fg={themeV2.text.subdued}>{expanded() ? "- Skill content" : "+ Skill content"}</text>
        <Show when={expanded()}>
          <scrollbox
            ref={(element: ScrollBoxRenderable) => (scroll = element)}
            maxHeight={height()}
            scrollbarOptions={{ visible: false }}
          >
            <text fg={themeV2.text.subdued} wrapMode="word">
              {prefixLines(display().output, " ", " ")}
            </text>
          </scrollbox>
        </Show>
      </box>
    </Show>
  )
}

function prefixLines(output: string, first: string, rest: string) {
  return output
    .split("\n")
    .map((line, index) => `${index === 0 ? first : rest}${line}`)
    .join("\n")
}

function InlineTool(props: {
  icon: string
  iconWidth?: number
  iconColor?: RGBA
  color?: RGBA
  completeColor?: RGBA
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  status?: JSX.Element
  lifecycle?: ToolLifecycleInput
  failed?: boolean
  children: JSX.Element
  part: SessionMessageAssistantTool
  onClick?: () => void
  paddingLeft?: number
}) {
  const { themeV2 } = useTheme()
  const ctx = use()
  const data = useData()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(false)

  const permission = createMemo(() => {
    const request = data.session.permission.list(ctx.sessionID)?.[0]
    return request?.source?.type === "tool" && request.source.callID === props.part.id
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error.message : undefined))
  const lifecycle = createMemo(() => props.lifecycle ?? toolLifecycle(props.part, { failed: props.failed }))
  const lifecyclePresentation = createMemo(() => toolLifecyclePresentation(lifecycle()))

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  const failed = createMemo(() => lifecyclePresentation().variant === "error" && !denied())
  const warning = createMemo(() => lifecyclePresentation().variant === "warning" && !denied())
  const clickable = createMemo(() => Boolean(props.onClick || error()))
  const fg = createMemo(() => {
    if (props.color) return props.color
    if (permission()) return themeV2.text.feedback.warning.default
    if (failed()) return themeV2.text.feedback.error.default
    if (props.complete && props.completeColor) return props.completeColor
    if (hover() && props.onClick) return themeV2.text.default
    return themeV2.text.subdued
  })

  return (
    <InlineToolRow
      icon={props.icon}
      iconColor={props.iconColor}
      color={fg()}
      errorColor={themeV2.text.feedback.error.default}
      failed={failed()}
      warning={warning()}
      denied={Boolean(denied())}
      error={error()}
      errorExpanded={errorExpanded()}
      complete={props.complete}
      pending={props.pending}
      failure={props.failure}
      spinner={props.spinner}
      status={
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Show when={props.status}>{(status) => status()}</Show>
          <ToolLifecycleStatus lifecycle={lifecycle()} />
        </box>
      }
      paddingLeft={props.paddingLeft}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        if (failed() && error()) {
          setErrorExpanded((value) => !value)
          return
        }
        props.onClick?.()
      }}
    >
      {props.children}
    </InlineToolRow>
  )
}

export function InlineToolRow(props: {
  icon: string
  iconWidth?: number
  iconColor?: RGBA
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  warning?: boolean
  denied?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  status?: JSX.Element
  children: JSX.Element
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: () => void
  paddingLeft?: number
}) {
  // Read the Session context optionally: this row is also mounted standalone by component tests and
  // by surfaces that have no Session above them, where a required read would throw.
  const ctx = useContext(context)
  // Read the theme optionally as well: this row is mounted standalone by component tests, where a
  // required read throws before anything renders. Callers already pass explicit colours.
  const themeV2 = useContext(ThemeContext)?.themeV2
  const errored = createMemo(() => Boolean(props.failed || props.warning || props.denied || props.error))
  const running = createMemo(() => Boolean(props.spinner || !props.complete) && !errored())
  const marker = createMemo(() => {
    if (errored()) return "!!"
    if (running()) return ".."
    if (props.icon === "◦") return "◦"
    return "ok"
  })
  const markerColor = createMemo(() => {
    if (props.failed) return props.errorColor ?? themeV2?.text.feedback.error.default
    if (props.warning) return themeV2?.text.feedback.warning.default
    if (props.denied) return themeV2?.text.feedback.warning.default
    if (running()) return themeV2?.text.feedback.info.default
    if (props.icon === "◦") return themeV2?.text.feedback.info.default
    return themeV2?.text.feedback.success.default
  })
  const label = () => {
    if (running()) return props.pending
    if (props.failed && !props.complete) return props.failure ?? props.children
    return props.children
  }
  return (
    <box
      width={ctx?.width}
      paddingLeft={props.paddingLeft ?? 1}
      flexDirection="column"
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={props.onMouseUp}
    >
      <box width="100%" border={["top"]} borderColor={themeV2?.border.default} flexDirection="row">
        <text
          width={2}
          flexShrink={0}
          fg={markerColor()}
          attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
        >
          {marker()}
        </text>
        <SessionActivitySpacer running={running()} color={markerColor()} />
        <text
          minWidth={0}
          flexShrink={1}
          wrapMode="none"
          truncate={true}
          fg={props.failed ? props.errorColor : (props.color ?? themeV2?.text.default)}
          attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
        >
          {label()}
        </text>
        <box flexGrow={1} />
        <Show when={props.status}>{(status) => status()}</Show>
      </box>
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={7} paddingTop={1}>
          <text fg={props.errorColor}>{safeToolDetailText(props.error ?? "")}</text>
        </box>
      </Show>
    </box>
  )
}

function StatusBadge(props: { children: string; color?: RGBA }) {
  const { themeV2 } = useTheme()
  return (
    <text flexShrink={0} bg={themeV2.raise(themeV2.background.default)} fg={props.color ?? themeV2.text.subdued}>
      {" "}
      {props.children}{" "}
    </text>
  )
}

function BlockTool(props: {
  title?: string
  path?: { label: string; value: string }
  children?: JSX.Element
  onClick?: () => void
  part?: SessionMessageAssistantTool
  spinner?: boolean
}) {
  const { themeV2 } = useTheme().contextual("elevated")
  const ctx = use()
  const data = useData()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error.message : undefined))
  const permission = createMemo(() => {
    if (!props.part) return false
    const request = data.session.permission.list(ctx.sessionID)?.[0]
    return request?.source?.type === "tool" && request.source.callID === props.part.id
  })
  const lifecycle = createMemo(() => (props.part ? toolLifecycle(props.part) : undefined))
  const lifecycleWidth = createMemo(() => {
    const item = lifecycle()
    return item ? stringWidth(toolLifecyclePresentation(item).status) + 1 : 0
  })
  return (
    <Show
      when={!props.spinner}
      fallback={
        <SessionToolActivityRow
          tool={(props.title ?? props.path?.label ?? "Working").replace(/^# /, "")}
          detail={props.path?.value ?? ""}
          lifecycle={lifecycle()}
          variant={props.part ? undefined : "running"}
          status={props.part ? undefined : "running"}
          width={ctx.width}
        />
      }
    >
      <box
        border={["left"]}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        gap={1}
        backgroundColor={hover() ? themeV2.raise(themeV2.background.default) : themeV2.background.default}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={themeV2.background.default}
        onMouseOver={() => props.onClick && setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          props.onClick?.()
        }}
      >
        <Show when={props.path || props.title || props.part}>
          <box width="100%" flexDirection="row" gap={1} minWidth={0}>
            <Show
              when={props.path}
              fallback={
                <Show when={props.title}>
                  {(title) => (
                    <text
                      flexShrink={1}
                      truncate
                      fg={permission() ? themeV2.text.feedback.warning.default : themeV2.text.subdued}
                    >
                      {title()}
                    </text>
                  )}
                </Show>
              }
            >
              {(path) => (
                <box flexDirection="row" gap={1} minWidth={0} flexShrink={1}>
                  <text flexShrink={0} fg={permission() ? themeV2.text.feedback.warning.default : themeV2.text.subdued}>
                    {path().label}
                  </text>
                  <FilePath
                    value={path().value}
                    maxWidth={Math.max(2, ctx.width - 4 - lifecycleWidth() - stringWidth(path().label))}
                    fg={permission() ? themeV2.text.feedback.warning.default : themeV2.text.subdued}
                  />
                </box>
              )}
            </Show>
            <box flexGrow={1} />
            <Show when={lifecycle()}>{(item) => <ToolLifecycleStatus lifecycle={item()} />}</Show>
          </box>
        </Show>
        {props.children}
        <Show when={error()}>
          <text fg={themeV2.text.feedback.error.default}>{safeToolDetailText(error() ?? "")}</text>
        </Show>
      </box>
    </Show>
  )
}

function Shell(props: ToolProps) {
  const { themeV2 } = useTheme()
  const ctx = use()
  const client = useClient()
  const data = useData()
  const permission = createMemo(() => {
    const request = data.session.permission.list(ctx.sessionID)?.[0]
    return request?.source?.type === "tool" && request.source.callID === props.part.id
  })
  const color = createMemo(() => (permission() ? themeV2.text.feedback.warning.default : themeV2.text.default))
  const shellID = createMemo(() => stringValue(props.metadata.shellID))
  const backgroundRunning = createMemo(() => {
    const id = shellID()
    return Boolean(id && data.shell.get(id))
  })
  const isRunning = createMemo(() => props.part.state.status === "running" || backgroundRunning())
  const command = createMemo(() => stringValue(props.input.command))
  const [expanded, setExpanded] = createSignal(false)
  const [backgroundOutput, setBackgroundOutput] = createSignal("")
  let loading = false
  const loadBackgroundOutput = async () => {
    const id = shellID()
    if (!id || loading) return
    loading = true
    const location = data.session.get(ctx.sessionID)?.location
    await client.api.shell
      .output({
        id,
        limit: 1024 * 1024,
        location: location ? { directory: location.directory, workspace: location.workspaceID } : undefined,
      })
      .then((response) => setBackgroundOutput(stripAnsi(response.data.output.trim())))
      .catch(() => undefined)
    loading = false
  }
  createEffect(() => {
    if (!expanded() || !backgroundRunning()) return
    const interval = setInterval(() => void loadBackgroundOutput(), 1_000)
    onCleanup(() => clearInterval(interval))
  })
  const output = createMemo(() => {
    if (props.part.state.status === "streaming") return ""
    if (shellID()) return expanded() ? backgroundOutput() : ""
    const content = props.part.state.content[0]
    return stripAnsi(content?.type === "text" ? content.text.trim() : "")
  })
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const input = createMemo(() => (command() ? `${isRunning() ? "" : "$ "}${command()}` : ""))
  const content = createMemo(() => [input(), output()].filter(Boolean).join("\n\n"))
  const collapsed = createMemo(() => collapseToolOutput(content(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return content()
    return collapsed().output
  })
  const expandable = createMemo(() => Boolean(shellID()) || collapsed().overflow)
  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    if (next) void loadBackgroundOutput()
  }

  return (
    <BlockTool part={props.part} onClick={expandable() ? toggle : undefined}>
      <box gap={1}>
        <Show
          when={command()}
          fallback={
            isRunning() || props.part.state.status === "streaming" ? (
              <Spinner color={color()}>Writing command...</Spinner>
            ) : (
              <text fg={themeV2.text.subdued}>Writing command...</text>
            )
          }
        >
          <Show
            when={isRunning()}
            fallback={
              <text>
                <span style={{ fg: themeV2.text.default }}>{limited().slice(0, input().length)}</span>
                <span style={{ fg: themeV2.text.subdued }}>{limited().slice(input().length)}</span>
              </text>
            }
          >
            <Spinner color={color()}>
              <span style={{ fg: themeV2.text.default }}>{limited().slice(0, input().length)}</span>
              <span style={{ fg: themeV2.text.subdued }}>{limited().slice(input().length)}</span>
            </Spinner>
          </Show>
        </Show>
        <Show when={shellID()}>
          <StatusBadge>Background</StatusBadge>
        </Show>
      </box>
    </BlockTool>
  )
}

function Write(props: ToolProps) {
  const { themeV2, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const code = createMemo(() => {
    return stringValue(props.input.content) ?? ""
  })

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool
          path={{ label: "# Wrote", value: pathFormatter.format(stringValue(props.input.path)) }}
          part={props.part}
        >
          <line_number fg={themeV2.text.subdued} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={themeV2.text.default}
              filetype={filetype(stringValue(props.input.path))}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.path) ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write..." complete={stringValue(props.input.path)} part={props.part}>
          Write {pathFormatter.format(stringValue(props.input.path))}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool
      icon="✱"
      pending="Finding files..."
      complete={stringValue(props.input.pattern)}
      part={props.part}
      paddingLeft={props.nested ? 8 : undefined}
    >
      Glob "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={finiteNumber(props.metadata.count)}>
        ({finiteNumber(props.metadata.count)} {finiteNumber(props.metadata.count) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps) {
  const { themeV2 } = useTheme()
  const pathFormatter = usePathFormatter()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon="→"
        pending="Reading file..."
        complete={stringValue(props.input.path)}
        spinner={isRunning()}
        part={props.part}
        paddingLeft={props.nested ? 8 : undefined}
      >
        Read {pathFormatter.format(stringValue(props.input.path))}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={props.nested ? 5 : 3}>
            <text paddingLeft={3} fg={themeV2.text.subdued}>
              ↳ Loaded {pathFormatter.format(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool
      icon="✱"
      pending="Searching content..."
      complete={stringValue(props.input.pattern)}
      part={props.part}
      paddingLeft={props.nested ? 8 : undefined}
    >
      Grep "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={finiteNumber(props.metadata.matches)}>
        ({finiteNumber(props.metadata.matches)} {finiteNumber(props.metadata.matches) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={stringValue(props.input.url)} part={props.part}>
      WebFetch {stringValue(props.input.url)}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps) {
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={stringValue(props.input.query)} part={props.part}>
      {webSearchProviderLabel(props.metadata.provider)} "{stringValue(props.input.query)}"{" "}
      <Show when={finiteNumber(props.metadata.numResults)}>({finiteNumber(props.metadata.numResults)} results)</Show>
    </InlineTool>
  )
}

function Subagent(props: ToolProps) {
  const { navigate } = useRoute()
  const data = useData()
  const sessionID = createMemo(() => stringValue(props.metadata.sessionID) ?? stringValue(props.metadata.sessionId))
  const description = createMemo(() => stringValue(props.input.description))
  const isRunning = createMemo(() => {
    const id = sessionID()
    return props.part.state.status === "running" || Boolean(id && data.session.status(id) === "running")
  })

  return (
    <InlineTool
      icon={isRunning() ? "│" : props.part.state.status === "completed" ? "✓" : "│"}
      spinner={isRunning()}
      complete={description()}
      pending="Delegating..."
      part={props.part}
      onClick={() => {
        const id = sessionID()
        if (id) navigate({ type: "session", sessionID: id })
      }}
      status={
        isBackgroundSubagent(props.metadata, props.part.state.status) ? (
          <StatusBadge>Background</StatusBadge>
        ) : undefined
      }
    >
      {`${Locale.titlecase(stringValue(props.input.agent) ?? stringValue(props.input.subagent_type) ?? "General")} Subagent — ${description() ?? "Subagent"}`}
    </InlineTool>
  )
}

export function isBackgroundSubagent(
  metadata: Record<string, unknown>,
  status: SessionMessageAssistantTool["state"]["status"],
) {
  return status === "completed" && metadata.status === "running"
}

export function formatSubagentRetry(attempt: number, message: string) {
  return `Retrying (attempt ${attempt}) · ${message}`
}

type ExecuteCall = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

function executeCalls(value: unknown): ExecuteCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    const item = recordValue(call)
    const tool = stringValue(item?.tool)
    const status = stringValue(item?.status)
    if (!tool || !status || !["running", "completed", "error"].includes(status)) return []
    return [{ tool, status: status as ExecuteCall["status"], input: recordValue(item?.input) }]
  })
}

// The `execute` tool streams child tool calls through metadata, not a child session like Task.
function Execute(props: ToolProps) {
  const { themeV2 } = useTheme()
  const isLoading = createMemo(() => props.part.state.status === "streaming" || props.part.state.status === "running")
  const calls = createMemo(() => executeCalls(props.metadata.toolCalls))
  const hasRuntimeError = createMemo(() => props.metadata.error === true)
  const content = createMemo(() => {
    const lines = ["execute"]
    for (const call of calls()) {
      const args = primitiveInputSummary(call.input ?? {})
      const status = call.status === "running" ? "running" : call.status === "completed" ? "done" : "failed"
      lines.push(`↳ ${call.tool}${args ? ` ${args}` : ""} · ${status}`)
    }
    return lines.join("\n")
  })

  return (
    <InlineTool
      icon={hasRuntimeError() ? "✗" : props.part.state.status === "completed" ? "✓" : "│"}
      color={hasRuntimeError() ? themeV2.text.feedback.error.default : undefined}
      spinner={isLoading()}
      pending={content()}
      complete={true}
      failed={hasRuntimeError()}
      lifecycle={toolLifecycle(props.part, { failed: hasRuntimeError() })}
      part={props.part}
    >
      {content()}
    </InlineTool>
  )
}

function Edit(props: ToolProps) {
  const ctx = use()
  const { themeV2, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const view = createMemo(() => {
    const diffView = ctx.config.diffs?.view
    if (diffView === "unified") return "unified"
    if (diffView === "split") return "split"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const file = createMemo(() => parseApplyPatchFiles(props.metadata.files)[0])
  const path = createMemo(() => file()?.relativePath ?? stringValue(props.input.path))

  return (
    <Switch>
      <Match when={file()}>
        {(item) => (
          <BlockTool path={{ label: "← Edit", value: pathFormatter.format(path()) }} part={props.part}>
            <box paddingLeft={1}>
              <diff
                diff={item().patch}
                view={view()}
                filetype={filetype(path())}
                syntaxStyle={syntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode={ctx.diffWrapMode()}
                fg={themeV2.text.default}
                addedBg={themeV2.diff.background.added}
                removedBg={themeV2.diff.background.removed}
                contextBg={themeV2.diff.background.context}
                addedSignColor={themeV2.diff.highlight.added}
                removedSignColor={themeV2.diff.highlight.removed}
                lineNumberFg={themeV2.diff.lineNumber.text}
                lineNumberBg={themeV2.diff.background.context}
                addedLineNumberBg={themeV2.diff.lineNumber.background.added}
                removedLineNumberBg={themeV2.diff.lineNumber.background.removed}
              />
            </box>
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.path) ?? ""} />
          </BlockTool>
        )}
      </Match>
      <Match when={true}>
        <BlockTool
          path={
            stringValue(props.input.path)
              ? { label: "← Edit", value: pathFormatter.format(stringValue(props.input.path)) }
              : undefined
          }
          title={stringValue(props.input.path) ? undefined : "# Preparing edit..."}
          part={props.part}
          spinner={props.part.state.status === "streaming"}
        />
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps) {
  const ctx = use()
  const { themeV2, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const files = createMemo(() => parseApplyPatchFiles(props.metadata.files))
  const targets = createMemo(() => {
    const patch = stringValue(props.input.patchText)
    if (!patch) return []
    return [...patch.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)/g)].map((match) => match[1].trim())
  })
  const applied = createMemo(() => {
    const applied = props.metadata.applied
    if (!Array.isArray(applied)) return []
    return applied.flatMap((value) => {
      const item = recordValue(value)
      const type = stringValue(item?.type)
      const resource = stringValue(item?.resource)
      return type && resource ? [{ type, resource }] : []
    })
  })
  const view = createMemo(() => {
    if (ctx.config.diffs?.view === "unified") return "unified"
    if (ctx.config.diffs?.view === "split") return "split"
    return ctx.width > 120 ? "split" : "unified"
  })

  return (
    <Switch>
      <Match when={files().length > 0}>
        <box flexDirection="column" gap={1}>
          <For each={files()}>
            {(file) => (
              <BlockTool
                path={{
                  label: file.type === "add" ? "# Created" : file.type === "delete" ? "# Deleted" : "← Patched",
                  value: pathFormatter.format(file.relativePath),
                }}
                part={props.part}
              >
                <Show
                  when={file.type !== "delete"}
                  fallback={
                    <text fg={themeV2.diff.text.removed}>
                      -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                    </text>
                  }
                >
                  <box paddingLeft={1}>
                    <diff
                      diff={file.patch}
                      view={view()}
                      filetype={filetype(file.relativePath)}
                      syntaxStyle={syntax()}
                      showLineNumbers={true}
                      width="100%"
                      wrapMode={ctx.diffWrapMode()}
                      fg={themeV2.text.default}
                      addedBg={themeV2.diff.background.added}
                      removedBg={themeV2.diff.background.removed}
                      contextBg={themeV2.diff.background.context}
                      addedSignColor={themeV2.diff.highlight.added}
                      removedSignColor={themeV2.diff.highlight.removed}
                      lineNumberFg={themeV2.diff.lineNumber.text}
                      lineNumberBg={themeV2.diff.background.context}
                      addedLineNumberBg={themeV2.diff.lineNumber.background.added}
                      removedLineNumberBg={themeV2.diff.lineNumber.background.removed}
                    />
                  </box>
                </Show>
              </BlockTool>
            )}
          </For>
        </box>
      </Match>
      <Match when={applied().length > 0}>
        <box flexDirection="column" gap={1}>
          <For each={applied()}>
            {(file) => (
              <BlockTool
                path={{
                  label: file.type === "add" ? "# Created" : file.type === "delete" ? "# Deleted" : "← Patched",
                  value: pathFormatter.format(file.resource),
                }}
                part={props.part}
              >
                <FilePath
                  value={file.resource}
                  maxWidth={Math.max(2, ctx.width - 3)}
                  fg={file.type === "delete" ? themeV2.diff.text.removed : themeV2.text.subdued}
                />
              </BlockTool>
            )}
          </For>
        </box>
      </Match>
      <Match when={true}>
        <SessionToolActivityRow
          tool={props.part.state.status === "error" ? "# Patch failed" : "Patching"}
          detail={targets().length === 1 ? pathFormatter.format(targets()[0]) : ""}
          lifecycle={toolLifecycle(props.part)}
          width={ctx.width}
        />
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps) {
  const { themeV2 } = useTheme()
  const questions = createMemo(() => parseQuestions(props.input.questions))
  const answers = createMemo(() => parseQuestionAnswers(props.metadata.answers))
  const count = createMemo(() => questions().length)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={answers()}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={questions()}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={themeV2.text.subdued}>{q.question}</text>
                  <text fg={themeV2.text.default}>{format(answers()?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps) {
  const { themeV2, mode } = useTheme()
  const accent = () => themeV2.hue.accent[mode() === "light" ? 700 : 200]
  const name = createMemo(() => stringValue(props.metadata.name) ?? stringValue(props.input.id))
  return (
    <>
      <InlineTool
        icon="✦"
        pending="Loading skill..."
        complete={props.part.state.status === "completed"}
        completeColor={props.part.state.status === "completed" ? themeV2.text.default : undefined}
        status={
          props.part.state.status === "completed" ? <StatusBadge color={accent()}>Loaded</StatusBadge> : undefined
        }
        part={props.part}
      >
        Skill "{name()}"
      </InlineTool>
      <Show when={props.part.state.status === "completed"}>
        <SkillContent content={props.output} />
      </Show>
    </>
  )
}

function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const { themeV2 } = useTheme()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const errors = createMemo(() => {
    const normalized = normalizePath(
      typeof props.filePath === "string" ? props.filePath : "",
      terminalEnvironment.platform,
    )
    return parseDiagnostics(props.diagnostics, normalized)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={themeV2.text.feedback.error.default}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

const toolDisplays = new Set([
  "shell",
  "glob",
  "read",
  "grep",
  "webfetch",
  "websearch",
  "write",
  "edit",
  "subagent",
  "execute",
  "patch",
  "question",
  "todowrite",
  "skill",
])

export function toolDisplay(tool: string) {
  const normalized = canonicalToolName(tool)
  return toolDisplays.has(normalized) ? normalized : "generic"
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function transcriptToolPartVisible(part: SessionMessageAssistantTool) {
  return (
    part.name !== "skill" ||
    part.state.status !== "completed" ||
    recordValue(recordValue(part.state)?.structured)?.alreadyActive !== true
  )
}

function formatSessionTranscript(session: SessionInfo, messages: SessionMessageInfo[], thinking: boolean) {
  const body = messages.flatMap((message) => {
    if (message.type === "user") return [`## User\n\n${message.text}`]
    if (message.type === "shell")
      return [`## Shell\n\n\`\`\`\n$ ${message.command}\n${message.output?.output ?? ""}\n\`\`\``]
    if (message.type !== "assistant") return []
    const content = message.content.flatMap((item) => {
      if (item.type === "text") return [item.text]
      if (item.type === "reasoning") return thinking ? [`_Thinking:_\n\n${item.text}`] : []
      const input = typeof item.state.input === "string" ? item.state.input : JSON.stringify(item.state.input, null, 2)
      const output =
        item.state.status === "error"
          ? item.state.error.message
          : item.state.status === "streaming"
            ? ""
            : item.state.content
                .flatMap((entry) => (entry.type === "text" ? [entry.text] : [entry.name ?? entry.uri]))
                .join("\n")
      return [`**Tool: ${item.name}**\n\n**Input:**\n\`\`\`json\n${input}\n\`\`\`\n\n${output}`]
    })
    return [`## Assistant\n\n${content.join("\n\n")}`]
  })
  return `# ${session.title}\n\n**Session ID:** ${session.id}\n**Created:** ${new Date(session.time.created).toLocaleString()}\n**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n---\n\n${body.join("\n\n---\n\n")}\n`
}

export function parseApplyPatchFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = recordValue(item)
    if (!file) return []
    const status = stringValue(file.status)
    const type =
      stringValue(file.type) ??
      (status === "added" ? "add" : status === "deleted" ? "delete" : status === "modified" ? "update" : undefined)
    const relativePath = stringValue(file.file) ?? stringValue(file.relativePath)
    const filePath = stringValue(file.filePath) ?? relativePath
    const patch = stringValue(file.patch)
    const additions = finiteNumber(file.additions)
    const deletions = finiteNumber(file.deletions)
    if (
      !type ||
      !relativePath ||
      !filePath ||
      patch === undefined ||
      additions === undefined ||
      deletions === undefined
    )
      return []
    return [{ type, relativePath, filePath, patch, additions, deletions, movePath: stringValue(file.movePath) }]
  })
}

export function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const question = stringValue(recordValue(item)?.question)
    return question ? [{ question }] : []
  })
}

export function parseQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) return
  return value.map((answer) =>
    Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
  )
}

export function parseDiagnostics(value: unknown, filePath: string) {
  const diagnostics = recordValue(value)?.[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .flatMap((item) => {
      const diagnostic = recordValue(item)
      const start = recordValue(recordValue(diagnostic?.range)?.start)
      const line = finiteNumber(start?.line)
      const character = finiteNumber(start?.character)
      const message = stringValue(diagnostic?.message)
      if (diagnostic?.severity !== 1 || line === undefined || character === undefined || !message) return []
      return [{ range: { start: { line, character } }, message }]
    })
    .slice(0, 3)
}
