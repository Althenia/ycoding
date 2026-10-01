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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trace } from "./debug.js";
/** Upstream `PlanExitTool` wording — keep verbatim so behaviour matches OpenCode. */
export function createPlanExecutionKickoffText(planPath) {
    const where = planPath.trim() || "the plan";
    return `The plan at ${where} has been approved, you can now edit files. Execute the plan`;
}
/**
 * Prefer a worktree-relative label when the plan sits under `workspaceRoot`,
 * matching OpenCode's `path.relative(instance.worktree, Session.plan(...))`.
 * Otherwise keep the absolute path (global data `plans/` is outside the tree).
 */
export function formatPlanKickoffPath(planPath, workspaceRoot) {
    const absolute = planPath.trim();
    if (!absolute)
        return absolute;
    const root = workspaceRoot?.trim();
    if (!root)
        return absolute;
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return absolute;
    }
    return relative;
}
/** Decode a `file://` plan URI to a filesystem path; pass other strings through. */
export function planPathFromUri(planUri) {
    const raw = planUri.trim();
    if (!raw)
        return "";
    if (raw.startsWith("file:")) {
        try {
            return fileURLToPath(raw);
        }
        catch {
            return raw;
        }
    }
    return raw;
}
let kickoff;
const pending = new Map();
const warnings = new Map();
const MAX_PENDING_PLAN_KICKOFFS = 256;
/** Install (or clear) the host kickoff. */
export function setPlanExecutionKickoff(fn) {
    kickoff = fn;
    if (!fn) {
        pending.clear();
        warnings.clear();
    }
}
export function hasPlanExecutionKickoff() {
    return kickoff !== undefined;
}
/** Record the approved plan; execution is flushed after the stream settles. */
export function queuePlanExecutionKickoff(input) {
    const sessionID = input.sessionID.trim();
    const planPath = input.planPath.trim();
    if (!sessionID || !planPath || !kickoff) {
        trace(`plan-execution-kickoff: not queued sessionID=${JSON.stringify(sessionID)} ` +
            `planPath=${JSON.stringify(planPath)} handler=${Boolean(kickoff)}`);
        return false;
    }
    pending.set(sessionID, {
        sessionID,
        planPath,
        ...(input.cursorSessionID ? { cursorSessionID: input.cursorSessionID } : {}),
        status: "pending",
        attempts: 0,
    });
    warnings.delete(sessionID);
    while (pending.size > MAX_PENDING_PLAN_KICKOFFS) {
        const oldest = pending.keys().next().value;
        if (!oldest)
            break;
        pending.delete(oldest);
        warnings.delete(oldest);
    }
    trace(`plan-execution-kickoff: pending sessionID=${sessionID} ` +
        `cursorSessionID=${input.cursorSessionID ?? ""} planPath=${planPath}`);
    return true;
}
/** Drop any approval state owned by a deleted host session. */
export function cancelPlanExecutionKickoff(sessionID) {
    const key = sessionID?.trim();
    if (!key)
        return;
    pending.delete(key);
    warnings.delete(key);
}
/**
 * Run one pending kickoff only after the owning Cursor Run reached a terminal,
 * idle state. Returns true only after successful host handoff.
 */
export async function flushPlanExecutionKickoff(sessionID, options = {}) {
    const key = sessionID?.trim();
    if (!key)
        return false;
    const state = pending.get(key);
    if (!state)
        return false;
    if (options.terminal !== true || options.pumpActive || (options.pendingExecs ?? 0) > 0) {
        trace(`plan-execution-kickoff: deferred sessionID=${key} terminal=${Boolean(options.terminal)} ` +
            `pumpActive=${Boolean(options.pumpActive)} pending=${options.pendingExecs ?? 0}`);
        return false;
    }
    if (state.cursorSessionID
        && options.cursorSessionID
        && state.cursorSessionID !== options.cursorSessionID) {
        // The owning Run was superseded before the handoff could happen. Applying
        // it from a later Run would execute a stale approval in the wrong turn.
        pending.delete(key);
        warnings.delete(key);
        trace(`plan-execution-kickoff: discarded stale Run sessionID=${key} ` +
            `owner=${state.cursorSessionID} terminal=${options.cursorSessionID}`);
        return false;
    }
    const run = kickoff;
    if (!run) {
        const message = "The plan was approved, but this host cannot start its execution turn.";
        state.status = "failed";
        state.lastError = message;
        warnings.set(key, message);
        return false;
    }
    state.attempts += 1;
    try {
        await run({
            sessionID: state.sessionID,
            planPath: state.planPath,
            ...(state.cursorSessionID ? { cursorSessionID: state.cursorSessionID } : {}),
        });
        pending.delete(key);
        warnings.delete(key);
        trace(`plan-execution-kickoff: queued sessionID=${key} planPath=${state.planPath}`);
        return true;
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const message = `The approved plan could not start execution: ${detail}. ` +
            "The plan remains active and can be retried.";
        state.status = "failed";
        state.lastError = detail;
        // A later explicit provider turn may retry after its own terminal boundary;
        // do not keep pinning the retry to the now-finished Cursor Run.
        delete state.cursorSessionID;
        warnings.set(key, message);
        trace(`plan-execution-kickoff: FAILED sessionID=${key} attempts=${state.attempts} err=${detail}`);
        return false;
    }
}
/** Consume a user-visible warning on the next provider turn. */
export function takePlanExecutionKickoffWarning(sessionID) {
    const key = sessionID?.trim();
    if (!key)
        return undefined;
    const message = warnings.get(key);
    if (message)
        warnings.delete(key);
    return message;
}
/** Retry state remains explicit; no timer or automatic loop fires it. */
export function planExecutionKickoffState(sessionID) {
    const key = sessionID?.trim();
    const state = key ? pending.get(key) : undefined;
    return state ? { ...state } : undefined;
}
/** Test helper: clear the registered kickoff and pending approvals. */
export function resetPlanExecutionKickoffForTests() {
    kickoff = undefined;
    pending.clear();
    warnings.clear();
}
