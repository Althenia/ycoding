import { expect, test } from "bun:test"
import { BUN_BINARY, NODE_BINARY, platformBinary } from "../src/binary"

test("published binaries use the ycoding command name", async () => {
  expect(BUN_BINARY).toBe("ycoding")
  expect(NODE_BINARY).toBe("ycoding-node")
  expect(platformBinary(BUN_BINARY, "darwin")).toBe("ycoding")
  expect(platformBinary(BUN_BINARY, "win32")).toBe("ycoding.exe")
  expect(platformBinary(NODE_BINARY, "win32")).toBe("ycoding-node.exe")

  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json()
  expect(pkg.bin).toEqual({ ycoding: "./bin/ycoding.cjs" })
  const wrappers = [...new Bun.Glob("*.cjs").scanSync(new URL("../bin/", import.meta.url).pathname)]
  expect(wrappers).toEqual(["ycoding.cjs"])
})
