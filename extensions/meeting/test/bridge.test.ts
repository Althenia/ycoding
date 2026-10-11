import { expect, test } from "bun:test"
import { sendControl } from "../src/bridge-client"

test("control client refuses external, credential, noncanonical and query-bearing transports before request", async () => {
  for (const url of [
    "https://example.com",
    "http://localhost:1234",
    "http://127.1:1234",
    "http://2130706433:1234",
    "http://127.0.0.1.evil:1234",
    "http://user:pass@127.0.0.1:1234",
    "http://127.0.0.1:1234?token=secret",
    "http://127.0.0.1:1234/control",
    "http://127.0.0.1:1234#fragment",
  ]) {
    await expect(sendControl(url, "test", {})).rejects.toThrow("Invalid bridge URL")
  }
})
