import { buildDynamicRequestContext, buildRequestContext, materializeRequestContext, requestContextBase, } from "./build.js";
import { clearContextEpoch, endContextEpoch, resetContextEpochsForTests } from "./epoch.js";
import { clearOverlayHold, resetOverlayHoldsForTests, transferOverlayHold, } from "./overlay.js";
import { trace } from "../debug.js";
import { encodeMessage } from "../protocol/messages.js";
/**
 * Freeze the expensive RequestContext base for the life of a conversation_id.
 *
 * Cursor's current exec-daemon cache treats RequestContext as a baked stable
 * base plus live plugin/tool overlays. Rebuilding volatile git/layout data on
 * every Run shifts the prompt prefix and tanks prompt-cache hits.
 *
 * Skills, subagents, plugin metadata, and tool/MCP capabilities are rediscovered
 * each Run, then epoch-held (equal ids keep frozen bytes; new ids append) and
 * overlaid on that base. If the encoded overlay bytes did not change, the exact
 * prior materialized object is reused.
 */
const byConversationId = new Map();
const materializedByConversationId = new Map();
const buildsByConversationId = new Map();
export const MAX_FROZEN_REQUEST_CONTEXTS = 256;
function freezeSnapshot(value, seen = new Set()) {
    if (!value || typeof value !== "object")
        return value;
    const object = value;
    if (seen.has(object) || ArrayBuffer.isView(object))
        return value;
    seen.add(object);
    for (const child of Object.values(object))
        freezeSnapshot(child, seen);
    return Object.freeze(value);
}
function remember(conversationId, context) {
    // Map insertion order is the LRU order. Refresh existing entries on use.
    byConversationId.delete(conversationId);
    // Clone + recursively freeze so session.requestContext cannot mutate the
    // byte-stable snapshot retained for later Runs in the same conversation.
    byConversationId.set(conversationId, freezeSnapshot(structuredClone(context)));
    materializedByConversationId.delete(conversationId);
    while (byConversationId.size > MAX_FROZEN_REQUEST_CONTEXTS) {
        const oldest = byConversationId.keys().next().value;
        if (!oldest)
            break;
        byConversationId.delete(oldest);
        materializedByConversationId.delete(oldest);
        clearOverlayHold(oldest);
    }
}
/** Frozen stable RequestContext base for this conversation, if any. */
export function getFrozenRequestContext(conversationId) {
    const frozen = byConversationId.get(conversationId);
    if (!frozen)
        return undefined;
    // Touch for LRU.
    byConversationId.delete(conversationId);
    byConversationId.set(conversationId, frozen);
    return frozen;
}
/** Replace the frozen stable base, stripping any live capability fields. */
export function setFrozenRequestContext(conversationId, context) {
    if (!conversationId)
        return;
    remember(conversationId, requestContextBase(context));
}
/** Drop a conversation's frozen RequestContext (compaction / binding reset). */
export function clearFrozenRequestContext(conversationId) {
    byConversationId.delete(conversationId);
    materializedByConversationId.delete(conversationId);
    clearOverlayHold(conversationId);
    clearContextEpoch(conversationId);
}
/**
 * Move a stable workspace base across a conversation-id reset.
 *
 * Compaction changes Cursor's state/checkpoint identity, not the OpenCode
 * workspace. Preserve the expensive base and the prior materialized bytes as a
 * comparison seed; getOrBuildRequestContext still rediscovers live capability
 * overlays (then epoch-holds them) and only reuses the complete context when
 * those bytes also match.
 */
export function transferFrozenRequestContext(previousConversationId, nextConversationId) {
    if (!previousConversationId || !nextConversationId)
        return false;
    const base = byConversationId.get(previousConversationId);
    const materialized = materializedByConversationId.get(previousConversationId);
    // System Context epoch does not transfer — compaction starts a fresh baseline.
    // Overlay hold does transfer: same workspace, same advertised skill/agent/plugin
    // bytes, so the comparison seed can still match. clearFrozenRequestContext
    // also drops epoch state for each id.
    endContextEpoch(previousConversationId, nextConversationId);
    transferOverlayHold(previousConversationId, nextConversationId);
    byConversationId.delete(previousConversationId);
    materializedByConversationId.delete(previousConversationId);
    byConversationId.delete(nextConversationId);
    materializedByConversationId.delete(nextConversationId);
    if (!base)
        return false;
    remember(nextConversationId, base);
    if (materialized) {
        materializedByConversationId.set(nextConversationId, {
            context: materialized.context,
            bytes: Uint8Array.from(materialized.bytes),
        });
    }
    return true;
}
/** Test helper — wipe all frozen contexts. */
export function resetFrozenRequestContextsForTests() {
    byConversationId.clear();
    materializedByConversationId.clear();
    buildsByConversationId.clear();
    resetOverlayHoldsForTests();
    resetContextEpochsForTests();
}
function sameBytes(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
function rememberMaterialized(conversationId, context) {
    const bytes = encodeMessage("RequestContext", context);
    const previous = materializedByConversationId.get(conversationId);
    if (previous && sameBytes(previous.bytes, bytes)) {
        return { context: previous.context, reused: true };
    }
    const frozen = freezeSnapshot(structuredClone(context));
    materializedByConversationId.set(conversationId, {
        context: frozen,
        bytes: Uint8Array.from(bytes),
    });
    return { context: frozen, reused: false };
}
/**
 * Return a stable-base + live-overlay RequestContext for `conversationId`.
 * The base is built once; capability sections are rediscovered every Run
 * and then epoch-held.
 */
export async function getOrBuildRequestContext(conversationId, input, opts) {
    const scoped = conversationId ? { ...input, conversationId } : input;
    if (opts?.refresh && conversationId)
        clearOverlayHold(conversationId);
    if (!opts?.refresh && conversationId) {
        const base = getFrozenRequestContext(conversationId);
        if (base) {
            const dynamic = await buildDynamicRequestContext(scoped);
            const materialized = rememberMaterialized(conversationId, materializeRequestContext(base, dynamic));
            trace(`request_context: materialized conversationId=${conversationId} ` +
                `tools=${Array.isArray(materialized.context.tools) ? materialized.context.tools.length : 0} ` +
                `reused=${materialized.reused}`);
            return materialized;
        }
    }
    // Two overlapping model calls can open Runs for the same conversation. Share
    // the first build so both Runs receive the same snapshot instead of racing
    // two independently collected git/layout views into the cache.
    if (!opts?.refresh && conversationId) {
        const inFlight = buildsByConversationId.get(conversationId);
        if (inFlight) {
            await inFlight;
            return getOrBuildRequestContext(conversationId, scoped);
        }
    }
    const build = buildRequestContext(scoped);
    if (conversationId)
        buildsByConversationId.set(conversationId, build);
    let context;
    try {
        context = await build;
    }
    finally {
        if (conversationId && buildsByConversationId.get(conversationId) === build) {
            buildsByConversationId.delete(conversationId);
        }
    }
    if (conversationId)
        setFrozenRequestContext(conversationId, context);
    // The first full build already contains both base and live overlay.
    const materialized = conversationId
        ? rememberMaterialized(conversationId, context)
        : { context: freezeSnapshot(structuredClone(context)), reused: false };
    trace(`request_context: built+frozen conversationId=${conversationId || "(none)"} ` +
        `tools=${Array.isArray(materialized.context.tools) ? materialized.context.tools.length : 0} ` +
        `refresh=${!!opts?.refresh}`);
    return { context: materialized.context, reused: false };
}
