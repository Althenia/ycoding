import { describe, expect, test } from "bun:test"
import { columns, officeLayout, props, rows } from "./map"
import { activityForActor, claimEntity, claimedEntities, entityCatalog, entityState, interactionKind, seededRoomVariant, transitionEntity } from "./entities"

describe("Office entities", () => {
  test("catalogs every map prop with a unique id, a walkable interaction, and positive capacity", () => {
    expect(entityCatalog).toHaveLength(props.length)
    expect(new Set(entityCatalog.map((entity) => entity.id)).size).toBe(entityCatalog.length)
    expect(entityCatalog.every((entity) => entity.capacity >= 1 && entity.interactionSpots.length > 0)).toBe(true)
    expect(entityCatalog.every((entity) => entity.interactionSpots.every(({ cell }) => cell.x >= 0 && cell.x < columns && cell.y >= 0 && cell.y < rows && officeLayout.walkable(cell.x, cell.y)))).toBe(true)
  })

  test("runtime activity and tool names select truthful object kinds", () => {
    expect(["read", "glob", "grep", "websearch", "edit", "patch", "shell", "test", "thinking", "attention", "idle"].map((tool) => interactionKind(tool))).toEqual([
      "bookshelf", "bookshelf", "whiteboard", "whiteboard", "developerDesk", "developerDesk", "deviceRack", "deviceRack", "developerDesk", "developerDesk", "coffeeMachine",
    ])
    expect([
      { status: "tool", statusText: "Editing app.ts", activity: "implement" },
      { status: "tool", statusText: "Running bun test", activity: "verify" },
      { status: "tool", statusText: "Searching source", activity: "research" },
      { status: "thinking", statusText: "Thinking", activity: "hold" },
      { status: "attention", statusText: "Needs your decision", activity: "hold" },
      { status: "idle", statusText: "", activity: undefined },
    ].map(activityForActor)).toEqual(["edit", "shell", "search", "thinking", "attention", "idle"])
  })

  test("entity transitions and exclusive claims reject an over-capacity actor", () => {
    const workstation = entityCatalog.find((entity) => entity.kind === "developerDesk")!
    const inUse = transitionEntity(workstation.state, { type: "claim", actorID: "actor-a" })
    expect(inUse).toMatchObject({ status: "in-use", users: ["actor-a"] })
    expect(claimEntity(workstation, inUse, "actor-b")).toBeUndefined()
    expect(transitionEntity(inUse, { type: "release", actorID: "actor-a" })).toMatchObject({ status: "idle", users: [] })
    expect(transitionEntity(workstation.state, { type: "power", on: true })).toMatchObject({ status: "on" })
    expect(entityState(workstation, ["actor-a"])).toMatchObject({ status: "occupied", users: ["actor-a"] })
    expect(entityState(entityCatalog.find((entity) => entity.kind === "conferenceTable")!, ["actor-a"])).toMatchObject({ status: "in-use" })
    expect(transitionEntity(workstation.state, { type: "brew" })).toMatchObject({ status: "brewing" })
  })

  test("decor variants are stable by room and seed", () => {
    expect(seededRoomVariant("block:3", 8, 4)).toBe(seededRoomVariant("block:3", 8, 4))
    expect(seededRoomVariant("block:3", 8, 4)).toBeGreaterThanOrEqual(0)
    expect(seededRoomVariant("block:3", 8, 4)).toBeLessThan(4)
    expect(new Set([0, 1, 2, 3, 4, 5, 6, 7].map((seed) => seededRoomVariant("block:3", seed, 4))).size).toBe(4)
  })

  test("activity claims stay within each entity capacity", () => {
    const actors = Array.from({ length: 4 }, (_, index) => ({ id: `actor-${index}`, status: "tool", statusText: "Running bun test", room: "block" as const,
      position: { x: (2 + index % 4) * 32, y: 4 * 32 } }))
    const claims = claimedEntities(actors)
    expect([...claims].every(([id, users]) => users.length <= entityCatalog.find((entity) => entity.id === id)!.capacity)).toBe(true)
    expect(new Set([...claims.values()].flat()).size).toBe(actors.length)
  })
})
