import { expect, test } from "bun:test"
import path from "path"
import { Global } from "@ycoding-ai/core/global"

test("the test preload keeps Global state, data, config, cache and home out of the developer's directories", () => {
  const root = process.env.YCODING_TEST_XDG_ROOT
  if (!root) throw new Error("YCODING_TEST_XDG_ROOT was not set by the test preload")

  expect(Global.Path.state).toBe(path.join(root, "state", "ycoding"))
  expect(Global.Path.data).toBe(path.join(root, "data", "ycoding"))
  expect(Global.Path.config).toBe(path.join(root, "config", "ycoding"))
  expect(Global.Path.cache).toBe(path.join(root, "cache", "ycoding"))
  expect(Global.Path.home).toBe(root)
})
