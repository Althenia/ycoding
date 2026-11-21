import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  applySessionEvent,
  readPendingInputs,
  readProjectedMessage,
  readSnapshot,
  type SessionView,
} from "../../../../apps/web/src/remote/projection"
import { readWireMessage } from "../../../../apps/web/src/remote/wire"
import { deltaChunk, finishChunk } from "../../../../packages/ai/test/lib/openai-chunks"
import {
  decodeStrict,
  FrameSchema,
  remotePayloadCodecs,
  type TypedPayload,
} from "../../../../packages/remote/src/index"
import { startRustRuntime } from "./rust-runtime"
import { openWeb, runtimeBinding } from "./versioned-relay-native"
import { registration, type Check } from "./versioned-relay-peers"
import { eventually, record } from "./versioned-relay-worker"

const model = { providerID: "relay-message-actions", id: "loopback-model" }
const deleteOperation = "session.message.delete"
const deleteOperationID = 4112
const deleteRefusalType = "ycoding.v5.MessageDeleteRefusedError"
const answer = "Native message-action fixture reply."
const sessions = {
  pending: "ses_relay_pending_actions",
  unread: "ses_relay_delete_unread",
  read: "ses_relay_delete_read",
  stale: "ses_relay_delete_stale",
  notOwned: "ses_relay_delete_not_owned",
}

function field(value: unknown, name: string): unknown {
  return record(value) ? value[name] : undefined
}

function inputEvent(event: unknown, type: string, sessionID: string, messageID: string) {
  const data = field(event, "data")
  const inputs = field(data, "inputIDs")
  return (
    field(event, "type") === type &&
    field(data, "sessionID") === sessionID &&
    (field(data, "inputID") === messageID || (Array.isArray(inputs) && inputs.includes(messageID)))
  )
}

function sequence(event: unknown, sessionID: string) {
  const durable = field(event, "durable")
  assert.equal(field(durable, "aggregateID"), sessionID)
  assert.equal(field(durable, "version"), 1)
  const seq = field(durable, "seq")
  assert.ok(typeof seq === "number" && Number.isSafeInteger(seq))
  return seq
}

export async function checkMessageActions(root: string, origin: string, cookie: string, check: Check) {
  const binding = runtimeBinding()
  const workspace = join(root, "workspace")
  const config = join(root, "fixture-config")
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(config, { recursive: true })])
  const gates = new Map<string, { arrived: boolean; wait: Promise<void> }>()
  const response = [deltaChunk({ role: "assistant", content: answer }), finishChunk("stop")]
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join("")
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST")
        return new Response(null, { status: 404 })
      const input: unknown = await request.json()
      if (!record(input) || input.model !== model.id || input.stream !== true || !Array.isArray(input.messages))
        return new Response(null, { status: 400 })
      const lastUser: unknown = input.messages.findLast((message: unknown) => field(message, "role") === "user")
      const prompt = JSON.stringify(field(lastUser, "content")) ?? ""
      for (const [marker, gate] of gates) {
        if (!prompt.includes(marker)) continue
        gate.arrived = true
        await gate.wait
        break
      }
      return new Response(`${response}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    await Bun.write(join(config, "models.json"), "{}")
    await Bun.write(
      join(config, "ycoding.json"),
      JSON.stringify({
        model: `${model.providerID}/${model.id}`,
        efficiency: { title: "off" },
        providers: {
          [model.providerID]: {
            name: "Loopback message actions",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { baseURL: `${provider.url.origin}/v1`, apiKey: "synthetic" },
            models: {
              [model.id]: {
                name: "Loopback model",
                limit: { context: 100_000, output: 4096 },
                capabilities: { tools: false, input: ["text"], output: ["text"] },
              },
            },
          },
        },
      }),
    )
    const runtime = await startRustRuntime(join(root, "native"), workspace, config, binding)
    try {
      const local = runtime.client
      for (const sessionID of Object.values(sessions)) {
        const created = await local.session.create({
          id: sessionID,
          title: sessionID,
          model,
          location: { directory: workspace },
        })
        assert.equal(created.id, sessionID)
      }
      const enrollment = await registration(origin, cookie)
      const { deviceID } = await local.remote.enroll({
        ...enrollment,
        relayOrigin: origin,
        name: "Native message actions",
      })
      await local.remote.set({ enabled: true })
      await eventually("Native message-action connector ready", async () => {
        const status = await local.remote.get()
        assert.notEqual(status.state, "error", status.message)
        return status.state === "on" ? true : undefined
      })

      const session = (sessionID: string) => {
        const events: unknown[] = []
        const deleteRejections: TypedPayload[] = []
        const socket = openWeb(
          origin,
          cookie,
          deviceID,
          (eventSessionID, batch) => {
            if (eventSessionID === sessionID) events.push(...batch)
          },
          (websocket) =>
            websocket.addEventListener("message", (event) => {
              if (!(event.data instanceof ArrayBuffer)) return
              const { body } = decodeStrict(FrameSchema, new Uint8Array(event.data))
              if (body.case !== "result" || body.value.operationId !== deleteOperationID) return
              if (body.value.outcome.case === "error") deleteRejections.push(body.value.outcome.value)
            }),
        )
        const release = new Set<() => void>()
        const request = (operation: string, input?: Readonly<Record<string, unknown>>) =>
          socket.request(operation, { sessionID, input })
        const read = async (operation: string, input?: Readonly<Record<string, unknown>>) => {
          const result = await request(operation, input)
          assert.equal(result.status, "ok", `${operation}: ${JSON.stringify(result)}, ${socket.diagnostics()}`)
          return result.value
        }
        const snapshot = async () => {
          const view = readSnapshot(field(await read("session.snapshot"), "data"))
          assert.ok(view, "Native snapshot did not produce a Web transcript")
          assert.equal(view.sessionID, sessionID)
          return view
        }
        const pending = async () => {
          const items = readPendingInputs(await read("session.pending.list"), sessionID)
          assert.ok(items)
          return items.map((item) => {
            assert.equal(item.kind, "user")
            return [item.id, item.delivery]
          })
        }
        const prompt = async (id: string, text: string, delivery: "steer" | "queue", resume: boolean) => {
          assert.equal(field(field(await read("session.prompt", { id, text, delivery, resume }), "data"), "id"), id)
        }
        const hold = async (messageID: string) => {
          const marker = `Synthetic input ${messageID}`
          const barrier = Promise.withResolvers<void>()
          const gate = { arrived: false, wait: barrier.promise }
          gates.set(marker, gate)
          const resume = () => {
            gates.delete(marker)
            barrier.resolve()
          }
          release.add(resume)
          await prompt(messageID, marker, "steer", true)
          await eventually(`Provider reached ${messageID} before emitting a frame`, () =>
            gate.arrived ? true : undefined,
          )
          return resume
        }
        const message = async (messageID: string, state: "promoted" | "consumed") => {
          const value = field(await read("session.message", { messageID }), "data")
          const projected = readProjectedMessage(value)
          assert.equal(field(field(value, "metadata"), "inputOrigin"), "direct")
          assert.equal(projected?.id, messageID)
          assert.equal(projected.kind, "user")
          assert.equal(projected.owned, true)
          assert.equal(projected.state, state)
          return projected
        }
        const durableLog = async () => {
          const [remote, localLog] = await Promise.all([
            read("session.log", { follow: false }),
            (async () => {
              const entries: unknown[] = []
              for await (const entry of local.session.log({ sessionID, follow: false })) entries.push(entry)
              return entries
            })(),
          ])
          const watermark = field(remote, "watermark")
          assert.ok(typeof watermark === "number" && Number.isSafeInteger(watermark), "Web log did not synchronize")
          return { watermark, entries: localLog }
        }
        const observe = async (type: string, messageID: string) => {
          const event = await eventually(`${type} for ${messageID} in live Web events`, () =>
            events.find((item) => inputEvent(item, type, sessionID, messageID)),
          )
          const seq = sequence(event, sessionID)
          const { watermark, entries } = await durableLog()
          assert.ok(watermark >= seq, "Web log did not reach the live event")
          const matching = entries.filter((item) => inputEvent(item, type, sessionID, messageID))
          assert.equal(matching.length, 1)
          assert.equal(sequence(matching[0], sessionID), seq)
          return { event, seq }
        }
        const remove = async (messageID: string) => {
          const codec = remotePayloadCodecs.get("session.deleteMessage")
          assert.equal(codec?.operation.operationId, deleteOperationID, "Native delete must be operation 4112")
          return request(deleteOperation, { messageID })
        }
        const refuse = async (messageID: string, code: "message_read" | "message_not_owned") => {
          const prior = deleteRejections.length
          const outcome = await remove(messageID)
          assert.equal(outcome.status, "failed", JSON.stringify(outcome))
          assert.equal(outcome.error.code, code)
          assert.equal(deleteRejections.length, prior + 1)
          const refusal = deleteRejections[prior]
          assert.ok(refusal)
          assert.equal(refusal.typeName, deleteRefusalType)
          const codec = remotePayloadCodecs.get("session.deleteMessage")?.errors.get(deleteRefusalType)
          assert.ok(codec, "Native delete refusal codec is missing")
          const reason = code === "message_read" ? "read" : "not_owned"
          const typed = readWireMessage(codec.schema, codec.decode(refusal.payload))
          assert.equal(field(typed, "messageID"), messageID)
          assert.equal(field(typed, "sessionID"), sessionID)
          assert.equal(field(typed, "reason"), reason)
          const { entries } = await durableLog()
          assert.equal(
            entries.some((item) => inputEvent(item, "session.input.deleted", sessionID, messageID)),
            false,
          )
        }
        return { socket, release, read, request, snapshot, pending, prompt, hold, message, observe, remove, refuse }
      }
      const run = (label: string, sessionID: string, test: (fixture: ReturnType<typeof session>) => Promise<void>) =>
        check(label, async () => {
          const fixture = session(sessionID)
          try {
            await eventually("Web v5 message actions ready", () =>
              fixture.socket.status().kind === "open" ? true : undefined,
            )
            const subscription = fixture.read("event.subscribe")
            await Promise.all([subscription, fixture.snapshot()])
            await test(fixture)
            assert.equal(fixture.socket.opened(), 1, "The Web client had to reconnect during the message action")
          } finally {
            for (const resume of fixture.release) resume()
            fixture.socket.close()
          }
        })

      await run(
        "v5 Web steers and withdraws distinct pending messages without changing the other entries",
        sessions.pending,
        async (fixture) => {
          await fixture.hold("msg_pending_provider_barrier")
          const steer = "msg_pending_steer"
          const remove = "msg_pending_withdraw"
          const keep = "msg_pending_survivor"
          for (const id of [steer, remove, keep]) await fixture.prompt(id, `Queued input ${id}`, "queue", false)
          assert.deepEqual(await fixture.pending(), [
            [steer, "queue"],
            [remove, "queue"],
            [keep, "queue"],
          ])
          await fixture.read("session.pending.steer", { messageID: steer })
          assert.deepEqual(await fixture.pending(), [
            [steer, "steer"],
            [remove, "queue"],
            [keep, "queue"],
          ])
          await fixture.observe("session.input.steered", steer)
          await fixture.read("session.pending.remove", { messageID: remove })
          assert.deepEqual(await fixture.pending(), [
            [steer, "steer"],
            [keep, "queue"],
          ])
          await fixture.observe("session.input.withdrawn", remove)
        },
      )
      await run(
        "v5 Web deletes an unread direct message from the live and durable transcript",
        sessions.unread,
        async (fixture) => {
          const survivor = "msg_unread_survivor"
          const target = "msg_unread_delete"
          await fixture.prompt(survivor, "Keep this sent prompt", "steer", true)
          await fixture.observe("session.input.consumed", survivor)
          await fixture.hold(target)
          await fixture.message(target, "promoted")
          const before = await fixture.snapshot()
          assert.ok(before.messages.some((item) => item.id === target))
          assert.ok(before.messages.some((item) => item.id === survivor))
          const outcome = await fixture.remove(target)
          assert.equal(outcome.status, "ok", JSON.stringify(outcome))
          const { event, seq } = await fixture.observe("session.input.deleted", target)
          const live: SessionView = {
            id: sessions.unread,
            status: "running",
            messages: before.messages,
            requests: [],
            unhandledEvents: 0,
          }
          const projected = applySessionEvent(live, event, Date.now())
          const after = await fixture.snapshot()
          const expected = before.messages.map((item) => item.id).filter((id) => id !== target)
          assert.deepEqual(
            projected.messages.map((item) => item.id),
            expected,
          )
          assert.deepEqual(
            after.messages.map((item) => item.id),
            expected,
          )
          assert.ok(after.watermark !== undefined && after.watermark >= seq)
          const missing = await fixture.request("session.message", { messageID: target })
          assert.equal(missing.status, "failed", JSON.stringify(missing))
          assert.equal(missing.error.code, "not_found")
        },
      )
      await run(
        "v5 Web refuses to delete a direct message already read by the runtime",
        sessions.read,
        async (fixture) => {
          const target = "msg_already_read"
          await fixture.prompt(target, "Read this prompt before delete", "steer", true)
          await fixture.observe("session.input.consumed", target)
          const before = await fixture.message(target, "consumed")
          await fixture.refuse(target, "message_read")
          assert.deepEqual(await fixture.message(target, "consumed"), before)
          assert.deepEqual(
            (await fixture.snapshot()).messages.find((message) => message.id === target),
            before,
          )
        },
      )
      await run(
        "v5 Web refuses a stale delete after the runtime consumes the message shown as unread",
        sessions.stale,
        async (fixture) => {
          const resume = await fixture.hold("msg_stale_delete_menu")
          const menuMessage = await fixture.message("msg_stale_delete_menu", "promoted")
          resume()
          await fixture.observe("session.input.consumed", menuMessage.id)
          const consumed = await fixture.message(menuMessage.id, "consumed")
          await fixture.refuse(menuMessage.id, "message_read")
          assert.deepEqual(await fixture.message(menuMessage.id, "consumed"), consumed)
          assert.deepEqual(
            (await fixture.snapshot()).messages.find((message) => message.id === menuMessage.id),
            consumed,
          )
        },
      )
      await run("v5 Web refuses to delete a message the user did not author", sessions.notOwned, async (fixture) => {
        const user = "msg_agent_reply_prompt"
        await fixture.prompt(user, "Produce a model reply I do not own", "steer", true)
        await fixture.observe("session.input.consumed", user)
        const assistant = await eventually("Completed model reply in Web transcript", async () =>
          (await fixture.snapshot()).messages.find(
            (message) => message.kind === "assistant" && message.completed !== undefined,
          ),
        )
        await fixture.refuse(assistant.id, "message_not_owned")
        const snapshot = await fixture.snapshot()
        assert.ok(snapshot.messages.some((message) => message.id === user))
        assert.deepEqual(
          snapshot.messages.find((message) => message.id === assistant.id),
          assistant,
        )
      })
    } finally {
      await runtime.close()
    }
  } finally {
    await provider.stop(true)
  }
}
