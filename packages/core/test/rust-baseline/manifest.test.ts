import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { generateManifest, ownerRules, reconcileMembers, resolveOwner } from "../../../../script/rust-parity/manifest"

const root = path.resolve(import.meta.dir, "../../../..")

describe("WP-001 / TEST-057 operation coverage", () => {
  test("generates complete live membership and exactly one runtime owner per member", async () => {
    const manifest = await generateManifest(root)
    expect(manifest.counts).toEqual({ endpoint: 198, connector: 66, notice: 4 })
    expect(manifest.owners).toEqual({ wire: "WP-003", adapter: "WP-014" })
    expect(manifest.members).toHaveLength(268)
    expect(manifest.members.filter((member) => member.kind === "connector").map((member) => member.name)).toEqual([
      "catalog.get",
      "event.subscribe",
      "event.unsubscribe",
      "fs.find",
      "keepAwake.get",
      "keepAwake.set",
      "provider.auth.begin",
      "provider.auth.cancel",
      "provider.auth.complete",
      "provider.auth.key",
      "provider.auth.list",
      "provider.auth.status",
      "providerUsage.list",
      "session.active",
      "session.attachment.read",
      "session.attachment.upload",
      "session.autonomy.get",
      "session.autonomy.set",
      "session.capturedChanges.list",
      "session.command",
      "session.compact",
      "session.compaction.list",
      "session.create",
      "session.family.activity",
      "session.form.cancel",
      "session.form.list",
      "session.form.reply",
      "session.get",
      "session.guardrail.request.list",
      "session.guardrail.request.reply",
      "session.guardrail.status",
      "session.interrupt",
      "session.list",
      "session.log",
      "session.message",
      "session.messages",
      "session.pending.list",
      "session.permission.list",
      "session.permission.reply",
      "session.pin",
      "session.prediction",
      "session.prompt",
      "session.promptGenerate",
      "session.side-chat.create",
      "session.side-chat.list",
      "session.skill",
      "session.snapshot",
      "session.status",
      "session.subagent.answer",
      "session.subagent.cancel",
      "session.subagent.list",
      "session.switchAgent",
      "session.switchModel",
      "session.team.economics",
      "session.team.shell.kill",
      "session.team.shell.list",
      "session.todo.list",
      "session.unpin",
      "shell.output",
      "telemetry.append",
      "telemetry.consent.get",
      "telemetry.consent.set",
      "telemetry.list",
      "usage.get",
      "usage.report",
      "workspace.list",
    ])
    expect(manifest.members.filter((member) => member.kind === "notice").map((member) => member.name)).toEqual([
      "notice.list",
      "notice.read",
      "notice.readAll",
      "notice.subscribe",
    ])
    expect(manifest.unresolved).toEqual([])
    expect(
      manifest.members.every((member) => member.inventoryEvidence.startsWith("specs/wire-operation-inventory.md#")),
    ).toBe(true)
    expect(manifest.members.every((member) => member.owner && member.ownerEvidence && member.inventoryEvidence)).toBe(
      true,
    )
  })

  test.each([
    { name: "missing", live: ["a"], inventory: ["a", "b"] },
    { name: "extra", live: ["a", "b"], inventory: ["a"] },
    { name: "duplicate live", live: ["a", "a"], inventory: ["a"] },
    { name: "duplicate inventory", live: ["a"], inventory: ["a", "a"] },
    { name: "same-count replacement", live: ["a", "c"], inventory: ["a", "b"] },
  ])("rejects $name drift, not just count drift", ({ live, inventory }) => {
    expect(() => reconcileMembers(live, inventory, "fixture")).toThrow()
  })

  test("rejects missing and overlapping runtime ownership, including split-group members", () => {
    const member = {
      kind: "endpoint" as const,
      name: "session.autonomy.get",
      group: "server.session",
      source: "fixture",
    }
    expect(resolveOwner(member).owner).toBe("WP-008")
    expect(() => resolveOwner(member, [])).toThrow("0 runtime owners")
    expect(() =>
      resolveOwner(member, [
        ...ownerRules,
        { kind: "endpoint", group: "server.session", owner: "WP-007", evidence: "fixture" },
      ]),
    ).toThrow("2 runtime owners")
  })

  test("retains inventory dispositions rather than assigning everything RPC", async () => {
    const manifest = await generateManifest(root)
    const disposition = (kind: string, name: string) =>
      manifest.members.find((member) => member.kind === kind && member.name === name)?.disposition
    expect(disposition("endpoint", "browser.connect")).toBe("EXTERNAL")
    expect(disposition("endpoint", "event.subscribe")).toBe("STREAM")
    expect(disposition("endpoint", "fs.read")).toBe("STREAM")
    expect(disposition("endpoint", "health.get")).toBe("RPC")
    expect(disposition("connector", "workspace.list")).toBe("DERIVED")
    expect(disposition("connector", "event.subscribe")).toBe("STREAM")
    expect(disposition("connector", "session.attachment.upload")).toBe("STREAM")
    expect(disposition("connector", "usage.report")).toBe("RPC")
    expect(disposition("notice", "notice.subscribe")).toBe("STREAM")
  })

  test("reads live source and rejects a same-count source/inventory divergence", async () => {
    const copy = await mkdtemp(path.join(tmpdir(), "ycoding-manifest-drift-"))
    try {
      for (const file of ["specs/wire-operation-inventory.md", "specs/wire-connector.md"])
        await Bun.write(path.join(copy, file), Bun.file(path.join(root, file)))
      for await (const file of new Bun.Glob("*.ts").scan(path.join(root, "packages/protocol/src/groups")))
        await Bun.write(
          path.join(copy, "packages/protocol/src/groups", file),
          Bun.file(path.join(root, "packages/protocol/src/groups", file)),
        )
      expect((await generateManifest(copy)).counts).toEqual({ endpoint: 198, connector: 66, notice: 4 })
      const file = path.join(copy, "packages/protocol/src/groups/agent.ts")
      const original = await Bun.file(file).text()
      await Bun.write(file, original.replace('HttpApiEndpoint.get("agent.list"', 'HttpApiEndpoint.get("agent.changed"'))
      await expect(generateManifest(copy)).rejects.toThrow("endpoint: membership drift")
      await Bun.write(file, original)
      const connectorSpec = path.join(copy, "specs/wire-connector.md")
      const originalConnectorSpec = await Bun.file(connectorSpec).text()
      await Bun.write(
        connectorSpec,
        originalConnectorSpec.replace(/(\| session\.subscribe\s+\|) event\.subscribe/, "$1 event.changed"),
      )
      await expect(generateManifest(copy)).rejects.toThrow("connector: membership drift")
      await Bun.write(connectorSpec, originalConnectorSpec)
      const inventory = path.join(copy, "specs/wire-operation-inventory.md")
      const originalInventory = await Bun.file(inventory).text()
      await Bun.write(inventory, originalInventory.replace(/(\| `agent\.ts:9`\s*\|)\s*1\s*\|/, "$1 2 |"))
      await expect(generateManifest(copy)).rejects.toThrow("endpoint: inventory row count drift")
      await Bun.write(
        inventory,
        originalInventory.replace(
          /(\| `provider\.auth\.\{list,key,begin,status,complete,cancel\}`\s*\|)\s*6\s*\|/,
          "$1 7 |",
        ),
      )
      await expect(generateManifest(copy)).rejects.toThrow("connector: inventory row count drift")
    } finally {
      await rm(copy, { recursive: true, force: true })
    }
  })
})
