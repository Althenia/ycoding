import type { YCodingClient, YCodingEvent } from "@ycoding-ai/client"

export class DesktopError extends Error {}

const encoder = new TextEncoder()
export const utf8Length = (value: string) => encoder.encode(value).length

export type Selection = { readonly mode: "own" } | { readonly mode: "shared"; readonly server?: string }
export type Preferences = { readonly selection?: Selection; readonly sharedEndpoint?: string; readonly error?: string }
export type ConnectionState = {
  readonly generation: number
  readonly status: "idle" | "connecting" | "connected" | "reconnecting" | "error"
  readonly mode?: Selection["mode"]
  readonly revision?: number
  readonly version?: string
  readonly backendPID?: number
  readonly error?: string
  readonly notice?: string
}
export type SessionsQuery =
  | { readonly search?: string; readonly revision?: never; readonly cursor?: never }
  | { readonly revision: number; readonly cursor: string; readonly search?: never }
export type SessionItem = {
  readonly id: string
  readonly parentID?: string
  readonly title: string
  readonly location: { readonly directory: string }
  readonly time: { readonly updated: number; readonly active?: number; readonly archived?: number; readonly pinned?: number }
  readonly agent?: string
  readonly model?: { readonly id: string; readonly providerID: string }
  readonly tokens: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cache: { readonly read: number; readonly write: number } }
  readonly cost: number
}
export type Sessions = { readonly revision: number; readonly items: readonly SessionItem[]; readonly next?: string }
export type SessionRead = { readonly revision: number; readonly item: SessionItem }
export type PinRequest = { readonly sessionID: string; readonly revision: number; readonly pinned: boolean }
export type Session = Awaited<ReturnType<YCodingClient["session"]["create"]>>
export type Messages = Awaited<ReturnType<YCodingClient["message"]["list"]>>
export type Workspace = { readonly directory: string; readonly name?: string }
export type NewSession = { readonly directory: string; readonly sessionID: string }
export type Prompt = { readonly sessionID: string; readonly promptID: string; readonly text: string }
export type Admission = Awaited<ReturnType<YCodingClient["session"]["prompt"]>>
export type PermissionRequest = Awaited<ReturnType<YCodingClient["permission"]["list"]>>[number]
export type FormRequest = Awaited<ReturnType<YCodingClient["form"]["list"]>>[number]
export type PermissionDecision = Parameters<YCodingClient["permission"]["reply"]>[0]["reply"]
export type FormAnswer = Parameters<YCodingClient["form"]["reply"]>[0]["answer"]
export type PendingRequests = {
  readonly sessionID: string
  readonly revision: number
  readonly permissions: readonly PermissionRequest[]
  readonly forms: readonly FormRequest[]
}
export type RequestReply =
  | { readonly kind: "permission"; readonly sessionID: string; readonly revision: number; readonly requestID: string; readonly reply: PermissionDecision; readonly message?: string }
  | { readonly kind: "form"; readonly sessionID: string; readonly revision: number; readonly formID: string; readonly answer: FormAnswer }
  | { readonly kind: "form-cancel"; readonly sessionID: string; readonly revision: number; readonly formID: string }
export type ModelStatus = "alpha" | "beta" | "deprecated" | "active"
export type ModelSelection = Parameters<YCodingClient["session"]["switchModel"]>[0]["model"]
export type ModelProfileOption = { readonly name: string; readonly active: boolean; readonly variants: readonly string[] }
export type ModelOption = {
  readonly id: string
  readonly providerID: string
  readonly name: string
  readonly enabled: boolean
  readonly status: ModelStatus
  readonly limit: { readonly context: number; readonly output: number }
  readonly variants: readonly string[]
  readonly profiles: readonly ModelProfileOption[]
}
export type ModelSource = { readonly sessionID: string } | { readonly directory: string }
export type ModelCatalog = { readonly revision: number; readonly models: readonly ModelOption[]; readonly default: ModelSelection | null } & (
  | { readonly source: { readonly sessionID: string }; readonly current: ModelSelection | null; readonly running: boolean }
  | { readonly source: { readonly directory: string } })
export type ModelSwitch = { readonly sessionID: string; readonly revision: number; readonly model: ModelSelection }
export type DesktopAPI = {
  readonly preferences: () => Promise<Preferences>
  readonly state: () => Promise<ConnectionState>
  readonly connect: (selection: Selection) => Promise<ConnectionState>
  readonly disconnect: () => Promise<void>
  readonly sessions: (query: SessionsQuery) => Promise<Sessions>
  readonly session: (input: { readonly sessionID: string }) => Promise<SessionRead>
  readonly pin: (request: PinRequest) => Promise<void>
  readonly workspaces: () => Promise<readonly Workspace[]>
  readonly messages: (sessionID: string) => Promise<Messages>
  readonly createSession: (input: NewSession) => Promise<Session>
  readonly prompt: (input: Prompt) => Promise<Admission>
  readonly interrupt: (sessionID: string) => Promise<void>
  readonly requests: (sessionID: string) => Promise<PendingRequests>
  readonly reply: (input: RequestReply) => Promise<void>
  readonly models: (source: string | { readonly directory: string }) => Promise<ModelCatalog>
  readonly switchModel: (input: ModelSwitch) => Promise<void>
  readonly onState: (listen: (state: ConnectionState) => void) => () => void
  readonly onEvent: (listen: (event: YCodingEvent) => void) => () => void
  readonly onResync: (listen: () => void) => () => void
}
