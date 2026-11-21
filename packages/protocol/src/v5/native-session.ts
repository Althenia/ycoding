import { NonNegativeInt } from "@ycoding-ai/schema/schema"
import { Schema } from "effect"

export const ListBefore = NonNegativeInt.check(Schema.isLessThanOrEqualTo(199))
