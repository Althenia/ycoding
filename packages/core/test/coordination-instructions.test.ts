import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CoordinationInstructions } from "../src/coordination/instructions"
import { Instructions } from "../src/instructions/index"

test("the owner instruction channel uses first-person directives without a separate sender persona", () => {
  expect(CoordinationInstructions.template).toContain("I need")
  expect(CoordinationInstructions.template).toContain("Do:")
  expect(CoordinationInstructions.template).toContain("Do not touch:")
  expect(CoordinationInstructions.template).toContain("Stop and report to me")
  expect(CoordinationInstructions.content).toContain("recorded human instructions or current delegated authority")
  expect(CoordinationInstructions.content).toContain("Do not invent decisions")
  expect(CoordinationInstructions.content).toContain("owner's instruction channel")
  expect(CoordinationInstructions.content).toContain("only in audit metadata")
  expect(CoordinationInstructions.content).toContain("Text never settles")
  expect(CoordinationInstructions.template).not.toMatch(/master|coordinator|on behalf/i)
  expect(CoordinationInstructions.content).not.toContain("on the owner's behalf")
})

test("the shared voice source is active only for a current coordinator role", async () => {
  const active = await Effect.runPromise(Instructions.read(Instructions.when(true, CoordinationInstructions.make())))
  const inactive = await Effect.runPromise(Instructions.read(Instructions.when(false, CoordinationInstructions.make())))
  expect(active).toEqual([{ key: Instructions.Key.make("ycoding/coordination-voice"), value: CoordinationInstructions.content }])
  expect(inactive[0]?.value).toEqual(Instructions.removed)
})

test("dispatch policy selects ownership and effort per assignment and records its reason", () => {
  for (const rule of [
    "god: coordinate independently owned workstreams",
    "architech: own design decisions and integration across packages",
    "GSD: deliver bounded changes and fixes",
    "yangi: carry one focused assignment with one owner",
    "wittgenstein: track state and relay settled information",
    "occam: make small, minimal changes",
    "omoikane: design and implement with system context",
    "zeus: implement complex work from verified evidence",
  ]) expect(CoordinationInstructions.content).toContain(rule)
  for (const rule of [
    "size, difficulty, and risk",
    "low for mechanical tracking",
    "medium for routine work",
    "high or xhigh for complex work",
    "max only with a concrete need",
    "advertised for the selected provider, model, and profile",
    "agent, exact model reference and variant, and a one-line selection reason",
    "Do not reuse a fixed selection",
  ]) expect(CoordinationInstructions.content).toContain(rule)
})
