export * as LocationAnnouncements from "./location-announcements"

import { Context, Effect } from "effect"

export type Kind = "catalog" | "command"

export class Reads {
  private readonly kinds = new Set<Kind>()
  private readonly all: boolean

  constructor(all = false) {
    this.all = all
  }

  mark(kind: Kind) {
    this.kinds.add(kind)
  }

  has(kind: Kind) {
    return this.all || this.kinds.has(kind)
  }
}

export const CurrentReads = Context.Reference<Reads>("@ycoding/LocationAnnouncements/CurrentReads", {
  defaultValue: () => new Reads(true),
})

export const Initial = Context.Reference<boolean>("@ycoding/LocationAnnouncements/Initial", {
  defaultValue: () => false,
})

export const initial = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, Initial, true)

export const read = Effect.fnUntraced(function* (kind: Kind) {
  const reads = yield* CurrentReads
  reads.mark(kind)
})

export class Gate {
  private built: boolean
  private closed = false
  private holds = 0
  private readonly reads: Reads

  constructor(built: boolean, reads = new Reads(true)) {
    this.built = built
    this.reads = reads
  }

  get open() {
    return this.built && !this.closed && this.holds === 0
  }

  settle() {
    this.built = true
  }

  close() {
    this.closed = true
  }

  announces(kind?: Kind) {
    const reads = this.reads
    const open = () => this.open
    return Effect.gen(function* () {
      if (!open()) return false
      if (!(yield* Initial)) return true
      return kind !== undefined && reads.has(kind)
    })
  }

  when<A, E, R>(effect: Effect.Effect<A, E, R>, kind?: Kind) {
    return Effect.flatMap(this.announces(kind), (announce) => (announce ? Effect.asVoid(effect) : Effect.void))
  }

  hold() {
    this.holds++
    let held = true
    return () => {
      if (!held) return
      held = false
      this.holds--
    }
  }
}

export const Current = Context.Reference<Gate>("@ycoding/LocationAnnouncements/Current", {
  defaultValue: () => new Gate(true),
})
