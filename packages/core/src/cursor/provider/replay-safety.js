import { trace } from "./debug.js";
import { readAllFieldsStrict } from "./protocol/struct.js";
export class AttemptReplaySafety {
    sessionId;
    barrierReason;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
    markBarrier(reason) {
        if (this.barrierReason)
            return;
        this.barrierReason = reason;
        trace(`replay barrier: reason=${reason} sessionId=${this.sessionId}`);
    }
    applyTo(failure) {
        failure.replaySafe = this.barrierReason === undefined && failure.replaySafe;
        if (this.barrierReason) {
            trace(`replay suppressed: reason=${this.barrierReason} sessionId=${this.sessionId}`);
        }
        return failure;
    }
}
const INTERACTION_UPDATE_FIELDS = new Set([1, 2, 3, 4, 7, 13, 14, 16, 17]);
const INTERACTION_QUERY_FIELDS = new Set([2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14]);
const TOP_LEVEL_FIELDS = new Set([1, 2, 3, 4, 5, 7]);
function nestedFields(topLevel, field) {
    if (topLevel?.fn !== field || topLevel.wt !== 2 || !topLevel.bytes)
        return [];
    return readAllFieldsStrict(topLevel.bytes) ?? [];
}
function analyzeExecWire(topLevel) {
    const variants = nestedFields(topLevel, 2)
        .filter((field) => ![1, 15, 19].includes(field.fn));
    const exactVariant = (field) => variants.length === 1 && variants[0].fn === field && variants[0].wt === 2;
    return {
        exactRequestContext: exactVariant(10),
        exactMcpState: exactVariant(36),
    };
}
function validKvWire(topLevel) {
    const variants = nestedFields(topLevel, 4).filter((field) => field.fn !== 1);
    const variant = variants.length === 1 ? variants[0] : undefined;
    const args = variant?.wt === 2 && variant.bytes
        ? (readAllFieldsStrict(variant.bytes) ?? [])
        : [];
    const blobIds = args.filter((field) => field.fn === 1 && field.wt === 2 && (field.bytes?.length ?? 0) > 0);
    return !!variant
        && [2, 3].includes(variant.fn)
        && variant.wt === 2
        && blobIds.length === 1
        && args.every((field) => field.wt === 2 && (field.fn === 1 || (variant.fn === 3 && field.fn === 2)));
}
function validInteractionUpdateWire(topLevel, decoded) {
    if (!decoded)
        return true;
    const fields = nestedFields(topLevel, 1);
    const update = fields.length === 1 ? fields[0] : undefined;
    if (!update || update.wt !== 2 || !INTERACTION_UPDATE_FIELDS.has(update.fn))
        return false;
    if (![1, 4].includes(update.fn))
        return true;
    const delta = update.bytes ? (readAllFieldsStrict(update.bytes) ?? []) : [];
    return delta.length === 1 && delta[0].fn === 1 && delta[0].wt === 2;
}
function validInteractionQueryWire(topLevel, decoded) {
    if (!decoded)
        return true;
    const fields = nestedFields(topLevel, 7);
    const ids = fields.filter((field) => field.fn === 1);
    const variants = fields.filter((field) => field.fn !== 1);
    return ids.length <= 1
        && ids.every((field) => field.wt === 0)
        && variants.length === 1
        && variants[0].wt === 2
        && INTERACTION_QUERY_FIELDS.has(variants[0].fn);
}
function decodedMatchesWire(topLevel, decoded) {
    return !((topLevel?.fn === 1 && !decoded.interactionUpdate)
        || (topLevel?.fn === 2 && !decoded.exec)
        || (topLevel?.fn === 4 && !decoded.kv)
        || (topLevel?.fn === 5 && !decoded.execControl)
        || (topLevel?.fn === 7 && !decoded.interactionQuery));
}
function hasSemanticProgress(decoded) {
    const update = decoded.interactionUpdate;
    const text = update?.text_delta?.text;
    const thinking = update?.thinking_delta?.text;
    return (typeof text === "string" && text.length > 0)
        || (typeof thinking === "string" && thinking.length > 0)
        || !!update?.turn_ended
        || !!update?.tool_call_started
        || !!update?.tool_call_completed
        || !!decoded.exec
        || !!decoded.kv
        || !!decoded.execControl
        || !!decoded.interactionQuery
        || !!decoded.checkpointBytes?.length;
}
/** Classify one decoded server frame without performing any protocol side effects. */
export function analyzeReplayFrame(payload, decoded) {
    const topLevelFields = readAllFieldsStrict(payload) ?? [];
    const topLevel = topLevelFields.length === 1 ? topLevelFields[0] : undefined;
    const exec = analyzeExecWire(topLevel);
    const validKv = validKvWire(topLevel);
    const malformed = !topLevel
        || topLevel.wt !== 2
        || !TOP_LEVEL_FIELDS.has(topLevel.fn)
        || !validInteractionUpdateWire(topLevel, decoded.interactionUpdate)
        || !validInteractionQueryWire(topLevel, decoded.interactionQuery)
        || !decodedMatchesWire(topLevel, decoded)
        || !!decoded.execControl;
    let barrier;
    if (decoded.interactionUpdate?.tool_call_started || decoded.interactionUpdate?.tool_call_completed) {
        barrier = "display-tool-lifecycle";
    }
    else if (malformed || (topLevel.fn === 4 && !validKv)) {
        barrier = "unknown-or-malformed-frame";
    }
    else if (topLevel.fn === 2 && !exec.exactRequestContext && !exec.exactMcpState) {
        barrier = "non-control-exec";
    }
    return {
        semanticProgress: hasSemanticProgress(decoded),
        barrier,
    };
}
