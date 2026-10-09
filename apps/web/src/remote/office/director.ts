import { appearanceFor } from "./sprites"
import { officeInputsSettled } from "./model"
import { findPath } from "./navigation"
import type { ActorFrame, ActorSpeech, OfficeActor, OfficeCue, OfficeLayout, OfficeSnapshot, OfficeSpot, Point } from "./types"

export type LeisurePhase =
  | { readonly kind: "desk"; readonly elapsed: number; readonly duration: number }
  | { readonly kind: "stretch"; readonly stage: "stand" | "wave" | "settle"; readonly elapsed: number; readonly duration: number }
  | { readonly kind: "travel"; readonly destination: OfficeSpot; readonly arrival: "pantry" | "rest" | "table" }
  | { readonly kind: "pantry"; readonly elapsed: number; readonly duration: number }
  | { readonly kind: "rest"; readonly spot: OfficeSpot; readonly elapsed: number; readonly duration: number }
  | { readonly kind: "table"; readonly spot: OfficeSpot; readonly elapsed: number; readonly duration: number }
  | { readonly kind: "gathering"; readonly groupID: number; readonly stage: "travel" | "talk"; readonly spot: OfficeSpot; readonly elapsed: number }
  | { readonly kind: "return" }

type Gathering = { readonly id: number; members: string[]; elapsed: number; readonly duration: number }

type ActorState = {
  actor: OfficeActor
  pod: number
  position: Point
  target: Point
  path: Point[]
  speed: number
  anchor: Point
  admitted?: Point
  yieldTicks: number
  yielding: boolean
  passing?: Point
  direction: ActorFrame["direction"]
  blocked: boolean
  leaving: boolean
  leavingAge: number
  opacityAge: number
  idleAge: number
  leisurePhase?: LeisurePhase
  reservedSpot?: OfficeSpot
  leisureTrips: number
  speech?: ActorSpeech
  speechSource?: "decorative" | "cue"
  cueFacing?: ActorFrame["direction"]
  speechAge: number
  lastChat: number
}

const center = (layout: OfficeLayout, cell: Point): Point => ({ x: cell.x * layout.tileSize + layout.tileSize / 2, y: cell.y * layout.tileSize + layout.tileSize / 2 })
const cellAt = (layout: OfficeLayout, position: Point): Point => ({ x: Math.floor(position.x / layout.tileSize), y: Math.floor(position.y / layout.tileSize) })
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y
const identitySeed = (identity: string) => [...identity].reduce((seed, character) => Math.imul(seed ^ character.charCodeAt(0), 16_777_619) >>> 0, 2_166_136_261)
const yieldTickBound = 8

export class OfficeDirector {
  private readonly actors = new Map<string, ActorState>()
  private readonly departed = new Set<string>()
  private readonly gatherings = new Map<number, Gathering>()
  private readonly routeOwners = new Map<number, number>()
  private scope?: string
  private snapshot?: OfficeSnapshot
  private hydrated = false
  private reduced = false
  private elapsed = 0
  private ambientClock = 0
  private nextGatheringID = 0

  constructor(private readonly layout: OfficeLayout) {
    layout.pods.forEach((pod, index) => {
      for (let y = pod.top; y <= pod.bottom; y++) for (let x = pod.left; x <= pod.right; x++) this.routeOwners.set(y * layout.columns + x, index)
    })
  }

  sync(snapshot: OfficeSnapshot): void {
    if (snapshot.scope !== this.scope) {
      this.actors.clear()
      this.departed.clear()
      this.gatherings.clear()
      this.elapsed = 0
      this.ambientClock = 0
      this.scope = snapshot.scope
      this.hydrated = false
    }
    const priorRoot = this.snapshot?.team.rootActorID
    this.snapshot = snapshot
    if (snapshot.connection !== "ready") for (const gathering of [...this.gatherings.values()]) this.endGathering(gathering, false)
    if (!officeInputsSettled(snapshot)) return
    const visible = new Set(snapshot.actors.map((actor) => actor.id))
    for (const [id, state] of this.actors) {
      if (visible.has(id)) continue
      if (!this.hydrated || snapshot.connection !== "ready" || this.reduced || state.actor.kind === "task" && priorRoot !== snapshot.team.rootActorID) this.actors.delete(id)
      else this.depart(state)
    }
    for (const actor of snapshot.actors) {
      if (!terminalTask(actor)) this.departed.delete(actor.id)
      const state = this.actors.get(actor.id)
      if (state) {
        const previousStatus = state.actor.status
        const previousSource = state.actor.source
        state.actor = actor
        if ((snapshot.connection !== "ready" || actor.source === "unavailable") && state.leisurePhase?.kind === "gathering") { state.path = []; state.speed = 0 }
        if (snapshot.connection !== "ready" || actor.status !== "idle" || actor.source !== "projection" || terminalTask(actor)) this.releaseGathering(state)
        if (snapshot.connection !== "ready" || actor.status !== "idle" || actor.source !== "projection") {
          this.clearDecorativeGesture(state)
          this.releaseLeisure(state)
        }
        if (terminalTask(actor) && !state.leaving) {
          if (!snapshot.cues.some((cue) => cue.kind === "report" && cue.fromActorID === actor.id)) {
            this.departed.add(actor.id)
            this.depart(state)
          }
          continue
        }
        if (state.leaving && this.departed.has(actor.id)) continue
        if (state.leaving) { state.leaving = false; state.leavingAge = 0; state.opacityAge = 400 }
        if (previousStatus !== actor.status && actor.status === "idle" && actor.source === "projection" && snapshot.connection === "ready") this.beginDeskRest(state)
        if (actor.status !== "idle") state.idleAge = 0
        if (snapshot.connection === "ready" && actor.source !== "unavailable") {
          if (actor.status !== "idle" || previousSource === "unavailable" || previousStatus !== actor.status) this.route(state)
        }
        continue
      }
      if (this.departed.has(actor.id) || terminalTask(actor)) continue
      const pod = this.layout.pods.findIndex((_, index) => ![...this.actors.values()].some((current) => current.pod === index))
      if (pod < 0) continue
      const direct = !this.hydrated || snapshot.connection !== "ready" || this.reduced || actor.kind === "task" && priorRoot !== snapshot.team.rootActorID
      const initialLeisure = direct && !this.hydrated && actor.status === "idle" && actor.source === "projection" && snapshot.connection === "ready"
        ? this.claimLeisure(actor, "table") ?? this.claimLeisure(actor, "rest") ?? this.claimLeisure(actor, "pantry") : undefined
      const target = initialLeisure?.cell ?? this.workSpot(pod, actor).cell
      const position = direct ? target : this.layout.door
      const added: ActorState = { actor, pod, position: center(this.layout, position), target: position, path: [], speed: 0, anchor: position, yieldTicks: 0, yielding: false, direction: "down", blocked: false,
        leaving: false, leavingAge: 0, opacityAge: direct ? 400 : 0, idleAge: 0,
        leisurePhase: initialLeisure ? this.phaseAt(initialLeisure, actor.sessionID) : actor.status === "idle" && actor.source === "projection" && snapshot.connection === "ready" ? this.deskPhase(actor.sessionID, 0) : undefined,
        reservedSpot: initialLeisure,
        speechAge: 0, lastChat: -20_000, leisureTrips: 0 }
      this.actors.set(actor.id, added)
      if (!direct) this.route(added)
    }
    this.hydrated = true
  }

  playCue(cue: OfficeCue): boolean {
    const source = this.actors.get(cue.fromActorID)
    const recipient = this.actors.get(cue.toActorID)
    if (!source || !recipient || source === recipient || source.actor.source === "unavailable" || recipient.actor.source === "unavailable" || this.snapshot?.connection !== "ready") return false
    this.releaseLeisure(source)
    this.releaseLeisure(recipient)
    source.speech = cue.kind === "delegate" ? "delegate" : "report"
    recipient.speech = "chat"
    source.speechSource = recipient.speechSource = "cue"
    source.cueFacing = this.face(source.position, recipient.position)
    recipient.cueFacing = this.face(recipient.position, source.position)
    source.speechAge = recipient.speechAge = cue.kind === "delegate" ? 2_450 : 2_000
    return true
  }

  cueActive(actorID: string): boolean { return (this.actors.get(actorID)?.speechAge ?? 0) > 0 }

  leisurePhase(actorID: string): LeisurePhase | undefined { return this.actors.get(actorID)?.leisurePhase }

  gatheringPhase(actorID: string): Extract<LeisurePhase, { kind: "gathering" }> | undefined {
    const phase = this.actors.get(actorID)?.leisurePhase
    return phase?.kind === "gathering" ? phase : undefined
  }

  settle(): void {
    for (const gathering of [...this.gatherings.values()]) this.endGathering(gathering, false)
    for (const [id, state] of this.actors) {
      if (state.leaving || terminalTask(state.actor)) { this.actors.delete(id); continue }
      state.speech = undefined
      state.speechSource = undefined
      state.cueFacing = undefined
      state.speechAge = 0
      state.path = []
      state.speed = 0
      state.admitted = undefined
      state.yieldTicks = 0
      state.yielding = false
      state.passing = undefined
      state.blocked = false
      state.opacityAge = 400
      this.releaseLeisure(state)
      if (state.actor.source !== "unavailable") {
        state.target = this.workSpot(state.pod, state.actor).cell
        state.position = center(this.layout, state.target)
      }
      state.anchor = cellAt(this.layout, state.position)
    }
  }

  tick(deltaMs: number, reducedMotion: boolean): readonly ActorFrame[] {
    this.reduced = reducedMotion
    if (reducedMotion) this.settle()
    const delta = Math.max(0, Math.min(Number.isFinite(deltaMs) ? deltaMs : 0, 50))
    this.elapsed += delta
    this.ambientClock += delta
    if (delta > 0 && !reducedMotion && this.snapshot?.connection === "ready") this.admitNextCells()
    for (const [id, state] of this.actors) {
      if (state.actor.source === "unavailable") continue
      state.opacityAge = Math.min(400, state.opacityAge + delta)
      if (state.leaving) state.leavingAge += delta
      if (state.speechAge > 0) {
        state.speechAge = Math.max(0, state.speechAge - delta)
        if (!state.speechAge) {
          state.speech = undefined
          state.speechSource = undefined
          state.cueFacing = undefined
          if (terminalTask(state.actor)) { this.departed.add(id); this.depart(state) }
        }
      }
      this.advance(state, delta, reducedMotion)
      this.advanceLeisure(state, delta, reducedMotion)
      if (state.leaving && state.leavingAge >= 400 && !state.path.length) this.actors.delete(id)
    }
    this.advanceGatherings(delta, reducedMotion)
    if (!reducedMotion && this.snapshot?.connection === "ready" && this.ambientClock >= 5_000) {
      this.ambientClock %= 5_000
      const resting = [...this.actors.values()].filter((state) => state.actor.status === "idle" && state.actor.source === "projection" && !state.path.length && !state.leaving && !state.speech && this.layout.roomAt(cellAt(this.layout, state.position)) === "lounge")
      for (const [index, first] of resting.entries()) for (const second of resting.slice(index + 1)) {
        const a = cellAt(this.layout, first.position)
        const b = cellAt(this.layout, second.position)
        if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 3 || this.elapsed - first.lastChat < 20_000 || this.elapsed - second.lastChat < 20_000) continue
        first.speech = second.speech = "chat"
        first.speechSource = second.speechSource = "decorative"
        first.speechAge = second.speechAge = 3_000
        first.lastChat = second.lastChat = this.elapsed
      }
    }
    return [...this.actors.values()].map((state) => this.frame(state, reducedMotion))
  }

  private workSpot(pod: number, actor: OfficeActor): OfficeSpot {
    const activity = actor.activity === "research" || actor.activity === "verify" || actor.activity === "coordinate" ? actor.activity : "implement"
    return this.layout.pods[pod]!.spots[activity]
  }

  private claimLeisure(actor: OfficeActor, kind: OfficeSpot["leisure"]): OfficeSpot | undefined {
    const occupied = new Set([...this.actors.values()].flatMap((state) => state.reservedSpot ? [`${state.reservedSpot.cell.x},${state.reservedSpot.cell.y}`] : []))
    const candidates = this.layout.lounge.filter((spot) => spot.leisure === kind)
    const offset = kind === "table" ? 0 : identitySeed(actor.sessionID) % Math.max(1, candidates.length)
    return candidates.map((_, index) => candidates[(offset + index) % candidates.length]!).find((spot) => !occupied.has(`${spot.cell.x},${spot.cell.y}`))
  }

  private route(state: ActorState): void {
    if (state.leaving || state.actor.source === "unavailable") return
    const target = this.workSpot(state.pod, state.actor).cell
    if (same(target, state.target)) return
    this.move(state, target)
  }

  private move(state: ActorState, target: Point): void {
    const path = findPath(this.layout, state.admitted ?? state.anchor, target, (point) => this.ownsRouteCell(state, point))
    state.target = target
    state.path = path ? [...(state.admitted ? [state.admitted] : []), ...path] : state.admitted ? [state.admitted] : []
    state.blocked = path === undefined
    state.speed = 0
    state.yieldTicks = 0
    state.yielding = false
    state.passing = undefined
  }

  private ownsRouteCell(state: ActorState, point: Point): boolean {
    const owner = this.routeOwners.get(point.y * this.layout.columns + point.x)
    return owner === undefined || owner === state.pod
  }

  private admitNextCells(): void {
    const key = (point: Point) => point.y * this.layout.columns + point.x
    const occupied = new Map<number, ActorState>()
    const requests = new Map<number, ActorState>()
    const states = [...this.actors.values()]
    const priority = (state: ActorState) => state.actor.source === "projection" && state.actor.status !== "idle" ? 1 : 0
    const before = (first: ActorState, second: ActorState) => priority(first) > priority(second)
      || priority(first) === priority(second) && (first.yieldTicks > second.yieldTicks || first.yieldTicks === second.yieldTicks && first.actor.id < second.actor.id)
    for (const state of states) {
      occupied.set(key(state.anchor), state)
      if (state.admitted) occupied.set(key(state.admitted), state)
      state.yielding = false
      if (!state.path.length || state.admitted || state.actor.source === "unavailable") continue
      const next = key(state.path[0]!)
      const request = requests.get(next)
      if (!request || before(state, request)) requests.set(next, state)
    }
    for (const state of states) {
      if (!state.path.length || state.admitted || state.actor.source === "unavailable") continue
      const next = state.path[0]!
      const blocker = occupied.get(key(next))
      if (!blocker && requests.get(key(next)) === state) {
        state.admitted = next
        state.yieldTicks = 0
        occupied.set(key(next), state)
        continue
      }
      state.yielding = true
      state.speed = 0
      state.yieldTicks++
      if (!blocker || blocker === state || blocker.admitted || state.yieldTicks % yieldTickBound !== 0) continue
      const loser = before(state, blocker) ? blocker : state
      if (loser.actor.source === "unavailable" || loser.admitted) continue
      const travel = loser.path[0] ?? state.anchor
      const offsets = travel.x !== loser.anchor.x ? [{ x: 0, y: 1 }, { x: 0, y: -1 }] : [{ x: 1, y: 0 }, { x: -1, y: 0 }]
      const aside = offsets.map((offset) => ({ x: loser.anchor.x + offset.x, y: loser.anchor.y + offset.y })).find((point) =>
        this.layout.walkable(point.x, point.y) && !this.routeOwners.has(key(point)) && !occupied.has(key(point)) && !requests.has(key(point)))
      if (!aside) continue
      const returning = !loser.path.length
      const reroute = findPath(this.layout, aside, loser.target, (point) => this.ownsRouteCell(loser, point)
        && (!same(point, loser.anchor) || returning) && (!occupied.has(key(point)) || same(point, loser.target)))
      if (!reroute) continue
      if (returning) loser.passing = loser.target
      loser.path = [aside, ...reroute]
      loser.admitted = aside
      loser.yieldTicks = 0
      loser.yielding = false
      occupied.set(key(aside), loser)
    }
  }

  private advance(state: ActorState, delta: number, reducedMotion: boolean): void {
    if (!state.path.length || !state.admitted || reducedMotion || this.snapshot?.connection !== "ready") return
    const maxSpeed = this.layout.tileSize * 4.5 / 1000
    const acceleration = maxSpeed / 400
    const first = center(this.layout, state.path[0]!)
    const remaining = Math.hypot(first.x - state.position.x, first.y - state.position.y) + (state.path.length - 1) * this.layout.tileSize
    const targetSpeed = Math.min(maxSpeed, Math.sqrt(2 * acceleration * remaining))
    const nextSpeed = targetSpeed < state.speed ? Math.max(targetSpeed, state.speed - acceleration * delta) : Math.min(targetSpeed, state.speed + acceleration * delta)
    const distance = Math.min(remaining, (state.speed + nextSpeed) / 2 * delta)
    state.speed = nextSpeed
    if (distance > 0) {
      const target = center(this.layout, state.path[0]!)
      const dx = target.x - state.position.x
      const dy = target.y - state.position.y
      const length = Math.hypot(dx, dy)
      if (length <= distance) {
        state.position = target
        state.anchor = state.path[0]!
        state.admitted = undefined
        if (state.passing && same(state.passing, state.anchor)) state.passing = undefined
        state.path.shift()
        if (!state.path.length) state.speed = 0
        return
      }
      state.direction = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "down" : "up"
      state.position = { x: state.position.x + dx / length * distance, y: state.position.y + dy / length * distance }
    }
    if (!state.path.length) state.speed = 0
  }

  private frame(state: ActorState, reducedMotion: boolean): ActorFrame {
    const atWork = !state.path.length && same(cellAt(this.layout, state.position), this.workSpot(state.pod, state.actor).cell)
    const phase = state.leisurePhase
    const spot = phase?.kind === "rest" || phase?.kind === "table" ? phase.spot : state.reservedSpot ?? this.workSpot(state.pod, state.actor)
    const playing = spot.pose === "play" && !state.path.length && !reducedMotion && state.actor.source !== "unavailable" && same(cellAt(this.layout, state.position), spot.cell)
    const working = ["working", "tool"].includes(state.actor.status)
    const workPose = working && atWork ? state.actor.activity === "research" ? "read"
      : state.actor.activity === "verify" ? spot.pose === "sit" ? "type" : "check"
      : state.actor.activity === "coordinate" ? "point"
      : state.actor.activity === "implement" ? "type" : undefined : undefined
    return {
      actor: state.actor, appearance: appearanceFor(state.actor.sessionID), position: state.position,
      direction: state.path.length ? state.direction : this.cueFacingFor(state) ?? spot.facing,
      pose: state.yielding ? "stand" : state.path.length && !reducedMotion ? "walk" : state.actor.status === "attention" && atWork ? "wave" : state.speech ? "talk" : phase?.kind === "gathering" && phase.stage === "talk" ? (phase.elapsed + (this.gatherings.get(phase.groupID)?.members.indexOf(state.actor.id) ?? 0) * 1_000) % 2_000 < 1_000 ? "talk" : "stand" : phase?.kind === "stretch" ? phase.stage === "wave" ? "wave" : "stand" : workPose ?? (state.actor.activity === "hold" || state.actor.status === "thinking" || state.actor.status === "compacting" ? "stand" : spot.pose === "play" ? playing ? "play" : "stand" : spot.pose),
      moving: state.path.length > 0 && !state.yielding && !reducedMotion && state.actor.source !== "unavailable",
      blocked: state.blocked, room: this.layout.roomAt(cellAt(this.layout, state.position)), speech: state.speech,
      leaving: state.leaving, opacity: state.leaving ? Math.max(0, 1 - state.leavingAge / 400) : state.opacityAge / 400,
    }
  }

  private depart(state: ActorState): void {
    state.leaving = true
    state.leavingAge = 0
    state.speech = undefined
    state.speechSource = undefined
    state.speechAge = 0
    this.releaseLeisure(state)
    this.move(state, this.layout.door)
  }

  private deskPhase(identity: string, trips: number): LeisurePhase {
    const seed = identitySeed(identity)
    return { kind: "desk", elapsed: 0, duration: 3_000 + (seed + trips * 2_654_435_761 >>> 0) % 6_001 }
  }

  private beginDeskRest(state: ActorState): void {
    this.releaseLeisure(state)
    state.leisurePhase = this.deskPhase(state.actor.sessionID, state.leisureTrips)
    state.idleAge = 0
    this.move(state, this.workSpot(state.pod, state.actor).cell)
  }

  private phaseAt(spot: OfficeSpot, identity: string): LeisurePhase {
    if (spot.leisure === "pantry") return { kind: "pantry", elapsed: 0, duration: 1_200 }
    if (spot.leisure === "table") return { kind: "table", spot, elapsed: 0, duration: 8_000 + identitySeed(identity) % 6_001 }
    return { kind: "rest", spot, elapsed: 0, duration: 4_000 + identitySeed(identity) % 7_001 }
  }

  private beginLeisureTrip(state: ActorState): void {
    if (this.beginGathering(state)) return
    const seed = identitySeed(state.actor.sessionID) + state.leisureTrips * 2_654_435_761
    const kind = (["pantry", "rest", "table"] as const)[(seed >>> 0) % 3]!
    const destination = this.claimLeisure(state.actor, kind) ?? this.claimLeisure(state.actor, "rest")
    if (!destination) {
      state.leisurePhase = this.deskPhase(state.actor.sessionID, state.leisureTrips)
      return
    }
    state.reservedSpot = destination
    state.leisurePhase = { kind: "travel", destination, arrival: destination.leisure! }
    this.move(state, destination.cell)
  }

  private advanceLeisure(state: ActorState, delta: number, reducedMotion: boolean): void {
    if (state.actor.status !== "idle" || state.actor.source !== "projection" || this.snapshot?.connection !== "ready" || !officeInputsSettled(this.snapshot) || reducedMotion || state.leaving) return
    const phase = state.leisurePhase
    if (state.passing) return
    if (!phase) { this.beginDeskRest(state); return }
    if (phase.kind === "gathering") return
    if (phase.kind === "travel") {
      if (state.path.length) return
      state.leisurePhase = this.phaseAt(phase.destination, state.actor.sessionID)
      return
    }
    if (phase.kind === "desk" || phase.kind === "stretch" || phase.kind === "pantry" || phase.kind === "rest" || phase.kind === "table") {
      const elapsed = phase.elapsed + delta
      if (elapsed < phase.duration) { state.leisurePhase = { ...phase, elapsed }; return }
      if (phase.kind === "desk") { state.leisurePhase = { kind: "stretch", stage: "stand", elapsed: 0, duration: 250 }; return }
      if (phase.kind === "stretch") {
        if (phase.stage === "stand") state.leisurePhase = { kind: "stretch", stage: "wave", elapsed: 0, duration: 400 }
        else if (phase.stage === "wave") state.leisurePhase = { kind: "stretch", stage: "settle", elapsed: 0, duration: 250 }
        else this.beginLeisureTrip(state)
        return
      }
      if (phase.kind === "pantry") {
        this.releaseReservedSpot(state)
        const seat = this.claimLeisure(state.actor, "rest")
        if (seat) {
          state.reservedSpot = seat
          state.leisurePhase = { kind: "travel", destination: seat, arrival: "rest" }
          this.move(state, seat.cell)
        } else this.returnHome(state)
        return
      }
      this.returnHome(state)
      return
    }
    if (!state.path.length) {
      state.leisurePhase = this.deskPhase(state.actor.sessionID, state.leisureTrips)
      state.idleAge = 0
    }
  }

  private returnHome(state: ActorState): void {
    state.leisureTrips++
    this.releaseLeisure(state)
    state.leisurePhase = { kind: "return" }
    this.move(state, this.workSpot(state.pod, state.actor).cell)
  }

  private releaseLeisure(state: ActorState): void {
    this.releaseGathering(state)
    this.releaseReservedSpot(state)
    state.leisurePhase = undefined
  }

  private releaseReservedSpot(state: ActorState): void { state.reservedSpot = undefined }

  private beginGathering(state: ActorState): boolean {
    const candidates = [...this.actors.values()].filter((candidate) => {
      const phase = candidate.leisurePhase
      return candidate.actor.status === "idle" && candidate.actor.source === "projection" && !terminalTask(candidate.actor)
        && this.snapshot?.connection === "ready" && !candidate.leaving && candidate.speechSource !== "cue"
        && (phase?.kind === "desk" || phase?.kind === "rest" || phase?.kind === "pantry" || candidate === state && phase?.kind === "stretch")
    })
    if (!candidates.some((candidate) => candidate === state) || candidates.length < 2) return false
    const occupied = new Set([...this.actors.values()].flatMap((candidate) => candidate.leisurePhase?.kind === "gathering" ? [`${candidate.leisurePhase.spot.cell.x},${candidate.leisurePhase.spot.cell.y}`] : []))
    const spots = this.layout.gathering.filter((spot) => !occupied.has(`${spot.cell.x},${spot.cell.y}`)).slice(0, 3)
    const members = [state, ...candidates.filter((candidate) => candidate !== state)].slice(0, spots.length)
    if (spots.length < 2 || members.length < 2) return false
    const gathering = { id: this.nextGatheringID++, members: members.map((member) => member.actor.id), elapsed: 0, duration: 4_000 + identitySeed(state.actor.sessionID) % 2_001 }
    this.gatherings.set(gathering.id, gathering)
    members.forEach((member, index) => {
      this.releaseReservedSpot(member)
      const spot = spots[index]!
      member.reservedSpot = spot
      member.leisurePhase = { kind: "gathering", groupID: gathering.id, stage: "travel", spot, elapsed: 0 }
      this.move(member, spot.cell)
    })
    return true
  }

  private advanceGatherings(delta: number, reducedMotion: boolean): void {
    for (const gathering of this.gatherings.values()) {
      const members = gathering.members.map((id) => this.actors.get(id)).filter((state): state is ActorState => Boolean(state))
      const eligible = members.filter((state) => state.actor.status === "idle" && state.actor.source === "projection" && !state.leaving && state.speechSource !== "cue")
      if (eligible.length < 2) { this.endGathering(gathering, true); continue }
      if (reducedMotion) { this.endGathering(gathering, false); continue }
      if (eligible.some((state) => state.path.length)) continue
      gathering.elapsed += delta
      eligible.forEach((state) => {
        const phase = state.leisurePhase
        if (phase?.kind === "gathering") state.leisurePhase = { ...phase, stage: "talk", elapsed: gathering.elapsed }
      })
      if (gathering.elapsed >= gathering.duration) this.endGathering(gathering, true)
    }
  }

  private releaseGathering(state: ActorState): void {
    const phase = state.leisurePhase
    if (phase?.kind !== "gathering") return
    const gathering = this.gatherings.get(phase.groupID)
    if (!gathering) return
    gathering.members = gathering.members.filter((id) => id !== state.actor.id)
    this.releaseReservedSpot(state)
    state.leisurePhase = undefined
    if (gathering.members.length < 2) this.endGathering(gathering, true)
  }

  private endGathering(gathering: Gathering, disperse: boolean): void {
    this.gatherings.delete(gathering.id)
    const members = gathering.members.flatMap((id) => {
      const state = this.actors.get(id)
      if (!state || state.leisurePhase?.kind !== "gathering" || state.leisurePhase.groupID !== gathering.id) return []
      this.releaseReservedSpot(state)
      state.leisurePhase = undefined
      if (!disperse) { state.path = []; state.speed = 0 }
      return [state]
    })
    if (!disperse) return
    for (const state of members) {
      if (state.actor.status !== "idle" || state.actor.source !== "projection") { this.route(state); continue }
      const rest = this.claimLeisure(state.actor, "rest")
      if (!rest) { this.beginDeskRest(state); continue }
      state.reservedSpot = rest
      state.leisurePhase = { kind: "travel", destination: rest, arrival: "rest" }
      this.move(state, rest.cell)
    }
  }

  private clearDecorativeGesture(state: ActorState): void {
    if (state.speechSource !== "decorative") return
    state.speech = undefined
    state.speechSource = undefined
    state.speechAge = 0
  }

  private cueFacingFor(state: ActorState): ActorFrame["direction"] | undefined {
    if (state.speechSource !== "cue" || state.speechAge <= 0 || state.actor.status === "attention") return undefined
    return state.cueFacing
  }

  private face(from: Point, to: Point): ActorFrame["direction"] {
    const dx = to.x - from.x
    const dy = to.y - from.y
    return Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "down" : "up"
  }
}

function terminalTask(actor: OfficeActor): boolean {
  return actor.kind === "task" && (actor.taskState === "completed" || actor.taskState === "cancelled" || actor.taskState === "failed" || actor.taskState === "lost")
}
