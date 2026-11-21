import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { make } from "../src/v5/index.js"
import { Service } from "../src/promise/service.js"
import { fixture } from "../../../rust/crates/runtime/tests/support/launcher-client"

test("returning a real event subscription preserves inline and typed-bulk skill snapshots", async () => {
  const binary = process.env.YCODING_TEST_RUST_RUNTIME
  if (!binary) throw new Error("YCODING_TEST_RUST_RUNTIME must name the built Rust runtime")
  const runtime = await fixture(binary)
  const content = "Preserve skill snapshot bytes and subscription ownership.\n".repeat(2000)
  try {
    await mkdir(path.join(runtime.configDir, "skills"))
    await writeFile(
      path.join(runtime.configDir, "skills/snapshot-audit.md"),
      `---\nname: Snapshot audit\nmetadata:\n  ycoding/autoinvoke: false\n---\n${content}`,
    )
    const endpoint = await Service.ensure({ file: runtime.file, command: runtime.command("snapshot-v5") })
    const client = make({ endpoint, location: { directory: runtime.configDir } })
    try {
      const session = await client.session.create({ location: { directory: runtime.configDir } })
      const epoch = client.transport.connectionEpoch
      const empty = client.event.subscribe()[Symbol.asyncIterator]()
      await empty.next()
      await empty.return?.()
      expect((await client.session.snapshot({ sessionID: session.id })).messages).toEqual([])
      await client.session.skill({ sessionID: session.id, skill: "snapshot-audit", resume: false })
      for (let repeat = 0; repeat < 3; repeat++) {
        const events = client.event.subscribe()[Symbol.asyncIterator]()
        expect((await events.next()).value).toMatchObject({ type: "server.connected" })
        await events.return?.()
        const snapshot = await client.session.snapshot({ sessionID: session.id })
        const skills = snapshot.messages.filter((message) => message.type === "skill")
        expect(skills).toHaveLength(1)
        expect(skills[0]).toMatchObject({ skill: "snapshot-audit", name: "Snapshot audit" })
        expect(skills[0].text).toContain(content.trimEnd())
        expect(skills[0].text.length).toBeGreaterThan(65536)
        expect((await client.health.get()).healthy).toBe(true)
        expect(client.transport.connectionEpoch).toBe(epoch)
        expect(client.transport.state).toBe("established")
      }
    } finally {
      client.transport.close()
      expect(client.transport.retainedBytes).toBe(0)
    }
  } finally {
    await runtime.dispose()
  }
}, 120_000)
