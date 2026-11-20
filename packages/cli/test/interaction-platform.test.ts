import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtempDisposable, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { packagedInteractionPlatforms } from "../src/interaction-platform"

test.skipIf(process.platform === "win32")("only a packaged macOS executable can mount the adjacent Interaction helper", async () => {
  await using directory = await mkdtempDisposable(path.join(tmpdir(), "ycoding-interaction-package-"))
  const executable = path.join(directory.path, "ycoding")
  const application = path.join(directory.path, "YCoding Interaction.app")
  const helper = path.join(application, "Contents", "MacOS", "ycoding-interaction")
  expect(await packagedInteractionPlatforms("darwin", executable)).toBeUndefined()
  await mkdir(path.dirname(helper), { recursive: true })
  await writeFile(helper, "synthetic package marker", { mode: 0o600 })
  expect(await packagedInteractionPlatforms("darwin", executable)).toBeUndefined()
  await chmod(helper, 0o755)
  expect(await packagedInteractionPlatforms("darwin", executable)).toEqual({
    macOS: { application, certificateSHA1: "9dd524184b0db949ffac7f0ada0ae860ac7f5f85" },
  })
  expect(await packagedInteractionPlatforms("darwin", path.join(directory.path, "ycoding-node"))).toEqual({
    macOS: { application, certificateSHA1: "9dd524184b0db949ffac7f0ada0ae860ac7f5f85" },
  })
  expect(await packagedInteractionPlatforms("darwin", path.join(directory.path, "bun"))).toBeUndefined()
  expect(await packagedInteractionPlatforms("darwin", path.join(directory.path, "node"))).toBeUndefined()
  expect(await packagedInteractionPlatforms("linux", executable)).toBeUndefined()
})
