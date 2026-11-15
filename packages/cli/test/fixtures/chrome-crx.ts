import { generateKeyPairSync } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"

export async function chromeCrxFixture(bin: string, version = "1", keys = generateKeyPairSync("rsa", { modulusLength: 2048 })) {
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" })
  const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" })
  for (const name of BrowserExtension.files) {
    const file = path.join(bin, BrowserExtension.directory, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, name === "manifest.json"
      ? JSON.stringify({ manifest_version: 3, name: "Synthetic", version, key: publicKey.toString("base64") })
      : `synthetic ${name} ${version}`)
  }
  await writeFile(path.join(bin, "ycoding"), `synthetic executable ${version}`, { mode: 0o755 })
  return { publicKey, privateKey: Buffer.from(privateKey), keys }
}
