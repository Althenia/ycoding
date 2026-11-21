import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { make } from "../src/v5/index.js"
import { Service } from "../src/promise/service.js"
import { fixture } from "../../../rust/crates/runtime/tests/support/launcher-client"

test("Rust global Forms settle only in their Location and owner, including after reconnect", async () => {
  const binary = process.env.YCODING_TEST_RUST_RUNTIME
  if (!binary) throw new Error("YCODING_TEST_RUST_RUNTIME must name the built Rust runtime")
  const runtime = await fixture(binary)
  try {
    const endpoint = await Service.ensure({ file: runtime.file, command: runtime.command("global-forms-v5") })
    const directory = path.join(runtime.configDir, "forms one ไทย")
    const other = path.join(runtime.configDir, "forms two")
    await Promise.all([mkdir(directory), mkdir(other)])
    const client = make({ endpoint, location: { directory: other } })
    const options = { headers: { "x-ycoding-directory": encodeURIComponent(directory) } }
    try {
      await Promise.all([
        client.location.get({ location: { directory } }),
        client.location.get({ location: { directory: other } }),
      ])
      const form = await client.form.create(
        { sessionID: "global", title: "Global reply", fields: [{ key: "ok", type: "boolean", required: true }] },
        options,
      )
      const target = { sessionID: "global", formID: form.id }
      expect((await client.form.list({ sessionID: "global" }, options)).map((item) => item.id)).toEqual([form.id])
      expect(await client.form.list({ sessionID: "global" })).toEqual([])
      await expect(client.form.reply({ ...target, answer: { ok: true } })).rejects.toMatchObject({
        _tag: "FormNotFoundError",
      })
      const session = await client.session.create({ location: { directory } })
      await expect(
        client.form.reply({ ...target, sessionID: session.id, answer: { ok: true } }, options),
      ).rejects.toMatchObject({ _tag: "FormNotFoundError" })
      const owned = await client.form.create({
        sessionID: session.id,
        title: "Session owned",
        fields: [{ key: "ok", type: "boolean" }],
      })
      await expect(
        client.form.reply({ sessionID: "global", formID: owned.id, answer: { ok: true } }, options),
      ).rejects.toMatchObject({ _tag: "FormNotFoundError" })
      expect(await client.form.state(target, options)).toMatchObject({ status: "pending" })
      await client.transport.reconnect()
      expect(await client.form.get(target, options)).toMatchObject({ id: form.id, sessionID: "global" })
      await client.form.reply({ ...target, answer: { ok: true } }, options)
      expect(await client.form.state(target, options)).toMatchObject({ status: "answered", answer: { ok: true } })
      expect(await client.form.list({ sessionID: "global" }, options)).toEqual([])
      const cancelled = await client.form.create(
        { sessionID: "global", title: "Global cancel", fields: [{ key: "ok", type: "boolean" }] },
        options,
      )
      await client.form.cancel({ sessionID: "global", formID: cancelled.id }, options)
      expect(await client.form.state({ sessionID: "global", formID: cancelled.id }, options)).toMatchObject({
        status: "cancelled",
      })
      expect(await client.form.list({ sessionID: "global" }, options)).toEqual([])
      expect(await client.form.state({ sessionID: session.id, formID: owned.id })).toMatchObject({ status: "pending" })
    } finally {
      client.transport.close()
    }
  } finally {
    await runtime.dispose()
  }
}, 120_000)
