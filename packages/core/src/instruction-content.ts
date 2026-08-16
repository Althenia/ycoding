export * as InstructionContent from "./instruction-content"

import { Hash } from "./util/hash"

export const DEFAULT_INSTRUCTION_MAX_BYTES = 50 * 1024
export const MAX_INSTRUCTION_MAX_BYTES = 1024 * 1024

export type InstructionRetrieval = "read" | "webfetch"

export interface RenderInstructionContentInput {
  readonly source: string
  readonly content: string
  readonly maxBytes?: number
  readonly retrieval: InstructionRetrieval
}

export interface RenderedInstructionContent {
  readonly content: string
  readonly bytes: number
  readonly digest: string
  readonly omitted: boolean
}

const encoder = new TextEncoder()

export function renderInstructionContent(input: RenderInstructionContentInput): RenderedInstructionContent {
  const bytes = encoder.encode(input.content).byteLength
  const digest = Hash.sha256(input.content)
  const maxBytes = input.maxBytes ?? DEFAULT_INSTRUCTION_MAX_BYTES
  if (bytes <= maxBytes) return { content: input.content, bytes, digest, omitted: false }

  return {
    bytes,
    digest,
    omitted: true,
    content: [
      `[Instruction content omitted because ${bytes} UTF-8 bytes exceeds the ${maxBytes}-byte inline limit.]`,
      `Source: ${input.source}`,
      `SHA-256: ${digest}`,
      `Use the ${input.retrieval} tool to load only the relevant sections on demand.`,
    ].join("\n"),
  }
}
