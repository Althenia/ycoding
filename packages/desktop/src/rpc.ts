import type { YCodingEvent } from "@ycoding-ai/client"
import path from "node:path"
import type { ConnectionState, DesktopAPI } from "./contract"
import type { BackendController } from "./backend-controller"
import type { readPreferences, savePreferences, validateSelection } from "./preferences"
import type { Preferences, Selection } from "./contract"
import { DesktopError, utf8Length } from "./contract"

type RequestName = Exclude<keyof DesktopAPI, "onState" | "onEvent" | "onResync">
type Requests = {
  [K in RequestName]: {
    params: Parameters<DesktopAPI[K]>[0]
    response: Awaited<ReturnType<DesktopAPI[K]>>
  }
}

export type DesktopRPCSchema = {
  bun: { requests: Requests; messages: Record<never, never> }
  webview: { requests: Record<never, never>; messages: { state: ConnectionState; event: YCodingEvent; resync: null } }
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

export function startDesktopConnection(preferences: Preferences, connect: (selection: Selection) => Promise<unknown>, log: (line: string) => void = console.error) {
  if (preferences.error !== undefined) return
  void connect(preferences.selection ?? { mode: "shared" }).catch((error: unknown) => { log(`Desktop backend startup failed: ${error instanceof Error ? error.message : "unknown error"}`) })
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
}, host: { readonly pickDirectory?: (startingFolder?: string) => Promise<string | null>; readonly openExternal?: (url: string) => boolean | Promise<boolean> } = {}) {
  let notice: string | undefined
  let starting = false
  let generation = 0
  const handlers = {
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
    integrations: (input?: Parameters<DesktopAPI["integrations"]>[0]) => controller.integrations(input),
    manageIntegration: (input: Parameters<DesktopAPI["manageIntegration"]>[0]) => controller.manageIntegration(input),
    mcpServers: (input?: Parameters<DesktopAPI["mcpServers"]>[0]) => controller.mcpServers(input),
    manageMcp: (input: Parameters<DesktopAPI["manageMcp"]>[0]) => controller.manageMcp(input),
    manageSession: (input: Parameters<DesktopAPI["manageSession"]>[0]) => controller.manageSession(input),
    vcsDiff: (input: Parameters<DesktopAPI["vcsDiff"]>[0]) => controller.vcsDiff(input),
    systemSnapshot: (input?: Parameters<DesktopAPI["systemSnapshot"]>[0]) => controller.systemSnapshot(input),
    manageSystem: (input: Parameters<DesktopAPI["manageSystem"]>[0]) => controller.manageSystem(input),
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
