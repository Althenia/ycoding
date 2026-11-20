import type { Interaction } from "@ycoding-ai/schema/interaction"
import type { SessionID } from "@ycoding-ai/schema/session-id"

export type InteractionDriverKey = Interaction.Platform | "chrome-isolated"

export type InventoryRequest = {
  readonly candidateID: Interaction.ID
  readonly sessionID: SessionID
  readonly expiresAt: number
} & (
  | { readonly purpose: "attach"; readonly selection: Interaction.Request }
  | { readonly purpose: "confirm"; readonly targetID: Interaction.ID; readonly revision: Interaction.Revision; readonly action: Interaction.Action }
)

export interface ConsentProof {
  readonly candidateID: Interaction.ID
  readonly sessionID: SessionID
  readonly targetID: Interaction.ID
  readonly authorization: string
}

export interface Lease {
  readonly id: Interaction.ID
}

export interface Command {
  readonly callID: Interaction.ID
  readonly action: Interaction.Action
  readonly consent?: ConsentProof
}

export interface InteractionDriver {
  readonly platform: Interaction.Platform
  inventory(request: InventoryRequest): Promise<readonly Interaction.Target[]>
  attach(target: Interaction.Target, proof: ConsentProof, signal: AbortSignal): Promise<Lease>
  observe(lease: Lease, signal: AbortSignal): Promise<Interaction.Observation>
  perform(lease: Lease, revision: Interaction.Revision, command: Command, signal: AbortSignal): Promise<Interaction.ActionResult>
  preview(lease: Lease, signal: AbortSignal): Promise<Interaction.Frame | undefined>
  detach(lease: Lease, reason: Interaction.StopReason): Promise<void>
}

export interface NativeInteraction {
  pending(): readonly InventoryRequest[]
  onPending(listener: (request: InventoryRequest, signal: AbortSignal) => void): () => void
  inventory(candidateID: Interaction.ID): Promise<readonly Interaction.Target[]>
  approve(proof: ConsentProof): Promise<boolean>
  reject(candidateID: Interaction.ID): boolean
  stop(leaseID: Interaction.ID, reason?: "stopped" | "target_lost" | "permission"): boolean
  disconnect(): void
}
