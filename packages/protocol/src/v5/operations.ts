import { fromBinary, getExtension, hasExtension, isFieldSet } from "@bufbuild/protobuf"
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt"
import {
  operation,
  operation_range,
  constraints,
  FieldConstraintsSchema,
} from "../generated/v5/ycoding/v5/operations_pb.js"

export function readConstraints(bytes: Uint8Array) {
  const set = fromBinary(FileDescriptorSetSchema, bytes)
  return Object.fromEntries(
    set.file.flatMap((file) =>
      file.messageType.flatMap((message) =>
        message.field.flatMap((field) => {
          if (!field.options || !hasExtension(field.options, constraints)) return []
          const value = getExtension(field.options, constraints)
          const rules = Object.fromEntries(
            FieldConstraintsSchema.fields
              .filter((item) => isFieldSet(value, item))
              .map((item) => {
                const v = value[item.localName as keyof typeof value]
                if (typeof v === "bigint" && v > BigInt(Number.MAX_SAFE_INTEGER))
                  throw new Error("constraint bound exceeds safe integer")
                return [item.localName, typeof v === "bigint" ? Number(v) : v]
              }),
          )
          for (const name of ["integerMin", "integerMax"]) {
            const bound = rules[name]
            if (
              bound !== undefined &&
              (typeof bound !== "string" ||
                !/^(?:0|-?[1-9][0-9]*)$/.test(bound) ||
                BigInt(bound) < -(1n << 63n) ||
                BigInt(bound) > (1n << 64n) - 1n)
            )
              throw new Error("invalid integer constraint")
          }
          for (const [min, max] of [
            ["integerMin", "integerMax"],
            ["utf16Min", "utf16Max"],
            ["codepointsMin", "codepointsMax"],
            ["utf8BytesMin", "utf8BytesMax"],
            ["countMin", "countMax"],
          ]) {
            if (
              rules[min!] !== undefined &&
              rules[max!] !== undefined &&
              BigInt(String(rules[min!])) > BigInt(String(rules[max!]))
            )
              throw new Error("inverted constraint bounds")
          }
          const integer = [3, 4, 5, 13].includes(field.type ?? 0)
          const text = field.type === 9 || field.typeName === ".ycoding.v5.LosslessString"
          if (
            (!integer && (rules.integerMin !== undefined || rules.integerMax !== undefined)) ||
            (!text &&
              Object.keys(rules).some(
                (name) => !["integerMin", "integerMax", "countMin", "countMax", "domainObligations"].includes(name),
              )) ||
            (field.label !== 3 && (rules.countMin !== undefined || rules.countMax !== undefined))
          )
            throw new Error("constraint type mismatch")
          if (
            value.domainObligations.some(
              (source) =>
                !/^packages\/(schema|protocol|remote|cli)\/src\/[A-Za-z0-9_./-]+\.ts#[A-Za-z0-9_.]+$/.test(source),
            )
          )
            throw new Error("invalid domain obligation source")
          if (value.domainObligations.length) rules.domainObligations = value.domainObligations
          return [[`${file.package}.${message.name}.${field.number}`, rules]]
        }),
      ),
    ),
  )
}

export function readOperations(bytes: Uint8Array) {
  const set = fromBinary(FileDescriptorSetSchema, bytes)
  const types = new Set(
    set.file.flatMap((file) => file.messageType.map((message) => `${file.package}.${message.name}`)),
  )
  const ids = new Set<number>()
  const names = new Set<string>()
  return set.file
    .flatMap((file) =>
      file.service.flatMap((service) =>
        service.method.map((method) => {
          if (!method.options || !hasExtension(method.options, operation))
            throw new Error("missing operation annotation")
          if (!file.options || !hasExtension(file.options, operation_range)) throw new Error("missing operation range")
          const range = getExtension(file.options, operation_range)
          const options = getExtension(method.options, operation)
          if (range.first > range.last || options.operationId < range.first || options.operationId > range.last)
            throw new Error("operation ID outside declared range")
          if (ids.has(options.operationId)) throw new Error("duplicate operation ID")
          if (!options.diagnosticName || names.has(options.diagnosticName))
            throw new Error("empty or duplicate diagnostic name")
          if (!options.roles.length) throw new Error("missing operation roles")
          if (method.clientStreaming || method.serverStreaming) throw new Error("gRPC streaming is not a v5 transport")
          const requestType = method.inputType!.slice(1)
          const resultType = method.outputType!.slice(1)
          for (const type of [requestType, resultType, ...options.errorTypes]) {
            if (!types.has(type)) throw new Error(`unknown operation type: ${type}`)
          }
          ids.add(options.operationId)
          names.add(options.diagnosticName)
          return { ...options, requestType, resultType, $typeName: "ycoding.v5.OperationDescriptor" as const }
        }),
      ),
    )
    .sort((a, b) => a.operationId - b.operationId)
}
