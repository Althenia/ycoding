import { SCHEMES, SCHEME_IDS, type SchemeID } from "../../theme/schemes"
import { themePreferenceLabel, type ThemePreference } from "../../theme/theme"
import { submission } from "./composer-logic"
import type { RemoteView } from "./shell-model"

export const paletteGroups = ["Session", "Commands", "Skills", "Navigation", "Settings", "Account"] as const

export type PaletteGroup = (typeof paletteGroups)[number]

export type PaletteIntent =
  | { readonly type: "compact" }
  | { readonly type: "interrupt" }
  | { readonly type: "stopGoal" }
  | { readonly type: "yolo"; readonly enabled: boolean }
  | { readonly type: "autoPermission"; readonly enabled: boolean }
  | { readonly type: "autoGuardrail"; readonly enabled: boolean }
  | { readonly type: "autoAnswer"; readonly enabled: boolean }
  | { readonly type: "sleep"; readonly sleep: boolean }
  | { readonly type: "keepAwake" }
  | { readonly type: "skill"; readonly skill: string }
  | { readonly type: "draft"; readonly text: string }
  | { readonly type: "go"; readonly view: "new" | "sessions" | "session" | "usage" | "settings" }
  | { readonly type: "openSession"; readonly sessionID: string }
  | { readonly type: "team" }
  | { readonly type: "device"; readonly deviceID: string }
  | { readonly type: "workspace"; readonly workspaceID: string }
  | { readonly type: "theme"; readonly preference: ThemePreference }
  | { readonly type: "scheme"; readonly scheme: SchemeID }
  | { readonly type: "readNotifications" }
  | { readonly type: "reconnect" }
  | { readonly type: "model" }
  | { readonly type: "connectProvider" }
  | { readonly type: "signOut" }

export type PaletteAction = {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly group: PaletteGroup
  /** Extra search terms: slash names, aliases, and nouns the title does not contain. */
  readonly keywords: string
  readonly intent: PaletteIntent
}

export type PaletteContext = {
  readonly view: RemoteView
  readonly connected: boolean
  readonly canCreateSession: boolean
  readonly canSelectModel: boolean
  readonly canConnectProvider: boolean
  /** Present only while a Session of the connected machine is selected. */
  readonly session?: {
    readonly id: string
    readonly running: boolean
    readonly managedChild: boolean
    readonly yolo: boolean
    readonly autoPermission?: boolean
    readonly autoGuardrail?: boolean
    readonly autoAnswer?: boolean
    readonly goalActive: boolean
    readonly asleep?: boolean
  }
  readonly commands: readonly { readonly name: string; readonly description?: string }[]
  readonly skills: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
  readonly sessions: readonly { readonly id: string; readonly title: string; readonly running?: boolean; readonly archived: boolean }[]
  readonly devices: readonly { readonly id: string; readonly name: string; readonly online: boolean; readonly active: boolean }[]
  readonly activeDeviceID?: string
  readonly workspaces: readonly { readonly id: string; readonly label: string }[]
  readonly selectedWorkspaceID?: string
  readonly theme: ThemePreference
  readonly scheme: SchemeID
  readonly unreadNotifications: number
  readonly canReconnect: boolean
  readonly hasTeam: boolean
  readonly signedIn: boolean
}

const themePreferences = ["system", "light", "dark"] as const

/** Every action available in the current view and state, in display order. */
export function paletteActions(context: PaletteContext): readonly PaletteAction[] {
  return [
    ...sessionActions(context),
    ...commandActions(context),
    ...skillActions(context),
    ...navigationActions(context),
    ...settingsActions(context),
    ...accountActions(context),
  ]
}

function sessionActions(context: PaletteContext): readonly PaletteAction[] {
  const session = context.session
  if (!session) return []
  const interrupt: PaletteAction[] = session.running
    ? [{ id: "session.interrupt", title: "Interrupt session", description: "Stop the running step", group: "Session", keywords: "stop cancel halt", intent: { type: "interrupt" } }]
    : []
  if (!context.connected) return []
  if (session.managedChild) return interrupt
  return [
    ...interrupt,
    { id: "session.compact", title: "Compact session", description: "Summarize earlier context", group: "Session", keywords: "/compact /summarize summarize context", intent: { type: "compact" } },
    { id: "session.goal", title: "Set goal…", description: "Start an autonomous goal in the composer", group: "Session", keywords: "/goal autonomous autonomy", intent: { type: "draft", text: "/goal " } },
    { id: "session.suggest", title: "Suggest next message", description: "Suggest your next message", group: "Session", keywords: "/suggest prediction next message", intent: { type: "draft", text: "/suggest " } },
    { id: "session.prompt", title: "Generate prompt", description: "Generate a prompt from a rough intent", group: "Session", keywords: "/prompt generate prompt", intent: { type: "draft", text: "/prompt " } },
    ...(session.goalActive
      ? [{ id: "session.goal.stop", title: "Stop goal", description: "End the active autonomous goal", group: "Session" as const, keywords: "goal autonomous cancel", intent: { type: "stopGoal" as const } }]
      : []),
    {
      id: "session.yolo",
      title: session.yolo ? "Turn off YOLO for this Session" : "Turn on YOLO for this Session",
      description: session.yolo ? "Requests YOLO would evaluate wait for you" : "YOLO evaluates requests it can settle; denies block and hard reviews still need your approval",
      group: "Session" as const,
      keywords: "/yolo autonomy evaluation approval",
      intent: { type: "yolo" as const, enabled: !session.yolo },
    },
    ...(session.autoPermission === undefined ? [] : [{
      id: "session.autoPermission",
      title: session.autoPermission ? "Turn off auto-permission for this Session" : "Turn on auto-permission for this Session",
      description: session.autoPermission ? "Ask-level tool permissions wait for you" : "Auto-approve ask-level tool permissions; denies still block",
      group: "Session" as const,
      keywords: "/auto-permission autonomy tool permissions approval",
      intent: { type: "autoPermission" as const, enabled: !session.autoPermission },
    }]),
    ...(session.autoGuardrail === undefined ? [] : [{
      id: "session.autoGuardrail",
      title: session.autoGuardrail ? "Turn off auto-guardrail for this Session" : "Turn on auto-guardrail for this Session",
      description: session.autoGuardrail ? "Routine guardrail reviews wait for you" : "Auto-approve routine guardrail reviews while awake; hard reviews still need your approval",
      group: "Session" as const,
      keywords: "/auto-guardrail autonomy routine reviews guardrails",
      intent: { type: "autoGuardrail" as const, enabled: !session.autoGuardrail },
    }]),
    ...(session.autoAnswer === undefined ? [] : [{
      id: "session.autoAnswer",
      title: session.autoAnswer ? "Turn off auto-answer for this Session" : "Turn on auto-answer for this Session",
      description: session.autoAnswer ? "New questions and forms wait for you; while asleep, they go to Review" : "Answer new questions and forms for this Session; items already in Review stay yours",
      group: "Session" as const,
      keywords: "/auto-answer autonomy questions forms sleep",
      intent: { type: "autoAnswer" as const, enabled: !session.autoAnswer },
    }]),
    ...(session.asleep === undefined ? [] : [session.asleep
      ? { id: "session.wake", title: "Wake Session family", description: "End sleep; configured automation stays in effect", group: "Session" as const, keywords: "/wake sleep autonomy", intent: { type: "sleep" as const, sleep: false } }
      : { id: "session.sleep", title: "Sleep Session family", description: "Unsettled questions and reviews wait for you in Review", group: "Session" as const, keywords: "/sleep autonomy away", intent: { type: "sleep" as const, sleep: true } }]),
    { id: "machine.keepAwake", title: "Toggle keep machine awake", description: "Flip this machine's manual keep-awake preference", group: "Session" as const, keywords: "/keep-awake machine sleep lid", intent: { type: "keepAwake" as const } },
  ]
}

function commandActions(context: PaletteContext): readonly PaletteAction[] {
  const session = context.session
  if (!session || !context.connected || session.managedChild) return []
  return context.commands
    .filter((command) => !["compact", "goal", "yolo", "auto-permission", "auto-guardrail", "auto-answer", "suggest", "prompt", "sleep", "wake", "keep-awake"].includes(command.name))
    .filter((command) => submission(`/${command.name}`, [], {
      status: "ready",
      agents: [],
      models: [],
      commands: context.commands,
      skills: [],
      references: [],
      resources: [],
    }, "steer").kind !== "invalid")
    .map((command) => ({
      id: `command.${command.name}`,
      title: `/${command.name}`,
      description: command.description,
      group: "Commands" as const,
      keywords: `command ${command.name}`,
      intent: { type: "draft" as const, text: `/${command.name} ` },
    }))
}

function skillActions(context: PaletteContext): readonly PaletteAction[] {
  const session = context.session
  if (!session || !context.connected || session.managedChild) return []
  return context.skills.map((skill) => ({
    id: `skill.${skill.id}`,
    title: `Activate skill: ${skill.name}`,
    description: skill.description,
    group: "Skills" as const,
    keywords: `skill $${skill.id} ${skill.id}`,
    intent: { type: "skill" as const, skill: skill.id },
  }))
}

function navigationActions(context: PaletteContext): readonly PaletteAction[] {
  const go = (view: "new" | "sessions" | "session" | "usage" | "settings"): PaletteIntent => ({ type: "go", view })
  return [
    ...(context.canCreateSession && context.view !== "/remote"
      ? [{ id: "nav.new", title: "New session", description: "Start a conversation on this machine", group: "Navigation" as const, keywords: "create conversation chat", intent: go("new") }]
      : []),
    ...(context.session && context.view !== "/remote/session"
      ? [{ id: "nav.session", title: "Go to session", description: "Return to the open conversation", group: "Navigation" as const, keywords: "conversation chat", intent: go("session") }]
      : []),
    ...(context.view === "/remote/sessions" ? [] : [{ id: "nav.sessions", title: "Go to Sessions", description: "Browse every session", group: "Navigation" as const, keywords: "list sessions", intent: go("sessions") }]),
    ...(context.view === "/remote/usage" ? [] : [{ id: "nav.usage", title: "Go to Usage", description: "Spend, tokens, and provider quotas", group: "Navigation" as const, keywords: "cost quota", intent: go("usage") }]),
    ...(context.view === "/remote/settings" ? [] : [{ id: "nav.settings", title: "Go to Settings", description: "Machine, account, app, and notifications", group: "Navigation" as const, keywords: "preferences configuration", intent: go("settings") }]),
    ...(context.hasTeam ? [{ id: "nav.team", title: "Open Team", description: "Subagents, shells, and side chats", group: "Navigation" as const, keywords: "subagents children shells side chats", intent: { type: "team" as const } }] : []),
    ...context.sessions
      .filter((session) => session.id !== context.session?.id && !session.archived)
      .map((session) => ({
        id: `session.open.${session.id}`,
        title: `Open session: ${session.title}`,
        description: session.running === true ? "Running" : undefined,
        group: "Navigation" as const,
        keywords: "switch conversation",
        intent: { type: "openSession" as const, sessionID: session.id },
      })),
    ...context.devices
      .filter((device) => device.online && !device.active)
      .map((device) => ({
        id: `device.switch.${device.id}`,
        title: `Switch machine: ${device.name}`,
        description: "Online",
        group: "Navigation" as const,
        keywords: "device computer connect",
        intent: { type: "device" as const, deviceID: device.id },
      })),
    ...context.workspaces
      .filter((workspace) => workspace.id !== context.selectedWorkspaceID)
      .map((workspace) => ({
        id: `workspace.select.${workspace.id}`,
        title: `Switch workspace: ${workspace.label}`,
        group: "Navigation" as const,
        keywords: "project directory folder",
        intent: { type: "workspace" as const, workspaceID: workspace.id },
      })),
  ]
}

function settingsActions(context: PaletteContext): readonly PaletteAction[] {
  return [
    ...(context.connected && context.canSelectModel && (context.view === "/remote" || !context.session?.managedChild)
      ? [{ id: "settings.model", title: "Select provider and model…", description: "Choose a model, profile, and reasoning effort", group: "Settings" as const, keywords: "/models /model provider profile variant account", intent: { type: "model" as const } }]
      : []),
    ...(context.connected && context.canConnectProvider
      ? [{ id: "settings.provider.connect", title: "Connect provider…", description: "Add or replace a profile on this machine", group: "Settings" as const, keywords: "/connect integration login account credentials", intent: { type: "connectProvider" as const } }]
      : []),
    ...themePreferences
      .filter((preference) => preference !== context.theme)
      .map((preference) => ({
        id: `theme.${preference}`,
        title: `Theme: ${themePreferenceLabel(preference)}`,
        description: preference === "system" ? "Follow the device appearance" : `Use the ${preference} appearance`,
        group: "Settings" as const,
        keywords: "appearance color scheme dark light toggle",
        intent: { type: "theme" as const, preference },
      })),
    ...SCHEME_IDS
      .filter((scheme) => scheme !== context.scheme)
      .map((scheme) => ({
        id: `scheme.${scheme}`,
        title: `Color scheme: ${SCHEMES[scheme].label}`,
        description: `Use the ${SCHEMES[scheme].label} color palette`,
        group: "Settings" as const,
        keywords: "appearance color theme palette contrast",
        intent: { type: "scheme" as const, scheme },
      })),
    ...(context.view === "/remote/settings"
      ? []
      : [
          { id: "settings.machine", title: "Keep machine awake…", description: "Open Settings → Machine", group: "Settings" as const, keywords: "sleep caffeinate machine awake", intent: { type: "go" as const, view: "settings" as const } },
          { id: "settings.notifications", title: "Notification settings", description: "Open Settings → Notifications", group: "Settings" as const, keywords: "alerts push", intent: { type: "go" as const, view: "settings" as const } },
        ]),
    ...(context.unreadNotifications > 0
      ? [{ id: "notifications.read", title: "Mark all notifications read", description: `${context.unreadNotifications} unread`, group: "Settings" as const, keywords: "clear alerts", intent: { type: "readNotifications" as const } }]
      : []),
  ]
}

function accountActions(context: PaletteContext): readonly PaletteAction[] {
  return [
    ...(context.canReconnect ? [{ id: "account.reconnect", title: "Reconnect to machine", description: "Open a fresh relay connection", group: "Account" as const, keywords: "connection relay retry", intent: { type: "reconnect" as const } }] : []),
    ...(context.signedIn ? [{ id: "account.signout", title: "Sign out", description: "End this browser's workspace session", group: "Account" as const, keywords: "log out logout account", intent: { type: "signOut" as const } }] : []),
  ]
}

/**
 * Narrows and ranks actions for a query. Every whitespace-separated term must match; a
 * leading slash is ignored so `/compact` finds the action its keywords name. Equal scores
 * keep their display order.
 */
export function filterPaletteActions(actions: readonly PaletteAction[], query: string): readonly PaletteAction[] {
  const terms = query.toLowerCase().split(/\s+/).map((term) => term.replace(/^[/$]/, "")).filter((term) => term.length > 0)
  if (terms.length === 0) return actions
  return actions
    .filter((action) => !query.trimStart().startsWith("$") || action.group === "Skills")
    .map((action, index) => ({ action, index, score: rank(action, terms) }))
    .filter((entry): entry is { action: PaletteAction; index: number; score: number } => entry.score !== undefined)
    .toSorted((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.action)
}

function rank(action: PaletteAction, terms: readonly string[]): number | undefined {
  const scores = terms.map((term) => termScore(action, term))
  return scores.includes(0) ? undefined : scores.reduce((total, score) => total + score, 0)
}

function termScore(action: PaletteAction, term: string): number {
  const title = action.title.toLowerCase().replace(/^\//, "")
  if (title.startsWith(term)) return 100
  if (title.split(/[^a-z0-9]+/).some((word) => word.startsWith(term))) return 80
  if (title.includes(term)) return 60
  if (action.keywords.toLowerCase().split(/\s+/).some((word) => word.replace(/^[/$]/, "").startsWith(term))) return 50
  if (action.keywords.toLowerCase().includes(term)) return 40
  if (action.group.toLowerCase().includes(term)) return 20
  if (action.description?.toLowerCase().includes(term)) return 15
  return isSubsequence(term, title) ? 10 : 0
}

function isSubsequence(term: string, text: string): boolean {
  let index = 0
  for (const character of text) if (character === term[index]) index += 1
  return index === term.length
}

export type PaletteSection = { readonly group: PaletteGroup | undefined; readonly actions: readonly PaletteAction[] }

/**
 * Display sections: Session leads inside a Session and Navigation leads elsewhere. A ranked
 * result list is one section without a group so relevance order is preserved.
 */
export function paletteSections(actions: readonly PaletteAction[], view: RemoteView, ranked: boolean): readonly PaletteSection[] {
  if (ranked) return actions.length === 0 ? [] : [{ group: undefined, actions }]
  const order = view === "/remote/session" ? paletteGroups : ["Navigation", ...paletteGroups.filter((group) => group !== "Navigation")] as readonly PaletteGroup[]
  return order.flatMap((group) => {
    const members = actions.filter((action) => action.group === group)
    return members.length === 0 ? [] : [{ group, actions: members }]
  })
}
