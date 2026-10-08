import { expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { LLM, Message } from "@ycoding-ai/ai"
import { LLMClient, RequestExecutor } from "@ycoding-ai/ai/route"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { CatalogModel } from "@ycoding-ai/core/model"
import { CursorModels } from "@ycoding-ai/core/cursor/models"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionModelHeaders } from "@ycoding-ai/core/session/model-headers"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Project } from "@ycoding-ai/core/project"
import { decodeMessage, encodeMessage } from "../../src/cursor/provider/protocol/messages"
import { buildSeedConversationState } from "../../src/cursor/provider/protocol/request"
import { writeCache } from "../../src/cursor/provider/models"
import { MODEL_CACHE_SCHEMA_VERSION } from "../../src/cursor/provider/shared"
import { sessionManager } from "../../src/cursor/provider/session"
import type { BidiStream } from "../../src/cursor/provider/transport/connect"

type Captured = {
  token: string
  request: {
    conversation_id: string
    conversation_state: Uint8Array
    requested_model: { model_id: string; parameters: { id: string; value: string }[] }
  }
}
const captured: Captured[] = []
const checkpoint = buildSeedConversationState({ systemPrompt: "fixture-private-Work-checkpoint" })
const transport = await import("../../src/cursor/provider/transport/connect")
void mock.module("../../src/cursor/provider/transport/connect", () => ({
  ...transport,
  bidiRunStream: async (token: string): Promise<BidiStream> => {
    let closed = false
    return {
      write: (bytes) => {
        const message = decodeMessage<{ run_request?: Captured["request"] }>("AgentClientMessage", bytes)
        if (message.run_request) captured.push({ token, request: message.run_request })
        return true
      },
      end: () => {
        closed = true
      },
      destroy: () => {
        closed = true
      },
      isClosed: () => closed,
      onTerminal: () => () => {},
      frames: async function* () {
        yield {
          flags: 0,
          payload: encodeMessage("AgentServerMessage", {
            interaction_update: { text_delta: { text: "The fixture work is complete with a verified result." } },
          }),
        }
        if (token === "fixture-work-token")
          yield {
            flags: 0,
            payload: encodeMessage("AgentServerMessage", { conversation_checkpoint_update: checkpoint }),
          }
        yield {
          flags: 0,
          payload: encodeMessage("AgentServerMessage", {
            interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } },
          }),
        }
      },
    }
  },
}))

test("captures native Cursor profile auth, account-specific variant inventory and opaque conversation namespaces", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-cursor-profile-"))
  const { createCursor } = await import("../../src/cursor/provider")
  const session = { id: SessionSchema.ID.make("ses_cursor_profile_wire"), projectID: Project.ID.global }
  const profiles = ["Work", "Personal"].map(
    (label) =>
      new Credential.Info({
        id: Credential.ID.make(`cred_cursor_${label}`),
        integrationID: Integration.ID.make("cursor"),
        label,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("browser"),
          access: label === "Work" ? "fixture-work-token" : "fixture-personal-token",
          refresh: "fixture",
          expires: Number.MAX_SAFE_INTEGER,
        }),
      }),
  )
  try {
    await Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      yield* aisdk.hook.sdk((event) => {
        if (!event.snapshot?.credential) return Effect.die(new Error("Expected captured profile snapshot"))
        event.sdk = createCursor({
          name: "cursor",
          apiKey: event.options.apiKey,
          cacheDir: path.join(directory, event.snapshot.credential.label),
          workspaceRoot: directory,
          agentBaseURL: "https://agent.fixture.cursor.sh",
          retry: { maxAttempts: 1 },
        })
      })
      const models = yield* Effect.forEach(profiles, (credential, index) =>
        Effect.gen(function* () {
          const effort = index === 0 ? "high" : "low"
          const inventory = [
            {
              id: "composer-fixture",
              variants: [
                {
                  key: effort,
                  displayName: effort,
                  isDefaultNonMax: true,
                  isDefaultMax: false,
                  parameterValues: [{ id: "effort", value: effort }],
                },
              ],
            },
          ]
          yield* Effect.promise(() =>
            writeCache(path.join(directory, credential.label), {
              models: inventory,
              fetchedAt: Date.now(),
              schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
            }),
          )
          const info = CursorModels.fromCursor(inventory)[0]!
          const selected = yield* SessionRunnerModel.withVariant(info, CatalogModel.VariantID.make(effort))
          return yield* SessionRunnerModel.fromCatalogModel(
            selected,
            credential.value,
            { loadAISDK: aisdk.model },
            undefined,
            {
              connection: { type: "credential", id: credential.id, label: credential.label, active: false },
              credential,
              value: credential.value,
            },
          )
        }),
      )
      const request = (index: number, followup = false) =>
        LLM.request({
          model: models[index]!,
          messages: [
            Message.user("Hello"),
            ...(followup
              ? [Message.assistant("The fixture work is complete with a verified result."), Message.user("Follow up")]
              : []),
          ],
          tools: [
            {
              name: "read",
              description: "Read a file",
              inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          ],
          http: {
            headers: SessionModelHeaders.make(session, {
              accountIdentityDigest: SessionRunnerModel.accountIdentityDigest(profiles[index]!),
            }),
          },
        })
      yield* Effect.all([LLMClient.generate(request(0)), LLMClient.generate(request(1))], { concurrency: "unbounded" })
      yield* LLMClient.generate(request(0, true))
    }).pipe(
      Effect.provide(AISDK.locationLayer),
      Effect.provide(LLMClient.configured()),
      Effect.provideService(RequestExecutor.Service, { execute: () => Effect.die("Unexpected external HTTP request") }),
      Effect.scoped,
      Effect.runPromise,
    )
    expect(captured).toHaveLength(3)
    const work = captured.filter((item) => item.token === "fixture-work-token")
    const personal = captured.filter((item) => item.token === "fixture-personal-token")
    expect(work).toHaveLength(2)
    expect(personal).toHaveLength(1)
    expect(work.map((item) => item.request.requested_model.parameters)).toEqual([
      [{ id: "effort", value: "high" }],
      [{ id: "effort", value: "high" }],
    ])
    expect(personal[0]!.request.requested_model.parameters).toEqual([{ id: "effort", value: "low" }])
    expect(work[0]!.request.conversation_id).not.toBe(personal[0]!.request.conversation_id)
    expect(work[0]!.request.conversation_id).toBe(work[1]!.request.conversation_id)
    expect(Buffer.from(personal[0]!.request.conversation_state).equals(Buffer.from(checkpoint))).toBe(false)
    expect(Buffer.from(work[1]!.request.conversation_state)).toEqual(Buffer.from(checkpoint))
    expect(JSON.stringify(captured.map((item) => item.request))).not.toContain("cred_cursor_")
  } finally {
    sessionManager.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
