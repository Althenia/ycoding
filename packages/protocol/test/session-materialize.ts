import path from "node:path"
import { sessionProto } from "./session-contract.js"

const file = Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/session.proto"))
const expected = sessionProto()
if (process.argv.includes("--write-new")) {
  if (await file.exists()) throw new Error("session.proto already exists; canonical IDs and tags are frozen")
  await Bun.write(file, expected)
  console.log("created canonical session.proto from the live source projection")
  process.exit(0)
}
if ((await file.text()) !== expected)
  throw new Error(
    "session.proto: live source projection differs from canonical declarations; IDs and tags must not be rewritten",
  )
console.log("session canonical declarations match the live source projection")
