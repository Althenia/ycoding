type BrandMarker = { readonly "~effect/Brand": unknown }

// Public plugin drafts use ordinary primitives while preserving literal unions.
// Arrays and objects are writable because the host exposes transaction-scoped drafts.
// eslint-disable-next-line @typescript-eslint/ban-types
export type Mutable<Value> = Value extends string
  ? Value extends BrandMarker
    ? string
    : Value
  : Value extends number
    ? Value extends BrandMarker
      ? number
      : Value
    : Value extends bigint
      ? Value extends BrandMarker
        ? bigint
        : Value
      : Value extends boolean | symbol | Function
        ? Value
        : Value extends readonly [unknown, ...unknown[]]
          ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
          : Value extends readonly (infer Item)[]
            ? Mutable<Item>[]
            : Value extends object
              ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
              : Value
