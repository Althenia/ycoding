import type { BulkStart, AssetMetadataResult } from "../../generated/v5/index.js"

export type Transfer = {
  start: BulkStart
  index: number
  offset: bigint
  data?: Uint8Array
  complete: boolean
  metadata?: AssetMetadataResult
  assetCharge?: number
}
