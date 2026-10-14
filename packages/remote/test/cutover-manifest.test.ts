import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PeerRole, operations, publicEvents } from "@ycoding-ai/protocol/v5"
import { generateManifest } from "../../../script/rust-parity/manifest"

const root = path.resolve(import.meta.dir, "../../..")

test("TEST-057 every manifest member has exactly one owner and a live descriptor or endpoint source", async () => {
  const manifest = await generateManifest(root)
  expect(manifest.counts).toEqual({ endpoint: 198, connector: 66, notice: 4 })
  expect(manifest.members).toHaveLength(268)
  expect(manifest.unresolved).toEqual([])
  const keys = manifest.members.map((member) => `${member.kind}:${member.name}`)
  expect(new Set(keys).size).toBe(keys.length)
  for (const member of manifest.members) {
    expect(member.owner, `${member.kind}:${member.name} has no runtime owner`).toBeTruthy()
    expect(member.ownerEvidence).toBeTruthy()
    expect(member.inventoryEvidence.startsWith("specs/wire-operation-inventory.md#")).toBe(true)
  }
  const byKind = (kind: string) =>
    manifest.members.filter((member) => member.kind === kind).map((member) => member.name)
  const relay = operations
    .filter((operation) => operation.roles.includes(PeerRole.RELAY))
    .map((operation) => operation.diagnosticName)
    .sort()
  const remote = operations
    .filter((operation) => operation.roles.includes(PeerRole.REMOTE_CLIENT))
    .map((operation) => operation.diagnosticName)
    .sort()
  expect(byKind("connector").sort()).toEqual(relay)
  expect([...byKind("connector"), ...byKind("notice")].sort()).toEqual(remote)
  expect(byKind("notice").sort()).toEqual(["notice.list", "notice.read", "notice.readAll", "notice.subscribe"])
})

test("TEST-057 retired source names are migration evidence, never manifest aliases", async () => {
  const manifest = await generateManifest(root)
  const connector = new Set(
    manifest.members.filter((member) => member.kind === "connector").map((member) => member.name),
  )
  const retired: Record<string, string> = {
    "machine.keepAwake.get": "keepAwake.get",
    "machine.keepAwake.set": "keepAwake.set",
    "machine.latency.append": "telemetry.append",
    "machine.latency.list": "telemetry.list",
    "machine.telemetry.consent.get": "telemetry.consent.get",
    "machine.telemetry.consent.set": "telemetry.consent.set",
    "session.catalog": "catalog.get",
    "session.file.find": "fs.find",
    "session.goal.set": "session.autonomy.set",
    "session.goal.stop": "session.autonomy.set",
    "session.guardrail.reply": "session.guardrail.request.reply",
    "session.message.stream": "session.message",
    "session.shell.output": "shell.output",
    "session.subscribe": "event.subscribe",
    "session.unsubscribe": "event.unsubscribe",
    "usage.providers": "providerUsage.list",
    "usage.summary": "usage.get",
    "workspace.catalog": "catalog.get",
    "workspace.file.find": "fs.find",
  }
  for (const [source, canonical] of Object.entries(retired)) {
    expect(connector.has(source), `retired source ${source} must not be a connector member`).toBe(false)
    expect(connector.has(canonical), `canonical target ${canonical} for ${source} must be retained`).toBe(true)
  }
})

test("TEST-057 public event membership is unique and descriptor-referenced events are declared", () => {
  expect(new Set(publicEvents.map((event) => `${event.name}:${event.tag}`)).size).toBe(publicEvents.length)
  const declared = new Set<string>(publicEvents.map((event) => event.type))
  for (const operation of operations)
    for (const event of operation.eventTypes)
      expect(
        declared.has(event) || event === "ycoding.v5.PublicEvent" || event === "ycoding.v5.SessionLogItem",
        `${operation.diagnosticName} references undeclared event ${event}`,
      ).toBe(true)
})

test.each([
  "## API Spec: Complete Local Endpoint Inventory",
  "### Explicit local transport/domain exceptions",
  "## Complete Remote Operation Inventory",
  "### Relay-owned notice operations",
  "## Complete Application Event Inventory",
])("TEST-057 inventory rejects missing section %s explicitly", async (heading) => {
  await withManifestFixture(async (fixture) => {
    const file = path.join(fixture, "specs/wire-operation-inventory.md")
    await Bun.write(file, (await Bun.file(file).text()).replace(heading, "## Missing section"))
    await expect(generateManifest(fixture)).rejects.toThrow("missing inventory section")
  })
})

test.each([
  { name: "endpoint names", pattern: /^\| `agent\.ts:9`[^\n]*$/m, row: "| `agent.ts:9` | 1 |" },
  {
    name: "connector disposition",
    pattern: /^\| `provider\.auth\.\{list,key,begin,status,complete,cancel\}`[^\n]*$/m,
    row: "| `provider.auth.{list,key,begin,status,complete,cancel}` | 6 |",
  },
])("TEST-057 inventory rejects missing $name explicitly", async (input) => {
  await withManifestFixture(async (fixture) => {
    const file = path.join(fixture, "specs/wire-operation-inventory.md")
    await Bun.write(file, (await Bun.file(file).text()).replace(input.pattern, input.row))
    await expect(generateManifest(fixture)).rejects.toThrow("missing inventory field")
  })
})

async function withManifestFixture(run: (fixture: string) => Promise<void>) {
  const fixture = await mkdtemp(path.join(tmpdir(), "ycoding-manifest-guard-"))
  try {
    for (const file of ["specs/wire-operation-inventory.md", "specs/wire-connector.md"])
      await Bun.write(path.join(fixture, file), Bun.file(path.join(root, file)))
    for await (const file of new Bun.Glob("*.ts").scan(path.join(root, "packages/protocol/src/groups")))
      await Bun.write(
        path.join(fixture, "packages/protocol/src/groups", file),
        Bun.file(path.join(root, "packages/protocol/src/groups", file)),
      )
    await run(fixture)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
}
