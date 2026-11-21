import { expect, test } from "bun:test"
import { PublicEventSchema, Shell_InfoSchema } from "@ycoding-ai/protocol/v5"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"
const info = {
  id: "sh_process",
  status: "running",
  command: "printf ready",
  cwd: "/workspace",
  shell: "/bin/sh",
  file: "/workspace/output",
  metadata: {},
  time: { started: 10 },
}
test("running shell metadata survives the native wire boundary", () => {
  expect(decodeDomain(Shell_InfoSchema.typeName, encodeDomain(Shell_InfoSchema.typeName, info))).toEqual(info)
})
test("retired queued status and ephemeral queue update are rejected", () => {
  expect(() => encodeDomain(Shell_InfoSchema.typeName, { ...info, status: "queued" })).toThrow()
  expect(() =>
    encodeDomain(PublicEventSchema.typeName, { id: "evt_shell", created: 11, type: "shell.updated", data: { info } }),
  ).toThrow()
})
test("retired scheduler tags cannot be reused", () => {
  expect(Shell_InfoSchema.fields.some((field) => field.number === 12)).toBe(false)
  expect(Shell_InfoSchema.proto.reservedName).toContain("queuePosition")
})
