import type { YCodingEvent } from "@ycoding-ai/client"
import path from "node:path"
import type { ApplicationMenuItemConfig } from "electrobun/bun"
import type { ClipboardContent, ConnectionState, DesktopAPI, DesktopMenuAction, SavedExport, TranscriptExport, UpdateCheckResult, UpdateInstallResult } from "./contract"
import type { BackendController } from "./backend-controller"
import type { readPreferences, savePreferences, validateSelection } from "./preferences"
import type { Preferences, Selection } from "./contract"
import { DesktopError, utf8Length, validateClipboardWrite, validateInstallUpdateInput } from "./contract"

type RequestName = Exclude<keyof DesktopAPI, "onState" | "onEvent" | "onResync" | "onMenuAction">
type Requests = {
  [K in RequestName]: {
    params: Parameters<DesktopAPI[K]>[0]
    response: Awaited<ReturnType<DesktopAPI[K]>>
  }
}

export type DesktopRPCSchema = {
  bun: { requests: Requests; messages: Record<never, never> }
  webview: { requests: Record<never, never>; messages: { state: ConnectionState; event: YCodingEvent; resync: null; menuAction: DesktopMenuAction } }
}

export const DESKTOP_RPC_MAX_REQUEST_TIME = 60_000

export const DESKTOP_NAVIGATION_RULES = ["^*", "views://mainview/*"] as const

export function shouldAllowDesktopNavigation(value: string) {
  try {
    const url = new URL(value)
    return value.startsWith("views://mainview/") && url.protocol === "views:" && url.host === "mainview"
  } catch { return false }
}

export function forwardDesktopEvent<T>(value: T, send: { event: (value: T) => void; resync: (value: null) => void }) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16_384) send.resync(null)
  else send.event(value)
}

const STARTUP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const
const MENU_ACTIONS: readonly DesktopMenuAction[] = ["check-for-updates", "open-settings", "new-chat"]

export function buildDesktopApplicationMenu(appName = "YCoding Desktop"): ApplicationMenuItemConfig[] {
  return [
    {
      label: appName,
      submenu: [
        { role: "about" },
        { type: "divider" },
        { label: "Check for Updates…", action: "check-for-updates" },
        { label: "Settings…", action: "open-settings" },
        { type: "divider" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "divider" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Chat", action: "new-chat" },
        { type: "divider" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "divider" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    { label: "View", submenu: [{ role: "toggleFullScreen" }] },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "divider" },
        { role: "bringAllToFront" },
      ],
    },
  ]
}

export function menuActionFromEvent(event: unknown): DesktopMenuAction | undefined {
  const source = event as { readonly data?: { readonly action?: unknown }; readonly action?: unknown } | null | undefined
  const raw = source?.data?.action ?? source?.action
  if (typeof raw !== "string") return undefined
  const action = raw.startsWith("|EB|") ? raw.split("|").at(-1) : raw
  return MENU_ACTIONS.find((candidate) => candidate === action)
}

export function startDesktopConnection(
  preferences: Preferences,
  connect: (selection: Selection) => Promise<unknown>,
  log: (line: string) => void = console.error,
  options?: { readonly delaysMs?: readonly number[]; readonly signal?: AbortSignal },
): Promise<void> {
  const signal = options?.signal
  if (preferences.error !== undefined || signal?.aborted) return Promise.resolve()
  const selection = preferences.selection ?? { mode: "shared" as const }
  const delays = options?.delaysMs ?? STARTUP_RETRY_DELAYS_MS
  const attempt = async () => { await connect(selection) }
  const wait = (delayMs: number) => new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve() }
    const timer = setTimeout(finish, delayMs)
    signal?.addEventListener("abort", finish, { once: true })
  })
  const run = async (first: Promise<void>) => {
    for (let index = 0; ; index++) {
      try {
        await (index === 0 ? first : attempt())
        return
      } catch (error) {
        if (signal?.aborted) return
        log(`Desktop backend startup failed: ${error instanceof Error ? error.message : "unknown error"}`)
        const delayMs = delays[index]
        if (delayMs === undefined) return
        await wait(delayMs)
        if (signal?.aborted) return
      }
    }
  }
  return run(attempt())
}

export function externalURL(input: unknown) {
  if (typeof input !== "object" || input === null || Object.keys(input).some((key) => key !== "url") || !("url" in input) || typeof input.url !== "string" || utf8Length(input.url) > 8192) throw new DesktopError("Choose a valid HTTPS URL without credentials.")
  let url: URL
  try { url = new URL(input.url) } catch { throw new DesktopError("Choose a valid HTTPS URL without credentials.") }
  if (url.protocol !== "https:" || url.username || url.password) throw new DesktopError("Only HTTPS URLs without credentials can be opened externally.")
  return url.href
}

export function createDesktopRPC(controller: BackendController, preferences: {
  read: typeof readPreferences
  save: typeof savePreferences
  validate: typeof validateSelection
  path: string
}, host: { readonly pickDirectory?: (startingFolder?: string) => Promise<string | null>; readonly openExternal?: (url: string) => boolean | Promise<boolean>
  readonly readClipboard?: () => ClipboardContent | Promise<ClipboardContent>
  readonly writeClipboard?: (text: string) => void | Promise<void>
  readonly checkForUpdates?: () => Promise<UpdateCheckResult>
  readonly installUpdate?: (input: { readonly version?: string }) => Promise<UpdateInstallResult>
  readonly saveExport?: (exported: TranscriptExport, current: () => boolean) => Promise<SavedExport>
  readonly quit?: () => void | Promise<void>
  readonly notify?: (input: import("./contract").AttentionNotification) => void | Promise<void>
} = {}) {
  let notice: string | undefined
  let starting = false
  let generation = 0
  const handlers = {
    notify: async (input: Parameters<DesktopAPI["notify"]>[0]) => {
      if (!input || typeof input !== "object" || Object.keys(input).some((key) => key !== "kind" && key !== "silent") || !["request", "complete", "failure"].includes(input.kind) || typeof input.silent !== "boolean") throw new DesktopError("Choose a valid attention notification.")
      if (!host.notify) throw new DesktopError("Native notifications are unavailable in headless worker mode.")
      await host.notify({ kind: input.kind, silent: input.silent })
    },
    quit: async () => {
      if (!host.quit) throw new DesktopError("Quitting the native app is unavailable in headless worker mode.")
      generation++
      await controller.disconnect()
      await host.quit()
    },
    browseDirectory: (input?: Parameters<DesktopAPI["browseDirectory"]>[0]) => controller.browseDirectory(input),
    openDirectory: (input: Parameters<DesktopAPI["openDirectory"]>[0]) => controller.openDirectory(input),
    createDirectory: (input: Parameters<DesktopAPI["createDirectory"]>[0]) => controller.createDirectory(input),
    pickDirectory: async (input?: Parameters<DesktopAPI["pickDirectory"]>[0]) => {
      if (input !== undefined && (typeof input !== "object" || input === null || Object.keys(input).some((key) => key !== "startingFolder") || (input.startingFolder !== undefined && (typeof input.startingFolder !== "string" || !path.isAbsolute(input.startingFolder) || utf8Length(input.startingFolder) > 4096 || input.startingFolder.includes("\0"))))) throw new DesktopError("Choose an absolute starting folder.")
      if (!host.pickDirectory) throw new DesktopError("Native folder dialog is unavailable in headless worker mode; use Browse folders.")
      const selected = await host.pickDirectory(input?.startingFolder)
      const directory = selected === null || !selected.trim() ? null : selected
      if (directory !== null && (!path.isAbsolute(directory) || utf8Length(directory) > 4096 || directory.includes("\0"))) throw new DesktopError("The native dialog returned an invalid folder.")
      if (directory && controller.state().status === "connected") await controller.openDirectory({ directory }).catch(() => undefined)
      return { directory }
    },
    openExternalUrl: async (input: Parameters<DesktopAPI["openExternalUrl"]>[0]) => {
      const url = externalURL(input)
      if (!host.openExternal) throw new DesktopError("External browser launch is unavailable in headless worker mode.")
      return { opened: Boolean(await host.openExternal(url)) }
    },
    readClipboard: async () => {
      if (!host.readClipboard) throw new DesktopError("Clipboard access is unavailable.")
      return host.readClipboard()
    },
    writeClipboard: async (input: Parameters<DesktopAPI["writeClipboard"]>[0]) => {
      const valid = validateClipboardWrite(input)
      if (!host.writeClipboard) throw new DesktopError("Clipboard access is unavailable.")
      await host.writeClipboard(valid.text)
    },
    checkForUpdates: async () => {
      if (!host.checkForUpdates) throw new DesktopError("Updates are unavailable in this runtime.")
      return host.checkForUpdates()
    },
    installUpdate: async (input?: Parameters<DesktopAPI["installUpdate"]>[0]) => {
      const valid = validateInstallUpdateInput(input)
      if (!host.installUpdate) throw new DesktopError("Updates are unavailable in this runtime.")
      return host.installUpdate(valid)
    },
    integrations: (input?: Parameters<DesktopAPI["integrations"]>[0]) => controller.integrations(input),
    manageIntegration: (input: Parameters<DesktopAPI["manageIntegration"]>[0]) => controller.manageIntegration(input),
    mcpServers: (input?: Parameters<DesktopAPI["mcpServers"]>[0]) => controller.mcpServers(input),
    manageMcp: (input: Parameters<DesktopAPI["manageMcp"]>[0]) => controller.manageMcp(input),
    manageSession: (input: Parameters<DesktopAPI["manageSession"]>[0]) => controller.manageSession(input),
    vcsDiff: (input: Parameters<DesktopAPI["vcsDiff"]>[0]) => controller.vcsDiff(input),
    systemSnapshot: (input?: Parameters<DesktopAPI["systemSnapshot"]>[0]) => controller.systemSnapshot(input),
    manageSystem: (input: Parameters<DesktopAPI["manageSystem"]>[0]) => controller.manageSystem(input),
    interactionStatus: (input: Parameters<DesktopAPI["interactionStatus"]>[0]) => controller.interactionStatus(input),
    interactionPreview: (input: Parameters<DesktopAPI["interactionPreview"]>[0]) => controller.interactionPreview(input),
    interactionStop: (input: Parameters<DesktopAPI["interactionStop"]>[0]) => controller.interactionStop(input),
    interactionResume: (input: Parameters<DesktopAPI["interactionResume"]>[0]) => controller.interactionResume(input),
    interactionRequest: (input: Parameters<DesktopAPI["interactionRequest"]>[0]) => controller.interactionRequest(input),
    state: () => ({ ...controller.state(), ...(notice ? { notice } : {}) }),
    preferences: () => preferences.read(preferences.path),
    connect: async (input: Parameters<DesktopAPI["connect"]>[0]) => {
      if (starting) throw new DesktopError("A backend connection is pending. Cancel it before changing backend.")
      const selection = preferences.validate(input)
      starting = true
      const attempt = ++generation
      try {
        notice = undefined
        try { await preferences.save(preferences.path, selection) } catch { notice = "Backend choice was not saved. This connection is for this launch only." }
        if (attempt !== generation) throw new DesktopError("Backend connection was cancelled.")
        return { ...await controller.connect(selection), ...(notice ? { notice } : {}) }
      } finally { starting = false }
    },
    disconnect: () => { generation++; return controller.disconnect() },
    restartBackend: (input: Parameters<DesktopAPI["restartBackend"]>[0]) => controller.restartBackend(input),
    editorSelection: (input: Parameters<DesktopAPI["editorSelection"]>[0]) => controller.editorSelection(input),
    editDraft: (input: Parameters<DesktopAPI["editDraft"]>[0]) => controller.editDraft(input),
    sessions: (input: Parameters<DesktopAPI["sessions"]>[0]) => controller.sessions(input),
    session: (input: Parameters<DesktopAPI["session"]>[0]) => controller.session(input),
    autonomy: (input: Parameters<DesktopAPI["autonomy"]>[0]) => controller.autonomy(input),
    setAutonomy: (input: Parameters<DesktopAPI["setAutonomy"]>[0]) => controller.setAutonomy(input),
    fileChanges: (input: Parameters<DesktopAPI["fileChanges"]>[0]) => controller.fileChanges(input),
    activity: (input: Parameters<DesktopAPI["activity"]>[0]) => controller.activity(input),
    shellOutput: (input: Parameters<DesktopAPI["shellOutput"]>[0]) => controller.shellOutput(input),
    projects: (input?: Parameters<DesktopAPI["projects"]>[0]) => controller.projects(input),
    workspaceDirectories: (input: Parameters<DesktopAPI["workspaceDirectories"]>[0]) => controller.workspaceDirectories(input),
    settings: () => controller.settings(),
    changeSettings: (input: Parameters<DesktopAPI["changeSettings"]>[0]) => controller.changeSettings(input),
    changeProject: (input: Parameters<DesktopAPI["changeProject"]>[0]) => controller.changeProject(input),
    changeWorkspace: (input: Parameters<DesktopAPI["changeWorkspace"]>[0]) => controller.changeWorkspace(input),
    usage: (input?: Parameters<DesktopAPI["usage"]>[0]) => controller.usage(input),
    usageDashboard: (input?: Parameters<DesktopAPI["usageDashboard"]>[0]) => controller.usageDashboard(input),
    incidents: (input: Parameters<DesktopAPI["incidents"]>[0]) => controller.incidents(input),
    manageIncident: (input: Parameters<DesktopAPI["manageIncident"]>[0]) => controller.manageIncident(input),
    appendTelemetry: (input: Parameters<DesktopAPI["appendTelemetry"]>[0]) => controller.appendTelemetry(input),
    telemetryConsent: () => controller.telemetryConsent(),
    revert: (input: Parameters<DesktopAPI["revert"]>[0]) => controller.revert(input),
    pin: async (input: Parameters<DesktopAPI["pin"]>[0]) => { await controller.pin(input) },
    workspaces: () => controller.workspaces(),
    messages: (input: Parameters<DesktopAPI["messages"]>[0]) => controller.messages(input),
    createSession: (input: Parameters<DesktopAPI["createSession"]>[0]) => controller.createSession(input),
    prompt: (input: Parameters<DesktopAPI["prompt"]>[0]) => controller.prompt(input),
    interrupt: async (input: Parameters<DesktopAPI["interrupt"]>[0]) => { await controller.interrupt(input) },
    requests: (input: Parameters<DesktopAPI["requests"]>[0]) => controller.requests(input),
    reply: async (input: Parameters<DesktopAPI["reply"]>[0]) => { await controller.reply(input) },
    models: (input?: Parameters<DesktopAPI["models"]>[0]) => controller.models(input),
    command: (input: Parameters<DesktopAPI["command"]>[0]) => controller.command(input),
    compact: (input: Parameters<DesktopAPI["compact"]>[0]) => controller.compact(input),
    composerCatalog: (input?: Parameters<DesktopAPI["composerCatalog"]>[0]) => controller.composerCatalog(input),
    findFiles: (input: Parameters<DesktopAPI["findFiles"]>[0]) => controller.findFiles(input),
    switchModel: async (input: Parameters<DesktopAPI["switchModel"]>[0]) => { await controller.switchModel(input) },
    sessionSnapshot: (input: Parameters<DesktopAPI["sessionSnapshot"]>[0]) => controller.sessionSnapshot(input),
    pendingInputs: (input: Parameters<DesktopAPI["pendingInputs"]>[0]) => controller.pendingInputs(input),
    removePending: async (input: Parameters<DesktopAPI["removePending"]>[0]) => { await controller.removePending(input) },
    steerPending: async (input: Parameters<DesktopAPI["steerPending"]>[0]) => { await controller.steerPending(input) },
    deleteMessage: async (input: Parameters<DesktopAPI["deleteMessage"]>[0]) => { await controller.deleteMessage(input) },
    sessionAttachment: (input: Parameters<DesktopAPI["sessionAttachment"]>[0]) => controller.sessionAttachment(input),
    sessionInsights: (input: Parameters<DesktopAPI["sessionInsights"]>[0]) => controller.sessionInsights(input),
    switchAgent: async (input: Parameters<DesktopAPI["switchAgent"]>[0]) => { await controller.switchAgent(input) },
    activateSkill: async (input: Parameters<DesktopAPI["activateSkill"]>[0]) => { await controller.activateSkill(input) },
    runShell: async (input: Parameters<DesktopAPI["runShell"]>[0]) => { await controller.runShell(input) },
    sendEditorContext: (input: Parameters<DesktopAPI["sendEditorContext"]>[0]) => controller.sendEditorContext(input),
    openSideChat: (input: Parameters<DesktopAPI["openSideChat"]>[0]) => controller.openSideChat(input),
    steerParent: (input: Parameters<DesktopAPI["steerParent"]>[0]) => controller.steerParent(input),
    prediction: (input: Parameters<DesktopAPI["prediction"]>[0]) => controller.prediction(input),
    promptGenerate: (input: Parameters<DesktopAPI["promptGenerate"]>[0]) => controller.promptGenerate(input),
    terminals: (input: Parameters<DesktopAPI["terminals"]>[0]) => controller.terminals(input),
    terminal: (input: Parameters<DesktopAPI["terminal"]>[0]) => controller.terminal(input),
    terminalConnect: (input: Parameters<DesktopAPI["terminalConnect"]>[0]) => controller.terminalConnect(input),
    terminalRead: (input: Parameters<DesktopAPI["terminalRead"]>[0]) => controller.terminalRead(input),
    terminalWrite: async (input: Parameters<DesktopAPI["terminalWrite"]>[0]) => { await controller.terminalWrite(input) },
    terminalClose: async (input: Parameters<DesktopAPI["terminalClose"]>[0]) => { await controller.terminalClose(input) },
    terminalControl: (input: Parameters<DesktopAPI["terminalControl"]>[0]) => controller.terminalControl(input),
    terminalResize: (input: Parameters<DesktopAPI["terminalResize"]>[0]) => controller.terminalResize(input),
    exportSession: (input: Parameters<DesktopAPI["exportSession"]>[0]) => controller.exportSession(input),
    saveExportSession: async (input: Parameters<DesktopAPI["saveExportSession"]>[0]) => {
      if (!host.saveExport) throw new DesktopError("Saving exports to a folder is unavailable in this runtime. Copy the export instead.")
      const exported = await controller.exportSession(input)
      const started = controller.state()
      const changed = "The connection changed before the export was saved. Open export again."
      if (started.status !== "connected" || started.revision !== exported.revision) throw new DesktopError(changed)
      const current = () => { const state = controller.state(); return state.status === "connected" && state.generation === started.generation && state.revision === exported.revision }
      return host.saveExport(exported, current)
    },
    artifacts: (input: Parameters<DesktopAPI["artifacts"]>[0]) => controller.artifacts(input),
    artifact: (input: Parameters<DesktopAPI["artifact"]>[0]) => controller.artifact(input),
    manageArtifact: (input: Parameters<DesktopAPI["manageArtifact"]>[0]) => controller.manageArtifact(input),
  }
  return new Proxy(handlers, {
    get(target, key, receiver) {
      const handler: unknown = Reflect.get(target, key, receiver)
      if (typeof handler !== "function") return handler
      return async (...args: unknown[]) => {
        try { return await Reflect.apply(handler, target, args) }
        catch (error) {
          throw new Error(error instanceof DesktopError ? Array.from(error.message).slice(0, 512).join("") : "Native desktop request failed.")
        }
      }
    },
  })
}
