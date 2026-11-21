import { describe, expect, test } from "bun:test"
import path from "node:path"
import { messages } from "../src/generated/v5/contract.js"
import { MutationClass, operations, PeerRole } from "../src/v5/index.js"
import { connectorOperations } from "./connector-source.js"

const mainRemoteOperationAccess = [
  ["provider.auth.list", "read"],
  ["provider.auth.key", "mutation"],
  ["provider.auth.begin", "mutation"],
  ["provider.auth.status", "mutation"],
  ["provider.auth.complete", "mutation"],
  ["provider.auth.cancel", "mutation"],
  ["provider.auth.refresh", "mutation"],
  ["workspace.list", "read"],
  ["session.list", "read"],
  ["session.active", "read"],
  ["session.get", "read"],
  ["session.delete", "mutation"],
  ["session.messages", "read"],
  ["session.capturedChanges.list", "read"],
  ["session.compaction.list", "read"],
  ["session.compact", "mutation"],
  ["session.snapshot", "read"],
  ["session.pending.list", "read"],
  ["session.attachment.read", "read"],
  ["session.message.stream", "read"],
  ["session.todo.list", "read"],
  ["session.subagent.list", "read"],
  ["session.pin", "mutation"],
  ["session.unpin", "mutation"],
  ["session.subagent.cancel", "mutation"],
  ["session.subagent.answer", "mutation"],
  ["session.team.economics", "read"],
  ["session.team.shell.list", "read"],
  ["session.team.shell.kill", "mutation"],
  ["session.side-chat.list", "read"],
  ["session.side-chat.create", "mutation"],
  ["session.family.activity", "read"],
  ["session.log", "read"],
  ["session.subscribe", "mutation"],
  ["session.unsubscribe", "mutation"],
  ["session.prompt", "mutation"],
  ["session.attachment.upload", "mutation"],
  ["session.interrupt", "mutation"],
  ["session.prediction", "mutation"],
  ["session.promptGenerate", "mutation"],
  ["session.permission.list", "read"],
  ["session.permission.reply", "mutation"],
  ["session.guardrail.status", "read"],
  ["session.guardrail.request.list", "read"],
  ["session.guardrail.reply", "mutation"],
  ["session.review.list", "read"],
  ["session.review.decide", "mutation"],
  ["session.form.list", "read"],
  ["session.form.reply", "mutation"],
  ["session.form.cancel", "mutation"],
  ["session.shell.output", "read"],
  ["session.autonomy.get", "read"],
  ["session.autonomy.set", "mutation"],
  ["session.goal.set", "mutation"],
  ["session.goal.stop", "mutation"],
  ["session.create", "mutation"],
  ["session.status", "read"],
  ["session.catalog", "read"],
  ["workspace.catalog", "read"],
  ["session.file.find", "read"],
  ["workspace.file.find", "read"],
  ["session.switchModel", "mutation"],
  ["session.switchAgent", "mutation"],
  ["session.command", "mutation"],
  ["dots.get", "read"],
  ["dots.set", "mutation"],
  ["dots.attach", "mutation"],
  ["dots.detach", "mutation"],
  ["dots.remove", "mutation"],
  ["session.skill", "mutation"],
  ["usage.providers", "read"],
  ["usage.summary", "read"],
  ["usage.report", "read"],
  ["session.usageReport", "read"],
  ["session.promptCosts", "read"],
  ["session.taskCosts", "read"],
  ["usage.forecast", "read"],
  ["usage.dashboard", "read"],
  ["incident.report", "read"],
  ["incident.recent", "read"],
  ["incident.guidance", "read"],
  ["incident.guidance.clear", "mutation"],
  ["coordination.settings", "read"],
  ["coordination.list", "read"],
  ["coordination.create", "mutation"],
  ["coordination.get", "read"],
  ["coordination.update", "mutation"],
  ["coordination.delete", "mutation"],
  ["machine.keepAwake.get", "read"],
  ["machine.keepAwake.set", "mutation"],
  ["machine.telemetry.consent.get", "read"],
  ["machine.telemetry.consent.set", "mutation"],
  ["machine.latency.append", "mutation"],
  ["machine.latency.list", "read"],
] as const
const mainNoticeOperations = ["notice.subscribe", "notice.list", "notice.read", "notice.readAll"] as const

const nativeRenames: Record<string, string> = {
  "session.delete": "session.remove",
  "incident.guidance": "incident.guidance.get",
}

const dots = {
  "dots.get": [2068, "read"],
  "dots.set": [2069, "mutation"],
  "dots.attach": [2071, "mutation"],
  "dots.detach": [2074, "mutation"],
  "dots.remove": [2075, "mutation"],
} as const
const localOnly = [
  "session.subagent.switchModel",
  "dots.threads",
  "dots.task.updates",
  "dots.thread.read",
  "dots.thread.send",
  "dots.thread.interrupt",
  "dots.resume",
  "dots.thread.requests",
  "dots.thread.respond",
]

const operation = (name: string) => {
  const found = operations.find((candidate) => candidate.diagnosticName === name)
  if (!found) throw new Error(`missing operation ${name}`)
  return found
}
const proto = Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/session.proto")).text()
const declared = messages as Record<string, { fields: readonly { name: string; tag: number; target?: string }[] }>

describe("main remote contract", () => {
  test("the native remote inventory equals the frozen main closed set with its two native renames and access classes", () => {
    const expected = mainRemoteOperationAccess.map(([name, access]) => [nativeRenames[name] ?? name, access] as const)
    expect(expected).toHaveLength(94)
    expect(Object.keys(connectorOperations).sort()).toEqual(expected.map(([name]) => name).sort())
    for (const [name, access] of expected)
      expect(connectorOperations[name as keyof typeof connectorOperations]?.[3], name).toBe(
        access === "read" ? "READ" : "MUTATION",
      )
  })

  test.each(Object.entries(dots))(
    "%s keeps the main remote role, operation ID and access class",
    (name, [id, access]) => {
      const descriptor = operation(name)
      expect(descriptor.operationId).toBe(id)
      expect(descriptor.roles).toEqual([PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY])
      expect(descriptor.mutation).toBe(access === "read" ? MutationClass.READ : MutationClass.MUTATION)
    },
  )

  test.each(localOnly)("%s stays local-only", (name) => {
    expect(operation(name).roles).toEqual([PeerRole.LOCAL_CLIENT])
  })

  test("remote and relay allowlist sizes derive from the main set", () => {
    const remote = operations.filter((descriptor) => descriptor.roles.includes(PeerRole.REMOTE_CLIENT))
    const relay = operations.filter((descriptor) => descriptor.roles.includes(PeerRole.RELAY))
    const canonical = new Set(
      mainRemoteOperationAccess.map(
        ([name]) => connectorOperations[(nativeRenames[name] ?? name) as keyof typeof connectorOperations][0],
      ),
    )
    expect([remote.length, relay.length]).toEqual([canonical.size + mainNoticeOperations.length, canonical.size])
  })
})

describe("caller-supplied request provenance", () => {
  test("no caller-supplied request carries McpEvents_RequestContext", async () => {
    const carriers = Object.entries(declared)
      .filter(([name]) => !name.startsWith("ycoding.v5.SessionLogItem"))
      .flatMap(([name, message]) =>
        message.fields
          .filter((field) => field.target === "ycoding.v5.McpEvents_RequestContext")
          .map((field) => `${name.replace("ycoding.v5.", "")}.${field.name}=${field.tag}`),
      )
      .sort()
    expect(carriers).toEqual([])
    const source = await proto
    expect(
      [...source.matchAll(/^message (\w+) \{[\s\S]*?\n\}/gm)]
        .filter(([block, name]) => !name!.startsWith("SessionLogItem") && / McpEvents_RequestContext \w+ = /.test(block))
        .map(([, name]) => name),
    ).toEqual([])
  })
})
