import { appearanceFor } from "./sprites"
import { findPath } from "./navigation"
import type { ActorFrame, ActorSpeech, OfficeActor, OfficeCue, OfficeHomeRoom, OfficeLayout, OfficeSnapshot, OfficeSpot, Point } from "./types"

type ActorState = {
  actor: OfficeActor
  position: Point
  direction: ActorFrame["direction"]
  path: Point[]
  target: Point
  work: OfficeSpot
  workRoom: OfficeHomeRoom | "meeting"
  workDwell: number
  lounge?: OfficeSpot
  blocked: boolean
  leaving: boolean
  opacityAge: number
  leavingAge: number
  speech?: ActorSpeech
  speechAge: number
  cue?: string
  legAge: number
  legDeadline: number
  dwell: number
  random: number
  lastChat: number
}

type Briefing = { supervisor: string; children: string[]; talked: string[]; activeChild?: string; timer: number; talking: boolean; returning: boolean }
type Report = { child: string; supervisor: string; timer: number; talking: boolean; returning: boolean }

export class OfficeDirector {
  private readonly actors = new Map<string, ActorState>()
  private readonly briefings = new Map<string, Briefing>()
  private readonly reports = new Map<string, Report>()
  private readonly departed = new Set<string>()
  private scope?: string
  private snapshot?: OfficeSnapshot
  private hydrated = false
  private elapsed = 0
  private ambientClock = 0

  constructor(private readonly layout: OfficeLayout) {}

  sync(snapshot: OfficeSnapshot): void {
    if (snapshot.scope !== this.scope) {
      this.clear()
      this.scope = snapshot.scope
      this.snapshot = snapshot
      this.hydrate(snapshot)
      return
    }
    const previous = this.snapshot
    this.snapshot = snapshot
    const rootChanged = previous?.team.rootActorID !== snapshot.team.rootActorID
    const visible = new Set(snapshot.actors.map((actor) => actor.id))
    for (const [id, state] of this.actors) {
      if (visible.has(id)) continue
      const immediate = snapshot.connection !== "ready" || state.actor.kind === "task" && rootChanged || this.reduced
      if (immediate || !this.hydrated) this.drop(id)
      else this.depart(state)
    }
    for (const actor of snapshot.actors) {
      if (!terminalTask(actor)) this.departed.delete(actor.id)
      const state = this.actors.get(actor.id)
      if (state) {
        state.actor = actor
        if (terminalTask(actor) && !state.leaving && !state.cue && !snapshot.cues.some((cue) => cue.kind === "report" && cue.fromActorID === actor.id)) {
          this.departed.add(actor.id)
          this.depart(state)
          continue
        }
        if (state.leaving) {
          if (this.departed.has(actor.id)) continue
          state.leaving = false
          state.leavingAge = 0
          state.opacityAge = 400
        }
        if (snapshot.connection === "ready" && actor.source !== "unavailable" && !state.cue) this.routeDestination(state)
        continue
      }
      if (this.departed.has(actor.id) || terminalTask(actor)) continue
      const direct = !this.hydrated || actor.kind === "task" && rootChanged && previous?.team.rootActorID !== undefined || snapshot.connection !== "ready" || this.reduced
      this.add(actor, direct ? undefined : this.layout.door, !direct)
      if (!direct) this.routeDestination(this.actors.get(actor.id)!)
    }
    this.hydrated = true
  }

  playCue(cue: OfficeCue): boolean {
    const source = this.actors.get(cue.fromActorID)
    const recipient = this.actors.get(cue.toActorID)
    if (!source || !recipient || source === recipient || source.actor.source === "unavailable" || recipient.actor.source === "unavailable" || this.snapshot?.connection !== "ready") return false
    if (cue.kind === "delegate") {
      let briefing = [...this.briefings.values()].find((item) => item.supervisor === source.actor.id)
      if (!briefing) {
        briefing = { supervisor: source.actor.id, children: [], talked: [], timer: 0, talking: false, returning: false }
        this.briefings.set(cue.id, briefing)
        source.cue = cue.id
        source.legAge = 0
        this.move(source, this.freeSpot(this.layout.meeting, [source.actor.id]).cell)
      }
      if (briefing.children.includes(recipient.actor.id)) return false
      briefing.children.push(recipient.actor.id)
      recipient.cue = cue.id
      recipient.legAge = 0
      this.move(recipient, this.freeSpot(this.layout.meeting, [recipient.actor.id]).cell)
      return true
    }
    if (source.cue || recipient.cue) return false
    const report: Report = { child: source.actor.id, supervisor: recipient.actor.id, timer: 0, talking: false, returning: false }
    this.reports.set(cue.id, report)
    source.cue = cue.id
    recipient.cue = cue.id
    const resting = recipient.path.length ? recipient.target : cellAt(this.layout, recipient.position)
    const adjacent = [{ x: resting.x + 1, y: resting.y }, { x: resting.x - 1, y: resting.y }, { x: resting.x, y: resting.y + 1 }, { x: resting.x, y: resting.y - 1 }]
      .find((point) => this.layout.walkable(point.x, point.y) && findPath(this.layout, cellAt(this.layout, source.position), point) !== undefined)
    if (!adjacent) {
      this.reports.delete(cue.id)
      source.cue = undefined
      recipient.cue = undefined
      return false
    }
    this.move(source, adjacent)
    return true
  }

  cueActive(actorID: string): boolean {
    return [...this.briefings.values()].some((briefing) => briefing.supervisor === actorID || briefing.children.includes(actorID)) || [...this.reports.values()].some((report) => report.child === actorID || report.supervisor === actorID)
  }

  settle(): void {
    this.briefings.clear()
    this.reports.clear()
    for (const [id, state] of this.actors) {
      if (state.leaving) {
        this.drop(id)
        continue
      }
      state.cue = undefined
      state.speech = undefined
      state.speechAge = 0
      state.lastChat = this.elapsed
      state.dwell = 8_000
      state.opacityAge = 400
      state.path = []
      state.blocked = false
      if (state.actor.source !== "unavailable") {
        state.target = this.destination(state.actor, state)
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
    for (const state of this.actors.values()) {
      if (state.actor.source === "unavailable") continue
      if (state.opacityAge < 400) state.opacityAge = Math.min(400, state.opacityAge + delta)
      if (state.leaving) state.leavingAge += delta
      if (state.speechAge > 0 && !state.cue) {
        state.speechAge = Math.max(0, state.speechAge - delta)
        if (!state.speechAge) state.speech = undefined
      }
      state.legAge += state.cue ? delta : 0
      this.advance(state, delta, reducedMotion || this.snapshot?.connection !== "ready")
      if (!state.path.length && !state.cue && !state.leaving && state.actor.status === "idle" && this.isLounge(state)) state.dwell -= delta
      if (!state.path.length && !state.cue && !state.leaving && (state.actor.activity === "research" || state.actor.activity === "verify")) state.workDwell -= delta
    }
    this.advanceChoreography(delta)
    if (!reducedMotion && this.snapshot?.connection === "ready") this.ambient()
    for (const [id, state] of this.actors) if (state.leaving && state.leavingAge >= 400 && !state.path.length) this.drop(id)
    return [...this.actors.values()].map((state) => this.frame(state, reducedMotion))
  }

  private reduced = false

  private hydrate(snapshot: OfficeSnapshot): void {
    for (const actor of snapshot.actors) if (!terminalTask(actor)) this.add(actor)
    this.hydrated = true
  }

  private add(actor: OfficeActor, start?: Point, arrival = false): void {
    const workRoom = this.workRoom(actor)
    const work = this.claimWork(actor, workRoom)
    const lounge = actor.status === "idle" ? this.claimLounge(actor) : undefined
    const position = start ?? (actor.status === "idle" ? lounge!.cell : work.cell)
    const state: ActorState = {
      actor, position: center(this.layout, position), direction: "down", path: [], target: position,
      work, workRoom, workDwell: 1_500, lounge, blocked: false, leaving: false, opacityAge: arrival ? 0 : 400,
      leavingAge: 0, legAge: 0, legDeadline: 4_000, speechAge: 0, dwell: 8_000 + this.randomFor(actor.sessionID) % 8_001,
      random: hash(actor.sessionID), lastChat: -20_000,
    }
    this.actors.set(actor.id, state)
  }

  private workRoom(actor: OfficeActor): OfficeHomeRoom | "meeting" {
    if (actor.activity === "coordinate") return "meeting"
    if (actor.activity === "research") return "research"
    if (actor.activity === "verify") return "qa"
    if (actor.activity === "implement") return "developer"
    return actor.homeRoom
  }

  private claimWork(actor: OfficeActor, room: OfficeHomeRoom | "meeting"): OfficeSpot {
    const spots = room === "meeting" ? this.layout.meeting : this.layout.work[room]
    const occupied = new Set([...this.actors.values()].filter((state) => state.workRoom === room && state.actor.id !== actor.id).map((state) => key(state.work.cell)))
    return spots.find((spot) => !occupied.has(key(spot.cell))) ?? spots[this.actors.size % spots.length]!
  }

  private claimLounge(actor: OfficeActor): OfficeSpot {
    const spots = this.layout.lounge
    const occupied = new Set([...this.actors.values()].flatMap((state) => state.lounge ? [key(state.lounge.cell)] : []))
    const offset = appearanceFor(actor.sessionID) % spots.length
    return spots.map((_, index) => spots[(offset + index) % spots.length]!).find((spot) => !occupied.has(key(spot.cell))) ?? spots[offset]!
  }

  private destination(actor: OfficeActor, state = this.actors.get(actor.id)): Point {
    if (actor.status === "idle") return state?.lounge?.cell ?? this.claimLounge(actor).cell
    if (actor.activity === "hold" && state) return state.target
    return state?.work.cell ?? this.claimWork(actor, this.workRoom(actor)).cell
  }

  private routeDestination(state: ActorState): void {
    if (state.actor.source === "unavailable" || state.leaving) return
    if (state.actor.status === "idle" && !state.lounge) state.lounge = this.claimLounge(state.actor)
    if (state.actor.status !== "idle") state.lounge = undefined
    if (state.actor.status !== "idle" && state.actor.activity !== "hold" && state.workRoom !== this.workRoom(state.actor)) {
      state.workRoom = this.workRoom(state.actor)
      state.work = this.claimWork(state.actor, state.workRoom)
      state.workDwell = 1_500
    }
    const target = this.destination(state.actor, state)
    if (same(target, state.target)) return
    this.move(state, target)
  }

  private move(state: ActorState, target: Point): void {
    const path = findPath(this.layout, cellAt(this.layout, state.position), target)
    state.target = target
    state.path = path ? [...path] : []
    state.blocked = path === undefined
    state.legAge = 0
    state.legDeadline = (path?.length ?? 0) * 1000 / 4.5 + 4_000
  }

  private advance(state: ActorState, delta: number, reducedMotion: boolean): void {
    if (!state.path.length || reducedMotion || this.snapshot?.connection !== "ready") return
    let distance = delta * this.layout.tileSize * 4.5 / 1000
    while (state.path.length && distance > 0) {
      const target = center(this.layout, state.path[0]!)
      const dx = target.x - state.position.x
      const dy = target.y - state.position.y
      const length = Math.hypot(dx, dy)
      if (length <= distance) {
        state.position = target
        state.path.shift()
        distance -= length
        if (!state.path.length && state.actor.status === "idle" && this.isLounge(state)) state.dwell = 8_000 + this.nextRandom(state) % 8_001
        continue
      }
      state.direction = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "down" : "up"
      state.position = { x: state.position.x + dx / length * distance, y: state.position.y + dy / length * distance }
      distance = 0
    }
  }

  private advanceChoreography(delta: number): void {
    for (const [id, briefing] of this.briefings) {
      const supervisor = this.actors.get(briefing.supervisor)
      const children = briefing.children.map((child) => this.actors.get(child)).filter((state): state is ActorState => !!state)
      if (!supervisor || [...children, supervisor].some((state) => state.legAge > state.legDeadline && (state.path.length || state.blocked))) {
        for (const state of [supervisor, ...children]) if (state) this.finishCueActor(state)
        this.briefings.delete(id)
        continue
      }
      const nextChild = children.find((state) => !state.path.length && !briefing.talked.includes(state.actor.id))
      if (!briefing.talking && !briefing.returning && !supervisor.path.length && nextChild) {
        briefing.talking = true
        briefing.timer = 2_450
        briefing.activeChild = nextChild.actor.id
        supervisor.speech = "delegate"
        nextChild.speech = "chat"
      }
      if (briefing.talking) {
        briefing.timer -= delta
        if (briefing.timer <= 0) {
          const completedChild = children.find((state) => state.actor.id === briefing.activeChild)
          if (completedChild) completedChild.speech = undefined
          if (briefing.activeChild && !briefing.talked.includes(briefing.activeChild)) briefing.talked.push(briefing.activeChild)
          supervisor.speech = undefined
          briefing.talking = false
          briefing.activeChild = undefined
          if (children.every((state) => briefing.talked.includes(state.actor.id))) {
            for (const child of children) {
              if (terminalTask(child.actor)) { this.departed.add(child.actor.id); this.depart(child) }
              else this.routeDestination(child)
            }
            this.routeDestination(supervisor)
            briefing.returning = true
          }
        }
      } else if (briefing.returning && !supervisor.path.length && children.every((state) => !state.path.length)) {
        for (const state of [supervisor, ...children]) state.cue = undefined
        this.briefings.delete(id)
      }
    }
    for (const [id, report] of this.reports) {
      const child = this.actors.get(report.child)
      const supervisor = this.actors.get(report.supervisor)
      if (!child || !supervisor || [child, supervisor].some((state) => state.legAge > state.legDeadline && (state.path.length || state.blocked))) {
        if (child) this.finishCueActor(child)
        if (supervisor) this.finishCueActor(supervisor)
        this.reports.delete(id)
        continue
      }
      if (!report.talking && !report.returning && !child.path.length) {
        report.talking = true
        report.timer = 2_000
        child.speech = "report"
        supervisor.speech = "chat"
      }
      if (report.talking) {
        report.timer -= delta
        if (report.timer <= 0) {
          child.speech = undefined
          supervisor.speech = undefined
          if (terminalTask(child.actor)) { this.departed.add(child.actor.id); this.depart(child) }
          else this.routeDestination(child)
          this.routeDestination(supervisor)
          report.talking = false
          report.returning = true
        }
      } else if (report.returning && !child.path.length && !supervisor.path.length) {
        child.cue = undefined
        supervisor.cue = undefined
        this.reports.delete(id)
      }
    }
  }

  private ambient(): void {
    for (const state of this.actors.values()) {
      if ((state.actor.activity === "research" || state.actor.activity === "verify") && state.actor.status !== "idle" && state.actor.source !== "unavailable"
        && !state.path.length && !state.cue && !state.leaving && state.workDwell <= 0) {
        const spots = this.layout.work[state.workRoom === "meeting" ? state.actor.homeRoom : state.workRoom]
          .filter((spot) => !same(spot.cell, state.work.cell))
        const next = this.freeSpot(spots, [state.actor.id])
        state.work = next
        this.move(state, next.cell)
        state.workDwell = 1_000 + this.nextRandom(state) % 1_500
      }
      if (state.actor.status !== "idle" || state.actor.source === "unavailable" || state.path.length || state.cue || state.dwell > 0 || !this.isLounge(state)) continue
      const next = this.freeSpot(this.layout.lounge.filter((spot) => !state.lounge || !same(spot.cell, state.lounge.cell)), [state.actor.id])
      state.lounge = next
      this.move(state, next.cell)
      state.dwell = 8_000 + this.nextRandom(state) % 8_001
    }
    if (this.ambientClock < 5_000) return
    this.ambientClock %= 5_000
    const idle = [...this.actors.values()].filter((state) => state.actor.status === "idle" && state.actor.source !== "unavailable" && !state.path.length && !state.cue && this.isLounge(state))
    for (let left = 0; left < idle.length; left++) for (let right = left + 1; right < idle.length; right++) {
      const a = idle[left]!
      const b = idle[right]!
      const aCell = cellAt(this.layout, a.position)
      const bCell = cellAt(this.layout, b.position)
      if (Math.abs(aCell.x - bCell.x) + Math.abs(aCell.y - bCell.y) > 3 || this.elapsed - a.lastChat < 20_000 || this.elapsed - b.lastChat < 20_000) continue
      if (this.nextRandom(a) % 100 >= 30) continue
      a.speech = "chat"
      b.speech = "chat"
      a.speechAge = 3_000
      b.speechAge = 3_000
      a.lastChat = this.elapsed
      b.lastChat = this.elapsed
      a.dwell = Math.max(a.dwell, 3_000)
      b.dwell = Math.max(b.dwell, 3_000)
    }
  }

  private frame(state: ActorState, reducedMotion: boolean): ActorFrame {
    const cell = cellAt(this.layout, state.position)
    const spot = state.actor.status === "idle" ? state.lounge : state.work
    const workStatus = ["working", "tool", "compacting"].includes(state.actor.status)
    const atWork = !state.path.length && same(cell, state.work.cell)
    const pose: ActorFrame["pose"] = state.path.length && !reducedMotion ? "walk"
      : state.speech ? "talk"
      : state.actor.status === "attention" && atWork ? "wave"
      : spot?.pose ?? "stand"
    const other = [...this.actors.values()].find((item) => item.speech && item.actor.id !== state.actor.id)
    const reportSupervisor = other?.speech === "report" && state.speech === "chat"
    const mayFaceOther = !reportSupervisor || spot?.pose === "stand"
    return {
      actor: state.actor,
      appearance: appearanceFor(state.actor.sessionID),
      position: state.position,
      direction: state.path.length ? state.direction : other && mayFaceOther ? face(state.position, other.position) : spot?.facing ?? state.direction,
      pose: state.path.length && !reducedMotion ? "walk" : state.speech ? "talk" : workStatus && atWork && (state.actor.activity === "implement" || state.actor.activity === undefined) ? "type" : pose,
      moving: state.path.length > 0 && !reducedMotion && state.actor.source !== "unavailable",
      blocked: state.blocked,
      room: this.layout.roomAt(cell),
      speech: state.speech,
      leaving: state.leaving,
      opacity: state.leaving ? Math.max(0, 1 - state.leavingAge / 400) : state.opacityAge / 400,
    }
  }

  private freeSpot(spots: readonly OfficeSpot[], except: readonly string[]): OfficeSpot {
    const excluded = new Set(except)
    const occupied = new Set([...this.actors.values()].filter((state) => !excluded.has(state.actor.id)).map((state) => key(state.target)))
    return spots.find((spot) => !occupied.has(key(spot.cell))) ?? spots[0]!
  }

  private isLounge(state: ActorState): boolean {
    return !!state.lounge && same(cellAt(this.layout, state.position), state.lounge.cell)
  }

  private finishCueActor(state: ActorState): void {
    state.cue = undefined
    state.speech = undefined
    if (terminalTask(state.actor)) { this.departed.add(state.actor.id); this.depart(state); return }
    this.routeDestination(state)
  }

  private depart(state: ActorState): void {
    state.leaving = true
    state.leavingAge = 0
    state.speech = undefined
    state.lounge = undefined
    this.move(state, this.layout.door)
  }

  private drop(id: string): void {
    this.actors.delete(id)
  }

  private clear(): void {
    this.actors.clear()
    this.briefings.clear()
    this.reports.clear()
    this.departed.clear()
    this.hydrated = false
    this.elapsed = 0
    this.ambientClock = 0
  }

  private randomFor(seed: string): number {
    return nextHash(hash(seed))
  }

  private nextRandom(state: ActorState): number {
    state.random = nextHash(state.random)
    return state.random
  }
}

function terminalTask(actor: OfficeActor): boolean {
  return actor.kind === "task" && (actor.taskState === "completed" || actor.taskState === "cancelled" || actor.taskState === "failed" || actor.taskState === "lost")
}

function center(layout: OfficeLayout, point: Point): Point {
  return { x: point.x * layout.tileSize + layout.tileSize / 2, y: point.y * layout.tileSize + layout.tileSize / 2 }
}

function cellAt(layout: OfficeLayout, point: Point): Point {
  return { x: Math.floor(point.x / layout.tileSize), y: Math.floor(point.y / layout.tileSize) }
}

function key(point: Point): string {
  return `${point.x},${point.y}`
}

function same(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y
}

function face(from: Point, to: Point): ActorFrame["direction"] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "down" : "up"
}

function hash(value: string): number {
  return Array.from(value).reduce((result, character) => Math.imul(result ^ character.codePointAt(0)!, 16777619) >>> 0, 2166136261)
}

function nextHash(value: number): number {
  let current = value + 0x6d2b79f5
  current = Math.imul(current ^ current >>> 15, current | 1)
  current ^= current + Math.imul(current ^ current >>> 7, current | 61)
  return (current ^ current >>> 14) >>> 0
}
