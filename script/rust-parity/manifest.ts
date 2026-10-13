import path from "node:path"
import { operations, PeerRole, Streaming } from "../../packages/protocol/src/generated/v5/index.js"

export type Kind = "endpoint" | "connector" | "notice"
export type Disposition = "RPC" | "STREAM" | "EXTERNAL" | "HTTP" | "REPLACE" | "DERIVED"
export type Member = { kind: Kind; name: string; group: string; source: string }
export type OwnerRule = {
  kind: Kind
  group: string
  prefix?: string
  except?: readonly string[]
  owner: string
  evidence: string
}

const ownership = "plans/rust-backend/tracking.md#disjoint-proposed-core-ownership"
const workPackage = (owner: string) => `plans/rust-backend/tracking.md#${owner.toLowerCase()}`
const sessionResourcePrefixes = ["session.attachment."]
const sessionAutonomyPrefixes = [
  "session.autonomy.",
  "session.subagent.",
  "session.skill",
  "session.skillConflict.",
  "session.completions",
]
const sessionRules = [
  ...sessionResourcePrefixes.map((prefix) => ({ prefix, owner: "WP-013" })),
  ...sessionAutonomyPrefixes.map((prefix) => ({ prefix, owner: "WP-008" })),
]
const groups: Record<string, string> = {
  "project-artifact": "projectArtifact",
  "project-copy": "projectCopy",
  "provider-usage": "providerUsage",
  "isolated-browser": "isolatedBrowser",
  "keep-awake": "keepAwake",
}
const connectorRules = [
  { prefix: "provider.auth.", owner: "WP-005" },
  { prefix: "workspace.list", owner: "WP-009" },
  { prefix: "catalog.get", owner: "WP-005" },
  { prefix: "fs.find", owner: "WP-009" },
  { prefix: "providerUsage.list", owner: "WP-006" },
  { prefix: "usage.get", owner: "WP-004" },
  { prefix: "usage.report", owner: "WP-004" },
  { prefix: "keepAwake.", owner: "WP-010" },
  { prefix: "telemetry.", owner: "WP-004" },
  { prefix: "shell.output", owner: "WP-009" },
  { prefix: "session.attachment.", owner: "WP-013" },
  { prefix: "session.autonomy.", owner: "WP-008" },
  { prefix: "session.goal.", owner: "WP-008" },
  { prefix: "session.subagent.", owner: "WP-008" },
  { prefix: "session.side-chat.", owner: "WP-008" },
  { prefix: "session.family.", owner: "WP-008" },
  { prefix: "session.status", owner: "WP-008" },
  { prefix: "session.team.economics", owner: "WP-004" },
  { prefix: "session.team.shell.", owner: "WP-009" },
  { prefix: "session.shell.", owner: "WP-009" },
  { prefix: "session.permission.", owner: "WP-009" },
  { prefix: "session.guardrail.", owner: "WP-009" },
  { prefix: "session.form.", owner: "WP-009" },
  { prefix: "session.catalog", owner: "WP-005" },
  { prefix: "session.file.find", owner: "WP-009" },
  { prefix: "session.skill", owner: "WP-008" },
  { prefix: "session.subscribe", owner: "WP-014" },
  { prefix: "session.unsubscribe", owner: "WP-014" },
]

export const ownerRules: readonly OwnerRule[] = [
  ...[
    ["agent", "command", "reference", "skill", "project-artifact"].map((group) => ({ group, owner: "WP-013" })),
    ["config", "credential", "integration", "model", "provider"].map((group) => ({ group, owner: "WP-005" })),
    ["provider-usage", "generate"].map((group) => ({ group, owner: "WP-006" })),
    ["debug", "event", "location", "message"].map((group) => ({ group, owner: "WP-007" })),
    ["form", "fs", "guardrail", "permission", "project", "project-copy", "pty", "question", "shell", "vcs"].map(
      (group) => ({ group, owner: "WP-009" }),
    ),
    ["browser", "isolated-browser", "keep-awake", "mcp"].map((group) => ({ group, owner: "WP-010" })),
    [
      { group: "plugin", owner: "WP-012" },
      { group: "remote", owner: "WP-014" },
      { group: "health", owner: "WP-015" },
      { group: "usage", owner: "WP-004" },
    ],
  ]
    .flat()
    .map((rule) => ({
      ...rule,
      group: `server.${groups[rule.group] ?? rule.group}`,
      kind: "endpoint" as const,
      evidence: `${ownership}; ${workPackage(rule.owner)}`,
    })),
  ...sessionRules.map((rule) => ({
    ...rule,
    kind: "endpoint" as const,
    group: "server.session",
    evidence: `${ownership}; packages/server/src/handlers/session.ts`,
  })),
  {
    kind: "endpoint",
    group: "server.session",
    except: sessionRules.map((rule) => rule.prefix),
    owner: "WP-007",
    evidence: `${ownership}; packages/server/src/handlers/session.ts`,
  },
  {
    kind: "endpoint",
    group: "server.server",
    prefix: "server.",
    owner: "WP-015",
    evidence: `${workPackage("WP-015")}; packages/server/src/handlers/server.ts`,
  },
  {
    kind: "endpoint",
    group: "server.server",
    prefix: "telemetry.",
    owner: "WP-004",
    evidence: `${workPackage("WP-004")}; packages/server/src/handlers/server.ts; plans/rust-backend/architecture.md#derived-duckdb-delivery-and-report-boundary`,
  },
  ...connectorRules.map((rule) => ({
    ...rule,
    kind: "connector" as const,
    group: "remote",
    evidence: `${ownership}; ${workPackage(rule.owner)}; packages/cli/src/remote-operations.ts#run; packages/cli/src/remote-local.ts`,
  })),
  {
    kind: "connector",
    group: "remote",
    prefix: "session.",
    except: connectorRules.map((rule) => rule.prefix),
    owner: "WP-007",
    evidence: `${ownership}; packages/cli/src/remote-operations.ts#run; packages/cli/src/remote-local.ts`,
  },
  {
    kind: "connector",
    group: "remote",
    prefix: "event.",
    owner: "WP-014",
    evidence: `${workPackage("WP-014")}; packages/protocol/src/v5/connection/index.ts; infra/cloudflare/src/relay/core.ts`,
  },
  {
    kind: "notice",
    group: "remote",
    owner: "WP-014",
    evidence: `${workPackage("WP-014")}; infra/cloudflare/src/relay/core.ts`,
  },
]

export function resolveOwner(member: Member, rules = ownerRules) {
  const matching = rules.filter(
    (rule) =>
      rule.kind === member.kind &&
      rule.group === member.group &&
      (rule.prefix === undefined || member.name.startsWith(rule.prefix)) &&
      !rule.except?.some((prefix) => member.name.startsWith(prefix)),
  )
  if (matching.length !== 1) throw new Error(`${member.kind}:${member.name}: ${matching.length} runtime owners`)
  return matching[0]
}

export function reconcileMembers(live: readonly string[], inventory: readonly string[], kind: string) {
  const duplicates = (names: readonly string[]) => names.filter((name, index) => names.indexOf(name) !== index)
  const missing = inventory.filter((name) => !live.includes(name))
  const extra = live.filter((name) => !inventory.includes(name))
  if (duplicates(live).length || duplicates(inventory).length || missing.length || extra.length)
    throw new Error(
      `${kind}: membership drift ${JSON.stringify({ missing, extra, duplicateLive: duplicates(live), duplicateInventory: duplicates(inventory) })}`,
    )
}

function expand(cell: string) {
  return [...cell.matchAll(/`([^`]+)`/g)].flatMap((match) => {
    const brace = match[1].match(/^([A-Za-z][A-Za-z0-9.-]*)\.\{([^}]+)\}$/)
    if (brace) return brace[2].split(",").map((suffix) => `${brace[1]}.${suffix}`)
    return /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/.test(match[1]) ? [match[1]] : []
  })
}

function table(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
}

export async function generateManifest(root: string) {
  const inventoryPath = "specs/wire-operation-inventory.md"
  const inventory = await Bun.file(path.join(root, inventoryPath)).text()
  const local = table(
    inventory
      .split("## API Spec: Complete Local Endpoint Inventory")[1]
      .split("### Explicit local transport/domain exceptions")[0],
  )
  const exceptions = table(
    inventory
      .split("### Explicit local transport/domain exceptions")[1]
      .split("## Complete Remote Operation Inventory")[0],
  )
  const remote = table(
    inventory.split("## Complete Remote Operation Inventory")[1].split("### Relay-owned notice operations")[0],
  )
  for (const row of local) {
    if (!/^\d+$/.test(row[1]) || Number(row[1]) !== expand(row[2]).length)
      throw new Error(`endpoint: inventory row count drift ${row[0]}`)
  }
  for (const row of remote) {
    if (!/^\d+$/.test(row[1]) || Number(row[1]) !== expand(row[0]).length)
      throw new Error(`connector: inventory row count drift ${row[0]}`)
  }
  const expected = local.flatMap((row) => expand(row[2]))
  const sourceMembers: Member[] = []
  for await (const file of new Bun.Glob("*.ts").scan(path.join(root, "packages/protocol/src/groups"))) {
    const source = `packages/protocol/src/groups/${file}`
    const text = await Bun.file(path.join(root, source)).text()
    const group = text.match(/HttpApiGroup\.make\("([^"]+)"\)/)?.[1]
    if (!group) throw new Error(`${source}: missing literal Protocol group identifier`)
    for (const match of text.matchAll(/HttpApiEndpoint\.\w+\(\s*"([^"]+)"/g))
      sourceMembers.push({
        kind: "endpoint",
        name: match[1],
        group,
        source: `${source}:${text.slice(0, match.index).split("\n").length}`,
      })
  }
  const remoteOperations = operations.filter((operation) => operation.roles.includes(PeerRole.REMOTE_CLIENT))
  const connector = remoteOperations.filter((operation) => !operation.diagnosticName.startsWith("notice.")).map((operation) => operation.diagnosticName)
  const notices = remoteOperations.filter((operation) => operation.diagnosticName.startsWith("notice.")).map((operation) => operation.diagnosticName)
  reconcileMembers(
    sourceMembers.map((member) => member.name),
    expected,
    "endpoint",
  )
  reconcileMembers(
    notices,
    expand(inventory.split("### Relay-owned notice operations")[1].split("## Complete Application Event Inventory")[0]),
    "notice",
  )
  const counts = { endpoint: sourceMembers.length, connector: connector.length, notice: notices.length }
  if (counts.endpoint !== 198 || counts.connector !== 66 || counts.notice !== 4 || new Set(connector).size !== connector.length)
    throw new Error(`Baseline counts disagree: ${JSON.stringify(counts)}`)
  sourceMembers.push(
    ...connector.map((name) => ({
      kind: "connector" as const,
      name,
      group: "remote",
      source: "packages/protocol/src/generated/v5/operations.ts",
    })),
    ...notices.map((name) => ({
      kind: "notice" as const,
      name,
      group: "remote",
      source: "packages/protocol/src/generated/v5/operations.ts",
    })),
  )
  const localDisposition = (name: string): Disposition => {
    const row = exceptions.find((row) => expand(row[0]).includes(name))
    return (row?.[1].match(/^(RPC|STREAM|EXTERNAL|HTTP|REPLACE|DERIVED)\b/)?.[1] as Disposition) ?? "RPC"
  }
  const members = sourceMembers
    .map((member) => {
      const owner = resolveOwner(member)
      const row = remote.find((row) => expand(row[0]).includes(member.name))
      const disposition: Disposition =
        member.kind === "endpoint"
          ? localDisposition(member.name)
          : remoteOperations.find((operation) => operation.diagnosticName === member.name)?.streaming === Streaming.EVENTS || remoteOperations.find((operation) => operation.diagnosticName === member.name)?.streaming === Streaming.ASSET_BULK
            ? "STREAM"
          : member.kind === "notice"
            ? member.name === "notice.subscribe"
              ? "STREAM"
              : "RPC"
            : member.name === "workspace.list"
              ? "DERIVED"
              : member.name.startsWith("workspace.")
                ? "REPLACE"
                : member.name === "usage.report"
                  ? "RPC"
                  : ((row?.[2].match(/^(RPC|STREAM|EXTERNAL|HTTP|REPLACE|DERIVED)\b/)?.[1] as Disposition) ??
                    localDisposition(member.name))
      return {
        ...member,
        disposition,
        owner: owner.owner,
        ownerEvidence: owner.evidence,
        inventoryEvidence: `${inventoryPath}#${member.kind === "endpoint" ? "api-spec-complete-local-endpoint-inventory" : member.kind === "connector" ? "complete-remote-operation-inventory" : "relay-owned-notice-operations"}`,
      }
    })
    .sort((left, right) => (`${left.kind}:${left.name}` < `${right.kind}:${right.name}` ? -1 : 1))
  return {
    version: 1,
    counts,
    owners: { wire: "WP-003", adapter: "WP-014" },
    rules: ownerRules,
    members,
    unresolved: [] as string[],
  }
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "../..")
  console.log(JSON.stringify(await generateManifest(root), null, 2))
}
