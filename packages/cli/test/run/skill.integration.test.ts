import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { YCoding } from "@ycoding-ai/client/promise"
import { runNonInteractivePrompt } from "../../src/run/noninteractive"
import { auth, createSession, startServer } from "../remote-harness"

async function skillServer(deny = false) {
  const scratch = path.resolve(import.meta.dir, "../../../../.cache/tmp")
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(path.join(scratch, "cli-skill-flow-"))
  await mkdir(path.join(directory, "config", "skills"), { recursive: true })
  const skillPath = path.join(directory, "config", "skills", "cli-explicit-audit.md")
  await writeFile(
    skillPath,
    "---\nname: CLI explicit audit\nmetadata:\n  ycoding/autoinvoke: false\n---\nInspect the CLI skill boundary before making a model decision.\n",
  )
  await writeFile(
    path.join(directory, "config", "skills", "cli-explicit-plan.md"),
    "---\nname: CLI explicit plan\nmetadata:\n  ycoding/autoinvoke: false\n---\nPlan every affected CLI boundary before implementation.\n",
  )
  if (deny)
    await writeFile(
      path.join(directory, "config", "ycoding.json"),
      JSON.stringify({
        agents: {
          build: {
            permissions: [{ action: "skill", resource: "cli-explicit-audit", effect: "deny" }],
          },
        },
      }),
    )
  const server = await startServer(path.join(directory, "config"), {
    provider: { text: "Skill instructions received." },
  })
  if (!server.provider) throw new Error("Missing isolated provider")
  const sessionID = "ses_cli_explicit_skill"
  await createSession(server, sessionID, directory, {
    providerID: server.provider.providerID,
    id: server.provider.modelID,
  })
  const client = YCoding.make({ baseUrl: server.base, headers: { authorization: auth } })
  return {
    server,
    provider: server.provider,
    client,
    directory,
    sessionID,
    skillPath,
    close: async () => {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test("noninteractive CLI sends every explicit skill's instructions in the first real provider request", async () => {
  const fixture = await skillServer()
  const exitCode = process.exitCode
  try {
    await runNonInteractivePrompt({
      client: fixture.client,
      sessionID: fixture.sessionID,
      location: { directory: fixture.directory },
      message: "Use $cli-explicit-audit $cli-explicit-plan $cli-explicit-audit, then report.",
      files: [],
      thinking: false,
      format: "json",
      attached: false,
      renderTool: () => Promise.resolve(),
      renderToolError: () => Promise.resolve(),
    })
    expect(fixture.provider.requests().length).toBeGreaterThanOrEqual(1)
    const request = fixture.provider.requests()[0]
    const wireMessages: unknown =
      typeof request === "object" && request !== null ? Reflect.get(request, "messages") : undefined
    expect(
      Array.isArray(wireMessages) &&
        wireMessages.some(
          (message) =>
            message?.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("Inspect the CLI skill boundary before making a model decision."),
        ),
    ).toBe(true)
    expect(
      Array.isArray(wireMessages) &&
        wireMessages.some(
          (message) =>
            message?.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("Plan every affected CLI boundary before implementation."),
        ),
    ).toBe(true)
    const messages = (await fixture.client.session.snapshot({ sessionID: fixture.sessionID })).messages
    expect(messages.flatMap((message) => (message.type === "skill" ? [message.skill] : []))).toEqual([
      "cli-explicit-audit",
      "cli-explicit-plan",
    ])
    expect(messages.filter((message) => message.type === "user")).toHaveLength(1)
    expect(
      messages.flatMap((message) =>
        message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
      ),
    ).toEqual([])
  } finally {
    process.exitCode = exitCode ?? 0
    await fixture.close()
  }
}, 30000)

test("a direct skill request cannot leak selected-agent denied instructions into an ordinary prompt", async () => {
  const fixture = await skillServer(true)
  const exitCode = process.exitCode
  try {
    await createSession(fixture.server, "ses_skill_catalog_warm", fixture.directory)
    await fixture.client.session.prompt({
      sessionID: "ses_skill_catalog_warm",
      text: "$cli-explicit-audit",
      resume: false,
    })
    await fixture.client.session.switchAgent({ sessionID: fixture.sessionID, agent: "build" })
    const response = await fixture.server.request(`/api/session/${fixture.sessionID}/skill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "cli-explicit-audit", resume: false }),
    })
    await runNonInteractivePrompt({
      client: fixture.client,
      sessionID: fixture.sessionID,
      location: { directory: fixture.directory },
      message: "Answer this ordinary prompt",
      files: [],
      thinking: false,
      format: "json",
      attached: false,
      renderTool: () => Promise.resolve(),
      renderToolError: () => Promise.resolve(),
    })
    expect(fixture.provider.requests().length).toBeGreaterThanOrEqual(1)
    expect(
      JSON.stringify(fixture.provider.requests()[0]).includes(
        "Inspect the CLI skill boundary before making a model decision.",
      ),
    ).toBe(false)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ _tag: "SkillNotFoundError", skill: "cli-explicit-audit" })
    expect(
      (await fixture.client.session.snapshot({ sessionID: fixture.sessionID })).messages.filter(
        (message) => message.type === "skill",
      ),
    ).toEqual([])
  } finally {
    process.exitCode = exitCode ?? 0
    await fixture.close()
  }
}, 30000)

test("cold admission retains a known invocation and unavailable skill content blocks the real provider", async () => {
  const fixture = await skillServer()
  try {
    const admitted = await fixture.client.session.prompt({
      sessionID: fixture.sessionID,
      id: "msg_cold_explicit_skill",
      text: "$cli-explicit-audit",
      resume: false,
    })
    expect(admitted.data.metadata).toMatchObject({ skills: [{ id: "cli-explicit-audit", name: "CLI explicit audit" }] })
    await writeFile(fixture.skillPath, "---\nname: 123\n---\nUnavailable skill\n")
    const live = fixture.client.event.subscribe({ signal: AbortSignal.timeout(10000) })[Symbol.asyncIterator]()
    await live.next()
    await fixture.client.session.prompt({ sessionID: fixture.sessionID, id: admitted.id, text: "$cli-explicit-audit" })
    while (true) {
      const next = await live.next()
      if (next.done) throw new Error("Event stream ended before the skill failure")
      const event = next.value
      if (event.type !== "session.execution.failed") continue
      expect(event.data.error).toEqual({ type: "skill.unavailable", message: "Skill unavailable: cli-explicit-audit" })
      break
    }
    await live.return?.()
    expect(fixture.provider.requests()).toEqual([])
    const snapshot = await fixture.client.session.snapshot({ sessionID: fixture.sessionID })
    expect(snapshot.messages.filter((message) => message.type === "skill" || message.type === "user")).toEqual([])
  } finally {
    await fixture.close()
  }
}, 30000)
