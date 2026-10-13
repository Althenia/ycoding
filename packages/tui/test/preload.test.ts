import { expect, test } from "bun:test"
import path from "path"
import { FrontendPaths } from "../src/frontend-paths"

test("the test preload keeps Global state, data, config, cache and home out of the developer's directories", () => {
  const root = process.env.YCODING_TEST_XDG_ROOT
  if (!root) throw new Error("YCODING_TEST_XDG_ROOT was not set by the test preload")

  expect(FrontendPaths.Path.state).toBe(path.join(root, "state", "ycoding"))
  expect(FrontendPaths.Path.config).toBe(path.join(root, "config", "ycoding"))
  expect(FrontendPaths.Path.cache).toBe(path.join(root, "cache", "ycoding"))
  expect(FrontendPaths.Path.home).toBe(root)
})
