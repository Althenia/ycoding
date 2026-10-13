import path from "node:path"
import { mkdir, readdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { fromBinary, isFieldSet } from "@bufbuild/protobuf"
import { FileDescriptorSetSchema, FieldDescriptorProtoSchema } from "@bufbuild/protobuf/wkt"
import { validateCodecNames } from "./codec-names.js"

const root = path.resolve(import.meta.dir, "../../../..")
const source = path.join(root, "protocol")
if (process.argv[2] === "--check-operations") {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ycoding-descriptors-"))
  try {
    const fixture = path.resolve(process.argv[3]!)
    const run = Bun.spawnSync(
      [
        process.env.PROTOC ?? "/opt/homebrew/bin/protoc",
        `--proto_path=${source}`,
        `--proto_path=${path.dirname(fixture)}`,
        "--include_imports",
        `--descriptor_set_out=${temp}/contract.bin`,
        fixture,
      ],
      { stdout: "inherit", stderr: "inherit" },
    )
    if (run.exitCode !== 0) throw new Error(`protoc exited ${run.exitCode}`)
    const { readOperations, readConstraints } = await import("./operations.js")
    const bytes = new Uint8Array(await Bun.file(`${temp}/contract.bin`).arrayBuffer())
    validateCodecNames(fromBinary(FileDescriptorSetSchema, bytes))
    readOperations(bytes)
    readConstraints(bytes)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  process.exit(0)
}
const output = path.join(root, "packages/protocol/src/generated/v5")
const files = (await readdir(path.join(source, "ycoding/v5"))).filter((file) => file.endsWith(".proto")).sort()
await mkdir(output, { recursive: true })
const temp = await mkdtemp(path.join(os.tmpdir(), "ycoding-descriptors-"))
const run = Bun.spawnSync(
  [
    process.env.PROTOC ?? "/opt/homebrew/bin/protoc",
    `--proto_path=${source}`,
    `--plugin=protoc-gen-es=${path.join(root, "packages/protocol/node_modules/.bin/protoc-gen-es")}`,
    `--es_out=${output}`,
    "--es_opt=target=ts,import_extension=js",
    `--descriptor_set_out=${temp}/contract.bin`,
    "--include_imports",
    ...files.map((file) => `ycoding/v5/${file}`),
  ],
  { cwd: source, stdout: "inherit", stderr: "inherit" },
)
const bytes = run.exitCode === 0 ? new Uint8Array(await Bun.file(`${temp}/contract.bin`).arrayBuffer()) : undefined
await rm(temp, { recursive: true, force: true })
if (!bytes) throw new Error(`protoc exited ${run.exitCode}`)
const digest = new Bun.CryptoHasher("sha256")
for (const file of files) {
  digest.update(`ycoding/v5/${file}\0`)
  digest.update(await Bun.file(path.join(source, "ycoding/v5", file)).arrayBuffer())
}
validateCodecNames(fromBinary(FileDescriptorSetSchema, bytes))
const { readOperations, readConstraints } = await import("./operations.js")
const operations = readOperations(bytes)
const fieldConstraints = readConstraints(bytes)
const set = fromBinary(FileDescriptorSetSchema, bytes)
set.file = set.file.filter((file) => file.package === "ycoding.v5")
const constraints = Object.fromEntries(
  set.file.flatMap((file) =>
    file.enumType
      .filter((item) => ["CollectionLimit", "CodePointLimit", "FieldTextPolicy"].includes(item.name))
      .flatMap((item) => item.value.map((value) => [value.name, value.number])),
  ),
)
const messages = Object.fromEntries(
  set.file.flatMap((file) =>
    file.messageType.map((message) => [
      `${file.package}.${message.name}`,
      {
        oneofs: message.oneofDecl.length,
        fields: message.field.map((field) => ({
          tag: field.number,
          name: field.name,
          type: field.type,
          required: field.label === 2,
          repeated: field.label === 3,
          target: field.typeName?.slice(1),
          group: isFieldSet(field, FieldDescriptorProtoSchema.field.oneofIndex) ? field.oneofIndex : undefined,
          maxCount:
            constraints[
              `${message.name.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter}`).toUpperCase()}_${field.name.toUpperCase()}_MAX_COUNT`
            ],
          maxCodepoints:
            constraints[
              `${message.name.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter}`).toUpperCase()}_${field.name.toUpperCase()}_MAX_CODEPOINTS`
            ],
          textPolicy:
            constraints[
              `${message.name.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter}`).toUpperCase()}_${field.name.toUpperCase()}_TEXT_POLICY`
            ],
          constraints: fieldConstraints[`${file.package}.${message.name}.${field.number}`],
        })),
      },
    ]),
  ),
)
const enums = Object.fromEntries(
  set.file.flatMap((file) =>
    file.enumType.map((item) => [`${file.package}.${item.name}`, item.value.map((value) => value.number)]),
  ),
)
await Bun.write(
  path.join(output, "contract.ts"),
  `export const CONTRACT_DIGEST = ${JSON.stringify(digest.digest("hex"))}\nexport const messages = ${JSON.stringify(messages, null, 2)} as const\nexport const enums = ${JSON.stringify(enums, null, 2)} as const\n`,
)
await Bun.write(
  path.join(output, "operations.ts"),
  `import type { OperationDescriptor, PeerRole } from "./ycoding/v5/foundation_pb.js"\nexport const operations: readonly OperationDescriptor[] = ${JSON.stringify(operations, null, 2)}\nexport const operationIDsByRole: Readonly<Record<PeerRole, readonly number[]>> = ${JSON.stringify(Object.fromEntries(set.file.flatMap((file) => file.enumType.filter((item) => item.name === "PeerRole").flatMap((item) => item.value.map((role) => [role.number, operations.filter((item) => item.roles.includes(role.number!)).map((item) => item.operationId)])))), null, 2)}\n`,
)
const registry = set.file
  .map(
    (file) =>
      `import { ${file.messageType.map((message) => `${message.name}Schema`).join(", ")} } from "./${file.name!.replace(".proto", "_pb.js")}"`,
  )
  .join("\n")
await Bun.write(
  path.join(output, "index.ts"),
  files.map((file) => `export * from "./ycoding/v5/${file.replace(".proto", "_pb.js")}"`).join("\n") +
    '\nexport { CONTRACT_DIGEST } from "./contract.js"\n' +
    'export { operations, operationIDsByRole } from "./operations.js"\n' +
    'import type { DescMessage } from "@bufbuild/protobuf"\n' +
    registry +
    `\nexport const schemas: DescMessage[] = []\nschemas.push(${set.file.flatMap((file) => file.messageType.map((message) => `${message.name}Schema`)).join(", ")})\n`,
)
const format = Bun.spawnSync(
  [
    path.join(root, "node_modules/.bin/prettier"),
    "--write",
    "--ignore-path",
    "/dev/null",
    path.join(output, "contract.ts"),
    path.join(output, "index.ts"),
    path.join(output, "operations.ts"),
    ...files.map((file) => path.join(output, "ycoding/v5", file.replace(".proto", "_pb.ts"))),
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
)
if (format.exitCode !== 0) throw new Error(`generated formatting exited ${format.exitCode}`)
