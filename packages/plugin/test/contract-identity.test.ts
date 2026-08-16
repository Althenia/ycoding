import { expect, test } from "bun:test"
import { Agent } from "@ycoding-ai/schema/agent"
import { Command } from "@ycoding-ai/schema/command"
import { Connection } from "@ycoding-ai/schema/connection"
import { Credential } from "@ycoding-ai/schema/credential"
import { Integration } from "@ycoding-ai/schema/integration"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { Reference } from "@ycoding-ai/schema/reference"
import { Skill } from "@ycoding-ai/schema/skill"

const Plugin = await import("../src/effect/index")
const PromisePlugin = await import("../src/promise/index")
const TuiPlugin = await import("../src/tui/index")

test.each([
  ["effect", Plugin],
  ["promise", PromisePlugin],
])("%s entrypoint exposes its canonical Schema contracts", (name, entrypoint) => {
  expect(entrypoint.Agent).toBe(Agent)
  expect(entrypoint.Command).toBe(Command)
  expect(entrypoint.Connection).toBe(Connection)
  expect(entrypoint.Credential).toBe(Credential)
  expect(entrypoint.Integration).toBe(Integration)
  expect(entrypoint.Model).toBe(Model)
  expect(entrypoint.Provider).toBe(Provider)
  expect(entrypoint.Reference).toBe(Reference)
  expect(entrypoint.Skill).toBe(Skill)
  expect(Object.keys(entrypoint).sort()).toEqual([
    "Agent",
    "Command",
    "Connection",
    "Credential",
    "Integration",
    "Model",
    "Plugin",
    "Provider",
    "Reference",
    "Skill",
  ])
})

test("tui entrypoint exposes the current plugin definition", () => {
  const plugin = TuiPlugin.Plugin.define({ id: "demo", setup() {} })
  expect(plugin.id).toBe("demo")
})
