import { expect, test } from "bun:test"
import { PublicEventSchema, Shell_InfoSchema } from "@ycoding-ai/protocol/v5"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"

const info = {
  id: "sh_queue",
  status: "queued",
  command: "printf ready",
  cwd: "/workspace",
  shell: "/bin/sh",
  file: "/workspace/output",
  metadata: {},
  queuePosition: 2,
  time: { started: 0, queued: 10 },
}

test("queued shell fields survive the native wire boundary", () => {
  expect(decodeDomain(Shell_InfoSchema.typeName, encodeDomain(Shell_InfoSchema.typeName, info))).toEqual(info)
})

test("queue position changes use a typed ephemeral shell update", () => {
  const event = { id: "evt_shell", created: 11, type: "shell.updated", data: { info } }
  expect(decodeDomain(PublicEventSchema.typeName, encodeDomain(PublicEventSchema.typeName, event))).toEqual(event)
})

test("queued positions reject zero rather than accepting an invalid admission position", () => {
  expect(() => encodeDomain(Shell_InfoSchema.typeName, { ...info, status: "running", queuePosition: 0 })).toThrow()
})
