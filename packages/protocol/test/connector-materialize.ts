import path from "node:path"
import { connectorProto } from "./connector-contract.js"

const file = Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/connector.proto"))
const expected = connectorProto()
if (process.argv.includes("--update-obligations")) {
  const withoutOwners = (source: string) => source.replace(/domain_obligations: "[^"]*"/g, "")
  if (withoutOwners(await file.text()) !== withoutOwners(expected))
    throw new Error("source-owner update changes frozen declarations")
  await Bun.write(file, expected)
  console.log("updated source owners without changing frozen declarations or structural constraints")
  process.exit(0)
}
if (process.argv.includes("--write-new")) {
  if (await file.exists()) throw new Error("connector.proto already exists; canonical IDs and tags are frozen")
  await Bun.write(file, expected)
  console.log("created canonical connector.proto from the remote contract projection")
  process.exit(0)
}
if ((await file.text()) !== expected)
  throw new Error("connector.proto: source projection differs from canonical declarations")
console.log("connector canonical declarations match the remote contract projection")
