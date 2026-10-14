import { Clock, Effect, Layer, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import { Auth, RequestExecutor } from "@ycoding-ai/ai/route"
import { Model } from "@ycoding-ai/ai"
import { route } from "@ycoding-ai/ai/protocols/openai-chat"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { Database } from "@ycoding-ai/core/database/database"
import { Global } from "@ycoding-ai/core/global"
import { ModelsDev } from "@ycoding-ai/core/models-dev"
import { Session } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionTodo } from "@ycoding-ai/core/session/todo"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { EventRuntime } from "@ycoding-ai/core/event"
import { InstructionEntry } from "@ycoding-ai/core/session/instruction-entry"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Location } from "@ycoding-ai/core/location"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { KV } from "@ycoding-ai/core/kv"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { TelemetryConsent } from "@ycoding-ai/core/telemetry-consent"
import { AbsolutePath, RelativePath } from "@ycoding-ai/core/schema"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { Project } from "@ycoding-ai/core/project"
import { Form } from "@ycoding-ai/core/form"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { ContextManifest } from "@ycoding-ai/core/session/context-manifest"
import { SessionCompactionJob } from "@ycoding-ai/core/session/compaction-job"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { SessionProviderState } from "@ycoding-ai/core/session/provider-state"
import { SessionContinuation } from "@ycoding-ai/core/session/runner/continuation"
import { SessionMessageTable } from "@ycoding-ai/core/session/sql"
import { ProjectArtifactStore } from "@ycoding-ai/core/project-artifact"
import { ProjectArtifactAccounting } from "@ycoding-ai/core/project-artifact/accounting"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Agent } from "@ycoding-ai/core/agent"
import { Skill } from "@ycoding-ai/core/skill"
import { Event } from "@ycoding-ai/schema/event"
import { WebLatency } from "@ycoding-ai/core/web-latency"
import { ShellLedger } from "@ycoding-ai/core/shell/ledger"
import { Shell } from "@ycoding-ai/schema/shell"
import { AppProcess } from "@ycoding-ai/core/process"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import path from "node:path"
import meetingBaseline from "../../../../extensions/meeting/test/fixture/stable-meeting/snapshot.json"

export const unicode = {
  paired: "paired:\ud83d\ude80",
  high: "high:\ud800",
  low: "low:\udc00",
  mixed: "mixed:\ud800A\udc00\ud83d\ude80\ud800\ud800\udc00",
} as const
export const unicodeDocument = Object.fromEntries(Object.values(unicode).map((value) => [value, value]))

export async function buildScenario(root: string) {
  const pluginRuntime = PluginRuntime.makeCell()
  for (const directory of [path.join(root, "locations/first"), path.join(root, "locations/second")]) {
    for (const args of [
      ["init", "--quiet", directory],
      ["-C", directory, "remote", "add", "origin", `https://synthetic.invalid/${path.basename(directory)}.git`],
    ]) {
      const git = Bun.spawn(["git", ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10000 })
      const error = await new Response(git.stderr).text()
      if ((await git.exited) !== 0) throw new Error(`Synthetic repository initialization failed: ${error}`)
    }
  }
  const recording = await Bun.file(
    path.resolve(import.meta.dir, "../fixtures/recordings/session-runner/openai-chat-streams-text.json"),
  ).json()
  const response = recording.interactions[0].response
  const requests: { method: string; source: string }[] = []
  const executor = Layer.succeed(RequestExecutor.Service, {
    execute: (request) =>
      Effect.sync(() => {
        requests.push({ method: request.method, source: "session-runner/openai-chat-streams-text" })
        return HttpClientResponse.fromWeb(
          request,
          new Response(response.body, { status: response.status, headers: response.headers }),
        )
      }),
  })
  const deniedNetwork = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("F-STORE forbids network access")),
  )
  const model = Model.make({
    id: "gpt-4o-mini",
    provider: "openai",
    route: route.with({
      endpoint: { baseURL: "https://baseline.invalid/v1" },
      auth: Auth.bearer("synthetic-fixture-not-a-credential"),
      limits: { context: 262_144, output: 8192 },
    }),
  })
  const layer = AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      Database.node,
      EventRuntime.node,
      SessionExecution.node,
      LocationServiceMap.node,
      Credential.node,
      KV.node,
      PermissionSaved.node,
      TelemetryConsent.node,
      AttachmentStore.node,
      Project.node,
      ProjectArtifactStore.node,
      ProjectArtifactAccounting.node,
      SessionCompactionJob.node,
      SessionContextState.node,
      AppProcess.node,
      PluginRuntime.providerNodeWithCell(pluginRuntime),
    ]),
    [
      [Database.node, Database.layerFromPath(path.join(root, "data/core.sqlite"))],
      [
        Global.node,
        Global.layerWith({
          home: path.join(root, "home"),
          data: path.join(root, "data/ycoding"),
          config: path.join(root, "config/ycoding"),
          state: path.join(root, "state/ycoding"),
          cache: path.join(root, "cache/ycoding"),
          tmp: path.join(root, "tmp/ycoding"),
        }),
      ],
      [
        ModelsDev.node,
        ModelsDev.configured({
          file: path.resolve(import.meta.dir, "../plugin/fixtures/models-dev.json"),
          fetch: false,
        }),
      ],
      [LayerNodePlatform.httpClient, deniedNetwork],
      [LayerNodePlatform.requestExecutor, executor],
      [PluginRuntime.node, PluginRuntime.layerWithCell(pluginRuntime)],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(SessionRunnerModel.resolved(model)))],
    ],
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service
      const execution = yield* SessionExecution.Service
      const events = yield* EventRuntime.Service
      const locations = yield* LocationServiceMap.Service
      const project = yield* Project.Service
      const credentials = yield* Credential.Service
      const kv = yield* KV.Service
      const consent = yield* TelemetryConsent.Service
      const permissions = yield* PermissionSaved.Service
      const attachments = yield* AttachmentStore.Service
      const first = Location.Ref.make({ directory: AbsolutePath.make(path.join(root, "locations/first")) })
      const second = Location.Ref.make({ directory: AbsolutePath.make(path.join(root, "locations/second")) })
      const selection = CatalogModel.Ref.make({
        providerID: Provider.ID.make("openai"),
        id: CatalogModel.ID.make("gpt-4o-mini"),
      })
      yield* project.recordOpened(first.directory)
      yield* project.recordOpened(second.directory)
      const parent = yield* session.create({
        id: Session.ID.make("ses_baseline_root"),
        title: "Synthetic baseline",
        location: first,
        model: selection,
      })
      const child = yield* session.create({
        id: Session.ID.make("ses_baseline_child"),
        title: "Synthetic child",
        parentID: parent.id,
        model: selection,
      })
      yield* session.create({
        id: Session.ID.make("ses_baseline_other"),
        title: "Second Location",
        location: second,
        model: selection,
      })
      yield* credentials.create({
        integrationID: Integration.ID.make("baseline-fixture"),
        label: "Synthetic profile",
        value: Credential.Key.make({ type: "key", key: "synthetic-fixture-not-a-credential" }),
      })
      yield* kv.set("baseline/utf16", unicodeDocument)
      yield* permissions.add({ projectID: parent.projectID, action: "read", resources: ["synthetic-fixture.txt"] })
      yield* consent.set({ enabled: true, noticeVersion: 1 })
      const content = yield* attachments.import(Buffer.from("Synthetic attachment bytes\n"))
      const artifacts = yield* ProjectArtifactStore.Service
      const accounting = yield* ProjectArtifactAccounting.Service
      const managed = yield* artifacts.writeAutomatic({
        projectID: parent.projectID,
        sessionID: parent.id,
        insightKey: "baseline-skill",
        id: "baseline-skill",
        definition: {
          kind: "skill",
          name: "Baseline skill",
          description: "Synthetic parity fixture",
          content: "Use the synthetic parity fixture.",
        },
      })
      yield* accounting.activate(
        ProjectArtifact.Activation.make({
          id: ProjectArtifact.ActivationID.make("paa_baseline"),
          artifact: {
            scopeID: managed.scopeID,
            kind: managed.kind,
            id: managed.id,
            versionID: managed.versionID,
          },
          projectID: parent.projectID,
          sessionID: parent.id,
          source: "session-skill",
          boundarySeq: ProjectArtifact.Revision.make(0),
          activatedAt: ProjectArtifact.TimestampMillis.make(Date.now()),
        }),
      )
      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID: parent.id,
        id: Skill.ID.make("baseline-skill"),
        name: Skill.Name.make("Baseline skill"),
        text: "Use the synthetic parity fixture.",
        artifact: {
          scopeID: managed.scopeID,
          versionID: managed.versionID,
          kind: "skill",
          id: managed.id,
          sourceScope: "project",
        },
      })
      yield* InstructionEntry.Service.use((entries) =>
        entries.put({ sessionID: parent.id, key: InstructionEntry.Key.make("baseline"), value: unicodeDocument }),
      ).pipe(Effect.provide(locations.get(first)))
      yield* SessionTodo.Service.use((todos) =>
        todos.update({
          sessionID: parent.id,
          todos: [{ content: "Verify synthetic baseline", status: "in_progress", priority: "high" }],
        }),
      ).pipe(Effect.provide(locations.get(first)))
      const form = yield* Form.Service.use((forms) =>
        forms.create({
          sessionID: parent.id,
          title: "Synthetic decision",
          fields: [{ key: "confirm", type: "boolean", required: true }],
          metadata: unicodeDocument,
        }),
      ).pipe(Effect.provide(locations.get(first)))
      yield* Form.Service.use((forms) => forms.reply({ id: form.id, answer: { confirm: true } })).pipe(
        Effect.provide(locations.get(first)),
      )
      const formState = yield* Form.Service.use((forms) => forms.state(form.id)).pipe(
        Effect.provide(locations.get(first)),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(root, "runtime-oracle.json"),
          JSON.stringify(
            {
              form: { input: form, state: formState },
              permissions: "PermissionSaved.add; durable permission rows are in semantic-export.json",
            },
            null,
            2,
          ),
        ),
      )
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_baseline_steer"),
        sessionID: parent.id,
        text: "Baseline steer",
        metadata: unicodeDocument,
        delivery: "steer",
        resume: false,
      })
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_baseline_queue"),
        sessionID: parent.id,
        text: "Baseline queue",
        delivery: "queue",
        resume: false,
      })
      yield* execution.resume(parent.id)
      const trash = yield* artifacts.writeAutomatic({
        projectID: parent.projectID,
        sessionID: child.id,
        insightKey: "baseline-trash",
        id: "baseline-trash",
        definition: {
          kind: "skill",
          name: "Baseline trash",
          description: "Synthetic recovery fixture",
          content: "Use the synthetic recovery fixture.",
        },
      })
      const details = yield* artifacts.get({
        scope: { type: "project" },
        projectID: parent.projectID,
        kind: trash.kind,
        id: trash.id,
      })
      yield* artifacts.remove({
        scopeID: trash.scopeID,
        kind: trash.kind,
        id: trash.id,
        expectedRevision: details.artifact.revision,
        expectedVersionID: trash.versionID,
        expectedDigest: trash.contentDigest,
      })
      const db = (yield* Database.Service).db
      yield* WebLatency.append(db, [
        {
          kind: "request",
          at: "2026-01-01T00:00:00.000Z",
          operation: "session.snapshot",
          outcome: "ok",
          queueMs: 1,
          settlementMs: 2,
          totalMs: 3,
        },
      ])
      yield* events.publish(SessionEvent.Task.Updated, {
        sessionID: child.id,
        change: {
          type: "launched",
          parentID: parent.id,
          parentAssistantMessageID: SessionMessage.ID.make("msg_baseline_launch"),
          toolCallID: "baseline-call",
          inputID: SessionMessage.ID.make("msg_baseline_child_task"),
          description: "Synthetic child task",
          agent: Agent.ID.make("zeus"),
          model: selection,
          promptDigest: ContextManifest.payloadDigest("Synthetic child task"),
          background: true,
          delivery: "steer",
        },
      })
      yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
      yield* events.publish(SessionEvent.Task.Updated, {
        sessionID: child.id,
        change: { type: "completed", excerpt: "Synthetic completion" },
      })
      yield* compactFixture(db, session, events, locations, first, parent.id)
      const assistant = (yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, parent.id))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)).find((message) => message.type === "assistant")
      if (!assistant) return yield* Effect.die("Baseline provider did not produce a terminal assistant message")
      yield* SessionProviderState.Service.use((state) =>
        state.capture({
          sessionID: parent.id,
          messageID: SessionMessage.ID.make(assistant.id),
          partOrdinal: 0,
          partKind: "text",
          provider: "openai",
          modelID: "gpt-4o-mini",
          contextRevision: 1,
          state: {
            opaqueCompactionItem: {
              type: "compaction",
              id: "synthetic-opaque-item",
              encrypted_content: "synthetic-not-encrypted",
              values: unicodeDocument,
            },
          },
        }),
      ).pipe(Effect.provide(locations.get(first)))
      yield* SessionContinuation.Service.use((continuation) =>
        continuation.remember({
          sessionID: parent.id,
          contextRevision: 1,
          continuationGeneration: 1,
          provider: "openai",
          routeID: "openai-responses",
          modelID: "gpt-4o-mini",
          connectionIdentityDigest: "a".repeat(64),
          representedThroughMessageID: SessionMessage.ID.make(assistant.id),
          representedMessageCount: 1,
          promptCacheKey: "synthetic-cache",
          instructionsDigest: "b".repeat(64),
          toolsDigest: "c".repeat(64),
          optionsDigest: "d".repeat(64),
          volatileContextDigest: "e".repeat(64),
          responseID: "synthetic-response",
        }),
      ).pipe(Effect.provide(locations.get(first)))
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_baseline_pending_steer"),
        sessionID: child.id,
        text: "Pending steer",
        metadata: unicodeDocument,
        files: [{ uri: AttachmentStore.managedURI(content), name: "synthetic.txt" }],
        delivery: "steer",
        resume: false,
      })
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_baseline_pending_queue"),
        sessionID: child.id,
        text: "Pending queue",
        delivery: "queue",
        resume: false,
      })
      yield* events.publish(SessionEvent.FileChange.Recorded, {
        sessionID: parent.id,
        change: { path: RelativePath.make("synthetic-fixture.txt"), patch: "+synthetic\n", additions: 1, deletions: 0 },
      })
      yield* shellFixture(db, parent.id)
      yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.orDie)
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
  await Bun.write(
    path.join(root, "provider-fixture.json"),
    JSON.stringify(
      {
        source: "packages/core/test/fixtures/recordings/session-runner/openai-chat-streams-text.json",
        requests,
        network: "denied",
      },
      null,
      2,
    ),
  )
  await buildMeeting(root)
}

const compactFixture = Effect.fn("Baseline.compaction")(function* (
  db: Database.Interface["db"],
  session: Session.Interface,
  events: EventRuntime.Interface,
  locations: Effect.Success<typeof LocationServiceMap.Service>,
  location: Location.Ref,
  sessionID: Session.ID,
) {
  const ids = [
    SessionMessage.ID.make("msg_baseline_duplicate_first"),
    SessionMessage.ID.make("msg_baseline_duplicate_second"),
  ]
  for (const id of ids)
    yield* session.synthetic({
      id,
      sessionID,
      text: "Duplicate synthetic context",
      description: "Synthetic duplicate",
      resume: false,
    })
  const clock = yield* Clock.Clock
  const now = yield* Clock.currentTimeMillis
  yield* SessionPending.promoteSteers(db, events, sessionID).pipe(
    Effect.provideService(Clock.Clock, {
      currentTimeMillisUnsafe: () => now,
      currentTimeMillis: Effect.succeed(now),
      currentTimeNanosUnsafe: () => BigInt(now) * 1000000n,
      currentTimeNanos: Effect.succeed(BigInt(now) * 1000000n),
      sleep: (duration) => clock.sleep(duration),
    }),
  )
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const duplicates = rows.filter((row) => ids.includes(SessionMessage.ID.make(row.id)))
  if (duplicates.length !== 2) return yield* Effect.die("Synthetic duplicates were not promoted")
  const coveredThrough = { messageID: SessionMessage.ID.make(duplicates[1].id), seq: Event.Seq.make(duplicates[1].seq) }
  const state = yield* SessionLiveState.Service.use((live) => live.load(sessionID)).pipe(
    Effect.provide(locations.get(location)),
  )
  const protectedState = SessionLiveState.toProtectedState(state.sources)
  const items = duplicates.map((row, position) => ({
    kind: "message" as const,
    messageID: SessionMessage.ID.make(row.id),
    position,
    terminalSeq: Event.Seq.make(row.seq),
    inputKind: row.type,
    payload: Schema.decodeUnknownSync(Schema.Json)(row.data),
    tokens: 10,
  }))
  const candidate = ContextManifest.decodeCandidate(
    JSON.stringify({
      schemaVersion: 1,
      baseContextRevision: 0,
      coveredThrough,
      protectedState,
      exclusions: [
        {
          reason: "exact_duplicate",
          target: ContextManifest.selector(items[0]),
          evidence: ContextManifest.selector(items[1]),
        },
      ],
    }),
  )
  const validated = ContextManifest.validate({
    candidate,
    evidence: {
      baseContextRevision: 0,
      coveredThrough,
      protectedState,
      items,
      settlements: [],
      authorities: [],
      resourceAuthorities: [],
      toolResults: [],
      recentTail: [],
      protectedTargets: [],
      providerLinks: [],
    },
  })
  if (!validated.valid) return yield* Effect.die(validated.issues)
  const jobs = yield* SessionCompactionJob.Service
  const admitted = yield* jobs.admit({
    sessionID,
    trigger: "manual",
    requestedThrough: coveredThrough,
    baseContextRevision: 0,
    targetMaxInputTokens: 10000,
    configDigest: "f".repeat(64),
  })
  const claimed = yield* jobs.claim({
    jobID: admitted.id,
    owner: "baseline-owner",
    now: Date.now(),
    expiresAt: Date.now() + 30000,
  })
  if (!claimed) return yield* Effect.die("Synthetic compaction job was not claimed")
  const context = yield* SessionContextState.Service
  yield* context.activate({ sessionID, manifest: validated.manifest, jobID: claimed.id, leaseOwner: "baseline-owner" })
})

const shellFixture = Effect.fn("Baseline.shell")(function* (db: Database.Interface["db"], sessionID: Session.ID) {
  const proc = yield* AppProcess.Service
  const child = Bun.spawn([process.execPath, "-e", "await new Response(Bun.stdin.stream()).text()"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      if (child.exitCode === null && !child.killed) child.kill()
      await child.exited
    }),
  )
  const identity = yield* ShellLedger.identify(proc, child.pid)
  if (!identity) return yield* Effect.die("Unable to identify owned synthetic shell process")
  const id = Shell.ID.make("sh_baseline")
  yield* ShellLedger.record(db, { id, pid: child.pid, started: identity.started, owner: identity })
  yield* ShellLedger.noticeOwed(db, id, sessionID)
  child.kill()
  yield* Effect.promise(() => child.exited)
  yield* ShellLedger.reconcile(db, proc)
})

async function buildMeeting(root: string) {
  const { Database } = await import("bun:sqlite")
  const meeting = new Database(path.join(root, "meeting/meetings.sqlite"), { create: true, strict: true })
  const put = (table: string, value: Record<string, unknown>, extra: Record<string, string | number> = {}) => {
    const columns = {
      id: String(value.id ?? value.meetingID),
      meeting_id: String(value.meetingID),
      ...extra,
      data: JSON.stringify(value),
    }
    const entries =
      table === "meetings" ? Object.entries(columns).filter(([key]) => key !== "meeting_id") : Object.entries(columns)
    meeting
      .query(
        `INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
      )
      .run(...entries.map(([, value]) => value))
  }
  try {
    meeting.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA user_version=1",
    )
    for (const entry of meetingBaseline.schema.filter((entry) => entry.type === "table")) meeting.exec(entry.sql!)
    for (const entry of meetingBaseline.schema.filter((entry) => entry.type === "index" && entry.sql))
      meeting.exec(entry.sql!)
    const now = "2026-01-01T00:00:00.000Z"
    put("meetings", {
      id: "baseline-meeting",
      title: unicode.mixed,
      sessionID: "ses_baseline_root",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    })
    const reference = {
      server: "synthetic-mcp",
      target: "synthetic-doc",
      revision: "revision-1",
      content: unicode.high,
      retrievedAt: now,
    }
    put(
      "segments",
      {
        id: "baseline-segment",
        meetingID: "baseline-meeting",
        sequence: 1,
        source: "remote",
        speakerID: "synthetic-speaker",
        startMs: 0,
        endMs: 1000,
        rawText: unicode.mixed,
        text: unicode.low,
        state: "final",
        model: "synthetic-model",
        createdAt: now,
      },
      { sequence: 1, state: "final", original_text: unicode.low },
    )
    meeting
      .query("INSERT INTO knowledge_references (meeting_id,server,target,data) VALUES (?,?,?,?)")
      .run("baseline-meeting", reference.server, reference.target, JSON.stringify(reference))
    put("findings", {
      id: "baseline-finding",
      meetingID: "baseline-meeting",
      kind: "decision",
      summary: unicode.paired,
      sourceSegmentIds: ["baseline-segment"],
      confidence: 1,
      status: "confirmed",
      createdAt: now,
    })
    put("checkpoints", {
      id: "baseline-checkpoint",
      meetingID: "baseline-meeting",
      throughSequence: 1,
      summary: unicode.high,
      final: true,
      createdAt: now,
      latencyMs: 1,
    })
    put("proposals", {
      id: "baseline-proposal",
      meetingID: "baseline-meeting",
      server: reference.server,
      target: reference.target,
      operation: "replace",
      existingContent: unicode.high,
      suggestedContent: unicode.low,
      explanation: unicode.mixed,
      sourceSegmentIds: ["baseline-segment"],
      references: [reference],
      expectedRevision: "revision-1",
      confidence: 1,
      status: "pending",
      createdAt: now,
    })
    put("plans", {
      meetingID: "baseline-meeting",
      content: unicode.mixed,
      findingIds: ["baseline-finding"],
      sourceSegmentIds: ["baseline-segment"],
      status: "proposed",
      createdAt: now,
    })
    put("approvals", {
      id: "baseline-approval",
      meetingID: "baseline-meeting",
      targetID: "baseline-finding",
      decision: "approve",
      detail: unicode.low,
      createdAt: now,
    })
    put("jobs", {
      id: "baseline-job",
      meetingID: "baseline-meeting",
      kind: "analysis",
      status: "done",
      attempts: 1,
      updatedAt: now,
    })
  } finally {
    meeting.close()
  }
}
