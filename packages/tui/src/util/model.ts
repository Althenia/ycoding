import { Model } from "@ycoding-ai/schema/model"

export function parse(value: string) {
  try {
    const model = Model.Ref.parse(value)
    return {
      providerID: String(model.providerID),
      modelID: String(model.id),
      ...(model.profile === undefined ? {} : { profile: String(model.profile) }),
      ...(model.variant === undefined ? {} : { variant: String(model.variant) }),
    }
  } catch {
    return undefined
  }
}

export function formatRef(model: { providerID: string; id: string; variant?: string; profile?: string }) {
  return `${model.profile === undefined ? "" : `${model.profile}#`}${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`
}

export function modelVariantIDs(input: {
  readonly model?: {
    readonly variants: readonly { readonly id: string }[]
    readonly profiles?: readonly { readonly name: string; readonly variants?: readonly string[] }[]
  }
  readonly profile?: string
}) {
  if (input.profile !== undefined) return input.model?.profiles?.find((profile) => profile.name === input.profile)?.variants ?? []
  return input.model?.variants.map((variant) => variant.id) ?? []
}

export function switchLabel(
  model: { providerID: string; id: string; variant?: string; profile?: string },
  models?: readonly { providerID: string; id: string; name: string }[],
  previous?: { providerID: string; id: string; variant?: string; profile?: string },
) {
  if (
    previous?.providerID === model.providerID &&
    previous.id === model.id &&
    previous.profile !== model.profile
  ) {
    const variant = previous.variant === model.variant ? "" : model.variant === undefined ? " (variant cleared)" : ` (variant ${model.variant})`
    return `Switched profile to ${model.profile ?? "provider default"}${variant}`
  }
  if (previous?.providerID === model.providerID && previous.id === model.id)
    return model.variant === undefined ? "Cleared variant selection" : `Switched variant to ${model.variant}`
  const display = models?.find((item) => item.providerID === model.providerID && item.id === model.id)?.name
  if (display === undefined) return `Switched model to ${formatRef(model)}`
  const variant = model.variant ? ` (${model.variant})` : ""
  return `Switched model to ${display}${variant}`
}
