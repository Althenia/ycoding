import { Info as TuiInfo } from "@ycoding-ai/tui/config/schema"
import { Schema } from "effect"

export const Info = Schema.Struct({ ...TuiInfo.fields })
export type Info = Schema.Schema.Type<typeof Info>
