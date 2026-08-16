import { Context, Layer } from "effect"
import { ServiceStatus } from "@ycoding-ai/protocol/groups/health"

export class ProcessIdentity extends Context.Service<ProcessIdentity, ProcessIdentityShape>()(
  "@ycoding/server/ProcessIdentity",
) {}

export interface ProcessIdentityShape {
  readonly sourceEpoch: ServiceStatus.Epoch
}

export const processIdentityLayer = (sourceEpoch: ServiceStatus.Epoch) =>
  Layer.succeed(ProcessIdentity, ProcessIdentity.of({ sourceEpoch }))
