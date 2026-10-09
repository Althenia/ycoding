export type OfficeStatus =
  | "unknown" | "idle" | "working" | "thinking" | "tool"
  | "attention" | "compacting" | "interrupted" | "failed" | "offline" | "reconnecting"

export type OfficePreferences = {
  readonly version: 1
  readonly motion: "system" | "reduced"
  readonly bubbles: "off" | "status" | "excerpt"
  readonly labels: boolean
  readonly followSelected: boolean
  readonly quality: "standard" | "battery"
}

export type SessionSummary = {
  readonly id: string
  readonly parentID?: string
  readonly title: string
  readonly agent?: string
  readonly archived: boolean
  readonly running?: boolean
}

export type OfficeRoomID = "block" | "lounge" | "hall"
export type OfficeActivity = "research" | "implement" | "coordinate" | "verify" | "hold"
type Direction = "down" | "left" | "right" | "up"

export type SelectedSession = {
  readonly id: string
  readonly status: "idle" | "running" | "interrupted" | "failed"
  readonly agent?: string
  readonly requestCount: number
  readonly activeTool?: string
  readonly activity?: OfficeActivity
  readonly compacting: boolean
  readonly thinking: boolean
  readonly assistantExcerpt?: string
  readonly unknownOutcome: boolean
}

type TaskState = "starting" | "running" | "waiting" | "cancelling" | "cancelled" | "completed" | "failed" | "lost"

export type TeamMember = {
  readonly sessionID: string
  readonly parentID: string
  readonly description: string
  readonly agent?: string
  readonly state: TaskState
}

type TeamCueInput =
  | { readonly id: string; readonly kind: "delegated"; readonly childID: string }
  | { readonly id: string; readonly kind: "reported"; readonly childID: string; readonly outcome: "completed" | "failed" | "cancelled" | "lost" }

export type TeamInput = {
  readonly rootID: string
  readonly status: "loading" | "ready" | "unsupported" | "error"
  readonly members: readonly TeamMember[]
  readonly total?: number
  readonly more: boolean
  readonly cues: readonly TeamCueInput[]
}

export type OfficeInput = {
  readonly ownerID?: string
  readonly deviceID?: string
  readonly connection: "ready" | "offline" | "reconnecting" | "unavailable"
  readonly activeSessionID?: string
  readonly sessions: readonly SessionSummary[]
  readonly selected?: SelectedSession
  readonly team?: TeamInput
  readonly familyActivity?: { readonly status: "loading" | "ready" | "unsupported" | "error"; readonly members: readonly RemoteFamilyActivity[] }
}

export type OfficeActor = {
  readonly id: string
  readonly sessionID: string
  readonly kind: "session" | "task"
  readonly name: string
  readonly role: string
  readonly title: string
  readonly selected: boolean
  readonly status: OfficeStatus
  readonly statusText: string
  readonly source: "projection" | "summary" | "unavailable"
  readonly bubble?: string
  readonly unknownOutcome: boolean
  readonly activity?: OfficeActivity
  readonly teamRootSessionID?: string
  readonly taskState?: TaskState
}

export type OfficeCue = {
  readonly id: string
  readonly kind: "delegate" | "report"
  readonly fromActorID: string
  readonly toActorID: string
  readonly outcome?: "completed" | "failed" | "cancelled" | "lost"
}

export type OfficeSnapshot = {
  readonly scope: string
  readonly connection: OfficeInput["connection"]
  readonly actors: readonly OfficeActor[]
  readonly totalSessions: number
  readonly activityStatus: "loading" | "ready" | "unsupported" | "error"
  readonly overflow: number
  readonly team: {
    readonly status: "none" | TeamInput["status"]
    readonly rootActorID?: string
    readonly total: number
    readonly shown: number
    readonly more: boolean
  }
  readonly cues: readonly OfficeCue[]
}

export type Point = { readonly x: number; readonly y: number }

export type OfficeSpot = { readonly cell: Point; readonly facing: Direction; readonly pose: "sit" | "stand" | "play"; readonly leisure?: "pantry" | "rest" | "table" }

export type OfficeLayout = {
  readonly columns: number
  readonly rows: number
  readonly tileSize: number
  readonly walkable: (x: number, y: number) => boolean
  readonly door: Point
  readonly pods: readonly { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly spots: Readonly<Record<"implement" | "research" | "verify" | "coordinate", OfficeSpot>> }[]
  readonly lounge: readonly OfficeSpot[]
  readonly gathering: readonly OfficeSpot[]
  readonly roomAt: (cell: Point) => OfficeRoomID | undefined
}

type ActorPose = "stand" | "walk" | "sit" | "type" | "talk" | "wave" | "play" | "read" | "check" | "point"
export type ActorSpeech = "chat" | "delegate" | "report"

export type ActorFrame = {
  readonly actor: OfficeActor
  readonly appearance: number
  readonly position: Point
  readonly direction: Direction
  readonly pose: ActorPose
  readonly moving: boolean
  readonly blocked: boolean
  readonly room?: OfficeRoomID
  readonly speech?: ActorSpeech
  readonly leaving: boolean
  readonly opacity: number
}
import type { RemoteFamilyActivity } from "@ycoding-ai/remote"
