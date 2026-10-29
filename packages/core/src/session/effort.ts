export * as SessionEffort from "./effort"

import { LLMRequest, Message, mergeHttpOptions, mergeProviderOptions } from "@ycoding-ai/ai"
import {
  anthropicEffortModel,
  defaultEffort,
  mechanism,
  selectedEffort,
} from "@ycoding-ai/ai/protocols/utils/effort-update"
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm"
import { Effect } from "effect"
import type { Catalog } from "../catalog"
import type { Database } from "../database/database"
import type { SessionContext } from "./context"
import { SessionContextRevisionTable, SessionMessageTable, SessionProviderRequestTable } from "./sql"
import { SessionRunnerModel } from "./runner/model"

export const prepare = Effect.fn("SessionEffort.prepare")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly catalog: Catalog.Interface
  readonly context: SessionContext.Loaded
  readonly request: LLMRequest
  readonly namespace: string
}) {
  const unchanged = { request: input.request, inputStart: (index: number) => index }
  const request = LLMRequest.update(input.request, {
    providerOptions: mergeProviderOptions(
      input.request.model.route.defaults.providerOptions,
      input.request.model.defaults?.providerOptions,
      input.request.providerOptions,
    ),
    http: mergeHttpOptions(
      input.request.model.route.defaults.http,
      input.request.model.defaults?.http,
      input.request.http,
    ),
  })
  const provider = mechanism(request)
  if (provider === undefined) return unchanged
  const key = provider === "openai" ? "reasoningEffort" : "effort"
  const currentEffort = selectedEffort(request.providerOptions, provider)
  const fallback = defaultEffort(input.request.model.id)
  if (fallback === undefined && currentEffort === undefined) return unchanged
  const assistantIDs = input.context.messages.flatMap((message) => (message.type === "assistant" ? [message.id] : []))
  if (assistantIDs.length === 0) return unchanged
  const rows = yield* input.db
    .select({
      model: SessionProviderRequestTable.model,
      assistantMessageID: SessionProviderRequestTable.assistant_message_id,
      account: SessionProviderRequestTable.connection_identity_digest,
    })
    .from(SessionProviderRequestTable)
    .innerJoin(SessionMessageTable, eq(SessionMessageTable.id, SessionProviderRequestTable.assistant_message_id))
    .leftJoin(
      SessionContextRevisionTable,
      and(
        eq(SessionContextRevisionTable.session_id, input.context.session.id),
        eq(SessionContextRevisionTable.revision, input.context.contextRevision),
      ),
    )
    .where(
      and(
        inArray(SessionProviderRequestTable.assistant_message_id, assistantIDs),
        or(
          isNull(SessionContextRevisionTable.activation_sequence),
          gt(SessionMessageTable.seq, SessionContextRevisionTable.activation_sequence),
        ),
        eq(SessionProviderRequestTable.session_id, input.context.session.id),
        eq(SessionProviderRequestTable.source, "step"),
        eq(SessionProviderRequestTable.route_id, input.request.model.route.id),
        eq(SessionProviderRequestTable.prompt_cache_key, input.namespace),
      ),
    )
    .orderBy(asc(SessionProviderRequestTable.request))
    .all()
    .pipe(Effect.orDie)
  const positions = new Map(
    input.request.messages.flatMap((message, index) => (message.id ? [[message.id, index] as const] : [])),
  )
  const retained = rows.flatMap((row) => {
    const index = row.assistantMessageID === null ? undefined : positions.get(row.assistantMessageID)
    return index === undefined ||
      row.account !== (input.context.model.accountIdentityDigest ?? null) ||
      row.model.providerID !== input.context.model.ref.providerID ||
      row.model.id !== input.context.model.ref.id ||
      (row.model.profile !== input.context.model.ref.profile && !input.context.model.accountIdentityDigest)
      ? []
      : [{ ...row, index }]
  })
  if (retained.length === 0) return unchanged
  const catalog = yield* input.catalog.model.get(
    input.context.model.ref.providerID,
    input.context.model.ref.id,
    input.context.model.ref.profile,
  )
  if (!catalog) return unchanged
  const variants = yield* Effect.forEach([...new Set(retained.map((row) => row.model.variant))], (variant) =>
    Effect.gen(function* () {
      if (variant !== undefined && !catalog.variants?.some((item) => item.id === variant))
        return [variant, undefined] as const
      const selected = yield* SessionRunnerModel.withVariant(catalog, variant)
      const model = yield* SessionRunnerModel.fromCatalogModel(selected).pipe(Effect.orDie)
      const options = mergeProviderOptions(model.route.defaults.providerOptions, model.defaults?.providerOptions)
      const historical = LLMRequest.update(input.request, {
        model,
        providerOptions: options,
        http: mergeHttpOptions(model.route.defaults.http, model.defaults?.http),
      })
      if (mechanism(historical) !== provider) return [variant, undefined] as const
      return [variant, { effort: selectedEffort(options, provider) }] as const
    }),
  ).pipe(Effect.orDie)
  const settings = new Map(variants)
  const reconstructed = retained.flatMap((row) => {
    const setting = settings.get(row.model.variant)
    return setting === undefined ? [] : [{ index: row.index, effort: setting.effort }]
  })
  const unknownDefault =
    fallback === undefined ? reconstructed.findLastIndex((entry) => entry.effort === undefined) : -1
  const history = unknownDefault === -1 ? reconstructed : reconstructed.slice(unknownDefault)
  const baseline = history[0]
  if (!baseline) return unchanged
  let effort = baseline.effort ?? fallback
  let start = 0
  const updates = new Map<number, string>()
  for (const entry of [...history, { index: input.request.messages.length, effort: currentEffort }]) {
    const desired = entry.effort ?? fallback
    const boundary = input.request.messages.findIndex(
      (message, index) =>
        index >= start &&
        index < entry.index &&
        message.role === "user" &&
        message.volatile !== true &&
        message.content.some((part) => part.type !== "tool-result"),
    )
    if (desired !== undefined && desired !== effort && (!anthropicEffortModel(request.model.id) || boundary !== -1)) {
      updates.set(boundary === -1 ? entry.index : boundary, desired)
      effort = desired
    }
    start = entry.index + 1
  }
  return {
    inputStart: (index: number) => index + [...updates.keys()].filter((boundary) => boundary < index).length,
    request: LLMRequest.update(input.request, {
      providerOptions: mergeProviderOptions(
        input.request.providerOptions,
        provider === "openrouter"
          ? {
              openrouter: { reasoning: { effort: baseline.effort ?? null } },
              openai: { reasoningEffort: baseline.effort ?? null },
            }
          : { [provider]: { [key]: baseline.effort ?? null } },
      ),
      messages: Array.from({ length: input.request.messages.length + 1 }).flatMap((_, index) => {
        const effort = updates.get(index)
        const update =
          effort === undefined
            ? []
            : [
                Message.make({
                  role: "system",
                  content: [],
                  native: { [provider]: { [key]: effort } },
                }),
              ]
        const message = input.request.messages[index]
        return [...update, ...(message === undefined ? [] : [message])]
      }),
    }),
  }
})
