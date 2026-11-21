import { expect, test } from "bun:test"
import path from "node:path"
import { readdir } from "node:fs/promises"
import { CONTRACT_DIGEST, PeerRole, operations } from "../src/v5/index.js"
import { Connection } from "../src/v5/connection/index.js"
import { receive } from "./connection-fixtures.js"

const root = path.resolve(import.meta.dir, "../../..")
const previousDigest = "03ed82fc9cc1926cab3a2a448f0d45c96fb514cf0fd00880e846f2fea19b6054"

test("M7 digest hashes sorted canonical files and rejects the prior role contract", async () => {
  const source = path.join(root, "protocol/ycoding/v5")
  const digest = new Bun.CryptoHasher("sha256")
  for (const file of (await readdir(source)).filter((file) => file.endsWith(".proto")).sort()) {
    digest.update(`ycoding/v5/${file}\0`)
    digest.update(await Bun.file(path.join(source, file)).arrayBuffer())
  }
  expect(CONTRACT_DIGEST).toBe(digest.digest("hex"))
  expect(CONTRACT_DIGEST).not.toBe(previousDigest)
  const client = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: [],
    now: 0,
  })
  const server = new Connection({
    role: PeerRole.SERVER,
    peer: PeerRole.LOCAL_CLIENT,
    operations,
    eventTypes: [],
    epoch: "epoch",
    sourceEpoch: "source",
    now: 0,
  })
  client.start(0)
  const hello = client.prepareHandoff()!.frame
  if (hello.body.case !== "hello") throw new Error("Hello missing")
  hello.body.value.contractDigest = new Uint8Array(Buffer.from(previousDigest, "hex"))
  const decisions = receive(server, hello)
  expect(decisions).toContainEqual(expect.objectContaining({ type: "closed", code: 1008 }))
  expect(decisions.some((decision) => decision.type === "dispatch")).toBe(false)
})

test("M7 Protocol and Client owner generation reproduces the checked-in files", async () => {
  const files = await Promise.all(
    ["packages/protocol/src/generated/v5", "packages/client/src/v5/generated"].map(async (directory) =>
      (await readdir(path.join(root, directory), { recursive: true }))
        .filter((file) => file.endsWith(".ts"))
        .map((file) => path.join(directory, file)),
    ),
  )
  const before = await Promise.all(
    files
      .flat()
      .sort()
      .map(async (file) => [file, Bun.hash(await Bun.file(path.join(root, file)).arrayBuffer())]),
  )
  for (const directory of ["packages/protocol", "packages/client"]) {
    const generated = Bun.spawnSync(["bun", "run", "--cwd", directory, "generate:v5"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    })
    expect(generated.exitCode, generated.stderr.toString()).toBe(0)
  }
  const afterFiles = await Promise.all(
    ["packages/protocol/src/generated/v5", "packages/client/src/v5/generated"].map(async (directory) =>
      (await readdir(path.join(root, directory), { recursive: true }))
        .filter((file) => file.endsWith(".ts"))
        .map((file) => path.join(directory, file)),
    ),
  )
  const after = await Promise.all(
    afterFiles
      .flat()
      .sort()
      .map(async (file) => [file, Bun.hash(await Bun.file(path.join(root, file)).arrayBuffer())]),
  )
  expect(after).toEqual(before)
}, 240_000)
