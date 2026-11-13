import { expect, test } from "bun:test"
import { setupWindowSmoke } from "./window-smoke"

test("window smoke refuses to launch without a nonpersistent view", async () => {
  await expect(setupWindowSmoke()).rejects.toThrow("persist:default")
  await expect(setupWindowSmoke()).rejects.toThrow("partition or incognito")
})
