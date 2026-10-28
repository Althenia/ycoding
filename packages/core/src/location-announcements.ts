export * as LocationAnnouncements from "./location-announcements"

import { Context, Effect } from "effect"

export class Gate {
  private built: boolean
  private closed = false
  private holds = 0

  constructor(built: boolean) {
    this.built = built
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

  when<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return Effect.suspend(() => (this.open ? Effect.asVoid(effect) : Effect.void))
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
