import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { asc, sql } from "drizzle-orm"
import { Agent } from "@ycoding-ai/schema/agent"
import { Instruction } from "@ycoding-ai/schema/instruction"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { AbsolutePath } from "@ycoding-ai/schema/schema"
import { tmpdir } from "node:os"
import { ConfigCapabilities } from "../src/config/capabilities"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { InstructionBuiltIns } from "../src/instructions/builtins"
import { Instructions } from "../src/instructions/index"
import { ModelIncident } from "@ycoding-ai/schema/model-incident"
import { layer, node, recordEscalation, recordFallback, recordRejection, Service } from "../src/model-incident/index"
import { ModelGuidanceInstructions } from "../src/model-incident/instructions"
import { ModelIncidentTable } from "../src/model-incident/sql"
import { RetentionSettings } from "../src/retention-settings"
import { Session } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { testEffect } from "./lib/effect"

const DAY = 86_400_000
let incidentDays = 30
const settings = Layer.succeed(RetentionSettings.Service, {
  read: () => Effect.sync(() => ({ recordsDays: 7, usageDays: 30, latencyDays: 30, incidentDays })),
})
const runtime = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, Session.node, node]),
  [
    [SessionExecution.node, SessionExecution.noopLayer],
    [RetentionSettings.node, settings],
  ],
)
const run = <A, E>(body: Effect.Effect<A, E, Database.Service | Session.Service | Service>) =>
  Effect.runPromise(body.pipe(Effect.provide(runtime), Effect.scoped))

const ref = (providerID: string, id: string, extra: { variant?: string; profile?: string } = {}) =>
  Model.Ref.make({
    providerID: Provider.ID.make(providerID),
    id: Model.ID.make(id),
    ...(extra.variant ? { variant: Model.VariantID.make(extra.variant) } : {}),
    ...(extra.profile ? { profile: Model.ProfileName.make(extra.profile) } : {}),
  })
const agent = (id: string) => Agent.ID.make(id)
const messageID = (id: string) => SessionMessage.ID.make(`msg_${id}`)
const incidentID = (id: string) => ModelIncident.ID.make(id)
const reportRow = (
  providerID: string,
  modelID: string,
  counts: { fallbacks: number; escalated: number; rejected: number; last: number },
  agentName?: string,
) => ({
  providerID: Provider.ID.make(providerID),
  modelID: Model.ID.make(modelID),
  ...(agentName === undefined ? {} : { agent: agent(agentName) }),
  ...counts,
})

const createSession = Effect.gen(function* () {
  const sessions = yield* Session.Service
  return yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
})

const seedMessage = (
  db: Database.Interface["db"],
  input: { sessionID: string; id: string; seq: number; type?: string; agent: string; model: object },
) =>
  db.run(sql`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (${`msg_${input.id}`}, ${input.sessionID}, ${input.type ?? "assistant"}, ${input.seq}, 0, 0,
      ${JSON.stringify({ agent: input.agent, model: input.model })})
  `)

type Put = {
  id: string
  time: number
  kind?: "fallback" | "guardrail-escalated" | "guardrail-rejected"
  provider?: string
  model?: string
  agent?: string
  variant?: string
  profile?: string
  request?: string
  rules?: ReadonlyArray<string>
  target?: object
  decidedBy?: string
  category?: string
}
const put = (db: Database.Interface["db"], row: Put) =>
  db.run(sql`
    INSERT INTO model_incident
      (id, time_created, kind, provider_id, model_id, variant, profile, agent, project_id, session_id, request_id, category, rule_ids, target, decided_by)
    VALUES (${row.id}, ${row.time}, ${row.kind ?? "guardrail-escalated"}, ${row.provider ?? "p"}, ${row.model ?? "m"},
      ${row.variant ?? null}, ${row.profile ?? null}, ${row.agent ?? "build"}, 'global', 'ses_gone', ${row.request ?? null},
      ${row.category ?? "ordinary"}, ${JSON.stringify(row.rules ?? [])}, ${row.target ? JSON.stringify(row.target) : null},
      ${row.decidedBy ?? null})
  `)

const bulk = (db: Database.Interface["db"], input: { prefix: string; count: number; time: number }) =>
  db.run(sql`
    WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < ${input.count - 1})
    INSERT INTO model_incident (id, time_created, kind, provider_id, model_id, agent, project_id, session_id, category, rule_ids)
    SELECT printf(${`${input.prefix}_%09d`}, value), ${input.time},
      CASE value % 3 WHEN 0 THEN 'fallback' WHEN 1 THEN 'guardrail-escalated' ELSE 'guardrail-rejected' END,
      'p', 'm', CASE value % 2 WHEN 0 THEN 'build' ELSE 'plan' END, 'global', 'ses_gone', 'ordinary', '[]' FROM n
  `)

const all = (db: Database.Interface["db"]) =>
  db.select().from(ModelIncidentTable).orderBy(asc(ModelIncidentTable.time_created), asc(ModelIncidentTable.id)).all()

const standard = (name: string) => `standard.review.${name}`
const note = (...lines: ReadonlyArray<string>) =>
  [
    "<model-guidance>",
    "Past guardrail reviews stopped some of this model's actions:",
    ...lines,
    "</model-guidance>",
  ].join("\n")
const templates = {
  [standard("outside-repo")]:
    "- Outside-repository changes (standard.review.outside-repo): Respect approved paths and required approval checks for outside-repository mutations.",
  [standard("git-destructive")]:
    "- Destructive Git (standard.review.git-destructive): Prefer reversible Git commands and retain required approval checks.",
  [standard("force-push")]:
    "- Force push (standard.review.force-push): Do not force-push unless the task requires it; retain required approval checks.",
  [standard("project-deletion")]:
    "- Project deletion (standard.review.project-deletion): Confirm the target and pass required approval checks before deleting a project or its ancestors.",
  [standard("home-child")]:
    "- Home-directory deletion (standard.review.home-child): Confirm the target and pass required approval checks before deleting a direct child of the home directory.",
  [standard("database-destructive")]:
    "- Destructive database statements (standard.review.database-destructive): Use scoped statements and pass required approval checks before destructive database changes.",
  custom: "- Custom guardrail rules (custom): Review configured guardrail rules before repeating a blocked action.",
}

test("fallback incidents attribute the abandoned model and survive Session deletion", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const session = yield* createSession
      const from = ref("anthropic", "primary", { variant: "high", profile: "work" })
      const to = ref("openai", "backup")
      yield* recordFallback(database.db, {
        sessionID: session.id,
        agent: agent("build"),
        from,
        to,
        category: "rate_limit",
        time: 1_000,
      })
      yield* recordFallback(database.db, {
        sessionID: session.id,
        agent: agent("build"),
        from,
        to,
        category: "Rate limited: key sk-secret at /Users/someone/file",
        time: 2_000,
      })
      yield* recordFallback(database.db, {
        sessionID: Session.ID.make("ses_missing"),
        agent: agent("build"),
        from,
        to,
        category: "rate_limit",
        time: 3_000,
      })
      yield* sessions.remove(session.id)
      const rows = yield* all(database.db)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        id: expect.stringMatching(/^inc_/),
        time_created: 1_000,
        kind: "fallback",
        provider_id: "anthropic",
        model_id: "primary",
        variant: "high",
        profile: "work",
        agent: "build",
        session_id: session.id,
        request_id: null,
        category: "rate_limit",
        rule_ids: [],
        target: to,
        decided_by: null,
      })
      expect(rows[0]!.project_id).toBe("global")
      expect(rows[1]!.category).toBe("unknown")
      expect(JSON.stringify(rows)).not.toContain("secret")
      expect(JSON.stringify(rows)).not.toContain("/Users")
    }),
  ))

test("escalations attribute only the named assistant row and store only sanitized rules", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const session = yield* createSession
      yield* seedMessage(database.db, {
        sessionID: session.id,
        id: "old",
        seq: 1,
        agent: "plan",
        model: { providerID: "p1", id: "m1" },
      })
      yield* seedMessage(database.db, {
        sessionID: session.id,
        id: "user",
        seq: 2,
        type: "user",
        agent: "ignored",
        model: { providerID: "ignored", id: "ignored" },
      })
      yield* seedMessage(database.db, {
        sessionID: session.id,
        id: "new",
        seq: 3,
        agent: "build",
        model: { providerID: "p2", id: "m2", variant: "high", profile: "work" },
      })
      const base = {
        sessionID: session.id,
        ruleIDs: [
          standard("outside-repo"),
          "/Users/someone/secret project",
          "rm -rf ~",
          "Upper-Case",
          "x".repeat(65),
          "custom",
          standard("outside-repo"),
        ],
        hardReview: false,
      }
      yield* recordEscalation(database.db, {
        ...base,
        requestID: "req_new",
        messageID: messageID("new"),
        time: 10,
      })
      yield* recordEscalation(database.db, { ...base, requestID: "req_without_message", time: 15 })
      yield* recordEscalation(database.db, {
        ...base,
        requestID: "req_named",
        messageID: messageID("old"),
        hardReview: true,
        time: 20,
      })
      yield* recordEscalation(database.db, {
        ...base,
        requestID: "req_not_assistant",
        messageID: messageID("user"),
        time: 30,
      })
      yield* recordEscalation(database.db, {
        ...base,
        requestID: "req_unknown_message",
        messageID: messageID("missing"),
        time: 40,
      })
      yield* recordEscalation(database.db, {
        ...base,
        requestID: "req_new",
        messageID: messageID("new"),
        time: 50,
      })
      const rows = yield* all(database.db)
      expect(rows.map((row) => row.request_id)).toEqual(["req_new", "req_named"])
      expect(rows[0]).toMatchObject({
        kind: "guardrail-escalated",
        provider_id: "p2",
        model_id: "m2",
        variant: "high",
        profile: "work",
        agent: "build",
        category: "ordinary",
        rule_ids: [standard("outside-repo"), "custom"],
        target: null,
        decided_by: null,
      })
      expect(rows[1]).toMatchObject({ provider_id: "p1", model_id: "m1", agent: "plan", category: "hard" })
      expect(JSON.stringify(rows)).not.toMatch(/Users|secret|rm -rf|Upper/)
    }),
  ))

test("escalations without an assistant row record nothing", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const session = yield* createSession
      yield* recordEscalation(database.db, {
        sessionID: session.id,
        requestID: "req",
        ruleIDs: [standard("force-push")],
        hardReview: true,
        time: 1,
      })
      expect(yield* all(database.db)).toEqual([])
    }),
  ))

test("rejections use the exact source row, else the same Session and request escalation, else nothing", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const session = yield* createSession
      const other = yield* createSession
      yield* seedMessage(database.db, {
        sessionID: session.id,
        id: "first",
        seq: 1,
        agent: "build",
        model: { providerID: "p1", id: "m1" },
      })
      yield* seedMessage(database.db, {
        sessionID: other.id,
        id: "foreign",
        seq: 1,
        agent: "review",
        model: { providerID: "p3", id: "m3" },
      })
      const base = { sessionID: session.id, ruleIDs: [standard("git-destructive")], hardReview: true }
      yield* recordEscalation(database.db, { ...base, requestID: "req_a", messageID: messageID("first"), time: 1 })
      yield* seedMessage(database.db, {
        sessionID: session.id,
        id: "later",
        seq: 2,
        agent: "plan",
        model: { providerID: "p2", id: "m2" },
      })
      yield* recordRejection(database.db, {
        ...base,
        requestID: "req_a",
        decidedBy: "decision-model",
        time: 2,
      })
      yield* recordRejection(database.db, {
        ...base,
        requestID: "req_b",
        messageID: messageID("later"),
        decidedBy: "client",
        time: 3,
      })
      yield* recordRejection(database.db, { ...base, requestID: "req_direct_shell", decidedBy: "client", time: 4 })
      yield* recordRejection(database.db, {
        ...base,
        requestID: "req_a",
        decidedBy: "decision-model",
        time: 5,
      })
      yield* recordRejection(database.db, {
        ...base,
        requestID: "req_foreign_message",
        messageID: messageID("foreign"),
        decidedBy: "client",
        time: 6,
      })
      yield* recordRejection(database.db, {
        sessionID: other.id,
        requestID: "req_a",
        ruleIDs: [standard("git-destructive")],
        hardReview: true,
        decidedBy: "client",
        time: 7,
      })
      const rows = yield* all(database.db)
      expect(rows.map((row) => [row.kind, row.request_id, row.provider_id, row.agent, row.decided_by])).toEqual([
        ["guardrail-escalated", "req_a", "p1", "build", null],
        ["guardrail-rejected", "req_a", "p1", "build", "decision-model"],
        ["guardrail-rejected", "req_b", "p2", "plan", "client"],
      ])
      expect(rows[1]!.category).toBe("hard")
    }),
  ))

test("rejections without an exact source or matching escalation record nothing even when assistants exist", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const session = yield* createSession
      yield* seedMessage(database.db, {
        sessionID: session.id,
        id: "latest",
        seq: 1,
        agent: "build",
        model: { providerID: "p1", id: "m1" },
      })
      yield* recordRejection(database.db, {
        sessionID: session.id,
        requestID: "req",
        ruleIDs: [],
        hardReview: false,
        decidedBy: "client",
        time: 1,
      })
      yield* recordRejection(database.db, {
        sessionID: session.id,
        requestID: "req",
        messageID: messageID("missing"),
        ruleIDs: [],
        hardReview: false,
        decidedBy: "client",
        time: 2,
      })
      expect(yield* all(database.db)).toEqual([])
    }),
  ))

test("report groups by model or agent with counts, last time, ordering, ranges and pagination", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const incidents = yield* Service
      yield* put(database.db, { id: "inc_01", time: 100, kind: "fallback", agent: "build" })
      yield* put(database.db, { id: "inc_02", time: 200, kind: "guardrail-escalated", agent: "build" })
      yield* put(database.db, { id: "inc_03", time: 300, kind: "guardrail-rejected", agent: "plan" })
      yield* put(database.db, { id: "inc_04", time: 400, kind: "fallback", agent: "plan", model: "other" })
      yield* put(database.db, { id: "inc_05", time: 500, kind: "fallback", agent: "plan", provider: "q", model: "z" })

      const byModel = yield* incidents.report({ group: "model" })
      expect(byModel).toEqual({
        groups: 3,
        rows: [
          reportRow("p", "m", { fallbacks: 1, escalated: 1, rejected: 1, last: 300 }),
          reportRow("q", "z", { fallbacks: 1, escalated: 0, rejected: 0, last: 500 }),
          reportRow("p", "other", { fallbacks: 1, escalated: 0, rejected: 0, last: 400 }),
        ],
      })
      const byAgent = yield* incidents.report({ group: "agent" })
      expect(byAgent.groups).toBe(4)
      expect(byAgent.rows.find((row) => row.modelID === "m" && row.agent === "build")).toEqual(
        reportRow("p", "m", { fallbacks: 1, escalated: 1, rejected: 0, last: 200 }, "build"),
      )
      expect(byAgent.rows.find((row) => row.modelID === "m" && row.agent === "plan")).toMatchObject({
        rejected: 1,
        last: 300,
      })

      const ranged = yield* incidents.report({ group: "model", from: 200, to: 400 })
      expect(ranged).toEqual({
        groups: 1,
        rows: [reportRow("p", "m", { fallbacks: 0, escalated: 1, rejected: 1, last: 300 })],
      })
      expect((yield* incidents.report({ group: "model", from: 200, to: 200 })).groups).toBe(0)

      const first = yield* incidents.report({ group: "model", limit: 2 })
      const second = yield* incidents.report({ group: "model", limit: 2, offset: 2 })
      expect(first.groups).toBe(3)
      expect(second.groups).toBe(3)
      expect(byModel.rows).toEqual([...first.rows, ...second.rows])
      expect((yield* incidents.report({ group: "model", offset: 3 })).rows).toEqual([])
    }),
  ))

test("report rejects out-of-contract limits, offsets and ranges", () =>
  run(
    Effect.gen(function* () {
      const incidents = yield* Service
      for (const input of [
        { group: "model", limit: 201 },
        { group: "model", limit: 0 },
        { group: "model", offset: -1 },
        { group: "model", from: 5, to: 4 },
        { group: "model", from: -1 },
      ] as const) {
        const error = yield* incidents.report(input).pipe(Effect.flip)
        expect(error._tag).toBe("ModelIncident.InvalidInputError")
      }
      expect((yield* incidents.report({ group: "model", limit: 200 })).groups).toBe(0)
    }),
  ))

test("report aggregates exactly beyond one 10,000-row statement, including identical timestamps", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const incidents = yield* Service
      const count = 10_003
      yield* bulk(database.db, { prefix: "inc_bulk", count, time: 1_000 })
      yield* put(database.db, { id: "inc_zz_last", time: 2_000, kind: "fallback", agent: "build" })
      const values = Array.from({ length: count }, (_, value) => value)
      const kinds = (predicate: (value: number) => boolean) => values.filter(predicate).length
      const expected = (agentName: string | undefined) => {
        const selected = (value: number) =>
          agentName === undefined || (value % 2 === 0 ? "build" : "plan") === agentName
        return {
          fallbacks: kinds((value) => value % 3 === 0 && selected(value)),
          escalated: kinds((value) => value % 3 === 1 && selected(value)),
          rejected: kinds((value) => value % 3 === 2 && selected(value)),
        }
      }
      const byModel = yield* incidents.report({ group: "model" })
      const total = expected(undefined)
      expect(byModel.rows).toEqual([reportRow("p", "m", { ...total, fallbacks: total.fallbacks + 1, last: 2_000 })])
      const byAgent = yield* incidents.report({ group: "agent" })
      expect(byAgent.groups).toBe(2)
      expect(byAgent.rows.map((row) => [row.agent, row.fallbacks, row.escalated, row.rejected])).toEqual(
        ["build", "plan"].map((name) => {
          const counts = expected(name)
          return [agent(name), counts.fallbacks + (name === "build" ? 1 : 0), counts.escalated, counts.rejected]
        }),
      )
    }),
  ), 60_000)

test("recent lists newest first with id tie-break, filters by model and agent, and caps the page", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const incidents = yield* Service
      const target = ref("openai", "backup")
      yield* put(database.db, {
        id: "inc_a",
        time: 100,
        kind: "fallback",
        category: "rate_limit",
        target,
        variant: "high",
        profile: "work",
      })
      yield* put(database.db, {
        id: "inc_b",
        time: 200,
        kind: "guardrail-rejected",
        category: "hard",
        rules: [standard("force-push")],
        decidedBy: "client",
        agent: "plan",
      })
      yield* put(database.db, { id: "inc_c", time: 200, kind: "guardrail-escalated", category: "ordinary" })
      yield* put(database.db, { id: "inc_d", time: 300, model: "other" })
      const recent = yield* incidents.recent({ provider: Provider.ID.make("p"), model: Model.ID.make("m") })
      expect(recent.items.map((item) => item.id)).toEqual(["inc_c", "inc_b", "inc_a"].map(incidentID))
      expect(recent.items[0]).toEqual({
        id: incidentID("inc_c"),
        time: 200,
        kind: "guardrail-escalated",
        category: "ordinary",
        ruleIDs: [],
        agent: agent("build"),
      })
      expect(recent.items[1]).toEqual({
        id: incidentID("inc_b"),
        time: 200,
        kind: "guardrail-rejected",
        category: "hard",
        ruleIDs: [standard("force-push")],
        agent: agent("plan"),
        decidedBy: "client",
      })
      expect(recent.items[2]).toEqual({
        id: incidentID("inc_a"),
        time: 100,
        kind: "fallback",
        category: "rate_limit",
        ruleIDs: [],
        agent: agent("build"),
        variant: Model.VariantID.make("high"),
        profile: Model.ProfileName.make("work"),
        target,
      })
      const filtered = yield* incidents.recent({
        provider: Provider.ID.make("p"),
        model: Model.ID.make("m"),
        agent: agent("plan"),
      })
      expect(filtered.items.map((item) => item.id)).toEqual([incidentID("inc_b")])
      expect(
        (yield* incidents.recent({ provider: Provider.ID.make("p"), model: Model.ID.make("m"), limit: 2 })).items,
      ).toHaveLength(2)
      yield* bulk(database.db, { prefix: "inc_many", count: 80, time: 50 })
      expect(
        (yield* incidents.recent({ provider: Provider.ID.make("p"), model: Model.ID.make("m"), limit: 50 })).items,
      ).toHaveLength(50)
      const error = yield* incidents
        .recent({ provider: Provider.ID.make("p"), model: Model.ID.make("m"), limit: 51 })
        .pipe(Effect.flip)
      expect(error._tag).toBe("ModelIncident.InvalidInputError")
    }),
  ))

const requests = (rule: string, count: number, prefix = rule) =>
  Array.from({ length: count }, (_, index) => ({ requestID: `${prefix}_${index}`, ruleIDs: [rule] }))

test("guidance renders only rule groups with two distinct requests in fixed order without counts", () => {
  expect(ModelGuidanceInstructions.render([])).toBeUndefined()
  expect(ModelGuidanceInstructions.render(requests(standard("outside-repo"), 1))).toBeUndefined()
  expect(
    ModelGuidanceInstructions.render([
      { requestID: "same", ruleIDs: [standard("outside-repo")] },
      { requestID: "same", ruleIDs: [standard("outside-repo")] },
    ]),
  ).toBeUndefined()

  const rows = [
    ...requests(standard("outside-repo"), 2),
    ...requests(standard("git-destructive"), 2),
    ...requests(standard("force-push"), 3),
    ...requests(standard("database-destructive"), 1),
  ]
  const text = ModelGuidanceInstructions.render(rows)!
  expect(text).toBe(
    note(
      templates[standard("force-push")],
      templates[standard("git-destructive")],
      templates[standard("outside-repo")],
    ),
  )
  expect(text).not.toMatch(/\d/)
})

test("each fixed template renders its approved wording exactly and only reminds of approval checks", () => {
  for (const [ruleID, line] of Object.entries(templates)) {
    const rule = ruleID === "custom" ? "team.custom" : ruleID
    const text = ModelGuidanceInstructions.render(requests(rule, 2))
    expect(text).toBe(note(line))
    expect(line).toContain(ruleID)
    expect(Buffer.byteLength(text!)).toBeLessThanOrEqual(1024)
  }
  expect(Object.keys(templates)).toEqual([
    standard("outside-repo"),
    standard("git-destructive"),
    standard("force-push"),
    standard("project-deletion"),
    standard("home-child"),
    standard("database-destructive"),
    "custom",
  ])
})

test("guidance bytes are stable across row order, repeated renders and counts above the threshold", () => {
  const rows = [...requests(standard("outside-repo"), 2), ...requests(standard("force-push"), 2)]
  const text = ModelGuidanceInstructions.render(rows)!
  expect(ModelGuidanceInstructions.render(rows)).toBe(text)
  expect(ModelGuidanceInstructions.render(rows.toReversed())).toBe(text)
  expect(
    ModelGuidanceInstructions.render([
      ...requests(standard("outside-repo"), 9),
      ...requests(standard("force-push"), 9),
    ]),
  ).toBe(text)
})

test("guidance aggregates unknown and malformed rule IDs into one custom line and ignores rows without rules", () => {
  const rows = [
    { requestID: "a", ruleIDs: ["team.rule-one", standard("unknown")] },
    { requestID: "b", ruleIDs: ["custom"] },
    { requestID: "c", ruleIDs: [] },
  ]
  const text = ModelGuidanceInstructions.render(rows)!
  expect(text).toBe(note(templates.custom))
  expect(text).not.toContain("team.rule-one")
  expect(ModelGuidanceInstructions.render(rows.slice(0, 1))).toBeUndefined()
})

test("guidance keeps at most five lines within one KiB, ordered by distinct requests then rule ID", () => {
  const rules = [
    ["custom", 9],
    ["force-push", 8],
    ["outside-repo", 7],
    ["project-deletion", 6],
    ["home-child", 5],
    ["git-destructive", 4],
    ["database-destructive", 3],
  ] as const
  const text = ModelGuidanceInstructions.render(
    rules.flatMap(([name, count]) =>
      requests(name === "custom" ? "team.custom" : standard(name), count, name),
    ),
  )!
  const lines = text.split("\n").filter((line) => line.startsWith("- "))
  expect(lines).toHaveLength(5)
  expect(lines.map((line) => line.match(/\((.*?)\)/)![1])).toEqual([
    "custom",
    standard("force-push"),
    standard("outside-repo"),
    standard("project-deletion"),
    standard("home-child"),
  ])
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024)
  expect(text.startsWith("<model-guidance>\n")).toBe(true)
  expect(text.endsWith("\n</model-guidance>")).toBe(true)
})

test("guidance rows honor the window, clear watermark, model scope, variant and profile invariance, and exclude fallbacks", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const now = 100 * DAY
      const model = { providerID: Provider.ID.make("p"), id: Model.ID.make("m") }
      const rule = [standard("outside-repo")]
      yield* put(database.db, { id: "inc_01", time: now - 30 * DAY, request: "r1", rules: rule })
      yield* put(database.db, { id: "inc_02", time: now - 30 * DAY - 1, request: "r2", rules: rule })
      yield* put(database.db, { id: "inc_03", time: now - 10, request: "r3", rules: rule, variant: "high" })
      yield* put(database.db, { id: "inc_04", time: now - 9, request: "r4", rules: rule, profile: "work" })
      yield* put(database.db, { id: "inc_05", time: now - 8, request: "r5", rules: rule, model: "other" })
      yield* put(database.db, { id: "inc_06", time: now - 7, request: "r6", rules: rule, kind: "fallback" })
      yield* put(database.db, { id: "inc_07", time: now - 6, rules: rule, kind: "guardrail-rejected" })
      yield* put(database.db, { id: "inc_08", time: now, request: "r8", rules: rule })
      yield* put(database.db, { id: "inc_09", time: now + 1, request: "r9", rules: rule })
      const read = () => ModelGuidanceInstructions.rows(database.db, model, now)
      expect((yield* read()).map((row) => row.requestID).toSorted()).toEqual(["inc_07", "r1", "r3", "r4", "r8"])

      yield* database.db.run(sql`INSERT INTO model_guidance_clear VALUES ('p', 'm', ${now - 10})`)
      expect((yield* read()).map((row) => row.requestID).toSorted()).toEqual(["inc_07", "r4", "r8"])
      yield* database.db.run(sql`UPDATE model_guidance_clear SET cleared_at = ${now - 6}`)
      expect((yield* read()).map((row) => row.requestID)).toEqual(["r8"])
    }),
  ))

test("guidance row limit keeps the newest rows and breaks timestamp ties by descending id", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const now = 100 * DAY
      const model = { providerID: Provider.ID.make("p"), id: Model.ID.make("m") }
      yield* database.db.run(sql`
        WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < 10000)
        INSERT INTO model_incident (id, time_created, kind, provider_id, model_id, agent, project_id, session_id, request_id, category, rule_ids)
        SELECT printf('inc_tie_%09d', value), ${now - 1}, 'guardrail-escalated', 'p', 'm', 'build', 'global', 'ses_gone',
          printf('inc_tie_%09d', value), 'ordinary', '["standard.review.outside-repo"]' FROM n
      `)
      yield* put(database.db, { id: "inc_older", time: now - 2, request: "inc_older", rules: [standard("outside-repo")] })
      const rows = yield* ModelGuidanceInstructions.rows(database.db, model, now)
      expect(rows).toHaveLength(10_000)
      expect(rows[0]!.requestID).toBe("inc_tie_000010000")
      expect(rows.at(-1)!.requestID).toBe("inc_tie_000000001")
      expect(rows.map((row) => row.requestID)).not.toContain("inc_tie_000000000")
      expect(rows.map((row) => row.requestID)).not.toContain("inc_older")
    }),
  ))

testEffect(runtime).effect("service guidance reports the note, the clear watermark and the caller's enabled state; clear keeps incidents and later rows count", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const incidents = yield* Service
      yield* TestClock.adjust(1_000)
      const now = 1_000
      const query = { provider: Provider.ID.make("p"), model: Model.ID.make("m") }
      for (const index of [1, 2])
        yield* put(database.db, {
          id: `inc_${index}`,
          time: now - 1_000,
          request: `r${index}`,
          rules: [standard("force-push")],
        })
      const before = yield* incidents.guidance(query, true)
      expect(before).toEqual({ enabled: true, text: ModelGuidanceInstructions.render(requests(standard("force-push"), 2)) })
      expect(yield* incidents.guidance(query, false)).toEqual({ ...before, enabled: false })

      const reportBefore = yield* incidents.report({ group: "model" })
      const clearedAt = yield* incidents.clear(query)
      expect(yield* incidents.guidance(query, true)).toEqual({ enabled: true, clearedAt })
      expect(yield* incidents.report({ group: "model" })).toEqual(reportBefore)
      expect((yield* all(database.db)).length).toBe(2)
      expect(yield* incidents.guidance({ ...query, model: Model.ID.make("other") }, true)).toEqual({ enabled: true })

      for (const index of [3, 4])
        yield* put(database.db, {
          id: `inc_${index}`,
          time: clearedAt + 1,
          request: `r${index}`,
          rules: [standard("force-push")],
        })
      expect(yield* incidents.guidance(query, true)).toEqual({ enabled: true, clearedAt })
      yield* TestClock.adjust(1)
      expect((yield* incidents.guidance(query, true)).text).toContain("force-push")
      expect((yield* incidents.guidance(query, true)).clearedAt).toBe(clearedAt)
      expect(
        (yield* database.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM model_guidance_clear`))?.count,
      ).toBe(1)
    }),
)

test("clear returns the stored watermark when the clock is behind it", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const incidents = yield* Service
      const query = { provider: Provider.ID.make("p"), model: Model.ID.make("m") }
      const ahead = Date.now() + 10 * DAY
      yield* database.db.run(sql`INSERT INTO model_guidance_clear VALUES ('p', 'm', ${ahead})`)
      expect(yield* incidents.clear(query)).toBe(ahead)
      expect(
        (yield* database.db.get<{ clearedAt: number }>(sql`SELECT cleared_at AS clearedAt FROM model_guidance_clear`))
          ?.clearedAt,
      ).toBe(ahead)
      expect((yield* incidents.guidance(query, true)).clearedAt).toBe(ahead)
    }),
  ))

const observed: Array<{ query: string; transactional: boolean }> = []
let capture = false
let capturedDb: Database.Interface["db"] | undefined
const loggedDatabase = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.make().pipe(
      Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
        logQuery: (query) =>
          Effect.gen(function* () {
            if (!capture || !capturedDb) return
            const transaction = yield* Effect.serviceOption(capturedDb.$client.transactionService)
            observed.push({ query, transactional: transaction._tag === "Some" })
          }),
      }),
      Effect.provide(EffectDrizzleSqlite.DefaultServices),
    )
    capturedDb = db
    yield* DatabaseMigration.apply(db)
    return { db }
  }),
).pipe(Layer.provide(sqliteLayer({ filename: ":memory:" })))

test("guidance reads the note and the clear watermark in one transaction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const incidents = yield* Service
      const query = { provider: Provider.ID.make("p"), model: Model.ID.make("m") }
      for (const index of [1, 2])
        yield* put(database.db, { id: `inc_${index}`, time: Date.now() - 1_000, request: `r${index}`, rules: [standard("force-push")] })
      yield* database.db.run(sql`INSERT INTO model_guidance_clear VALUES ('p', 'm', 1)`)
      observed.length = 0
      capture = true
      yield* incidents.guidance(query, true)
      capture = false
      const reads = observed.filter((entry) => /model_incident|model_guidance_clear/.test(entry.query))
      expect(reads).toHaveLength(2)
      expect(reads.every((entry) => entry.transactional)).toBe(true)
    }).pipe(
      Effect.provide(layer.pipe(Layer.provideMerge(Layer.merge(loggedDatabase, settings)))),
      Effect.scoped,
    ),
  ))

test("the guidance source is keyed, never unavailable, retracts with fixed text and is observed removed when the capability is denied", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const model = Model.Ref.make({ providerID: Provider.ID.make("p"), id: Model.ID.make("m") })
      const guidance = ModelGuidanceInstructions.make(database.db, model)
      const guidanceKey = Instructions.Key.make("core/model-guidance")
      expect(guidance.map((source) => source.key)).toEqual([guidanceKey])

      const empty = yield* Instructions.read(guidance)
      expect(empty).toEqual([{ key: guidanceKey, value: Instructions.removed }])
      expect(yield* Instructions.diff(empty)).toEqual({ delta: {}, blobs: {} })

      const now = Date.now()
      for (const index of [1, 2])
        yield* put(database.db, { id: `inc_${index}`, time: now - 1_000, request: `r${index}`, rules: [standard("git-destructive")] })
      const observed = yield* Instructions.read(guidance)
      const again = yield* Instructions.read(guidance)
      expect(again).toEqual(observed)
      const value = observed[0]!.value
      if (typeof value !== "string") return yield* Effect.die(new Error("Expected rendered guidance"))
      const admission = yield* Instructions.diff(observed)
      expect(Object.values(admission.blobs)).toEqual([value])
      const source = guidance[0]!
      expect(source.initial(value)).toBe(value)
      expect(source.changed(value, value)).toContain(value)
      expect(source.removed(value)).toBe(ModelGuidanceInstructions.retraction)
      expect(value).toBe(note(templates[standard("git-destructive")]))

      const denied: Omit<InstructionBuiltIns.Input, "sessionID"> = { capabilities: { builtin_instructions: { deny: ["model-guidance"] } }, tools: new Set<string>() }
      expect(InstructionBuiltIns.enabled("model-guidance", denied)).toBe(false)
      expect(InstructionBuiltIns.enabled("model-guidance", { capabilities: {}, tools: new Set<string>() })).toBe(true)
      expect(
        InstructionBuiltIns.enabled("model-guidance", {
          capabilities: { builtin_instructions: { allow: ["date"] } },
          tools: new Set<string>(),
        }),
      ).toBe(false)
      const hidden = yield* Instructions.read(Instructions.when(false, guidance))
      expect(hidden).toEqual([{ key: guidanceKey, value: Instructions.removed }])
      const retracted = yield* Instructions.diff(hidden, Instructions.applyHashDelta({}, admission.delta))
      expect(retracted.delta[guidanceKey]).toBe(Instruction.removed)
      expect(retracted.blobs).toEqual({})
    }),
  ))

test("the model-guidance capability literal is accepted and denied through the selection rules", () => {
  expect(ConfigCapabilities.BuiltinInstruction.literals).toContain("model-guidance")
  expect(ConfigCapabilities.allows({ deny: ["model-guidance"] }, "model-guidance")).toBe(false)
  expect(ConfigCapabilities.allows({ enabled: false }, "model-guidance")).toBe(false)
  expect(ConfigCapabilities.allows(undefined, "model-guidance")).toBe(true)
})

test("cleanup deletes strictly older incidents in batches using the configured days and keeps clear rows", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const incidents = yield* Service
      const now = 100 * DAY
      incidentDays = 3
      yield* bulk(database.db, { prefix: "inc_old", count: 2_005, time: now - 3 * DAY - 1 })
      yield* put(database.db, { id: "inc_boundary", time: now - 3 * DAY })
      yield* put(database.db, { id: "inc_fresh", time: now })
      yield* database.db.run(sql`INSERT INTO model_guidance_clear VALUES ('p', 'm', 1)`)
      expect(yield* incidents.cleanup(now)).toBe(2_005)
      expect((yield* all(database.db)).map((row) => row.id)).toEqual(["inc_boundary", "inc_fresh"].map(incidentID))
      expect(yield* incidents.cleanup(now)).toBe(0)
      expect(
        (yield* database.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM model_guidance_clear`))?.count,
      ).toBe(1)
      incidentDays = 1
      expect(yield* incidents.cleanup(now)).toBe(1)
      incidentDays = 30
    }),
  ), 30_000)

let sweeps = 0
const scheduled = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, node]), [
    [
      RetentionSettings.node,
      Layer.succeed(RetentionSettings.Service, {
        read: () =>
          Effect.sync(() => {
            sweeps++
            return { recordsDays: 7, usageDays: 30, latencyDays: 30, incidentDays: 30 }
          }),
      }),
    ],
  ]),
)

scheduled.effect("incident cleanup runs at startup and every subsequent hour", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust(0)
    expect(sweeps).toBe(1)
    for (const expected of [2, 3, 4]) {
      yield* TestClock.adjust("1 hour")
      expect(sweeps).toBe(expected)
    }
  }),
)
