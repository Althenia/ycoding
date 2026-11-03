import { expect, test } from "bun:test"
import { startRelayDouble } from "./relay-double"

test("relay double listens only on IPv4 loopback", async () => {
  const relay = await startRelayDouble()
  try {
    expect((await relay.diagnostics()).listener).toMatchObject({ hostname: "127.0.0.1" })
  } finally {
    await relay.stop()
  }
})
