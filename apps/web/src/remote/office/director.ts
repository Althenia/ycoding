import { appearanceFor } from "./sprites"
import { officeInputsSettled } from "./model"
import { findPath } from "./navigation"
import type { ActorFrame, ActorSpeech, OfficeActor, OfficeCue, OfficeLayout, OfficeSnapshot, OfficeSpot, Point } from "./types"

type ActorState = {
  actor: OfficeActor
  pod: number
  position: Point
  target: Point
  path: Point[]
  speed: number
  direction: ActorFrame["direction"]
  blocked: boolean
  leaving: boolean
  leavingAge: number
  opacityAge: number
  idleAge: number
  lounge?: OfficeSpot
  speech?: ActorSpeech
  speechSource?: "decorative" | "cue"
  cueFacing?: ActorFrame["direction"]
  speechAge: number
  lastChat: number
}

const center = (layout: OfficeLayout, cell: Point): Point => ({ x: cell.x * layout.tileSize + layout.tileSize / 2, y: cell.y * layout.tileSize + layout.tileSize / 2 })
const cellAt = (layout: OfficeLayout, position: Point): Point => ({ x: Math.floor(position.x / layout.tileSize), y: Math.floor(position.y / layout.tileSize) })
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y

export class OfficeDirector {
  private readonly actors = new Map<string, ActorState>()
  private readonly departed = new Set<string>()
  private scope?: string
  private snapshot?: OfficeSnapshot
  private hydrated = false
  private reduced = false
  private elapsed = 0
  private ambientClock = 0

  constructor(private readonly layout: OfficeLayout) {}

  sync(snapshot: OfficeSnapshot): void {
    if (snapshot.scope !== this.scope) {
      this.actors.clear()
      this.departed.clear()
      this.elapsed = 0
      this.ambientClock = 0
      this.scope = snapshot.scope
      this.hydrated = false
    }
    const priorRoot = this.snapshot?.team.rootActorID
    this.snapshot = snapshot
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
        if (snapshot.connection !== "ready" || actor.status !== "idle") this.clearDecorativeGesture(state)
        if (terminalTask(actor) && !state.leaving) {
          if (!snapshot.cues.some((cue) => cue.kind === "report" && cue.fromActorID === actor.id)) {
            this.departed.add(actor.id)
            this.depart(state)
          }
          continue
        }
        if (state.leaving && this.departed.has(actor.id)) continue
        if (state.leaving) { state.leaving = false; state.leavingAge = 0; state.opacityAge = 400 }
        if (previousStatus !== actor.status && actor.status === "idle") state.idleAge = 0
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
      const lounge = actor.status === "idle" ? this.claimLounge(actor) : undefined
      const target = actor.status === "idle" ? lounge!.cell : this.workSpot(pod, actor).cell
      const position = direct ? target : this.layout.door
      const added: ActorState = { actor, pod, position: center(this.layout, position), target: position, path: [], speed: 0, direction: "down", blocked: false,
        leaving: false, leavingAge: 0, opacityAge: direct ? 400 : 0, idleAge: 0, lounge, speechAge: 0, lastChat: -20_000 }
      this.actors.set(actor.id, added)
      if (!direct) this.route(added)
    }
    this.hydrated = true
  }

  playCue(cue: OfficeCue): boolean {
    const source = this.actors.get(cue.fromActorID)
    const recipient = this.actors.get(cue.toActorID)
    if (!source || !recipient || source === recipient || source.actor.source === "unavailable" || recipient.actor.source === "unavailable" || this.snapshot?.connection !== "ready") return false
    source.speech = cue.kind === "delegate" ? "delegate" : "report"
    recipient.speech = "chat"
    source.speechSource = recipient.speechSource = "cue"
    source.cueFacing = this.face(source.position, recipient.position)
    recipient.cueFacing = this.face(recipient.position, source.position)
    source.speechAge = recipient.speechAge = cue.kind === "delegate" ? 2_450 : 2_000
    return true
  }

  cueActive(actorID: string): boolean { return (this.actors.get(actorID)?.speechAge ?? 0) > 0 }

  settle(): void {
    for (const [id, state] of this.actors) {
      if (state.leaving || terminalTask(state.actor)) { this.actors.delete(id); continue }
      state.speech = undefined
      state.speechSource = undefined
      state.cueFacing = undefined
      state.speechAge = 0
      state.path = []
      state.speed = 0
      state.blocked = false
      state.opacityAge = 400
      if (state.actor.source !== "unavailable") {
        state.target = state.actor.status === "idle" ? (state.lounge ??= this.claimLounge(state.actor)).cell : this.workSpot(state.pod, state.actor).cell
        state.position = center(this.layout, state.target)
      }
    }
  }

  tick(deltaMs: number, reducedMotion: boolean): readonly ActorFrame[] {
    this.reduced = reducedMotion
    if (reducedMotion) this.settle()
    const delta = Math.max(0, Math.min(Number.isFinite(deltaMs) ? deltaMs : 0, 50))
    this.elapsed += delta
    this.ambientClock += delta
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
      if (!state.leaving && state.actor.status === "idle" && !state.lounge && this.snapshot?.connection === "ready") {
        state.idleAge += delta
        if (state.idleAge >= 6_000) { state.lounge = this.claimLounge(state.actor); this.route(state) }
      }
      this.advance(state, delta, reducedMotion)
      if (state.leaving && state.leavingAge >= 400 && !state.path.length) this.actors.delete(id)
    }
    if (!reducedMotion && this.snapshot?.connection === "ready" && this.ambientClock >= 5_000) {
      this.ambientClock %= 5_000
      const resting = [...this.actors.values()].filter((state) => state.actor.status === "idle" && !state.path.length && !state.leaving && !state.speech && this.layout.roomAt(cellAt(this.layout, state.position)) === "lounge")
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

  private claimLounge(actor: OfficeActor): OfficeSpot {
    const occupied = new Set([...this.actors.values()].flatMap((state) => state.lounge ? [`${state.lounge.cell.x},${state.lounge.cell.y}`] : []))
    const offset = appearanceFor(actor.sessionID) % this.layout.lounge.length
    const rotated = this.layout.lounge.map((_, index) => this.layout.lounge[(offset + index) % this.layout.lounge.length]!)
    return [...this.layout.lounge.filter((spot) => spot.pose === "play"), ...rotated.filter((spot) => spot.pose !== "play")]
      .find((spot) => !occupied.has(`${spot.cell.x},${spot.cell.y}`)) ?? this.layout.lounge[offset]!
  }

  private route(state: ActorState): void {
    if (state.leaving || state.actor.source === "unavailable") return
    if (state.actor.status !== "idle") state.lounge = undefined
    const target = state.actor.status === "idle" ? state.lounge?.cell ?? this.layout.pods[state.pod]!.spots.implement.cell : this.workSpot(state.pod, state.actor).cell
    if (same(target, state.target)) return
    this.move(state, target)
  }

  private move(state: ActorState, target: Point): void {
    const allowed = (point: Point) => {
      const owning = this.layout.pods.findIndex((item) => point.x >= item.left && point.x <= item.right && point.y >= item.top && point.y <= item.bottom)
      return owning < 0 || owning === state.pod
    }
    const path = findPath(this.layout, cellAt(this.layout, state.position), target, allowed)
    state.target = target
    state.path = path ? [...path] : []
    state.blocked = path === undefined
    state.speed = 0
  }

  private advance(state: ActorState, delta: number, reducedMotion: boolean): void {
    if (!state.path.length || reducedMotion || this.snapshot?.connection !== "ready") return
    const maxSpeed = this.layout.tileSize * 4.5 / 1000
    const acceleration = maxSpeed / 400
    const first = center(this.layout, state.path[0]!)
    const remaining = Math.hypot(first.x - state.position.x, first.y - state.position.y) + (state.path.length - 1) * this.layout.tileSize
    const targetSpeed = Math.min(maxSpeed, Math.sqrt(2 * acceleration * remaining))
    const nextSpeed = targetSpeed < state.speed ? Math.max(targetSpeed, state.speed - acceleration * delta) : Math.min(targetSpeed, state.speed + acceleration * delta)
    let distance = Math.min(remaining, (state.speed + nextSpeed) / 2 * delta)
    state.speed = nextSpeed
    while (state.path.length && distance > 0) {
      const target = center(this.layout, state.path[0]!)
      const dx = target.x - state.position.x
      const dy = target.y - state.position.y
      const length = Math.hypot(dx, dy)
      if (length <= distance) {
        state.position = target
        state.path.shift()
        distance -= length
        continue
      }
      state.direction = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "down" : "up"
      state.position = { x: state.position.x + dx / length * distance, y: state.position.y + dy / length * distance }
      distance = 0
    }
    if (!state.path.length) state.speed = 0
  }

  private frame(state: ActorState, reducedMotion: boolean): ActorFrame {
    const atWork = !state.path.length && same(cellAt(this.layout, state.position), this.workSpot(state.pod, state.actor).cell)
    const spot = state.actor.status === "idle" && state.lounge ? state.lounge : this.workSpot(state.pod, state.actor)
    const playing = spot.pose === "play" && !state.path.length && !reducedMotion && state.actor.source !== "unavailable" && same(cellAt(this.layout, state.position), spot.cell)
    const working = ["working", "tool", "compacting"].includes(state.actor.status)
    return {
      actor: state.actor, appearance: appearanceFor(state.actor.sessionID), position: state.position,
      direction: state.path.length ? state.direction : this.cueFacingFor(state) ?? spot.facing,
      pose: state.path.length && !reducedMotion ? "walk" : state.actor.status === "attention" && atWork ? "wave" : state.speech ? "talk" : working && atWork && (!state.actor.activity || state.actor.activity === "implement") ? "type" : spot.pose === "play" ? playing ? "play" : "stand" : spot.pose,
      moving: state.path.length > 0 && !reducedMotion && state.actor.source !== "unavailable",
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
    state.lounge = undefined
    this.move(state, this.layout.door)
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
