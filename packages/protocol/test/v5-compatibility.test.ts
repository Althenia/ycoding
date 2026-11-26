import { expect, test } from "bun:test"
import { fromBinary, isFieldSet } from "@bufbuild/protobuf"
import { FieldDescriptorProtoSchema, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { WireLimit } from "../src/generated/v5/index.js"
import { readOperations } from "../src/v5/operations.js"

function contractRows() {
  const source = path.resolve(import.meta.dir, "../../../protocol")
  const files = readdirSync(path.join(source, "ycoding/v5"))
    .filter((name) => name.endsWith(".proto"))
    .map((name) => `ycoding/v5/${name}`)
  const temporary = mkdtempSync(path.join(tmpdir(), "ycoding-v5-protocol-"))
  const output = path.join(temporary, "contract.pb")
  const bytes = (() => {
    try {
      const result = Bun.spawnSync(
        [process.env.PROTOC ?? "protoc", "-I", source, "--include_imports", `--descriptor_set_out=${output}`, ...files],
        { cwd: source },
      )
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return readFileSync(output)
    } finally {
      rmSync(temporary, { recursive: true })
    }
  })()
  const set = fromBinary(FileDescriptorSetSchema, bytes)
  return Object.fromEntries(
    [
      ...readOperations(bytes).map(
        (op) =>
          [
            `operation ${op.diagnosticName}`,
            [`${op.operationId}:${op.requestType}:${op.resultType}`, ...op.errorTypes].sort(),
          ] as const,
      ),
      ...set.file
        .filter((file) => file.package === "ycoding.v5")
        .flatMap((file) => [
          ...file.messageType.map(
            (message) =>
              [
                `message ${message.name}`,
                message.field
                  .map((field) => {
                    const group = isFieldSet(field, FieldDescriptorProtoSchema.field.oneofIndex)
                      ? message.oneofDecl[field.oneofIndex]?.name
                      : undefined
                    return `${field.number}:${field.name}:${field.label}:${field.typeName ?? field.type}:${group ?? ""}`
                  })
                  .sort(),
              ] as const,
          ),
          ...file.enumType.map(
            (enumeration) =>
              [
                `enum ${enumeration.name}`,
                enumeration.value.map((variant) => `${variant.number}:${variant.name}`).sort(),
              ] as const,
          ),
        ]),
    ].sort(([left], [right]) => left.localeCompare(right)),
  )
}

test("the v5 compatibility snapshot retains operations, fields and variants at the same revision", async () => {
  const [revision, ...rows] = (await Bun.file(path.join(import.meta.dir, "fixtures/v5-compatibility.txt")).text())
    .trimEnd()
    .split("\n")
  if (Number(revision) !== Number(WireLimit.REVISION)) {
    expect(WireLimit.REVISION).toBeGreaterThan(Number(revision))
    return
  }
  const current = contractRows()
  const incompatible = rows.flatMap((row) => {
    const [name, ...baseline] = row.split("\t")
    const fields = current[name]
    if (!fields) return [name]
    return [
      ...baseline.filter((entry) => !fields.includes(entry)).map((entry) => `${name}: missing ${entry}`),
      ...fields
        .filter((entry) => name.startsWith("message ") && entry.split(":")[2] === "2" && !baseline.includes(entry))
        .map((entry) => `${name}: added required field ${entry}`),
    ]
  })
  expect(incompatible).toEqual([])
})
