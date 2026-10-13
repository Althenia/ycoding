import path from "node:path"
import { platformProto, sharedProto, platformSharedSet } from "./platform-contract.js"
import { resourceSharedSet } from "./resources-contract.js"
import { frontendBoundaryBaseline } from "./frontend-boundary-baseline.js"

const file = Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/platform.proto"))
const expected = platformProto()
if (process.argv.includes("--move-shared")) {
  const shared = Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/shared.proto"))
  const current = await file.text()
  const declarations = (source: string) =>
    new Map([...source.matchAll(/^(?:message|enum) (\w+) \{[\s\S]*?^\}/gm)].map((match) => [match[1], match[0]]))
  const before = declarations(current)
  const after = declarations(sharedProto())
  const moved = [...platformSharedSet()].filter((name) => !resourceSharedSet().has(name))
  if (current !== platformProto(undefined, false))
    throw new Error("platform.proto does not match frozen declarations before sharing")
  for (const name of moved)
    if (before.get(name) !== after.get(name)) throw new Error(`shared move changed frozen declaration: ${name}`)
  const oldShared = declarations(await shared.text())
  for (const [name, value] of oldShared)
    if (after.get(name) !== value) throw new Error(`shared move changed existing declaration: ${name}`)
  await Bun.write(shared, sharedProto())
  await Bun.write(file, expected)
  console.log(`moved unchanged platform declarations to shared.proto: ${moved.join(", ")}`)
  process.exit(0)
}
if (process.argv.includes("--write-new")) {
  if (await file.exists()) throw new Error("platform.proto already exists; canonical IDs and tags are frozen")
  await Bun.write(file, expected)
  console.log("created canonical platform.proto from the live source projection")
  process.exit(0)
}
if (frontendBoundaryBaseline(await file.text()) !== expected)
  throw new Error(
    "platform.proto: live source projection differs from canonical declarations; IDs and tags must not be rewritten",
  )
console.log("platform canonical declarations match the live source projection")
