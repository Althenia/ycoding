import { create } from "@bufbuild/protobuf"
import type { DescFile } from "@bufbuild/protobuf"
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt"
import { schemas } from "../src/generated/v5/index.js"

export function descriptorSet() {
  const files: DescFile[] = []
  const visit = (file: DescFile) => {
    if (files.includes(file)) return
    file.dependencies.forEach(visit)
    files.push(file)
  }
  schemas.forEach((schema) => visit(schema.file))
  return create(FileDescriptorSetSchema, { file: files.map((file) => file.proto) })
}
