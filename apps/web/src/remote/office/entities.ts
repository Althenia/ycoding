import { officeLayout, props, type OfficeFurniture, type OfficeProp } from "./map"
import type { OfficeRoomID, Point } from "./types"
import type { OfficeActor } from "./types"

export type OfficeEntityStatus = "idle" | "in-use" | "occupied" | "on" | "off" | "brewing"
export type OfficeEntityState = { readonly status: OfficeEntityStatus; readonly users: readonly string[] }
export type OfficeEntity = {
  readonly id: string
  readonly kind: OfficeFurniture
  readonly name: string
  readonly room: OfficeRoomID
  readonly interactionSpots: readonly { readonly cell: Point; readonly facing: "up" | "down" | "left" | "right" }[]
  readonly capacity: number
  readonly description: string
  readonly state: OfficeEntityState
  readonly prop: OfficeProp
}

export type OfficeEntityEvent =
  | { readonly type: "claim"; readonly actorID: string }
  | { readonly type: "release"; readonly actorID: string }
  | { readonly type: "power"; readonly on: boolean }
  | { readonly type: "brew" }
  | { readonly type: "ready" }

const labels: Record<OfficeFurniture, readonly [string, string, number]> = {
  developerDesk: ["Developer desk", "A private workstation for editing code.", 1], developerDeskLamp: ["Developer desk", "A private workstation for editing code.", 1], developerDeskPlant: ["Developer desk", "A private workstation for editing code.", 1],
  researchDesk: ["Research desk", "A private workstation for reading and research.", 1], qaDesk: ["QA desk", "A private workstation for tests and checks.", 1], qaDeskMug: ["QA desk", "A private workstation for tests and checks.", 1],
  compactDeskCode: ["Code workstation", "A compact workstation for editing code.", 1], compactDeskChart: ["Chart workstation", "A compact workstation for analysis.", 1], compactDeskTest: ["Test workstation", "A compact workstation for running checks.", 1], cornerDesk: ["Corner workstation", "A private corner workstation.", 1], cornerReturn: ["Desk return", "A work surface extension.", 1], credenza: ["Credenza", "Shared office storage.", 1], partition: ["Partition", "A low divider between desks.", 1],
  conferenceTable: ["Meeting table", "A shared space for coordination.", 4], sofaPeach: ["Sofa", "A shared lounge seat.", 2], sofaOrange: ["Sofa", "A shared lounge seat.", 2], coffeeTable: ["Coffee table", "A shared lounge table.", 2], beanBag: ["Bean bag", "A casual lounge seat.", 1], beanBagBlue: ["Bean bag", "A casual lounge seat.", 1], beanBagPink: ["Bean bag", "A casual lounge seat.", 1], pingPong: ["Ping-pong table", "A shared leisure table.", 2],
  kitchenCounter: ["Kitchen counter", "A shared pantry counter.", 2], fridge: ["Refrigerator", "Shared pantry storage.", 1], coffeeMachine: ["Coffee machine", "A shared coffee machine.", 1], bistroTable: ["Bistro table", "A shared pantry table.", 2], serverRack: ["Server rack", "A shared terminal station.", 1], deviceRack: ["Equipment rack", "Shared office equipment.", 1], bookshelf: ["Bookshelf", "A place to browse reference material.", 2], whiteboard: ["Whiteboard", "A shared board for search notes and planning.", 1], bugBoard: ["Bug board", "A shared board for investigation notes.", 1], wallTv: ["Wall display", "A shared meeting display.", 1], waterDispenser: ["Water cooler", "A shared water station.", 1],
  plantFern: ["Fern", "A leafy office plant.", 1], plantMonstera: ["Monstera", "A leafy office plant.", 1], plantBamboo: ["Bamboo plant", "A leafy office plant.", 1], plantSucculent: ["Succulent", "A small office plant.", 1], plantFlowers: ["Flowering plant", "A flowering office plant.", 1],
  globe: ["Globe", "A decorative room object.", 1], readingSeat: ["Reading seat", "A shared quiet seat.", 1], receptionDesk: ["Reception desk", "The office entrance desk.", 1], blueRug: ["Blue rug", "A floor accent.", 1], rugRound: ["Round rug", "A floor accent.", 1], rugRunner: ["Runner rug", "A floor accent.", 1], rugMat: ["Desk rug", "A floor accent.", 1], rugSage: ["Meeting rug", "A floor accent.", 1], wallArt: ["Wall art", "A decorative wall object.", 1], clock: ["Clock", "A shared wall clock.", 1], floorLamp: ["Floor lamp", "A decorative floor lamp.", 1], sideTable: ["Side table", "A small shared table.", 1], filingCabinet: ["Filing cabinet", "Shared office storage.", 1], printer: ["Printer", "A shared office printer.", 1],
}


export const entityCatalog: readonly OfficeEntity[] = props.map((prop, index) => {
  const [name, description, capacity] = labels[prop.kind]
  const interaction = interactionSpot(prop)
  return {
    id: `${prop.kind}:${prop.pod ?? "shared"}:${prop.cell.x}:${prop.cell.y}:${index}`,
    kind: prop.kind,
    name,
    room: officeLayout.roomAt(interaction.cell) ?? "hall",
    interactionSpots: [interaction],
    capacity,
    description,
    state: { status: "idle", users: [] },
    prop,
  }
})

export function interactionKind(activity: string): OfficeFurniture {
  if (["read", "glob", "webfetch", "research"].includes(activity)) return "bookshelf"
  if (["grep", "search", "websearch", "whiteboard"].includes(activity)) return "whiteboard"
  if (["edit", "write", "patch", "thinking", "attention", "waiting"].includes(activity)) return "developerDesk"
  if (["shell", "test", "terminal", "monitor", "verify"].includes(activity)) return "deviceRack"
  if (["coordinate", "delegate", "report"].includes(activity)) return "whiteboard"
  if (["idle", "coffee", "brewing"].includes(activity)) return "coffeeMachine"
  if (["sofa", "beanbag", "plant"].includes(activity)) return "sofaPeach"
  return "developerDesk"
}

export function activityForActor(actor: { readonly status: string; readonly activity?: string; readonly statusText: string }): string | undefined {
  if (actor.status === "attention") return "attention"
  if (actor.status === "thinking") return "thinking"
  if (actor.status === "idle") return "idle"
  const text = actor.statusText.toLowerCase()
  if (/\b(read|reading|glob|webfetch)\b/.test(text)) return "read"
  if (/\b(grep|search(?:ing)?|websearch)\b/.test(text)) return "search"
  if (/\b(test|shell|command|terminal)\b/.test(text)) return "shell"
  if (/\b(edit|editing|write|patch)\b/.test(text)) return "edit"
  return actor.activity
}

export function claimedEntities(actors: readonly { readonly id: string; readonly status: string; readonly activity?: string; readonly statusText: string; readonly room?: OfficeRoomID; readonly position: Point }[]) {
  const claimed = new Map<string, readonly string[]>()
  for (const actor of actors.toSorted((a, b) => a.id.localeCompare(b.id))) {
    const activity = actor.activity ?? activityForActor(actor)
    if (!activity || activity === "idle") continue
    const kind = interactionKind(activity)
    const entity = entityCatalog.filter((item) => canonicalKind(item.kind) === kind && (!actor.room || item.room === actor.room))
      .toSorted((a, b) => distance(a.interactionSpots[0]!.cell, actor.position) - distance(b.interactionSpots[0]!.cell, actor.position))
      .find((item) => (claimed.get(item.id)?.length ?? 0) < item.capacity)
    if (entity) claimed.set(entity.id, [...(claimed.get(entity.id) ?? []), actor.id])
  }
  return claimed
}

export function entityUsers(entity: OfficeEntity, actors: readonly OfficeActor[], claims: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const users = new Set(claims.get(entity.id) ?? [])
  return actors.filter((actor) => users.has(actor.id)).map((actor) => actor.name)
}

export function transitionEntity(state: OfficeEntityState, event: OfficeEntityEvent): OfficeEntityState {
  if (event.type === "claim") return state.users.includes(event.actorID) ? state : {
    status: "in-use", users: [...state.users, event.actorID],
  }
  if (event.type === "release") {
    const users = state.users.filter((user) => user !== event.actorID)
    return { status: users.length ? "in-use" : "idle", users }
  }
  if (event.type === "power") return { ...state, status: event.on ? "on" : "off" }
  if (event.type === "brew") return { ...state, status: "brewing" }
  return { ...state, status: "idle" }
}

export function claimEntity(entity: OfficeEntity, state: OfficeEntityState, actorID: string): OfficeEntityState | undefined {
  if (state.users.includes(actorID)) return state
  if (state.users.length >= entity.capacity) return undefined
  return entityState(entity, [...state.users, actorID])
}

export function entityState(entity: OfficeEntity, users: readonly string[]): OfficeEntityState {
  if (entity.kind === "coffeeMachine" && users.length > 0) return { status: "brewing", users }
  if (entity.kind === "deviceRack") return { status: users.length > 0 ? "on" : "off", users }
  return { status: users.length === 0 ? "idle" : users.length >= entity.capacity ? "occupied" : "in-use", users }
}

export function seededRoomVariant(room: string, seed: number, count: number): number {
  let value = seed >>> 0
  for (const character of room) value = Math.imul(value ^ character.codePointAt(0)!, 16_777_619) >>> 0
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5
  return Math.abs(value) % count
}

function interactionSpot(prop: OfficeProp): { readonly cell: Point; readonly facing: "up" | "down" | "left" | "right" } {
  const origin = { x: prop.cell.x + Math.floor(prop.width / 2), y: prop.cell.y + prop.height }
  const candidates = Array.from({ length: officeLayout.columns * officeLayout.rows }, (_, index) => ({ x: index % officeLayout.columns, y: Math.floor(index / officeLayout.columns) }))
    .filter((cell) => officeLayout.walkable(cell.x, cell.y))
    .toSorted((a, b) => Math.abs(a.x - origin.x) + Math.abs(a.y - origin.y) - Math.abs(b.x - origin.x) - Math.abs(b.y - origin.y)
      || a.y - b.y || a.x - b.x)
  const cell = candidates[0]!
  return { cell, facing: cell.x < origin.x ? "right" : cell.x > origin.x ? "left" : cell.y < origin.y ? "down" : "up" }
}

function distance(cell: Point, position: Point): number {
  return Math.abs(cell.x * officeLayout.tileSize - position.x) + Math.abs(cell.y * officeLayout.tileSize - position.y)
}

function canonicalKind(kind: OfficeFurniture): OfficeFurniture {
  if (kind === "developerDeskLamp" || kind === "developerDeskPlant") return "developerDesk"
  if (kind === "qaDeskMug") return "qaDesk"
  if (kind === "compactDeskCode" || kind === "compactDeskChart" || kind === "compactDeskTest" || kind === "cornerDesk" || kind === "researchDesk") return "developerDesk"
  if (kind === "beanBagBlue" || kind === "beanBagPink") return "beanBag"
  if (kind === "sofaOrange") return "sofaPeach"
  return kind
}
