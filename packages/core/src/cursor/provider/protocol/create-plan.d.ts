/**
 * Cursor-native CreatePlan → host-default plan file.
 *
 * Cursor raises `create_plan_request_query` (#7) with CreatePlanArgs and expects
 * a CreatePlanResult carrying `plan_uri`. Cursor CLI writes under
 * `~/.cursor/plans/*.plan.md` with YAML frontmatter; this provider deliberately
 * does **not** — plans must stay host-portable so switching models does not
 * strand users on Cursor-specific paths or frontmatter.
 *
 * Location mirrors OpenCode Session.plan shape, but the project-config segment
 * comes from {@link hostPlansDir} / {@link opencodeProjectConfigDirs}
 * (the active host's project config dir via the path bridge), never a
 * hardcoded OpenCode-only directory name.
 *
 * Body is plain markdown (the same shape a plan-mode model would write with
 * `write`). Cursor YAML frontmatter is never emitted.
 */
import { type OpencodeQuestionInput } from "./ask-question.js";
export type CursorPlanTodo = {
    id: string;
    content: string;
    status: string;
};
export type CursorCreatePlanArgs = {
    plan: string;
    overview: string;
    name: string;
    isProject: boolean;
    todos: CursorPlanTodo[];
};
export type DecodedCreatePlanQuery = {
    args: CursorCreatePlanArgs;
    toolCallId: string;
};
export type CreatePlanWriteResult = {
    ok: true;
    planPath: string;
    planUri: string;
    markdown: string;
} | {
    ok: false;
    error: string;
};
/** Optional host plan-stage tool advertised by a compatible host. */
export declare const CURSOR_PLAN_STAGE_TOOL = "cursor_plan_stage";
/** Held InteractionQuery continuation field for a native host plan stage. */
export declare const CREATE_PLAN_RESULT_FIELD = "create_plan_request_response";
export type CursorPlanStageInput = {
    plan_uri: string;
    content: string;
    title: string;
};
/**
 * How a CreatePlan query is satisfied this turn. Keyed only on the advertised
 * catalog and the provider's own plan-mode state — never on host identity.
 *
 * - `stage`   a host plan-stage tool is advertised; the host writes the plan.
 *             Its tool result is the approval outcome (success = approved,
 *             error = not approved). The result may name the host's own
 *             follow-up approval call. This provider does not invent that prompt.
 * - `approve` no such tool, but the host advertises `question`: the provider
 *             writes the plan itself and then asks the same thing with upstream
 *             `PlanExitTool`'s own prompt.
 * - `ack`     nothing to ask with (or a lifecycle turn): write, or for a
 *             lifecycle turn skip the write, and acknowledge the CLI way.
 *
 * The plan is always persisted before any prompt: writing needs no approval,
 * executing does.
 */
export type CreatePlanBridge = {
    kind: "stage";
} | {
    kind: "approve";
} | {
    kind: "ack";
};
/** Upstream `PlanExitTool` wording, with the plan the provider just wrote. */
export declare function createPlanApprovalQuestion(planLabel: string): string;
export declare const CREATE_PLAN_APPROVAL_HEADER = "Build Agent";
/** Cursor-visible reason when the user wants the plan revised instead of run. */
export declare const CREATE_PLAN_NOT_APPROVED_REASON: string;
/**
 * Resolve how this CreatePlan is satisfied. `planModeActive` is the provider's
 * own record of an approved Cursor plan/spec mode: the approval prompt guards
 * the transition *out of* planning, so a CreatePlan raised outside plan mode is
 * written and acknowledged without one.
 */
export declare function resolveCreatePlanBridge(options: {
    allowTools: boolean;
    canStage?: boolean;
    planModeActive?: boolean;
    advertised: ReadonlySet<string> | Iterable<string>;
}): CreatePlanBridge;
/** Host `question` input mirroring upstream `PlanExitTool`'s own prompt. */
export declare function createPlanApprovalQuestionInput(planLabel: string): OpencodeQuestionInput;
/**
 * True when the emulated approval prompt came back as an explicit "Yes".
 * An unanswered, dismissed, or failed prompt keeps the model planning rather
 * than silently starting execution. OpenCode prose is anchored on the exact
 * prompt text. Every other result shape fails closed.
 */
export declare function createPlanApproved(output: string, isError: boolean, question: string): boolean;
/** Decode a `create_plan_request_query` body, or undefined when unusable. */
export declare function decodeCreatePlanQuery(queryBytes: Uint8Array): DecodedCreatePlanQuery | undefined;
/** OpenCode-style adjective-noun slug (core/src/util/slug.ts). */
export declare function randomPlanSlug(seed?: number): string;
/** Slugify a human title into a filesystem-safe token. */
export declare function slugifyPlanName(name: string): string;
/** Build the advertised host plan-stage artifact payload. */
export declare function createPlanStageInput(args: CursorCreatePlanArgs): CursorPlanStageInput;
/**
 * Resolve the absolute plan file path via {@link hostPlansDir}.
 * Filename shape matches OpenCode Session.plan: `<created>-<slug>.md`.
 */
export declare function resolveHostPlanPath(workspaceRoot: string, name?: string, created?: number): string;
/** @deprecated Prefer {@link resolveHostPlanPath}. */
export declare const resolveOpencodePlanPath: typeof resolveHostPlanPath;
/**
 * Render plain markdown for the plan file. No Cursor YAML frontmatter.
 * Prefer `args.plan` as the body; prepend a title/overview when useful; append
 * a markdown checklist for todos.
 */
export declare function renderOpencodePlanMarkdown(args: CursorCreatePlanArgs): string;
/**
 * Write the plan under {@link hostPlansDir} and return a `file://` URI.
 * Empty / missing content is the caller's responsibility (empty plan_uri ack).
 */
export declare function writeOpencodePlanFile(args: CursorCreatePlanArgs, workspaceRoot: string, created?: number): CreatePlanWriteResult;
/**
 * The plan as the user reads it before approving execution.
 *
 * Cursor routes the plan body through the interaction query rather than the
 * text stream, so without this the user is asked to approve a plan they were
 * never shown. It goes into the assistant message — the host renders markdown
 * there, it scrolls, and it survives answering the prompt. It must not go into
 * the question itself: OpenCode renders the question dock outside its
 * scrollbox with `flexShrink={0}`, so a full plan there would push the
 * conversation off screen.
 */
export declare function renderPlanReviewMessage(markdown: string, planPath: string): string;
