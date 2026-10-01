/**
 * Queue OpenCode's post-plan-exit kickoff after CreatePlan approval.
 *
 * Native `plan_exit` asks the user, then injects a synthetic user message with
 * `agent: "build"` so a new turn starts implementing. Our CreatePlan → question
 * path already asks; this module is the missing second half. A host plugin
 * installs the prompt handler; the language model records a request after Yes,
 * and the outer stream wrapper flushes it only after the current `doStream`
 * result stream has settled. This prevents a second generation from starting
 * while the continuation Run is still live.
 */
export type PlanExecutionKickoffInput = {
    sessionID: string;
    /** Filesystem path (or relative display path) of the approved plan. */
    planPath: string;
    /** Concrete Cursor Run that owns the approval. Guards recovery/supersession. */
    cursorSessionID?: string;
};
export type PlanExecutionKickoffFn = (input: PlanExecutionKickoffInput) => void | Promise<void>;
/** Upstream `PlanExitTool` wording — keep verbatim so behaviour matches OpenCode. */
export declare function createPlanExecutionKickoffText(planPath: string): string;
/**
 * Prefer a worktree-relative label when the plan sits under `workspaceRoot`,
 * matching OpenCode's `path.relative(instance.worktree, Session.plan(...))`.
 * Otherwise keep the absolute path (global data `plans/` is outside the tree).
 */
export declare function formatPlanKickoffPath(planPath: string, workspaceRoot?: string): string;
/** Decode a `file://` plan URI to a filesystem path; pass other strings through. */
export declare function planPathFromUri(planUri: string): string;
export type PlanExecutionKickoffState = PlanExecutionKickoffInput & {
    status: "pending" | "failed";
    attempts: number;
    lastError?: string;
};
/** Install (or clear) the host kickoff. */
export declare function setPlanExecutionKickoff(fn: PlanExecutionKickoffFn | undefined): void;
export declare function hasPlanExecutionKickoff(): boolean;
/** Record the approved plan; execution is flushed after the stream settles. */
export declare function queuePlanExecutionKickoff(input: PlanExecutionKickoffInput): boolean;
/** Drop any approval state owned by a deleted host session. */
export declare function cancelPlanExecutionKickoff(sessionID: string | undefined): void;
/**
 * Run one pending kickoff only after the owning Cursor Run reached a terminal,
 * idle state. Returns true only after successful host handoff.
 */
export declare function flushPlanExecutionKickoff(sessionID: string | undefined, options?: {
    cursorSessionID?: string;
    terminal?: boolean;
    pumpActive?: boolean;
    pendingExecs?: number;
}): Promise<boolean>;
/** Consume a user-visible warning on the next provider turn. */
export declare function takePlanExecutionKickoffWarning(sessionID: string | undefined): string | undefined;
/** Retry state remains explicit; no timer or automatic loop fires it. */
export declare function planExecutionKickoffState(sessionID: string | undefined): PlanExecutionKickoffState | undefined;
/** Test helper: clear the registered kickoff and pending approvals. */
export declare function resetPlanExecutionKickoffForTests(): void;
