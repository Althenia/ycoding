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
  { prefix: "providerUsage.forecast", owner: "WP-006" },
  { prefix: "usage.get", owner: "WP-004" },
  { prefix: "usage.report", owner: "WP-004" },
  { prefix: "usage.dashboard", owner: "WP-004" },
  { prefix: "dots.", owner: "WP-008" },
  { prefix: "incident.", owner: "WP-004" },
  { prefix: "keepAwake.", owner: "WP-010" },
  { prefix: "mcp.app.view", owner: "WP-010" },
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
  { prefix: "coordination.", owner: "WP-008" },
  { prefix: "session.unsubscribe", owner: "WP-014" },
]

export const ownerRules: readonly OwnerRule[] = [
  ...[
    ["agent", "command", "reference", "skill"].map((group) => ({ group, owner: "WP-013" })),
    ["config", "credential", "integration", "model", "provider"].map((group) => ({ group, owner: "WP-005" })),
    ["provider-usage", "generate"].map((group) => ({ group, owner: "WP-006" })),
    ["debug", "event", "location", "message"].map((group) => ({ group, owner: "WP-007" })),
    [
      "decision",
      "form",
      "fs",
      "guardrail",
      "permission",
      "project",
      "project-copy",
      "pty",
      "question",
      "review",
      "shell",
      "vcs",
    ].map((group) => ({ group, owner: "WP-009" })),
    ["browser", "isolated-browser", "interaction", "keep-awake", "mcp"].map((group) => ({ group, owner: "WP-010" })),
    [
      { group: "plugin", owner: "WP-012" },
      { group: "remote", owner: "WP-014" },
      { group: "health", owner: "WP-015" },
      { group: "usage", owner: "WP-004" },
      { group: "incident", owner: "WP-004" },
      { group: "coordination", owner: "WP-008" },
      { group: "dots", owner: "WP-008" },
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
  const owner = matching[0]
  if (matching.length !== 1 || owner === undefined)
    throw new Error(`${member.kind}:${member.name}: ${matching.length} runtime owners`)
  return owner
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
    const value = requiredField(match, 1)
    const brace = value.match(/^([A-Za-z][A-Za-z0-9.-]*)\.\{([^}]+)\}$/)
    if (brace)
      return requiredField(brace, 2)
        .split(",")
        .map((suffix) => `${requiredField(brace, 1)}.${suffix}`)
    return /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/.test(value) ? [value] : []
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

export function connectorAllocationRows(inventory: string) {
  const section = inventorySection(
    inventory,
    "## Canonical connector allocations",
    "## Complete Application Event Inventory",
  )
  const lines = section
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const cells = (line: string) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim())
  if (
    lines.length < 3 ||
    cells(lines[0] ?? "").join("|") !== "Connector operation|Descriptor diagnostic name|ID|Class|Roles|Mutation" ||
    !/^\|(?:\s*:?-+:?\s*\|){6}$/.test(lines[1] ?? "")
  )
    throw new Error("malformed connector allocation header")
  const names = new Set<string>()
  const byID = new Map<string, string>()
  const byName = new Map<string, string>()
  return lines.slice(2).map((line): [string, string, string, string, string, string] => {
    const row = cells(line)
    const [source, name, id, kind, roles, mutation] = row
    const operation = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/
    if (
      !line.startsWith("|") ||
      !line.endsWith("|") ||
      row.length !== 6 ||
      !source ||
      !name ||
      !id ||
      !kind ||
      !roles ||
      !mutation ||
      !operation.test(source) ||
      !operation.test(name) ||
      !/^\d+$/.test(id) ||
      !Number.isSafeInteger(Number(id)) ||
      Number(id) <= 0 ||
      !["A", "B-reuse", "B-distinct", "C"].includes(kind ?? "") ||
      !["S", "C", "N"].includes(roles ?? "") ||
      !["READ", "MUTATION"].includes(mutation ?? "")
    )
      throw new Error("malformed connector allocation row")
    if (names.has(source)) throw new Error(`duplicate connector allocation ${source}`)
    if ((byID.has(id) && byID.get(id) !== name) || (byName.has(name) && byName.get(name) !== id))
      throw new Error(`inconsistent connector allocation ${source}`)
    names.add(source)
    byID.set(id, name)
    byName.set(name, id)
    return [source, name, id, kind, roles, mutation]
  })
}

export async function generateManifest(root: string) {
  const inventoryPath = "specs/wire-operation-inventory.md"
  const inventory = await Bun.file(path.join(root, inventoryPath)).text()
  const local = table(
    inventorySection(
      inventory,
      "## API Spec: Complete Local Endpoint Inventory",
      "### Explicit local transport/domain exceptions",
    ),
  )
  const exceptions = table(
    inventorySection(
      inventory,
      "### Explicit local transport/domain exceptions",
      "## Complete Remote Operation Inventory",
    ),
  )
  const remote = table(
    inventorySection(inventory, "## Complete Remote Operation Inventory", "### Relay-owned notice operations"),
  )
  const allocations = connectorAllocationRows(inventory)
  for (const row of local) {
    if (!/^\d+$/.test(requiredField(row, 1)) || Number(requiredField(row, 1)) !== expand(requiredField(row, 2)).length)
      throw new Error(`endpoint: inventory row count drift ${requiredField(row, 0)}`)
  }
  for (const row of remote) {
    if (!/^\d+$/.test(requiredField(row, 1)) || Number(requiredField(row, 1)) !== expand(requiredField(row, 0)).length)
      throw new Error(`connector: inventory row count drift ${requiredField(row, 0)}`)
  }
  const expected = local.flatMap((row) => expand(requiredField(row, 2)))
  const sourceMembers: Member[] = []
  for await (const file of new Bun.Glob("*.ts").scan(path.join(root, "packages/protocol/src/groups"))) {
    const source = `packages/protocol/src/groups/${file}`
    const text = await Bun.file(path.join(root, source)).text()
    const group = text.match(/HttpApiGroup\.make\("([^"]+)"\)/)?.[1]
    if (!group) throw new Error(`${source}: missing literal Protocol group identifier`)
    for (const match of text.matchAll(/HttpApiEndpoint\.\w+\(\s*"([^"]+)"/g))
      sourceMembers.push({
        kind: "endpoint",
        name: requiredField(match, 1),
        group,
        source: `${source}:${text.slice(0, match.index).split("\n").length}`,
      })
  }
  const remoteOperations = operations.filter((operation) => operation.roles.includes(PeerRole.REMOTE_CLIENT))
  const connector = remoteOperations
    .filter((operation) => !operation.diagnosticName.startsWith("notice."))
    .map((operation) => operation.diagnosticName)
  const notices = remoteOperations
    .filter((operation) => operation.diagnosticName.startsWith("notice."))
    .map((operation) => operation.diagnosticName)
  reconcileMembers(
    sourceMembers.map((member) => member.name),
    expected,
    "endpoint",
  )
  const noticeInventory = expand(
    inventorySection(inventory, "### Relay-owned notice operations", "## Canonical connector allocations"),
  )
  reconcileMembers(notices, noticeInventory, "notice")
  reconcileMembers(
    [...remote.flatMap((row) => expand(requiredField(row, 0))), ...noticeInventory],
    allocations.map((row) => requiredField(row, 0)),
    "connector source",
  )
  reconcileMembers(
    connector,
    [...new Set(allocations.map((row) => requiredField(row, 1)).filter((name) => !name.startsWith("notice.")))],
    "connector",
  )
  reconcileMembers(
    notices,
    [...new Set(allocations.map((row) => requiredField(row, 1)).filter((name) => name.startsWith("notice.")))],
    "notice",
  )
  const counts = { endpoint: sourceMembers.length, connector: connector.length, notice: notices.length }
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
    const row = exceptions.find((row) => expand(requiredField(row, 0)).includes(name))
    return (row === undefined ? undefined : parseDisposition(requiredField(row, 1))) ?? "RPC"
  }
  const members = sourceMembers
    .map((member) => {
      const owner = resolveOwner(member)
      const row = remote.find((row) => expand(requiredField(row, 0)).includes(member.name))
      const disposition: Disposition =
        member.kind === "endpoint"
          ? localDisposition(member.name)
          : remoteOperations.find((operation) => operation.diagnosticName === member.name)?.streaming ===
                Streaming.EVENTS ||
              remoteOperations.find((operation) => operation.diagnosticName === member.name)?.streaming ===
                Streaming.ASSET_BULK
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
                    : ((row === undefined ? undefined : parseDisposition(requiredField(row, 2))) ??
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

function requiredField(values: readonly string[], index: number) {
  const value = values[index]
  if (value === undefined) throw new Error(`missing inventory field ${index + 1}`)
  return value
}

function inventorySection(text: string, start: string, end: string) {
  const from = text.indexOf(start)
  if (from === -1) throw new Error(`missing inventory section ${start}`)
  if (text.indexOf(start, from + start.length) !== -1) throw new Error(`duplicate inventory section ${start}`)
  const to = text.indexOf(end, from + start.length)
  if (to === -1) throw new Error(`missing inventory section ${end}`)
  return text.slice(from + start.length, to)
}

function parseDisposition(value: string) {
  const name = value.match(/^(RPC|STREAM|EXTERNAL|HTTP|REPLACE|DERIVED)\b/)?.[1]
  if (
    name === "RPC" ||
    name === "STREAM" ||
    name === "EXTERNAL" ||
    name === "HTTP" ||
    name === "REPLACE" ||
    name === "DERIVED"
  )
    return name
  return undefined
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "../..")
  console.log(JSON.stringify(await generateManifest(root), null, 2))
}
