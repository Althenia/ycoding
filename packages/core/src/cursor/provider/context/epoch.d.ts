export declare const MAX_CONTEXT_EPOCHS = 256;
export type ContextSourceSnapshot = {
    hostSystemHash: string;
    guidanceHash: string;
    hostAgent: string;
    workspaceRoot: string;
};
export type ContextEpoch = {
    conversationId: string;
    /** Exact system text seeded at epoch start. Empty when recovered from checkpoint. */
    baselineSystemPrompt: string;
    baselineHash: string;
    /** True when restart hydrated past a checkpoint without the original baseline bytes. */
    recovered: boolean;
    snapshot: ContextSourceSnapshot;
};
export type AdmitContextEpochInput = {
    conversationId: string;
    /** True when this Run carries conversation_state (no systemPrompt on the wire). */
    hasCheckpoint: boolean;
    hostSystem?: string;
    guidance?: string;
    hostAgent?: string;
    workspaceRoot: string;
    /**
     * One-shot reminders already wrapped (mode / kickoff). Always chronological —
     * never folded into the frozen baseline.
     */
    oneShotReminders?: readonly string[];
};
export type AdmitContextEpochResult = {
    action: "initialize" | "unchanged" | "updated" | "recovered";
    /** Wire systemPrompt for seed Runs only — always the frozen baseline once set. */
    seedSystemPrompt?: string;
    /** Combined Mid-Conversation System Message (append after user text). */
    midConversationMessage?: string;
    epoch: ContextEpoch;
};
/**
 * Admit System Context at a Safe Provider-Turn Boundary.
 *
 * - First seed: freeze baseline, return it as seedSystemPrompt; one-shots → mid.
 * - Checkpoint turn: never returns seedSystemPrompt; source diffs + one-shots → mid.
 * - Reseed same epoch: return frozen baseline bytes (not live host text).
 * - Recovered (restart past a checkpoint, original bytes unknown): never freeze
 *   live host text as a new baseline and never send a seed systemPrompt.
 */
export declare function admitContextEpoch(input: AdmitContextEpochInput): AdmitContextEpochResult;
export declare function getContextEpoch(conversationId: string): ContextEpoch | undefined;
/** Drop epoch state (compaction remint / binding clear). */
export declare function clearContextEpoch(conversationId: string): void;
/**
 * Compaction remints conversation_id. RequestContext workspace base transfers;
 * System Context baseline does not — the destination starts a fresh epoch.
 */
export declare function endContextEpoch(previousConversationId: string, nextConversationId?: string): void;
export declare function resetContextEpochsForTests(): void;
/** Append a mid-conversation message after user text (V2: user precedes update). */
export declare function appendMidConversationMessage(userText: string, midConversationMessage: string | undefined): string;
