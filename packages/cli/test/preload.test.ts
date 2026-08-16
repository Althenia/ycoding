import { expect, test } from "bun:test"
import path from "node:path"
import { Global } from "@ycoding-ai/core/global"

test("test preload redirects data to its XDG sandbox", () => {
  const root = process.env.YCODING_TEST_XDG_ROOT
  if (!root) throw new Error("YCODING_TEST_XDG_ROOT was not set by the test preload")

  expect(Global.Path.data).toBe(path.join(root, "data", "ycoding"))
})
