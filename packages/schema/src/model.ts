export * as Model from "./model.js"

import { Schema } from "effect"
import { optional, statics } from "./schema.js"
import { Provider } from "./provider.js"
import { Money } from "./money.js"

export const ID = Schema.String.pipe(Schema.brand("Model.ID"))
export type ID = typeof ID.Type

export const VariantID = Schema.String.pipe(Schema.brand("Model.VariantID"))
export type VariantID = typeof VariantID.Type

export const ProfileName = Schema.String.check(Schema.isNonEmpty()).annotate({ identifier: "Model.ProfileName" })
export type ProfileName = typeof ProfileName.Type

export const Ref = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  variant: VariantID.pipe(optional),
  profile: ProfileName.pipe(optional),
})
  .annotate({ identifier: "Model.Ref" })
  .pipe(
    statics((schema) => ({
      parse: (input: string) => {
        const profileEnd = input.indexOf("#")
        const firstSlash = input.indexOf("/")
        const hasProfile = profileEnd >= 0 && profileEnd < firstSlash
        const providerStart = hasProfile ? profileEnd + 1 : 0
        const providerEnd = input.indexOf("/", providerStart)
        if (providerEnd <= 0) throw new Error(`Invalid model reference: ${input}`)
        const providerID = input.slice(providerStart, providerEnd)
        const variantStart = input.indexOf("#", providerEnd + 1)
        const id = input.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart)
        const variant = variantStart === -1 ? undefined : input.slice(variantStart + 1)
        const profile = hasProfile ? input.slice(0, profileEnd) : undefined
        if (
          !id ||
          !providerID ||
          (hasProfile && !profile) ||
          providerID.includes("#") ||
          (variant !== undefined && (!variant || variant.includes("#")))
        )
          throw new Error(`Invalid model reference: ${input}`)
        return schema.make({
          providerID: Provider.ID.make(providerID),
          id: ID.make(id),
          ...(variant ? { variant: VariantID.make(variant) } : {}),
          ...(profile ? { profile: ProfileName.make(profile) } : {}),
        })
      },
    })),
  )
export interface Ref extends Schema.Schema.Type<typeof Ref> {}

export const Family = Schema.String.pipe(Schema.brand("Model.Family"))
export type Family = typeof Family.Type

export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  tools: Schema.Boolean,
  input: Schema.Array(Schema.String),
  output: Schema.Array(Schema.String),
}).annotate({ identifier: "Model.Capabilities" })

export interface Cost extends Schema.Schema.Type<typeof Cost> {}
export const Cost = Schema.Struct({
  tier: Schema.Struct({
    type: Schema.tag("context"),
    size: Schema.Int,
  }).pipe(optional),
  input: Money.USDPerMillionTokens,
  output: Money.USDPerMillionTokens,
  cache: Schema.Struct({
    read: Money.USDPerMillionTokens,
    write: Money.USDPerMillionTokens,
  }),
}).annotate({ identifier: "Model.Cost" })

export interface Variant extends Schema.Schema.Type<typeof Variant> {}
export const Variant = Schema.Struct({
  id: VariantID,
  ...Provider.Overlays,
}).annotate({ identifier: "Model.Variant" })

export const Daybreak = Schema.Literals(["daybreak_blue", "daybreak_red"]).annotate({
  identifier: "Model.Daybreak",
})
export type Daybreak = typeof Daybreak.Type

export interface Profile extends Schema.Schema.Type<typeof Profile> {}
export const Profile = Schema.Struct({
  name: ProfileName,
  active: Schema.Boolean,
  variants: Schema.Array(VariantID).pipe(optional),
  daybreak: Schema.Array(Daybreak).pipe(optional),
}).annotate({ identifier: "Model.Profile" })

export const API = Schema.Literals(["chat", "responses"]).annotate({
  identifier: "Model.API",
})
export type API = typeof API.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  modelID: ID,
  providerID: Provider.ID,
  family: Family.pipe(optional),
  name: Schema.String,
  package: Provider.Package.pipe(optional),
  ...Provider.Overlays,
  capabilities: Capabilities,
  variants: Schema.Array(Variant),
  profiles: Schema.Array(Profile).pipe(optional),
  time: Schema.Struct({
    released: Schema.Finite,
  }),
  cost: Schema.Array(Cost),
  status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
  enabled: Schema.Boolean,
  /** Daybreak programs an authenticated account advertises for this model; absent means none advertised. */
  daybreak: Schema.Array(Daybreak).pipe(optional),
  /** OpenAI-compatible API surface: chat or responses. Absent means the provider's default. */
  api: API.pipe(optional),
  limit: Schema.Struct({
    context: Schema.Int,
    input: Schema.Int.pipe(optional),
    output: Schema.Int,
  }),
})
  .annotate({ identifier: "Model.Info" })
  .pipe(
    statics(() => ({
      empty: (providerID: Provider.ID, id: ID) =>
        ({
          id,
          modelID: id,
          providerID,
          name: id,
          capabilities: { tools: false, input: [], output: [] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 0, output: 0 },
        }) satisfies Info,
    })),
  )

export interface Default extends Schema.Schema.Type<typeof Default> {}
export const Default = Schema.Struct({
  ...Info.fields,
  selection: Ref,
}).annotate({ identifier: "Model.Default" })
