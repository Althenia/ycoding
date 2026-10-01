import type { CursorProviderError } from "./errors.js";
export type ReplayBarrierReason = "visible-text" | "visible-reasoning" | "display-tool-lifecycle" | "non-control-exec" | "stateful-interaction" | "unknown-or-malformed-frame";
export declare class AttemptReplaySafety {
    private readonly sessionId;
    private barrierReason;
    constructor(sessionId: string);
    markBarrier(reason: ReplayBarrierReason): void;
    applyTo(failure: CursorProviderError): CursorProviderError;
}
export type DecodedReplayFrame = {
    interactionUpdate?: Record<string, unknown>;
    exec?: Record<string, unknown>;
    kv?: Record<string, unknown>;
    execControl?: Record<string, unknown>;
    interactionQuery?: Record<string, unknown>;
    checkpointBytes?: Uint8Array;
};
export type ReplayFrameAnalysis = {
    semanticProgress: boolean;
    barrier?: ReplayBarrierReason;
};
/** Classify one decoded server frame without performing any protocol side effects. */
export declare function analyzeReplayFrame(payload: Uint8Array, decoded: DecodedReplayFrame): ReplayFrameAnalysis;
