import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readOperations, readConstraints } from "../src/v5/operations.js"
import { create, toBinary } from "@bufbuild/protobuf"
import { OperationDescriptorSchema } from "../src/v5/index.js"
import { validateBinary } from "../src/v5/validate.js"

const root = path.resolve(import.meta.dir, "../../..")
const annotation = `option (ycoding.v5.operation) = {
  operation_id: 3000 diagnostic_name: "test.read"
  roles: LOCAL_CLIENT scope: MACHINE mutation: READ settlement: COMPLETED
  paging: UNPAGED streaming: INLINE sensitivity: PRIVATE
};`

for (const [name, methods, range, error] of [
  [
    "duplicate",
    `rpc Read(Empty) returns (Empty) { ${annotation} } rpc Again(Empty) returns (Empty) { ${annotation} }`,
    "3000",
    "duplicate operation ID",
  ],
  ["missing", "rpc Read(Empty) returns (Empty);", "3000", "missing operation annotation"],
  ["range", `rpc Read(Empty) returns (Empty) { ${annotation} }`, "3001", "outside declared range"],
  [
    "unknown",
    `rpc Read(Empty) returns (Empty) { ${annotation.replace("operation_id: 3000", 'operation_id: 3000 error_types: "ycoding.v5.Missing"')} }`,
    "3000",
    "unknown operation type",
  ],
] as const) {
  test(`operation generation rejects ${name}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ycoding-operations-"))
    try {
      await Bun.write(
        path.join(dir, "fixture.proto"),
        `syntax = "proto2"; package ycoding.v5;
import "ycoding/v5/foundation.proto"; import "ycoding/v5/operations.proto";
option (ycoding.v5.operation_range) = { first: ${range} last: 3999 };
service Fixture { ${methods} }`,
      )
      const result = Bun.spawnSync(
        [
          "bun",
          "run",
          path.join(root, "packages/protocol/src/v5/generate.ts"),
          "--check-operations",
          path.join(dir, "fixture.proto"),
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      )
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain(error)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test("canonical descriptor and structural metadata are extracted from protoc", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ycoding-operations-"))
  try {
    await Bun.write(
      path.join(dir, "fixture.proto"),
      `syntax = "proto2"; package ycoding.v5;
import "ycoding/v5/foundation.proto"; import "ycoding/v5/operations.proto";
option (ycoding.v5.operation_range) = { first: 3000 last: 3999 };
message Checked {
  required int64 value = 1 [(ycoding.v5.constraints) = { integer_min: "-9007199254740991" integer_max: "9007199254740991" }];
  required LosslessString text = 2 [(ycoding.v5.constraints) = { utf16_max: 10 codepoints_max: 8 utf8_bytes_max: 32 domain_obligations: "packages/schema/src/browser.ts#Browser.Tab" }];
  repeated Empty items = 3 [(ycoding.v5.constraints) = { count_min: 1 count_max: 2 }];
}
service Fixture { rpc Read(Checked) returns (Empty) { ${annotation} } }`,
    )
    const result = Bun.spawnSync([
      process.env.PROTOC ?? "protoc",
      `--proto_path=${root}/protocol`,
      `--proto_path=${dir}`,
      "--include_imports",
      `--descriptor_set_out=${dir}/contract.bin`,
      path.join(dir, "fixture.proto"),
    ])
    expect(result.exitCode).toBe(0)
    const bytes = new Uint8Array(await Bun.file(path.join(dir, "contract.bin")).arrayBuffer())
    const operations = readOperations(bytes)
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({
      operationId: 3000,
      diagnosticName: "test.read",
      requestType: "ycoding.v5.Checked",
      resultType: "ycoding.v5.Empty",
    })
    validateBinary(
      "ycoding.v5.OperationDescriptor",
      toBinary(OperationDescriptorSchema, create(OperationDescriptorSchema, operations[0])),
    )
    expect(readConstraints(bytes)).toMatchObject({
      "ycoding.v5.Checked.1": { integerMin: "-9007199254740991", integerMax: "9007199254740991" },
      "ycoding.v5.Checked.2": {
        utf16Max: 10,
        codepointsMax: 8,
        utf8BytesMax: 32,
        domainObligations: ["packages/schema/src/browser.ts#Browser.Tab"],
      },
      "ycoding.v5.Checked.3": { countMin: 1, countMax: 2 },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

for (const [field, error] of [
  [
    'required int64 value = 1 [(ycoding.v5.constraints) = { integer_min: "2" integer_max: "1" }];',
    "inverted constraint bounds",
  ],
  ["required bool value = 1 [(ycoding.v5.constraints) = { utf16_max: 5 }];", "constraint type mismatch"],
  [
    'required LosslessString value = 1 [(ycoding.v5.constraints) = { domain_obligations: "unknown" }];',
    "invalid domain obligation source",
  ],
] as const) {
  test(`metadata generation rejects ${error}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ycoding-constraints-"))
    try {
      await Bun.write(
        path.join(dir, "fixture.proto"),
        `syntax = "proto2"; package ycoding.v5; import "ycoding/v5/foundation.proto"; import "ycoding/v5/operations.proto"; message Checked { ${field} }`,
      )
      const result = Bun.spawnSync(
        [
          "bun",
          "run",
          path.join(root, "packages/protocol/src/v5/generate.ts"),
          "--check-operations",
          path.join(dir, "fixture.proto"),
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      )
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain(error)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}
