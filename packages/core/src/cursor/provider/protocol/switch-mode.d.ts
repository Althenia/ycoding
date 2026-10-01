/**
 * Cursor-native SwitchMode ⇄ OpenCode `plan_enter` / `plan_exit`.
 *
 * Cursor raises `switch_mode_request_query` (#4) with SwitchModeArgs and blocks
 * until the client replies approved{} or rejected{reason} (no async variant).
 * Cursor CLI prompts the user, then flips unifiedMode and injects a
 * `<system_reminder>` describing how to behave in that mode.
 * Display `switch_mode_tool_call` (#25) is a separate transcript record and is
 * not replayed as a host tool.
 *
 * OpenCode 1.x mapping (advertisement-gated):
 * - plan, spec → plan_enter
 * - every other non-empty target → plan_exit (leave plan for OpenCode build),
 *   then inject the Cursor CLI-shaped mode reminder for that target
 *
 * Upstream OpenCode's plan tools are not mode flags. Each one asks the user
 * through the Question service and, on "Yes", injects a synthetic user message
 * carrying `agent: "plan" | "build"`, which `createUserMessage` turns into a
 * `setAgentModel` primary-agent switch (opencode `tool/plan.ts`,
 * `session/prompt.ts`). A provider cannot reach `setAgentModel`, but the two
 * observable halves — the approval gate and the behavioural contract — are both
 * reachable, so the protocol bridge degrades instead of refusing when the host
 * tool is missing. OpenCode 2 additionally exposes `session.switchAgent`; its
 * entrypoint installs a structural callback that selects the native `plan` or
 * `build` primary agent after the owning Cursor Run becomes terminal:
 *
 * - entering plan/spec needs no host tool at all — approve immediately and let
 *   the injected <system_reminder> carry the contract, exactly as Cursor CLI's
 *   own plan mode is prompt-enforced.
 * - leaving plan mode is the gate the user must actually see, so it falls back
 *   to the host `question` tool and only rejects when that is absent too.
 *
 * Resolution is keyed solely on the advertised catalog under canonical
 * OpenCode tool names — never on any external identity or model id.
 *
 * CLI reject reason for user declines: "Mode switch rejected by user"
 * (chunk-7076/dist/ui.js onSwitchModeReject).
 */
import { type OpencodeQuestionInput } from "./ask-question.js";
/**
 * `PendingExec.resultField` for a held-open SwitchMode InteractionQuery.
 * Continuation writes an InteractionResponse, not an ExecClientMessage.
 */
export declare const SWITCH_MODE_RESULT_FIELD = "switch_mode_request_response";
/** CLI verbatim when the user rejects the mode switch. */
export declare const USER_REJECTED_REASON = "Mode switch rejected by user";
export declare const MISSING_QUERY_REASON = "Missing switch-mode query";
export declare const MISSING_ARGS_REASON = "Missing switch-mode arguments";
export declare const MISSING_TARGET_REASON = "Missing targetModeId";
/**
 * A turn that cannot call host tools is a lifecycle turn (title generation,
 * compaction, summarization). OpenCode opens one alongside the real Run, and it
 * must not mutate session state — approving there flips plan mode twice and
 * lets the throwaway turn write its own plan file.
 *
 * Soft-ack with `approved{}` instead of `rejected{reason}`: a hard reject lands
 * in the transcript and the real turn narrates "mode switches are blocked"
 * even though the next Run will succeed. CreatePlan already soft-acks the same
 * case; SwitchMode must match.
 */
export declare const PLAN_EXIT_UNAVAILABLE_REASON: string;
/** Upstream `PlanExitTool` wording, minus a plan path the provider cannot verify. */
export declare const SWITCH_MODE_EXIT_QUESTION = "Planning is complete. Would you like to switch to the build agent and start implementing?";
export declare const SWITCH_MODE_EXIT_HEADER = "Build Agent";
export type SwitchModeHostTool = "plan_enter" | "plan_exit";
/**
 * How a SwitchMode query is satisfied this turn.
 *
 * - `native`   the host advertises the matching plan tool; bridge to it.
 * - `approve`  entering plan mode needs no host tool — approve immediately.
 * - `ack`      lifecycle turn (`allowTools=false`): approve on the wire without
 *              mutating session mode (same soft-ack pattern as CreatePlan).
 * - `question` leaving plan mode falls back to the host `question` prompt.
 * - `reject`   nothing can satisfy it; `reason` names the real cause.
 */
export type SwitchModeBridge = {
    kind: "native";
    toolName: SwitchModeHostTool;
} | {
    kind: "approve";
} | {
    kind: "ack";
} | {
    kind: "question";
    input: OpencodeQuestionInput;
} | {
    kind: "reject";
    reason: string;
};
export type CursorSwitchModeArgs = {
    targetModeId: string;
    explanation: string;
    toolCallId: string;
};
export type DecodedSwitchModeQuery = {
    args: CursorSwitchModeArgs;
    toolCallId: string;
};
export type SwitchModeMapping = {
    ok: true;
    toolName: SwitchModeHostTool;
} | {
    ok: false;
    reason: string;
};
/** Normalize Cursor mode ids for comparison. */
export declare function normalizeSwitchModeId(targetModeId: string): string;
/**
 * Map a Cursor unified-mode id onto an OpenCode plan enter/exit tool.
 * Does not check advertisement — callers gate on the host catalog.
 *
 * plan/spec enter plan; every other non-empty target leaves plan via plan_exit
 * (host-portable primary switch) and relies on {@link cursorModeSystemReminder}
 * for CLI-shaped behavioral guidance.
 */
export declare function mapSwitchModeTarget(targetModeId: string): SwitchModeMapping;
/** Host `question` input mirroring upstream `PlanExitTool`'s own prompt. */
export declare function switchModeExitQuestionInput(): OpencodeQuestionInput;
/**
 * Resolve how this SwitchMode target is satisfied, keyed only on the advertised
 * catalog under canonical tool names.
 *
 * A missing plan tool is not a refusal: entering plan mode needs no host tool,
 * and leaving it degrades to the `question` prompt so the user still approves
 * before any execution starts.
 */
export declare function resolveSwitchModeBridge(targetModeId: string, options: {
    allowTools: boolean;
    advertised: ReadonlySet<string> | Iterable<string>;
    /** Cursor unified mode currently recorded for this session, if any. */
    activeModeId?: string;
}): SwitchModeBridge;
/** Decode a `switch_mode_request_query` body, or undefined when unusable. */
export declare function decodeSwitchModeQuery(queryBytes: Uint8Array): DecodedSwitchModeQuery | undefined;
/** OpenCode plan_enter / plan_exit advertise empty input. */
export declare function switchModeToolInput(): Record<string, never>;
/** Shape `approved{}` / `rejected{reason}` for encodeMessage. */
export declare function switchModeApprovedResult(): Record<string, unknown>;
export declare function switchModeRejectedResult(reason: string): Record<string, unknown>;
/**
 * Host tool outcome → Cursor SwitchModeRequestResponse.
 * Question/permission declines and empty failures use the CLI user-reject string.
 */
export declare function switchModeResultFromToolOutput(output: string, isError: boolean): Record<string, unknown>;
/**
 * Host `question` outcome → Cursor SwitchModeRequestResponse, for the emulated
 * plan exit. Only an explicit "Yes" approves; an unanswered or dismissed prompt
 * keeps the model in plan mode rather than silently starting execution.
 */
export declare function switchModeResultFromQuestionOutput(output: string, isError: boolean): Record<string, unknown>;
/** Record the approved Cursor mode for later system-reminder injection. */
export declare function setActiveCursorMode(sessionKey: string | undefined, targetModeId: string, options?: {
    bridgedPlanEntered?: boolean;
}): void;
export declare function getActiveCursorMode(sessionKey: string | undefined): string | undefined;
/** True while the provider has an approved Cursor plan/spec mode for this session. */
export declare function isCursorPlanModeActive(sessionKey: string | undefined): boolean;
/** True after a bridged plan/spec Run has observed plan_enter removed by the host. */
export declare function isBridgedCursorPlanModeActive(sessionKey: string | undefined): boolean;
export declare function clearActiveCursorMode(sessionKey: string | undefined): void;
export declare function resetActiveCursorModesForTests(): void;
/**
 * Cursor CLI-shaped mode reminder for the active unified mode.
 * Tool names are adapted to OpenCode (`task`, `question`) where the CLI names
 * Cursor-only tools; the behavioral contract matches the CLI reminders.
 */
export declare function cursorModeSystemReminder(targetModeId: string, options?: {
    firstTurn?: boolean;
    planExitAdvertised?: boolean;
    planStageAdvertised?: boolean;
}): string | undefined;
/**
 * Consume the active-mode reminder for this OpenCode session.
 * Marks the mode as no longer first-turn after the first successful read.
 */
export declare function takeActiveCursorModeReminder(sessionKey: string | undefined, options?: {
    advertisedTools?: ReadonlySet<string> | Iterable<string>;
}): string | undefined;
