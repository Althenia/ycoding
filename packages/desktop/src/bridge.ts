import { Electroview } from "electrobun/view"
import type { YCodingEvent } from "@ycoding-ai/client"
import type { ConnectionState, DesktopAPI, DesktopMenuAction } from "./contract"
import { DESKTOP_RPC_MAX_REQUEST_TIME, type DesktopRPCSchema } from "./rpc"

declare global {
  interface Window { __ycodingDesktop?: DesktopAPI }
}

const states = new Set<(state: ConnectionState) => void>()
const events = new Set<(event: YCodingEvent) => void>()
const resyncs = new Set<() => void>()
const menuActions = new Set<(action: DesktopMenuAction) => void>()
const rpc = Electroview.defineRPC<DesktopRPCSchema>({ maxRequestTime: DESKTOP_RPC_MAX_REQUEST_TIME, handlers: { messages: {
  state: (value) => { for (const callback of states) callback(value) },
  event: (value) => { for (const callback of events) callback(value) },
  resync: () => { for (const callback of resyncs) callback() },
  menuAction: (action) => { for (const callback of menuActions) callback(action) },
} } })
export const desktopRPC = rpc
if (window.__electrobunWebviewId) new Electroview({ rpc })
const api = () => window.__electrobunWebviewId ? undefined : window.__ycodingDesktop
type DesktopTransport = typeof rpc

export function createDesktopBridge(rpc: DesktopTransport, api: () => DesktopAPI | undefined): DesktopAPI {
return {
  readClipboard: () => api()?.readClipboard() ?? rpc.request.readClipboard(),
  writeClipboard: (input) => api()?.writeClipboard(input) ?? rpc.request.writeClipboard(input),
  checkForUpdates: () => api()?.checkForUpdates() ?? rpc.request.checkForUpdates(),
  installUpdate: (input) => api()?.installUpdate(input) ?? rpc.request.installUpdate(input),
  browseDirectory: (input) => api()?.browseDirectory(input) ?? rpc.request.browseDirectory(input),
  openDirectory: (input) => api()?.openDirectory(input) ?? rpc.request.openDirectory(input),
  createDirectory: (input) => api()?.createDirectory(input) ?? rpc.request.createDirectory(input),
  pickDirectory: (input) => api()?.pickDirectory(input) ?? rpc.request.pickDirectory(input),
  openExternalUrl: (input) => api()?.openExternalUrl(input) ?? rpc.request.openExternalUrl(input),
  integrations: (input) => api()?.integrations(input) ?? rpc.request.integrations(input),
  manageIntegration: (input) => api()?.manageIntegration(input) ?? rpc.request.manageIntegration(input),
  mcpServers: (input) => api()?.mcpServers(input) ?? rpc.request.mcpServers(input),
  manageMcp: (input) => api()?.manageMcp(input) ?? rpc.request.manageMcp(input),
  manageSession: (input) => api()?.manageSession(input) ?? rpc.request.manageSession(input),
  vcsDiff: (input) => api()?.vcsDiff(input) ?? rpc.request.vcsDiff(input),
  systemSnapshot: (input) => api()?.systemSnapshot(input) ?? rpc.request.systemSnapshot(input),
  manageSystem: (input) => api()?.manageSystem(input) ?? rpc.request.manageSystem(input),
  preferences: () => api()?.preferences() ?? rpc.request.preferences(),
  state: () => api()?.state() ?? rpc.request.state(),
  connect: (selection) => api()?.connect(selection) ?? rpc.request.connect(selection),
  disconnect: () => api()?.disconnect() ?? rpc.request.disconnect(),
  sessions: (query) => api()?.sessions(query) ?? rpc.request.sessions(query),
  session: (input) => api()?.session(input) ?? rpc.request.session(input),
  autonomy: (input) => api()?.autonomy(input) ?? rpc.request.autonomy(input),
  setAutonomy: (input) => api()?.setAutonomy(input) ?? rpc.request.setAutonomy(input),
  fileChanges: (sessionID) => api()?.fileChanges(sessionID) ?? rpc.request.fileChanges(sessionID),
  activity: (sessionID) => api()?.activity(sessionID) ?? rpc.request.activity(sessionID),
  shellOutput: (input) => api()?.shellOutput(input) ?? rpc.request.shellOutput(input),
  projects: (input) => api()?.projects(input) ?? rpc.request.projects(input),
  workspaceDirectories: (input) => api()?.workspaceDirectories(input) ?? rpc.request.workspaceDirectories(input),
  settings: () => api()?.settings() ?? rpc.request.settings(),
  changeSettings: (input) => api()?.changeSettings(input) ?? rpc.request.changeSettings(input),
  changeProject: (input) => api()?.changeProject(input) ?? rpc.request.changeProject(input),
  changeWorkspace: (input) => api()?.changeWorkspace(input) ?? rpc.request.changeWorkspace(input),
  usage: (input) => api()?.usage(input) ?? rpc.request.usage(input),
  revert: (input) => api()?.revert(input) ?? rpc.request.revert(input),
  pin: (request) => api()?.pin(request) ?? rpc.request.pin(request),
  workspaces: () => api()?.workspaces() ?? rpc.request.workspaces(),
  messages: (sessionID) => api()?.messages(sessionID) ?? rpc.request.messages(sessionID),
  createSession: (input) => api()?.createSession(input) ?? rpc.request.createSession(input),
  prompt: (input) => api()?.prompt(input) ?? rpc.request.prompt(input),
  interrupt: (sessionID) => api()?.interrupt(sessionID) ?? rpc.request.interrupt(sessionID),
  requests: (sessionID) => api()?.requests(sessionID) ?? rpc.request.requests(sessionID),
  reply: (input) => api()?.reply(input) ?? rpc.request.reply(input),
  models: (source) => api()?.models(source) ?? rpc.request.models(source),
  command: (input) => api()?.command(input) ?? rpc.request.command(input),
  compact: (input) => api()?.compact(input) ?? rpc.request.compact(input),
  composerCatalog: (source) => api()?.composerCatalog(source) ?? rpc.request.composerCatalog(source),
  findFiles: (input) => api()?.findFiles(input) ?? rpc.request.findFiles(input),
  switchModel: (input) => api()?.switchModel(input) ?? rpc.request.switchModel(input),
  onState: (callback) => api()?.onState(callback) ?? (states.add(callback), () => { states.delete(callback) }),
  onEvent: (callback) => api()?.onEvent(callback) ?? (events.add(callback), () => { events.delete(callback) }),
  onResync: (callback) => api()?.onResync(callback) ?? (resyncs.add(callback), () => { resyncs.delete(callback) }),
  onMenuAction: (callback) => api()?.onMenuAction(callback) ?? (menuActions.add(callback), () => { menuActions.delete(callback) }),
}
}

const implementation = createDesktopBridge(rpc, api)
export const desktop: DesktopAPI = {
  readClipboard: implementation.readClipboard,
  writeClipboard: implementation.writeClipboard,
  checkForUpdates: implementation.checkForUpdates,
  installUpdate: implementation.installUpdate,
  browseDirectory: implementation.browseDirectory,
  openDirectory: implementation.openDirectory,
  createDirectory: implementation.createDirectory,
  pickDirectory: implementation.pickDirectory,
  openExternalUrl: implementation.openExternalUrl,
  integrations: implementation.integrations,
  manageIntegration: implementation.manageIntegration,
  mcpServers: implementation.mcpServers,
  manageMcp: implementation.manageMcp,
  manageSession: implementation.manageSession,
  vcsDiff: implementation.vcsDiff,
  systemSnapshot: implementation.systemSnapshot,
  manageSystem: implementation.manageSystem,
  preferences: implementation.preferences,
  state: implementation.state,
  connect: implementation.connect,
  disconnect: implementation.disconnect,
  sessions: implementation.sessions,
  session: implementation.session,
  autonomy: implementation.autonomy,
  setAutonomy: implementation.setAutonomy,
  fileChanges: implementation.fileChanges,
  activity: implementation.activity,
  shellOutput: implementation.shellOutput,
  projects: implementation.projects,
  workspaceDirectories: implementation.workspaceDirectories,
  settings: implementation.settings,
  changeSettings: implementation.changeSettings,
  changeProject: implementation.changeProject,
  changeWorkspace: implementation.changeWorkspace,
  usage: implementation.usage,
  revert: implementation.revert,
  pin: implementation.pin,
  workspaces: implementation.workspaces,
  messages: implementation.messages,
  createSession: implementation.createSession,
  prompt: implementation.prompt,
  interrupt: implementation.interrupt,
  requests: implementation.requests,
  reply: implementation.reply,
  models: implementation.models,
  command: implementation.command,
  compact: implementation.compact,
  composerCatalog: implementation.composerCatalog,
  findFiles: implementation.findFiles,
  switchModel: implementation.switchModel,
  onState: implementation.onState,
  onEvent: implementation.onEvent,
  onResync: implementation.onResync,
  onMenuAction: implementation.onMenuAction,
}
