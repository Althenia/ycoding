import path from "node:path"
import { resourceProto } from "../test/resources-contract.js"
import { platformProto, sharedProto } from "../test/platform-contract.js"
import { sessionProto } from "../test/session-contract.js"
import { coordinationProto } from "../test/coordination-contract.js"
import { connectorProto } from "../test/connector-contract.js"
import { publicEventProto } from "../test/public-event-contract.js"

const directory = path.resolve(import.meta.dir, "../../../protocol/ycoding/v5")
const extension = async (file: string, marker: string) => {
  const source = await Bun.file(path.join(directory, file)).text()
  const offset = source.indexOf(marker)
  if (offset < 0) throw new Error(`Missing maintained frontend declarations: ${file}`)
  return source.slice(offset)
}
const [resources, shared, platform] = await Promise.all([
  extension("resources.proto", "enum ConfigurationScope {"),
  extension("shared.proto", "message BackendPaths {"),
  extension("platform.proto", "enum RemoteDeviceCredentialState {"),
])
const outputs = {
  "resources.proto":
    resourceProto().replace(/(message Skill_Info \{\n)/, "$1  optional ConfigurationScope scope = 9;\n") +
    "\n" +
    resources,
  "shared.proto":
    sharedProto().replace(/(message Location_Info \{\n)/, "$1  optional BackendPaths backendPaths = 4;\n") +
    "\n" +
    shared,
  "platform.proto":
    platformProto()
      .replace("last: 3052", "last: 3055")
      .replace(/(message remote_get_Result_data \{\n)/, "$1  optional RemoteDevice device = 3;\n") +
    "\n" +
    platform
      .replace(/^message (?:RemoteMcpStatus|remote_mcp_\w+) \{[\s\S]*?^\}\n*/gm, "")
      .replace(/^  rpc remote_mcp_\w+\([^\n]*\n[\s\S]*?^  \}\n/gm, ""),
  "session.proto": sessionProto(),
  "coordination.proto": coordinationProto(),
  "connector.proto": connectorProto(),
}
for (const [file, source] of Object.entries(outputs)) await Bun.write(path.join(directory, file), source)
await Bun.write(path.join(directory, "events.proto"), publicEventProto())
console.log("Materialized current v5 contracts and preserved maintained frontend declarations")
