import { z } from "zod"
import { transcriptionConfigSchema } from "./transcription"

export const meetingConfigSchema = z
  .object({
    transcription: transcriptionConfigSchema.default(() => transcriptionConfigSchema.parse({})),
    streaming: z
      .object({
        enabled: z.boolean().default(true),
        vad: z.boolean().default(true),
        sampleRate: z.number().int().min(8000).max(48000).default(16000),
        maxBufferedSeconds: z.number().min(30).max(180).default(60),
      })
      .strict()
      .default(() => ({ enabled: true, vad: true, sampleRate: 16000, maxBufferedSeconds: 60 })),
    vocabulary: z
      .object({
        preserveTechnicalTerms: z.boolean().default(true),
        hints: z.array(z.string().min(1).max(100)).max(64).default([]),
      })
      .strict()
      .default(() => ({ preserveTechnicalTerms: true, hints: [] })),
    fallback: z
      .object({
        enabled: z.boolean().default(true),
        provider: z.string().nullable().default(null),
        model: z.string().nullable().default(null),
      })
      .strict()
      .default(() => ({ enabled: true, provider: null, model: null })),
    analysis: z
      .object({
        model: z
          .union([
            z.literal("inherit"),
            z
              .object({
                id: z.string().min(1),
                providerID: z.string().min(1),
                variant: z.string().optional(),
                profile: z.string().optional(),
              })
              .strict(),
          ])
          .default("inherit"),
        incremental: z.boolean().default(true),
        maxCharacters: z.number().int().min(8000).max(64000).default(32000),
      })
      .strict()
      .default(() => ({ model: "inherit" as const, incremental: true, maxCharacters: 32000 })),
    knowledge: z
      .object({
        mcpEnabled: z.boolean().default(true),
        autoApply: z.literal(false).default(false),
        requireApproval: z.literal(true).default(true),
        retrievalTTL: z.number().int().min(0).max(3600000).default(300000),
        bindings: z
          .array(
            z
              .object({
                server: z.string().min(1).max(200),
                search: z.string().min(1).max(200),
                read: z.string().min(1).max(200),
                write: z.string().min(1).max(200).optional(),
              })
              .strict(),
          )
          .max(4)
          .default([]),
      })
      .strict()
      .default(() => ({
        mcpEnabled: true,
        autoApply: false as const,
        requireApproval: true as const,
        retrievalTTL: 300000,
        bindings: [],
      })),
    storage: z
      .object({
        provider: z.literal("sqlite").default("sqlite"),
        retainAudio: z.literal(false).default(false),
        retentionDays: z.number().int().positive().max(36500).nullable().default(null),
      })
      .strict()
      .default(() => ({ provider: "sqlite" as const, retainAudio: false as const, retentionDays: null })),
  })
  .strict()

export type MeetingConfig = z.infer<typeof meetingConfigSchema>
