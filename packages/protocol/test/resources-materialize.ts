import path from "node:path"
import { resourceProto } from "./resources-contract.js"
import { sharedProto } from "./platform-contract.js"
import { frontendBoundaryBaseline } from "./frontend-boundary-baseline.js"

for (const [file, shared] of [
  ["resources.proto", false],
  ["shared.proto", true],
] as const) {
  const actual = await Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5", file)).text()
  if (frontendBoundaryBaseline(actual) !== (shared ? sharedProto() : resourceProto()))
    throw new Error(`${file}: live source projection differs from canonical declarations`)
}
console.log("resource and shared canonical declarations match the live source projection")
