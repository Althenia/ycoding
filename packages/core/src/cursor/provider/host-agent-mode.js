/**
 * Host-owned primary-agent synchronization for Cursor SwitchMode.
 *
 * The language model stays host-neutral: it records a canonical Cursor mode
 * (`plan`, `spec`, `agent`, ...). A host entrypoint may install this structural
 * callback when its public API can select the corresponding primary agent.
 * OpenCode 2.0 uses it to select its vendor-maintained `plan` / `build` agents;
 * OpenCode 1.x continues to use advertised `plan_enter` / `plan_exit` tools.
 */
import { trace } from "./debug.js";
let switchHostAgent;
const pending = new Map();
const MAX_PENDING_HOST_AGENT_SWITCHES = 256;
export function setHostAgentModeSwitch(fn) {
    switchHostAgent = fn;
    if (!fn)
        pending.clear();
}
/** Queue only when this host installed a native primary-agent switch. */
export function queueHostAgentModeSwitch(input) {
    const sessionID = input.sessionID.trim();
    const targetModeID = input.targetModeID.trim();
    if (!switchHostAgent || !sessionID || !targetModeID)
        return false;
    pending.set(sessionID, {
        sessionID,
        targetModeID,
        ...(input.cursorSessionID ? { cursorSessionID: input.cursorSessionID } : {}),
        attempts: 0,
    });
    while (pending.size > MAX_PENDING_HOST_AGENT_SWITCHES) {
        const oldest = pending.keys().next().value;
        if (!oldest)
            break;
        pending.delete(oldest);
    }
    trace(`host-agent-mode: pending sessionID=${sessionID} ` +
        `cursorSessionID=${input.cursorSessionID ?? ""} target=${targetModeID}`);
    return true;
}
export function cancelHostAgentModeSwitch(sessionID) {
    const key = sessionID?.trim();
    if (key)
        pending.delete(key);
}
/**
 * Apply the switch only after its Cursor Run is terminal and owns no pending
 * execs. This avoids changing the host's permission/catalog state underneath a
 * held Run that still needs to finish or receive a tool result.
 */
export async function flushHostAgentModeSwitch(sessionID, options = {}) {
    const key = sessionID?.trim();
    if (!key)
        return false;
    const state = pending.get(key);
    if (!state || !switchHostAgent)
        return false;
    if (options.terminal !== true || options.pumpActive || (options.pendingExecs ?? 0) > 0) {
        return false;
    }
    if (state.cursorSessionID
        && options.cursorSessionID
        && state.cursorSessionID !== options.cursorSessionID) {
        // A newer Run reached its terminal boundary, so the owner was superseded
        // before its native-agent switch could be applied. Never let that stale
        // request mutate a later turn, and do not retain it indefinitely.
        pending.delete(key);
        trace(`host-agent-mode: discarded stale Run sessionID=${key} ` +
            `owner=${state.cursorSessionID} terminal=${options.cursorSessionID}`);
        return false;
    }
    state.attempts += 1;
    try {
        await switchHostAgent(state);
        pending.delete(key);
        trace(`host-agent-mode: switched sessionID=${key} target=${state.targetModeID}`);
        return true;
    }
    catch (error) {
        // Keep the request pending so a later explicit provider turn can retry at
        // its own terminal boundary. The provider-owned mode reminder remains the
        // behavioral fallback until the native host switch succeeds.
        delete state.cursorSessionID;
        trace(`host-agent-mode: FAILED sessionID=${key} target=${state.targetModeID} ` +
            `attempts=${state.attempts} err=${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
export function resetHostAgentModeSwitchForTests() {
    switchHostAgent = undefined;
    pending.clear();
}
