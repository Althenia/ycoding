import { expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import path from "node:path"
import baseline from "./fixtures/wire-numbers-before-autonomy-review.json" with { type: "json" }

const descriptors = path.resolve(import.meta.dir, "../../../protocol/ycoding/v5")
const text = readdirSync(descriptors)
  .filter((file) => file.endsWith(".proto"))
  .sort()
  .map((file) => Bun.file(path.join(descriptors, file)).text())
const sources = await Promise.all(text)

const current = {
  messages: new Map<string, Map<string, number>>(),
  enums: new Map<string, Map<string, number>>(),
  reserved: new Map<string, number[]>(),
  operations: new Map<string, number>(),
  events: new Map<string, [number, boolean, string]>(),
}
for (const source of sources) {
  for (const match of source.matchAll(/^message (\w+) \{\n([\s\S]*?)^\}/gm)) {
    current.messages.set(
      match[1],
      new Map(
        [...match[2].matchAll(/^\s+(?:(?:required|optional|repeated) )?\S+ (\w+) = (\d+)/gm)].map((field) => [
          field[1],
          Number(field[2]),
        ]),
      ),
    )
    const reserved = [...match[2].matchAll(/^\s+reserved ([\d, ]+);/gm)].flatMap((line) =>
      line[1].split(",").map((value) => Number(value.trim())),
    )
    if (reserved.length) current.reserved.set(match[1], reserved)
  }
  for (const match of source.matchAll(/^enum (\w+) \{\n([\s\S]*?)^\}/gm))
    current.enums.set(
      match[1],
      new Map([...match[2].matchAll(/^\s+(\w+) = (\d+)(?: \[[^\]]*\])?;/gm)].map((value) => [value[1], Number(value[2])])),
    )
  for (const match of source.matchAll(/operation_id: (\d+)\s+diagnostic_name: "([^"]+)"/g))
    current.operations.set(match[2], Number(match[1]))
  for (const match of source.matchAll(
    /(\w+) (\w+) = (\d+) \[\(ycoding\.v5\.public_event\) = \{ diagnostic_name: "([^"]+)" durable: (true|false) \}\]/g,
  ))
    current.events.set(match[4], [Number(match[3]), match[5] === "true", match[1]])
}

test("every operation ID in the before-map is unchanged", () => {
  const changed = Object.entries(baseline.operations).filter(([name, id]) => current.operations.get(name) !== id)
  expect(changed).toEqual([])
})

test("every public event tag, durability and envelope type in the before-map is unchanged", () => {
  const changed = Object.entries(baseline.publicEvents).filter(
    ([name, entry]) => JSON.stringify(current.events.get(name)) !== JSON.stringify(entry),
  )
  expect(changed).toEqual([])
})

test("every enum value in the before-map is unchanged", () => {
  const changed = Object.entries(baseline.enums).flatMap(([name, values]) =>
    Object.entries(values).flatMap(([value, number]) =>
      current.enums.get(name)?.get(value) === number ? [] : [`${name}.${value}`],
    ),
  )
  expect(changed).toEqual([])
})

test("retained message field tags are unchanged and no later field reuses a retired tag", () => {
  const changed = Object.entries(baseline.messages).flatMap(([name, fields]) =>
    Object.entries(fields).flatMap(([field, tag]) =>
      current.messages.get(name)?.get(field) === tag ? [] : [`${name}.${field}`],
    ),
  )
  expect(changed).toEqual(["SessionAutonomyYolo.value_4"])
  const reused = Object.entries(baseline.messages).flatMap(([name, fields]) => {
    const used = new Set(Object.values(fields))
    return [...(current.messages.get(name) ?? [])].flatMap(([field, tag]) =>
      field in fields || !used.has(tag) ? [] : [`${name}.${field}`],
    )
  })
  expect(reused).toEqual([])
})

test("retired slots stay reserved and unused", () => {
  expect(baseline.reserved).toEqual({ SessionLogItem: [40] })
  for (const [name, slots] of Object.entries({ ...baseline.reserved, SessionAutonomyYolo: [4] })) {
    for (const slot of slots) {
      expect(current.reserved.get(name) ?? []).toContain(slot)
      expect([...(current.messages.get(name)?.values() ?? [])]).not.toContain(slot)
    }
  }
})
