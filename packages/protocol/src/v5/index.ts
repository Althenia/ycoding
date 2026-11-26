export * from "../generated/v5/index.js"
export { encodeAssetMetadata } from "./asset.js"
export { create, toBinary, clearField, getOption, hasOption } from "@bufbuild/protobuf"
export {
  decodeLossless,
  decodeCompatible,
  encodeLossless,
  decodeStrict,
  encodeStrict,
  validateBinary,
  WireConnection,
} from "./validate.js"
